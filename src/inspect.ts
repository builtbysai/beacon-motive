import { MotiveError } from "./errors.ts";
import { sidecarPath, WinClient } from "./adapters/windows.ts";

// Read-only look at the Windows accessibility tree for the desktop app's Inspector screen (ADR 0012). It returns what
// the CLI's `motive inspect` returns: control metadata (names, automation ids, types, positions), never field values;
// password controls are flagged and never read. It is explicit (a user action in the app), local, and audited.

const MAX_DEPTH = 6;

async function withClient<T>(fn: (c: WinClient) => Promise<T>): Promise<T> {
  const exe = sidecarPath();
  if (process.platform !== "win32" || !exe) throw new MotiveError("unsupported", "Windows inspection needs Windows and the built helper (npm run build:win)");
  const c = new WinClient(exe);
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

export function inspectWindows(): Promise<unknown> {
  return withClient((c) => c.call("windows.list"));
}

export function inspectTree(window: string, depth: number): Promise<unknown> {
  if (!window || window.length > 200) throw new MotiveError("invalid_args", "window must be a title of 1-200 characters");
  const d = Math.min(Math.max(Math.trunc(depth) || 3, 1), MAX_DEPTH);
  return withClient((c) => c.call("tree", { window: { name: window }, depth: d }));
}
