import { z } from "zod";
import { MotiveError } from "../errors.ts";
import type { Adapter, OpDef } from "./types.ts";

const sleep: OpDef = {
  name: "core.sleep",
  idempotent: true,
  args: z.object({ ms: z.number().int().min(0).max(60_000) }).strict(),
  async run(a: { ms: number }, ctx) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, a.ms);
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new MotiveError("cancelled", "cancelled"));
      });
    });
    return { slept: a.ms };
  },
};

/** Carries a value forward under a name; conditions on the step then act as assertions. */
const set: OpDef = {
  name: "core.set",
  idempotent: true,
  args: z.object({ value: z.unknown() }).strict(),
  run: async (a: { value: unknown }) => ({ value: a.value }),
};

export function coreAdapter(): Adapter {
  return {
    id: "core",
    ops: [sleep, set],
    capability: () => ({ adapter: "core", available: true, ops: ["core.sleep", "core.set"] }),
    dispose: async () => {},
  };
}
