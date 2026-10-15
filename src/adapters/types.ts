import type { ZodType } from "zod";
import type { Workflow } from "../workflow.ts";

export interface OpContext {
  signal: AbortSignal;
  /** Milliseconds left for this step; adapters use it as their own wait budget. */
  budgetMs: number;
  scopes: Workflow["scopes"];
}

export interface OpDef {
  name: string;
  /** Re-running is harmless, so a failing postcondition may poll by repeating it. */
  idempotent: boolean;
  args: ZodType;
  run(args: any, ctx: OpContext): Promise<Record<string, unknown>>;
}

export interface Capability {
  adapter: string;
  available: boolean;
  /** Why it is not available (permissions, platform, missing binary); never silent. */
  reason?: string;
  ops: string[];
}

export interface Adapter {
  id: string;
  ops: OpDef[];
  capability(): Capability;
  /** Release processes, browsers, handles. Must be safe to call more than once and while an op is in flight. */
  dispose(): Promise<void>;
}
