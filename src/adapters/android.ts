import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { MotiveError } from "../errors.ts";
import type { Adapter, OpContext, OpDef } from "./types.ts";

// Android through adb and UI Automator. Everything a workflow sees is limited to the packages it declared in
// scopes.apps: the rest of the dump (notifications, other apps) is dropped before anything else can read it, and the
// raw dump is never stored or logged.

export interface UiNode {
  text: string;
  resourceId: string;
  className: string;
  package: string;
  contentDesc: string;
  clickable: boolean;
  enabled: boolean;
  password: boolean;
  checked: boolean;
  bounds: { left: number; top: number; right: number; bottom: number };
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);|&#(\d+);/g, (m, _n, code) => (code ? String.fromCodePoint(Number(code)) : (ENTITIES[m] ?? m)));

/** Parses a uiautomator dump, keeping only nodes of the allowed packages. */
export function parseDump(xml: string, allowedPackages: string[]): UiNode[] {
  const out: UiNode[] = [];
  for (const m of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const a: Record<string, string> = {};
    for (const kv of m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) a[kv[1]!] = decode(kv[2]!);
    if (!allowedPackages.includes(a.package ?? "")) continue;
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(a.bounds ?? "");
    if (!b) continue;
    out.push({
      text: a.text ?? "",
      resourceId: a["resource-id"] ?? "",
      className: a.class ?? "",
      package: a.package ?? "",
      contentDesc: a["content-desc"] ?? "",
      clickable: a.clickable === "true",
      enabled: a.enabled === "true",
      password: a.password === "true",
      checked: a.checked === "true",
      bounds: { left: +b[1]!, top: +b[2]!, right: +b[3]!, bottom: +b[4]! },
    });
  }
  return out;
}

const Selector = z
  .object({
    resourceId: z.string().optional(),
    text: z.string().optional(),
    textContains: z.string().optional(),
    contentDesc: z.string().optional(),
    contentDescContains: z.string().optional(),
    className: z.string().optional(),
  })
  .strict()
  .refine((s) => Object.keys(s).length > 0, "target needs a selector");
export type Selector = z.infer<typeof Selector>;

export function matches(n: UiNode, s: Selector): boolean {
  if (s.resourceId && !(n.resourceId === s.resourceId || n.resourceId.endsWith(`:id/${s.resourceId}`))) return false;
  if (s.text !== undefined && n.text !== s.text) return false;
  if (s.textContains && !n.text.toLowerCase().includes(s.textContains.toLowerCase())) return false;
  if (s.contentDesc !== undefined && n.contentDesc !== s.contentDesc) return false;
  if (s.contentDescContains && !n.contentDesc.toLowerCase().includes(s.contentDescContains.toLowerCase())) return false;
  if (s.className && n.className !== s.className) return false;
  return n.bounds.right > n.bounds.left && n.bounds.bottom > n.bounds.top; // on screen, with an area
}

export function adbPath(): string | undefined {
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk") : path.join(os.homedir(), "Android", "Sdk")];
  const candidates = [process.env.MOTIVE_ADB, ...roots.map((r) => (r ? path.join(r, "platform-tools", exe) : undefined))];
  const found = candidates.find((c) => c && existsSync(c));
  if (found) return found;
  try {
    execFileSync(exe, ["version"], { stdio: "ignore", timeout: 3000 });
    return exe; // on PATH
  } catch {
    return undefined;
  }
}

interface Device {
  serial?: string;
  reason?: string;
}
let deviceCache: { at: number; value: Device } | undefined;

function findDevice(adb: string): Device {
  if (deviceCache && Date.now() - deviceCache.at < 3000) return deviceCache.value;
  let value: Device;
  try {
    const out = execFileSync(adb, ["devices"], { encoding: "utf8", timeout: 8000 });
    const rows = out.split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2);
    const wanted = process.env.MOTIVE_ANDROID_SERIAL;
    const ready = rows.filter((r) => r[1] === "device" && (!wanted || r[0] === wanted));
    if (ready.length === 1) value = { serial: ready[0]![0]! };
    else if (ready.length > 1) value = { reason: "More than one Android device is connected; set MOTIVE_ANDROID_SERIAL" };
    else if (rows.some((r) => r[1] === "unauthorized")) value = { reason: "The Android device has not authorised this computer (accept the USB debugging prompt on the phone)" };
    else value = { reason: "No authorised Android device is connected" };
  } catch {
    value = { reason: "adb did not respond" };
  }
  deviceCache = { at: Date.now(), value };
  return value;
}

