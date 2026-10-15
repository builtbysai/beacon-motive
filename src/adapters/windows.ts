import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MotiveError, type ErrorCode } from "../errors.ts";
import type { Adapter, OpContext, OpDef } from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

export function sidecarPath(): string | undefined {
  const candidates = [process.env.MOTIVE_WIN_UIA, path.resolve(here, "../../crates/win-uia/target/release/motive-win-uia.exe")];
  return candidates.find((c) => c && existsSync(c));
}

interface Reply {
  id: number;
  ok: boolean;
  result?: any;
  error?: { code: string; message: string };
}

/** Newline-delimited JSON client for the Rust UI Automation sidecar. One request at a time is in flight per call site. */
export class WinClient {
  private child: ChildProcess;
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  calls = 0;

  constructor(exe: string) {
    this.child = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    readline.createInterface({ input: this.child.stdout! }).on("line", (line) => {
      let r: Reply;
      try {
        r = JSON.parse(line);
      } catch {
        return;
      }
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r.result);
      else p.reject(new MotiveError((r.error?.code === "denied" ? "permission_denied" : (r.error?.code as ErrorCode)) ?? "adapter_failed", r.error?.message ?? "sidecar error", { retryable: r.error?.code === "not_found" }));
    });
    this.child.on("exit", () => {
      for (const p of this.pending.values()) p.reject(new MotiveError("adapter_failed", "the Windows automation helper exited"));
      this.pending.clear();
    });
    this.child.stderr!.on("data", () => {});
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.next++;
      this.pending.set(id, { resolve, reject });
      this.calls++;
      this.child.stdin!.write(JSON.stringify({ id, method, params }) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new MotiveError("adapter_failed", "the Windows automation helper is not running"));
        }
      });
    });
  }

  close(): void {
    this.child.stdin?.end();
    this.child.kill();
  }
}

const WindowSel = z
  .object({ name: z.string().optional(), nameContains: z.string().optional(), className: z.string().optional(), processId: z.number().int().optional() })
  .strict()
  .refine((w) => Object.keys(w).length > 0, "window needs a selector");
const TargetSel = z
  .object({ automationId: z.string().optional(), name: z.string().optional(), nameContains: z.string().optional(), controlType: z.string().optional() })
  .strict()
  .refine((t) => Object.keys(t).length > 0, "target needs a selector");

/** Interpreters and shells can run anything their arguments say, so an app allow-list can never include them. */
const INTERPRETERS = new Set(["cmd.exe", "powershell.exe", "pwsh.exe", "wscript.exe", "cscript.exe", "mshta.exe", "wsl.exe", "bash.exe", "sh.exe", "python.exe", "pythonw.exe", "node.exe", "rundll32.exe", "regsvr32.exe", "msiexec.exe"]);

const RETRY_WHILE = new Set<string>(["not_found", "not_actionable"]);

/** Re-resolves until the control exists and is actionable or the step budget runs out. No fixed delays. */
async function settle<T>(ctx: OpContext, fn: () => Promise<T>, retryWhile: Set<string> = RETRY_WHILE): Promise<T> {
  const deadline = Date.now() + ctx.budgetMs;
  let delay = 20;
  for (;;) {
    if (ctx.signal.aborted) throw new MotiveError("cancelled", "cancelled");
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof MotiveError) || !retryWhile.has(e.code) || Date.now() >= deadline) {
        if (e instanceof MotiveError && retryWhile.has(e.code)) throw new MotiveError("timeout", `${e.message} (waited ${ctx.budgetMs} ms)`, { retryable: true, details: { last: e.code } });
        throw e;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 150);
    }
  }
}

