import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MotiveError } from "../errors.ts";
import type { Adapter, OpContext, OpDef } from "./types.ts";

const MAX_BYTES = 5_000_000;

/** A path is allowed only if it resolves (after symlinks) inside a directory the workflow declared. */
export async function checkDir(target: string, ctx: OpContext, mustExist: boolean): Promise<string> {
  const abs = path.resolve(target);
  const real = mustExist ? await realpath(abs).catch(() => abs) : path.join(await realpath(path.dirname(abs)).catch(() => path.dirname(abs)), path.basename(abs));
  for (const d of ctx.scopes.dirs) {
    const root = await realpath(path.resolve(d)).catch(() => path.resolve(d));
    const rel = path.relative(root, real);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return real;
  }
  throw new MotiveError("scope_denied", `${target} is outside the directories this workflow declared (scopes.dirs)`);
}

const writeOp: OpDef = {
  name: "fs.write",
  idempotent: false,
  args: z.object({ path: z.string(), content: z.string(), append: z.boolean().default(false) }).strict(),
  async run(a: { path: string; content: string; append: boolean }, ctx) {
    if (Buffer.byteLength(a.content) > MAX_BYTES) throw new MotiveError("invalid_args", "content too large");
    const p = await checkDir(a.path, ctx, false);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, a.content, { flag: a.append ? "a" : "w" });
    return { path: p, bytes: Buffer.byteLength(a.content) };
  },
};

const readOp: OpDef = {
  name: "fs.read",
  idempotent: true,
  args: z.object({ path: z.string() }).strict(),
  async run(a: { path: string }, ctx) {
    const p = await checkDir(a.path, ctx, true);
    const buf = await readFile(p).catch(() => {
      throw new MotiveError("not_found", `cannot read ${a.path}`);
    });
    if (buf.length > MAX_BYTES) throw new MotiveError("invalid_args", "file too large");
    return { path: p, text: buf.toString("utf8"), bytes: buf.length };
  },
};

export function fsAdapter(): Adapter {
  return {
    id: "fs",
    ops: [writeOp, readOp],
    capability: () => ({ adapter: "fs", available: true, ops: ["fs.write", "fs.read"] }),
    dispose: async () => {},
  };
}
