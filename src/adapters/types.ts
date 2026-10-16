import type { ZodType } from "zod";
import type { Workflow } from "../workflow.ts";

export interface OpContext {
  signal: AbortSignal;
  /** Milliseconds left for this step; adapters use it as their own wait budget. */
  budgetMs: number;
  scopes: Workflow["scopes"];
}

/** A control currently on screen, as a selector this op could use plus a short description for a person or a model. */
export interface Candidate {
  selector: Record<string, unknown>;
  describe: string;
}

export interface OpDef {
  name: string;
  /** Re-running is harmless, so a failing postcondition may poll by repeating it. */
  idempotent: boolean;
  args: ZodType;
  run(args: any, ctx: OpContext): Promise<Record<string, unknown>>;
  /** Side-effect-free check that these args would resolve to exactly one target right now. Used to test healing alternatives. */
  probe?(args: any, ctx: OpContext): Promise<boolean>;
  /**
   * What is on screen right now that this op could target. Read-only, never stored. Used only when a run asked for AI
   * recovery and the recorded target no longer resolves, so a local model can pick among real controls.
   */
  candidates?(args: any, ctx: OpContext): Promise<Candidate[]>;
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