const KEYS = { back: "4", home: "3", enter: "66", tab: "61" } as const;
const PKG = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/);

export function androidAdapter(): Adapter {
  const adb = adbPath();
  const device = adb ? findDevice(adb) : { reason: "adb not found (install Android platform-tools or set MOTIVE_ADB)" };
  const reason = !adb ? device.reason : device.reason;
  let disposed = false;
  const live = new Set<AbortController>();

  function run(args: string[], ctx: OpContext, timeoutMs = 20_000): Promise<string> {
    if (disposed) return Promise.reject(new MotiveError("cancelled", "cancelled"));
    if (!adb || !device.serial) return Promise.reject(new MotiveError("unsupported", reason ?? "no device"));
    const own = new AbortController();
    live.add(own);
    const onAbort = () => own.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    return new Promise((resolve, reject) => {
      execFile(adb, ["-s", device.serial!, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, signal: own.signal, windowsHide: true }, (err, stdout) => {
        live.delete(own);
        ctx.signal.removeEventListener("abort", onAbort);
        if (err) {
          if (ctx.signal.aborted || disposed) return reject(new MotiveError("cancelled", "cancelled"));
          return reject(new MotiveError("adapter_failed", `adb ${args[0]} failed: ${String(err.message).split("\n")[0]}`));
        }
        resolve(stdout);
      });
    });
  }

  function packages(ctx: OpContext): string[] {
    if (!ctx.scopes.apps.length) throw new MotiveError("scope_denied", "no Android package is allowed (scopes.apps is empty)");
    return ctx.scopes.apps;
  }

  async function snapshot(ctx: OpContext): Promise<UiNode[]> {
    const pk = packages(ctx);
    const xml = await run(["exec-out", "uiautomator", "dump", "/dev/tty"], ctx);
    return parseDump(xml, pk);
  }

  /** Re-reads the screen until exactly one node matches, the budget ends, or the selector turns out ambiguous. */
  async function resolve(sel: Selector, ctx: OpContext, needEnabled: boolean): Promise<UiNode> {
    const deadline = Date.now() + ctx.budgetMs;
    let last = "no matching element on screen";
    for (;;) {
      if (ctx.signal.aborted) throw new MotiveError("cancelled", "cancelled");
      const hits = (await snapshot(ctx)).filter((n) => matches(n, sel));
      if (hits.length > 1) {
        // Two nodes can describe one control (a clickable row and its label); prefer a single clickable one.
        const clickable = hits.filter((n) => n.clickable);
        if (clickable.length === 1) return needEnabled && !clickable[0]!.enabled ? Promise.reject(new MotiveError("not_actionable", "control is disabled")) : clickable[0]!;
        throw new MotiveError("ambiguous", `${hits.length} elements match; make the selector more specific`);
      }
      if (hits.length === 1) {
        if (!needEnabled || hits[0]!.enabled) return hits[0]!;
        last = "control is disabled";
      }
      if (Date.now() >= deadline) throw new MotiveError("timeout", `${last} (waited ${ctx.budgetMs} ms)`, { retryable: true });
    }
  }

  const center = (n: UiNode) => ({ x: Math.round((n.bounds.left + n.bounds.right) / 2), y: Math.round((n.bounds.top + n.bounds.bottom) / 2) });

  const launch: OpDef = {
    name: "android.launch",
    idempotent: false,
    // fresh: stop the app first so it starts on its home screen instead of resuming where it was left.
    args: z.object({ package: PKG, fresh: z.boolean().default(false) }).strict(),
    async run(a: { package: string; fresh: boolean }, ctx) {
      if (!packages(ctx).includes(a.package)) throw new MotiveError("scope_denied", `${a.package} is not in this workflow's scopes.apps`);
      if (a.fresh) await run(["shell", "am", "force-stop", a.package], ctx);
      await run(["shell", "monkey", "-p", a.package, "-c", "android.intent.category.LAUNCHER", "1"], ctx);
      const deadline = Date.now() + ctx.budgetMs;
      for (;;) {
        const out = await run(["shell", "dumpsys", "activity", "activities"], ctx);
        if (new RegExp(`topResumedActivity=.*\\s${a.package.replace(/\./g, "\\.")}/`).test(out)) return { package: a.package };
        if (Date.now() >= deadline) throw new MotiveError("timeout", `${a.package} did not come to the front`, { retryable: true });
        await new Promise((r) => setTimeout(r, 150));
      }
    },
  };

  const wait: OpDef = {
    name: "android.wait",
    idempotent: true,
    args: z.object({ target: Selector }).strict(),
    async run(a: { target: Selector }, ctx) {
      const n = await resolve(a.target, ctx, false);
      return { found: true, text: n.password ? "" : n.text };
    },
  };

  const click: OpDef = {
    name: "android.click",
    idempotent: false,
    args: z.object({ target: Selector }).strict(),
    async run(a: { target: Selector }, ctx) {
      const n = await resolve(a.target, ctx, true);
      const { x, y } = center(n);
      await run(["shell", "input", "tap", String(x), String(y)], ctx);
      return { clicked: true };
    },
  };

  const read: OpDef = {
    name: "android.read",
    idempotent: true,
    args: z.object({ target: Selector }).strict(),
    async run(a: { target: Selector }, ctx) {
      const n = await resolve(a.target, ctx, false);
      if (n.password) throw new MotiveError("permission_denied", "password fields are never read");
      return { text: n.text || n.contentDesc, checked: n.checked, enabled: n.enabled };
    },
  };

  const setText: OpDef = {
    name: "android.setText",
    idempotent: true,
    args: z.object({ target: Selector, value: z.string().max(500) }).strict(),
    async run(a: { target: Selector; value: string }, ctx) {
      if (!/^[\x20-\x7e]*$/.test(a.value)) throw new MotiveError("unsupported", "only printable ASCII can be typed through adb input");
      const n = await resolve(a.target, ctx, true);
      const { x, y } = center(n);
      await run(["shell", "input", "tap", String(x), String(y)], ctx);
      await run(["shell", "input", "keycombination", "113", "29"], ctx); // select all
      await run(["shell", "input", "keyevent", "67"], ctx); // delete
      if (a.value) await run(["shell", "input", "text", a.value.replace(/ /g, "%s").replace(/([&|;<>()$`\\"'*?\[\]{}~#!^])/g, "\\$1")], ctx);
      return { set: true };
    },
  };

  const key: OpDef = {
    name: "android.key",
    idempotent: false,
    args: z.object({ key: z.enum(["back", "home", "enter", "tab"]) }).strict(),
    async run(a: { key: keyof typeof KEYS }, ctx) {
      packages(ctx); // a workflow with no Android scope cannot press keys either
      await run(["shell", "input", "keyevent", KEYS[a.key]], ctx);
      return { pressed: a.key };
    },
  };

  const tree: OpDef = {
    name: "android.tree",
    idempotent: true,
    args: z.object({}).strict(),
    async run(_a, ctx) {
      const nodes = await snapshot(ctx);
      return { nodes: nodes.filter((n) => n.text || n.contentDesc || n.resourceId).map((n) => ({ text: n.password ? "" : n.text, contentDesc: n.contentDesc, resourceId: n.resourceId, className: n.className, clickable: n.clickable, enabled: n.enabled })) };
    },
  };

  const ops = [launch, wait, click, read, setText, key, tree];
  return {
    id: "android",
    ops,
    capability: () => ({ adapter: "android", available: !reason, ...(reason ? { reason } : {}), ops: ops.map((o) => o.name) }),
    async dispose() {
      disposed = true;
      for (const c of live) c.abort();
    },
  };
}
