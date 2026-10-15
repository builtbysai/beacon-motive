import { MotiveError } from "./errors.ts";
import type { RunRecord } from "./store.ts";
import { parseWorkflow, type Workflow } from "./workflow.ts";

export interface StepProposals {
  stepId: string;
  op: string;
  problem: string;
  targets: Record<string, unknown>[];
}

/** Repairs the engine proposed during a run: alternatives that resolved to exactly one control after the recorded target failed. */
export function proposalsFor(run: RunRecord): StepProposals[] {
  const out: StepProposals[] = [];
  for (const s of run.steps) {
    const p = (s.error?.details as { proposals?: { target: Record<string, unknown> }[] } | undefined)?.proposals;
    if (s.status === "failed" && p?.length) out.push({ stepId: s.stepId, op: s.op, problem: s.error!.message, targets: p.map((x) => x.target) });
  }
  return out;
}

/** Returns a copy of the workflow with the chosen proposal as the step's target; the replaced target is kept as an alternative. */
export function applyProposal(w: Workflow, stepId: string, targetIndex: number, proposals: StepProposals[]): Workflow {
  const prop = proposals.find((p) => p.stepId === stepId);
  const chosen = prop?.targets[targetIndex];
  if (!prop || !chosen) throw new MotiveError("not_found", `no proposal ${targetIndex} for step ${stepId}`);
  const copy = structuredClone(w);
  const step = copy.steps.find((s) => s.id === stepId);
  if (!step || !step.args.target) throw new MotiveError("not_found", `step ${stepId} has no target in this workflow`);
  const old = step.args.target as Record<string, unknown>;
  step.args.target = chosen;
  step.alternatives = [...(step.alternatives ?? []).filter((a) => JSON.stringify(a) !== JSON.stringify(chosen)), old].slice(-6);
  return parseWorkflow(copy);
}
