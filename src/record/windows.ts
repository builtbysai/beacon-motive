import path from "node:path";
import { sidecarPath, WinClient } from "../adapters/windows.ts";
import { MotiveError } from "../errors.ts";
import { FORMAT, parseWorkflow, type Workflow } from "../workflow.ts";
import { showRecordingIndicator } from "./indicator.ts";

export interface WinTarget {
  automationId?: string;
  name?: string;
  controlType?: string;
}

export interface WinRecordedStep {
  kind: "click" | "select" | "value" | "toggle";
  target: WinTarget;
  alternatives: WinTarget[];
  label: string;
  text?: string;
  secret?: boolean;
  verified: "unique" | "ambiguous" | "unverified";
}

interface RawEvent {
  kind: "invoke" | "select" | "value" | "toggle";
  element: { automationId: string; name: string; controlType: string };
  password: boolean;
  text?: string;
  toggle?: string | null;
}

/** Candidate selectors for a control, best first: its automation id, then name with type. */
function candidates(e: RawEvent["element"]): WinTarget[] {
  const out: WinTarget[] = [];
  if (e.automationId) out.push({ automationId: e.automationId });
  if (e.name) out.push({ name: e.name, controlType: e.controlType });
  return out;
}

/**
 * Records what a person does in one window, from UI Automation events, while a visible indicator is shown. Edits to a
 * field collapse into its final value; password fields are reported without their contents.
 */
export async function recordWindow(window: { name: string }, signal: AbortSignal, onStarted: () => void): Promise<WinRecordedStep[]> {
  const exe = sidecarPath();
  if (process.platform !== "win32" || !exe) throw new MotiveError("unsupported", "Windows recording needs Windows and the built helper (npm run build:win).");
  const client = new WinClient(exe);
  const events: RawEvent[] = [];
  client.onEvent = (e) => events.push(e);
  const indicator = showRecordingIndicator();
  try {
    await client.call("record.start", { window });
    onStarted();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    await client.call("record.stop").catch(() => {});
    await new Promise((r) => setTimeout(r, 150)); // events already in flight

    const steps: WinRecordedStep[] = [];
    for (const ev of events) {
      const cands = candidates(ev.element);
      if (!cands.length) continue;
      const base = { target: cands[0]!, alternatives: cands.slice(1), label: ev.element.name || ev.element.automationId, verified: "unverified" as const };
      if (ev.kind === "value") {
        const last = steps.at(-1);
        // Every keystroke raises a value change; only the final value of a run on the same control matters.
        if (last?.kind === "value" && JSON.stringify(last.target) === JSON.stringify(base.target)) {
          if (!ev.password) last.text = ev.text ?? "";
          continue;
        }
        steps.push({ ...base, kind: "value", secret: ev.password, ...(ev.password ? {} : { text: ev.text ?? "" }) });
      } else if (ev.kind === "toggle") {
        steps.push({ ...base, kind: "toggle" });
      } else if (ev.kind === "select") {
        steps.push({ ...base, kind: "select", text: ev.text ?? ev.element.name });
      } else {
        steps.push({ ...base, kind: "click" });
      }
    }
    // A click on a list item and its selection event are one action.
    const merged = steps.filter((s, i) => !(s.kind === "click" && steps[i + 1]?.kind === "select" && JSON.stringify(steps[i + 1]!.target) === JSON.stringify(s.target)));

    // Check each target identifies exactly one control right now (controls that have gone away stay "unverified").
    for (const s of merged) {
      const found = await client.call("element.find", { window, target: s.target }).then(
        () => "unique" as const,
        (e: MotiveError) => (e.code === "ambiguous" ? ("ambiguous" as const) : ("unverified" as const)),
      );
      s.verified = found;
    }
    return merged;
  } finally {
    client.close();
    indicator.kill();
  }
}

function camel(label: string, fallback: string): string {
  const words = label.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 4);
  if (!words.length) return fallback;
  const s = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join("");
  return /^[A-Za-z_]/.test(s) ? s : fallback;
}

