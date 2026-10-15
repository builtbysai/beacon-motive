import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Target } from "../adapters/browser.ts";
import { FORMAT, parseWorkflow, type Workflow } from "../workflow.ts";

export interface RecordedStep {
  kind: "open" | "click" | "fill" | "select" | "press";
  url?: string;
  target?: Target;
  /** Other selectors verified to identify the same element at record time. */
  alternatives?: Target[];
  /** unique: a Playwright locator matched exactly the demonstrated element. unverified: could not be checked (page changed). ambiguous: nothing identified it uniquely. */
  verified?: "unique" | "unverified" | "ambiguous";
  label?: string;
  value?: string;
  secret?: boolean;
  key?: "Enter";
}

export interface Compiled {
  workflow: Workflow;
  warnings: string[];
}

export class AmbiguousRecording extends Error {}

function camel(label: string, fallback: string): string {
  const words = label.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 4);
  if (!words.length) return fallback;
  const s = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join("");
  return /^[A-Za-z_]/.test(s) ? s : fallback;
}

/**
 * Turns a demonstration into a workflow. Policy for the questions a single demonstration cannot answer:
 *  - typed text and selected options become inputs, defaulting to the demonstrated value (data is usually variable);
 *  - sensitive fields become secret inputs with no default and no recorded value;
 *  - clicks, navigation and keys stay constants;
 *  - an action that cannot be tied to exactly one element is refused rather than guessed.
 */
export function compile(recorded: RecordedStep[], opts: { name: string; expectText?: string }): Compiled {
  const warnings: string[] = [];
  const ambiguous = recorded.filter((s) => s.verified === "ambiguous");
  if (ambiguous.length) {
    throw new AmbiguousRecording(
      `Cannot identify ${ambiguous.length} action(s) uniquely: ${ambiguous.map((s) => `${s.kind} "${s.label ?? "?"}"`).join(", ")}. Give those elements an accessible name, label or data-testid, or record again.`,
    );
  }
  const inputs: Workflow["inputs"] = {};
  const hosts = new Set<string>();
  const dirs = new Set<string>();
  const steps: Workflow["steps"] = [];
  const used = new Set<string>();
  const inputName = (label: string | undefined, fallback: string) => {
    let base = camel(label ?? "", fallback);
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}${i}`;
    used.add(n);
    return n;
  };

  for (const [i, r] of recorded.entries()) {
    const id = `${r.kind}${i + 1}`;
    if (r.kind === "open") {
      const u = new URL(r.url!);
      if (u.protocol === "file:") {
        dirs.add(path.dirname(fileURLToPath(u)));
        warnings.push("Opens a local file by absolute path; the workflow is tied to this machine unless you edit the url.");
      } else hosts.add(u.hostname);
      steps.push({ id, op: "browser.open", args: { url: r.url }, onError: "fail" });
      continue;
    }
    if (r.verified === "unverified") warnings.push(`${id}: "${r.label ?? "?"}" could not be checked for uniqueness because the page changed; verify it on replay.`);
    const target = r.target!;
    const alt = r.alternatives?.length ? { alternatives: r.alternatives as Record<string, unknown>[] } : {};
    if (r.kind === "click") steps.push({ id, op: "browser.click", args: { target }, onError: "fail", ...alt });
    else if (r.kind === "press") steps.push({ id, op: "browser.press", args: { target, key: r.key }, onError: "fail", ...alt });
    else if (r.kind === "fill") {
      const name = inputName(r.label, `field${i + 1}`);
      inputs[name] = r.secret ? { type: "string", secret: true } : { type: "string", secret: false, default: r.value ?? "" };
      steps.push({ id, op: "browser.fill", args: { target, value: `\${inputs.${name}}` }, onError: "fail", ...alt });
    } else {
      const name = inputName(r.label, `choice${i + 1}`);
      inputs[name] = { type: "string", secret: false, default: r.value ?? "" };
      steps.push({ id, op: "browser.select", args: { target, option: `\${inputs.${name}}` }, onError: "fail", ...alt });
    }
  }
  if (opts.expectText) {
    // Text that contains a value typed during the demonstration should follow that input when replayed with another value.
    let expected = opts.expectText;
    for (const [name, def] of Object.entries(inputs)) {
      if (!def.secret && typeof def.default === "string" && def.default.length >= 2 && expected.includes(def.default)) {
        expected = expected.split(def.default).join(`\${inputs.${name}}`);
      }
    }
    steps.push({ id: "verify", op: "browser.wait", args: { target: { text: expected }, state: "visible" }, timeoutMs: 10_000, onError: "fail" });
  } else {
    warnings.push("No expected result was given (--expect-text), so a replay verifies actions but not the outcome. Add a postcondition before relying on it.");
  }

  const workflow = parseWorkflow({
    format: FORMAT,
    name: opts.name,
    description: "Recorded in Teach Mode. Review every step and the scopes before saving.",
    inputs,
    scopes: { hosts: [...hosts], dirs: [...dirs], apps: [] },
    steps,
  });
  return { workflow, warnings };
}
