import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { MotiveError } from "../errors.ts";
import type { UiNode } from "./android.ts";

// Client for the resident on-device helper in apps/android-helper (ADR 0009). The helper is an instrumentation started
// with `adb shell am instrument`; it lives only as long as that command, listens on an abstract local socket, and
// answers only requests that carry this session's token and name the packages the workflow may use.

export const HELPER_PACKAGE = "dev.beacon.motive.helper";
const REQUEST_TIMEOUT_MS = 15_000;

export function helperInstalled(adb: string, serial: string): boolean {
  try {
    return execFileSync(adb, ["-s", serial, "shell", "pm", "path", HELPER_PACKAGE], { encoding: "utf8", timeout: 8000 }).includes("package:");
  } catch {
    return false;
  }
}

interface Reply {
  id?: number;
  ok: boolean;
  error?: string;
  code?: string;
  nodes?: RawNode[];
}
interface RawNode {
  text: string;
  resourceId: string;
  className: string;
  package: string;
  contentDesc: string;
  clickable: boolean;
  enabled: boolean;
  password: boolean;
  checked: boolean;
  editable: boolean;
  bounds: [number, number, number, number];
}
export type HelperNode = UiNode & { editable: boolean };

/** Converts helper nodes, dropping any outside the allowed packages even though the helper already filtered them. */
export function toNodes(raw: RawNode[], allowed: string[]): HelperNode[] {
  return raw
    .filter((n) => allowed.includes(n.package))
    .map((n) => ({
      text: n.text,
      resourceId: n.resourceId,
      className: n.className,
      package: n.package,
      contentDesc: n.contentDesc,
      clickable: n.clickable,
      enabled: n.enabled,
      password: n.password,
      checked: n.checked,
      editable: n.editable,
      bounds: { left: n.bounds[0], top: n.bounds[1], right: n.bounds[2], bottom: n.bounds[3] },
    }));
}

export class HelperClient {
  private child?: ChildProcess;
  private sock?: net.Socket;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private hostPort?: number;
  private closed = false;

  private adb: string;
  private serial: string;

  constructor(adb: string, serial: string) {
    this.adb = adb;
    this.serial = serial;
  }

  private readonly token = randomBytes(24).toString("hex");
  private readonly socketName = `motive-${randomBytes(8).toString("hex")}`;

  async start(signal: AbortSignal): Promise<void> {
    const child = spawn(this.adb, ["-s", this.serial, "shell", "am", "instrument", "-w", "-e", "token", this.token, "-e", "socket", this.socketName, `${HELPER_PACKAGE}/.HelperInstrumentation`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    let out = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new MotiveError("adapter_failed", "the Android helper did not start in time")), 10_000);
      const onData = (d: Buffer) => {
        out += d.toString();
        if (out.includes("status=ready")) {
          clearTimeout(timer);
          resolve();
        } else if (out.includes("INSTRUMENTATION_CODE") || out.includes("shortMsg")) {
          clearTimeout(timer);
          reject(new MotiveError("adapter_failed", `the Android helper failed to start: ${out.trim().split("\n").slice(-2).join(" ").slice(0, 200)}`));
        }
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      child.once("exit", () => reject(new MotiveError("adapter_failed", "the Android helper exited before it was ready")));
      signal.addEventListener("abort", () => reject(new MotiveError("cancelled", "cancelled")), { once: true });
    }).catch(async (e) => {
      await this.close();
      throw e;
    });
    const forwarded = execFileSync(this.adb, ["-s", this.serial, "forward", "tcp:0", `localabstract:${this.socketName}`], { encoding: "utf8", timeout: 8000 }).trim();
    this.hostPort = Number(forwarded);
    if (!Number.isInteger(this.hostPort) || this.hostPort <= 0) {
      await this.close();
      throw new MotiveError("adapter_failed", "adb forward did not return a port");
    }
    this.sock = net.connect(this.hostPort, "127.0.0.1");
    this.sock.setEncoding("utf8");
    this.sock.on("data", (d: string) => this.onData(d));
    this.sock.on("close", () => this.failAll(new MotiveError("adapter_failed", "the Android helper connection closed")));
    this.sock.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      this.sock!.once("connect", resolve);
      this.sock!.once("error", reject);
    }).catch(async () => {
      await this.close();
      throw new MotiveError("adapter_failed", "could not connect to the Android helper");
    });
    await this.call("ping", {});
  }

  private onData(d: string): void {
    this.buf += d;
    for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      let r: Reply;
      try {
        r = JSON.parse(line) as Reply;
      } catch {
        continue;
      }
      const p = r.id !== undefined ? this.pending.get(r.id) : undefined;
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(r.id!);
        p.resolve(r);
      }
    }
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  /** Sends one request; refusals from the helper surface as MotiveErrors with their code. */
  async call(cmd: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Reply> {
    if (this.closed || !this.sock) throw new MotiveError("cancelled", "cancelled");
    if (signal?.aborted) throw new MotiveError("cancelled", "cancelled");
    const id = this.nextId++;
    const reply = await new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MotiveError("timeout", `the Android helper did not answer ${cmd}`, { retryable: true }));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener("abort", () => reject(new MotiveError("cancelled", "cancelled")), { once: true });
      this.sock!.write(JSON.stringify({ token: this.token, id, cmd, ...args }) + "\n");
    });
    if (!reply.ok) {
      const code = reply.code === "scope_denied" ? "scope_denied" : "adapter_failed";
      throw new MotiveError(code, `Android helper: ${reply.error ?? "request failed"}`);
    }
    return reply;
  }

  async tree(packages: string[], signal?: AbortSignal): Promise<HelperNode[]> {
    const r = await this.call("tree", { packages }, signal);
    return toNodes(r.nodes ?? [], packages);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new MotiveError("cancelled", "cancelled"));
    try {
      this.sock?.write(JSON.stringify({ token: this.token, id: 0, cmd: "quit" }) + "\n");
    } catch {
      /* already gone */
    }
    this.sock?.destroy();
    if (this.hostPort) {
      execFile(this.adb, ["-s", this.serial, "forward", "--remove", `tcp:${this.hostPort}`], { windowsHide: true }, () => {});
    }
    const child = this.child;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill();
          resolve();
        }, 1500);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    // If the process was killed, make sure the helper is not left running on the phone.
    execFile(this.adb, ["-s", this.serial, "shell", "am", "force-stop", HELPER_PACKAGE], { windowsHide: true }, () => {});
  }
}