export function windowsAdapter(): Adapter {
  const exe = process.platform === "win32" ? sidecarPath() : undefined;
  const reason =
    process.platform !== "win32"
      ? "Windows adapter only runs on Windows"
      : exe
        ? undefined
        : "motive-win-uia.exe is not built (npm run build:win) and MOTIVE_WIN_UIA is not set";
  let client: WinClient | undefined;
  let disposed = false;

  function win(): WinClient {
    if (disposed) throw new MotiveError("cancelled", "cancelled");
    if (!exe) throw new MotiveError("unsupported", reason!);
    return (client ??= new WinClient(exe));
  }

  const launch: OpDef = {
    name: "win.launch",
    idempotent: false,
    args: z.object({ command: z.string(), args: z.array(z.string()).default([]), window: WindowSel }).strict(),
    async run(a: { command: string; args: string[]; window: object }, ctx) {
      const base = path.basename(a.command).toLowerCase();
      if (!ctx.scopes.apps.map((x) => x.toLowerCase()).includes(base)) {
        throw new MotiveError("scope_denied", `${base} is not in this workflow's scopes.apps`);
      }
      if (INTERPRETERS.has(base)) throw new MotiveError("scope_denied", `${base} is a shell or interpreter and can never be launched by a workflow`);
      const c = win();
      const child = spawn(a.command, a.args, { detached: true, stdio: "ignore", shell: false });
      child.on("error", () => {});
      child.unref();
      const found = await settle(ctx, () => c.call("window.find", { window: a.window }));
      return { window: found.name as string, processId: found.processId as number };
    },
  };

  const wait: OpDef = {
    name: "win.wait",
    idempotent: true,
    args: z.object({ window: WindowSel, target: TargetSel.optional() }).strict(),
    async run(a: { window: object; target?: object }, ctx) {
      const c = win();
      await settle(ctx, () => (a.target ? c.call("element.find", a)  : c.call("window.find", a)));
      return { found: true };
    },
  };

  const click: OpDef = {
    name: "win.click",
    async probe(a: { window: object; target: object }) {
      const c = win();
      return c.call("element.find", a).then(() => true, () => false);
    },
    idempotent: false,
    args: z.object({ window: WindowSel, target: TargetSel }).strict(),
    async run(a, ctx) {
      const c = win();
      await settle(ctx, () => c.call("element.invoke", a));
      return { invoked: true };
    },
  };

  const setValue: OpDef = {
    name: "win.setValue",
    async probe(a: { window: object; target: object }) {
      const c = win();
      return c.call("element.find", a).then(() => true, () => false);
    },
    idempotent: true,
    args: z.object({ window: WindowSel, target: TargetSel, value: z.string() }).strict(),
    async run(a, ctx) {
      const c = win();
      await settle(ctx, () => c.call("element.setValue", a));
      return { set: true };
    },
  };

  const read: OpDef = {
    name: "win.read",
    async probe(a: { window: object; target: object }) {
      const c = win();
      return c.call("element.find", a).then(() => true, () => false);
    },
    idempotent: true,
    args: z.object({ window: WindowSel, target: TargetSel }).strict(),
    async run(a, ctx) {
      const c = win();
      const r = await settle(ctx, () => c.call("element.read", a));
      return { text: r.text as string, name: r.name as string, enabled: r.enabled as boolean, toggle: (r.toggle as string | null) ?? "", selected: (r.selected as boolean | null) ?? false };
    },
  };

  const select: OpDef = {
    name: "win.select",
    idempotent: true,
    args: z.object({ window: WindowSel, target: TargetSel, container: TargetSel.optional() }).strict(),
    async run(a, ctx) {
      const c = win();
      await settle(ctx, () => c.call("element.select", a));
      return { selected: true };
    },
  };

  const type: OpDef = {
    name: "win.type",
    idempotent: false,
    args: z.object({ window: WindowSel, target: TargetSel, text: z.string().max(500) }).strict(),
    async run(a, ctx) {
      const c = win();
      const r = await settle(ctx, () => c.call("element.type", a));
      return { typed: r.typed as number };
    },
  };

  const close: OpDef = {
    name: "win.close",
    idempotent: false,
    args: z.object({ window: WindowSel }).strict(),
    async run(a, ctx) {
      const c = win();
      await settle(ctx, () => c.call("window.close", a));
      // Close is a request; wait until the window is really gone so the next step sees the true state.
      const deadline = Date.now() + ctx.budgetMs;
      for (;;) {
        if (ctx.signal.aborted) throw new MotiveError("cancelled", "cancelled");
        const gone = await c.call("window.find", a).then(
          () => false,
          (e: MotiveError) => (e.code === "not_found" ? true : Promise.reject(e)),
        );
        if (gone) return { closed: true };
        if (Date.now() >= deadline) throw new MotiveError("timeout", "the window did not close (it may be asking to save something)", { retryable: false });
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };

  const tree: OpDef = {
    name: "win.tree",
    idempotent: true,
    args: z.object({ window: WindowSel, depth: z.number().int().min(1).max(12).default(4) }).strict(),
    async run(a, ctx) {
      const c = win();
      return { tree: await settle(ctx, () => c.call("tree", a)) };
    },
  };

  const ops = [launch, wait, click, setValue, type, select, read, close, tree];
  return {
    id: "windows",
    ops,
    capability: () => ({ adapter: "windows", available: !reason, ...(reason ? { reason } : {}), ops: ops.map((o) => o.name) }),
    async dispose() {
      disposed = true;
      client?.close();
      client = undefined;
    },
  };
}
