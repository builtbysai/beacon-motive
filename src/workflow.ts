import { z } from "zod";
import { MotiveError } from "./errors.ts";

export const FORMAT = "motive.workflow/1";

const InputDef = z.object({
  type: z.enum(["string", "number", "boolean"]),
  secret: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().optional(),
});

const Condition = z.union([
  z.object({ equals: z.object({ value: z.unknown(), to: z.unknown() }).strict() }).strict(),
  z.object({ contains: z.object({ value: z.unknown(), text: z.unknown() }).strict() }).strict(),
  z.object({ matches: z.object({ value: z.unknown(), pattern: z.string().max(200) }).strict() }).strict(),
]);
export type Condition = z.infer<typeof Condition>;

const Step = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    op: z.string().regex(/^[a-z]+\.[a-zA-Z]+$/),
    args: z.record(z.string(), z.unknown()).default({}),
    timeoutMs: z.number().int().min(100).max(600_000).optional(),
    retry: z
      .object({ max: z.number().int().min(1).max(5), backoffMs: z.number().int().min(0).max(30_000).default(250) })
      .strict()
      .optional(),
    // Step runs only when every condition holds; otherwise it is recorded as skipped. Evaluated against inputs and
    // earlier steps. A later reference to a skipped step's output is an unresolved_reference error, not an empty value.
    when: z.array(Condition).optional(),
    pre: z.array(Condition).optional(),
    // Evaluated against the step's own output as ${out.<field>}. For idempotent ops (reads, waits) a failing
    // postcondition re-runs the step until the timeout instead of failing at once.
    post: z.array(Condition).optional(),
    onError: z.enum(["fail", "continue"]).default("fail"),
    // Other selectors that identified the same control when it was recorded. Used only to propose a repair when
    // args.target stops matching; never applied automatically.
    alternatives: z.array(z.record(z.string(), z.unknown())).max(6).optional(),
  })
  .strict();
export type Step = z.infer<typeof Step>;

export const WorkflowSchema = z
  .object({
    format: z.literal(FORMAT),
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    description: z.string().max(500).optional(),
    inputs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), InputDef).default({}),
    // Deny by default: what the workflow may touch. Checked by adapters, not by the workflow's own steps.
    scopes: z
      .object({
        hosts: z.array(z.string()).default([]),
        dirs: z.array(z.string()).default([]),
        apps: z.array(z.string()).default([]),
      })
      .strict()
      .default({ hosts: [], dirs: [], apps: [] }),
    deadlineMs: z.number().int().min(1000).max(3_600_000).default(120_000),
    steps: z.array(Step).min(1).max(500),
    outputs: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((w, ctx) => {
    const seen = new Set<string>();
    for (const [i, s] of w.steps.entries()) {
      if (seen.has(s.id)) ctx.addIssue({ code: "custom", message: `duplicate step id ${s.id}`, path: ["steps", i, "id"] });
      seen.add(s.id);
    }
  });
export type Workflow = z.infer<typeof WorkflowSchema>;

export function parseWorkflow(raw: unknown): Workflow {
  const r = WorkflowSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new MotiveError("invalid_workflow", `${issue?.path.join(".") || "workflow"}: ${issue?.message}`, {
      details: { issues: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }
  return r.data;
}

// ---- interpolation -------------------------------------------------------------------------------------------

export interface Scope {
  inputs: Record<string, unknown>;
  steps: Record<string, Record<string, unknown>>;
  out?: Record<string, unknown>;
}

const REF = /\$\{([^}]+)\}/g;
const WHOLE = /^\$\{([^}]+)\}$/;

function lookup(path: string, scope: Scope): unknown {
  const parts = path.trim().split(".");
  let cur: unknown = scope;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, p)) {
      throw new MotiveError("unresolved_reference", `\${${path}} does not exist`, { details: { reference: path } });
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function interpolate(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    if (whole) return lookup(whole[1]!, scope);
    return value.replace(REF, (_m, p: string) => String(lookup(p, scope)));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, scope));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, scope)]));
  }
  return value;
}

export function evaluate(cond: Condition, scope: Scope): { ok: boolean; why: string } {
  if ("equals" in cond) {
    const a = interpolate(cond.equals.value, scope);
    const b = interpolate(cond.equals.to, scope);
    return { ok: Object.is(a, b) || String(a) === String(b), why: `expected ${JSON.stringify(a)} to equal ${JSON.stringify(b)}` };
  }
  if ("contains" in cond) {
    const a = String(interpolate(cond.contains.value, scope));
    const b = String(interpolate(cond.contains.text, scope));
    return { ok: a.includes(b), why: `expected ${JSON.stringify(a)} to contain ${JSON.stringify(b)}` };
  }
  const a = String(interpolate(cond.matches.value, scope));
  return { ok: new RegExp(cond.matches.pattern).test(a), why: `expected ${JSON.stringify(a)} to match /${cond.matches.pattern}/` };
}