/** Same policy as the browser compiler: values become inputs, secrets are never stored, ambiguous actions are refused. */
export function compileWindow(
  recorded: WinRecordedStep[],
  opts: { name: string; window: string; command?: string; expect?: { automationId: string; text: string } },
): { workflow: Workflow; warnings: string[] } {
  let steps = recorded;
  const warnings: string[] = [];
  const bad = steps.filter((s) => s.verified === "ambiguous");
  if (bad.length) throw new Error(`Cannot identify ${bad.length} action(s) uniquely: ${bad.map((s) => `${s.kind} "${s.label}"`).join(", ")}. Use the control's automation id or a unique name.`);

  // A combo box reports its choice twice: the dropdown item (gone once it closes) and the box's new value. The value is
  // what replays, so drop an unfindable item that is immediately followed by one.
  const kept = steps.filter((s, i) => !(s.kind === "select" && s.verified === "unverified" && steps[i + 1]?.kind === "value"));
  if (kept.length !== steps.length) warnings.push(`${steps.length - kept.length} transient dropdown selection(s) were folded into the combo box's value.`);
  // Edits to one field separated only by dropped dropdown noise are one edit: keep the last value.
  steps = kept.filter((s, i) => !(s.kind === "value" && kept[i + 1]?.kind === "value" && JSON.stringify(kept[i + 1]!.target) === JSON.stringify(s.target)));

  const win = { name: opts.window };
  const inputs: Workflow["inputs"] = {};
  const used = new Set<string>();
  const out: Workflow["steps"] = [];
  const scopes: Workflow["scopes"] = { hosts: [], dirs: [], apps: [] };
  if (opts.command) {
    scopes.apps.push(path.basename(opts.command));
    out.push({ id: "open", op: "win.launch", args: { command: opts.command, window: win }, timeoutMs: 15000, onError: "fail" });
  } else {
    out.push({ id: "open", op: "win.wait", args: { window: win }, timeoutMs: 15000, onError: "fail" });
    warnings.push("The application must already be running when this workflow starts (pass --command to launch it).");
  }
  const name = (label: string, fallback: string) => {
    let base = camel(label, fallback);
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}${i}`;
    used.add(n);
    return n;
  };
  for (const [i, s] of steps.entries()) {
    const id = `${s.kind}${i + 1}`;
    const alt = s.alternatives.length ? { alternatives: s.alternatives as Record<string, unknown>[] } : {};
    if (s.verified === "unverified") warnings.push(`${id}: "${s.label}" could not be re-found after recording (it may be transient, such as a menu); verify it on replay.`);
    if (s.kind === "click" || s.kind === "toggle") out.push({ id, op: "win.click", args: { window: win, target: s.target }, onError: "fail", ...alt });
    else if (s.kind === "select") out.push({ id, op: "win.select", args: { window: win, target: { name: s.text, controlType: "ListItem" } }, onError: "fail" });
    else {
      const input = name(s.label, `field${i + 1}`);
      if (s.secret) {
        inputs[input] = { type: "string", secret: true };
        out.push({ id, op: "win.type", args: { window: win, target: s.target, text: `\${inputs.${input}}` }, onError: "fail", ...alt });
      } else {
        inputs[input] = { type: "string", secret: false, default: s.text ?? "" };
        out.push({ id, op: "win.setValue", args: { window: win, target: s.target, value: `\${inputs.${input}}` }, onError: "fail", ...alt });
      }
    }
  }
  if (opts.expect) {
    let text = opts.expect.text;
    for (const [k, def] of Object.entries(inputs)) {
      if (!def.secret && typeof def.default === "string" && def.default.length >= 2 && text.includes(def.default)) text = text.split(def.default).join(`\${inputs.${k}}`);
    }
    out.push({ id: "verify", op: "win.read", args: { window: win, target: { automationId: opts.expect.automationId } }, post: [{ contains: { value: "${out.text}", text } }], timeoutMs: 10_000, onError: "fail" });
  } else warnings.push("No expected result was given (--expect <automationId>:<text>), so a replay verifies actions but not the outcome.");

  const workflow = parseWorkflow({ format: FORMAT, name: opts.name, description: "Recorded from a Windows application in Teach Mode. Review every step before saving.", inputs, scopes, steps: out });
  return { workflow, warnings };
}
