import { EventEmitter } from "node:events";
import type { ModelProvider } from "./ai/provider.ts";
import { suggestTarget } from "./ai/recovery.ts";
import { z } from "zod";
import type { Adapter, Capability, OpDef } from "./adapters/types.ts";
import { browserAdapter } from "./adapters/browser.ts";
import { coreAdapter } from "./adapters/core.ts";
import { fsAdapter } from "./adapters/fs.ts";
import { windowsAdapter } from "./adapters/windows.ts";
import { androidAdapter } from "./adapters/android.ts";
import { MotiveError, toErrorInfo, type ErrorInfo } from "./errors.ts";
import type { RunRecord, StepRecord, Store } from "./store.ts";
import { evaluate, interpolate, loopItems, type Condition, type Scope, type Step, type Workflow } from "./workflow.ts";

export type AdapterFactory = () => Adapter;
export const defaultAdapters: AdapterFactory[] = [coreAdapter, fsAdapter, browserAdapter, windowsAdapter, androidAdapter];

export interface RunEvent {
  type: "run.start" | "step.start" | "step.end" | "run.end";
  runId: string;
  step?: StepRecord | { stepId: string; op: string };
  run?: RunRecord;
}

export interface ActiveRun {
  id: string;
  done: Promise<RunRecord>;
  cancel(reason?: string): void;
}

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
const CALL_OP = "flow.call";
const MAX_CALL_DEPTH = 3;
const CallArgs = z.object({ workflow: z.string().min(1), inputs: z.record(z.string(), z.unknown()).default({}) }).strict();

interface SeqCtx {
  ops: Map<string, { op: OpDef; adapter: Adapter }>;
  record: RunRecord;
  signal: AbortSignal;
  redact: Redactor;
  /** Set only when the caller asked for AI recovery for this run. */
  ai?: ModelProvider;
  prefix: string;
  depth: number;
  chain: string[];
}

/** A subflow may only touch what its caller may touch. */
function requireScopeSubset(parent: Workflow, child: Workflow, stepId: string): void {
  for (const kind of ["hosts", "dirs", "apps"] as const) {
    const extra = child.scopes[kind].filter((x) => !parent.scopes[kind].includes(x));
    if (extra.length) throw new MotiveError("scope_denied", `step ${stepId}: subflow ${child.name} wants ${kind} the caller does not have: ${extra.join(", ")}`);
  }
}


export class Engine {
  store: Store;
  events = new EventEmitter();
  private factories: AdapterFactory[];
  private active = new Map<string, ActiveRun>();
  maxConcurrentRuns: number;

  constructor(store: Store, opts: { adapters?: AdapterFactory[]; maxConcurrentRuns?: number } = {}) {
    this.store = store;
    this.factories = opts.adapters ?? defaultAdapters;
    this.maxConcurrentRuns = opts.maxConcurrentRuns ?? 1;
  }

  async capabilities(): Promise<Capability[]> {
    const adapters = this.factories.map((f) => f());
    const caps = adapters.map((a) => a.capability());
    await Promise.all(adapters.map((a) => a.dispose()));
    return caps;
  }

  activeRuns(): string[] {
    return [...this.active.keys()];
  }

  stopRun(id: string, reason: string): boolean {
    const r = this.active.get(id);
    r?.cancel(reason);
    return Boolean(r);
  }

  /** Emergency stop: cancels every active run. */
  stopAll(reason = "emergency stop"): number {
    const runs = [...this.active.values()];
    for (const r of runs) r.cancel(reason);
    return runs.length;
  }

  start(workflow: Workflow, rawInputs: Record<string, unknown> = {}, opts: { actor?: string; ai?: ModelProvider } = {}): ActiveRun {
    const actor = opts.actor ?? "cli";
    if (this.active.size >= this.maxConcurrentRuns) {
      throw new MotiveError("precondition_failed", `${this.active.size} run(s) already active (limit ${this.maxConcurrentRuns})`, { retryable: true });
    }
    const { inputs, secrets } = resolveInputs(workflow, rawInputs);
    const redact = makeRedactor(secrets);
    const record = this.store.createRun(workflow.name, redactInputs(workflow, inputs));
    this.store.audit(actor, "run.start", { run: record.id, workflow: workflow.name });

    const controller = new AbortController();
    const adapters = this.factories.map((f) => f());
    const run: ActiveRun = {
      id: record.id,
      cancel: (reason = "cancelled") => {
        this.store.audit(actor, "run.cancel", { run: record.id, reason });
        controller.abort(new MotiveError("cancelled", reason));
      },
      done: undefined as unknown as Promise<RunRecord>,
    };
    this.active.set(record.id, run);
    run.done = this.execute(workflow, inputs, redact, record, adapters, controller, opts.ai).finally(() => this.active.delete(record.id));
    return run;
  }

  private emit(e: RunEvent): void {
    this.events.emit("event", e);
    this.events.emit(`run:${e.runId}`, e);
  }

  private async execute(w: Workflow, inputs: Record<string, unknown>, redact: Redactor, record: RunRecord, adapters: Adapter[], controller: AbortController, ai?: ModelProvider): Promise<RunRecord> {
    const t0 = performance.now();
    const signal = controller.signal;
    const ops = new Map<string, { op: OpDef; adapter: Adapter }>();
    for (const a of adapters) for (const op of a.ops) ops.set(op.name, { op, adapter: a });
    const scope: Scope = { inputs, steps: {} };
    let failure: ErrorInfo | undefined;
    let cancelled = false;

    // The deadline aborts the run like a cancel would.
    const deadline = setTimeout(() => controller.abort(new MotiveError("timeout", `workflow deadline of ${w.deadlineMs} ms exceeded`)), w.deadlineMs);
    this.emit({ type: "run.start", runId: record.id });

    try {
      // Fail before any side effect if the workflow (or a subflow it names) cannot run here at all.
      this.preflight(w, ops, new Set([w.name]), 0);
      const ctx: SeqCtx = { ops, record, signal, redact, ...(ai ? { ai } : {}), prefix: "", depth: 0, chain: [w.name] };
      failure = await this.runSequence(w, w.steps, scope, ctx);

      if (!failure) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(w.outputs)) out[k] = interpolate(v, scope);
        record.outputs = redact.value(out) as Record<string, unknown>;
      }
    } catch (e) {
      failure = toErrorInfo(e);
    } finally {
      clearTimeout(deadline);
      await Promise.all(adapters.map((a) => a.dispose().catch(() => {})));
    }

    if (failure) {
      failure = redact.value(failure);
      cancelled = failure.code === "cancelled";
      record.error = failure;
    }
    record.status = failure ? (cancelled ? "cancelled" : "failed") : "succeeded";
    record.endedAt = new Date().toISOString();
    record.durationMs = Math.round(performance.now() - t0);
    this.store.finishRun(record);
    this.emit({ type: "run.end", runId: record.id, run: record });
    return record;
  }

  /** Refuses, before anything runs, a workflow whose ops or (literally named) subflows cannot run here. */
  private preflight(w: Workflow, ops: Map<string, { op: OpDef; adapter: Adapter }>, chain: Set<string>, depth: number): void {
    for (const s of w.steps) {
      if (s.op === CALL_OP) {
        const name = (s.args as { workflow?: unknown }).workflow;
        if (typeof name !== "string" || name.includes("${")) continue; // named at run time; checked then
        if (chain.has(name)) throw new MotiveError("invalid_workflow", `step ${s.id}: workflow ${name} would call itself (${[...chain, name].join(" > ")})`);
        if (depth + 1 > MAX_CALL_DEPTH) throw new MotiveError("invalid_workflow", `step ${s.id}: subflows nest more than ${MAX_CALL_DEPTH} deep`);
        const child = this.store.getWorkflow(name);
        if (!child) throw new MotiveError("not_found", `step ${s.id}: no stored workflow named ${name}`);
        requireScopeSubset(w, child, s.id);
        this.preflight(child, ops, new Set([...chain, name]), depth + 1);
        continue;
      }
      const found = ops.get(s.op);
      if (!found) throw new MotiveError("unknown_op", `step ${s.id}: unknown operation ${s.op}`);
      const cap = found.adapter.capability();
      if (!cap.available) throw new MotiveError("unsupported", `step ${s.id}: ${s.op} is unavailable: ${cap.reason}`);
    }
  }

  /** Runs steps in order; returns the failure that stopped them, if any. Used for the workflow and for each subflow. */
  private async runSequence(w: Workflow, steps: Step[], scope: Scope, ctx: SeqCtx): Promise<ErrorInfo | undefined> {
    const { record, signal } = ctx;
    const finish = (sr: StepRecord) => {
      sr.index = record.steps.length;
      sr.stepId = ctx.prefix + sr.stepId;
      this.store.addStep(record.id, sr);
      record.steps.push(sr);
      this.emit({ type: "step.end", runId: record.id, step: sr });
    };
    const one = (st: Step, sc: Scope): Promise<StepRecord> =>
      st.op === CALL_OP ? this.runCall(w, st, sc, ctx) : this.runStep(w, st, 0, ctx.ops.get(st.op)!.op, sc, signal, ctx.redact, ctx.ai);

    for (const step of steps) {
      if (signal.aborted) throw abortReason(signal);
      this.emit({ type: "step.start", runId: record.id, step: { stepId: ctx.prefix + step.id, op: step.op } });
      const skip = step.when?.length ? whenSkipReason(step.when, scope) : undefined;
      if (skip) {
        finish({ index: 0, stepId: step.id, op: step.op, status: "skipped", durationMs: 0, attempts: 0, output: { reason: skip } });
        continue;
      }
      if (!step.forEach) {
        const sr = await one(step, scope);
        finish(sr);
        if (sr.status === "failed" && step.onError === "fail") return sr.error!;
        continue;
      }
      // One record per iteration (id "step[i]"); the step's own id then holds {count, results} for later steps.
      const items = loopItems(step.forEach, scope);
      const results: unknown[] = [];
      let failure: ErrorInfo | undefined;
      for (const [i, item] of items.entries()) {
        if (signal.aborted) throw abortReason(signal);
        const sr = await one({ ...step, id: `${step.id}[${i}]` }, { ...scope, loop: { item, index: i } });
        finish(sr);
        results.push(sr.status === "succeeded" ? sr.output : { error: sr.error?.message });
        if (sr.status === "failed" && step.onError === "fail") {
          failure = sr.error!;
          break;
        }
      }
      scope.steps[step.id] = { count: items.length, results };
      if (failure) return failure;
    }
    return undefined;
  }

  /**
   * flow.call: runs a stored workflow inline with its own inputs and steps (records are named "call/step"). It shares the
   * run cancellation, deadline, adapters and redaction. A subflow may only touch what its caller may touch, and secret
   * inputs must be handed over explicitly (a subflow never reads secrets from the environment on its own).
   */
  private async runCall(w: Workflow, step: Step, scope: Scope, ctx: SeqCtx): Promise<StepRecord> {
    const t0 = performance.now();
    const base = { index: 0, stepId: step.id, op: step.op };
    try {
      const parsed = CallArgs.safeParse(interpolate(step.args, scope));
      if (!parsed.success) throw new MotiveError("invalid_args", `step ${step.id}: ${parsed.error.issues[0]?.path.join(".") || "args"}: ${parsed.error.issues[0]?.message}`);
      const { workflow: name, inputs: given } = parsed.data;
      if (ctx.depth >= MAX_CALL_DEPTH) throw new MotiveError("invalid_args", `step ${step.id}: subflows nest more than ${MAX_CALL_DEPTH} deep`);
      if (ctx.chain.includes(name)) throw new MotiveError("invalid_args", `step ${step.id}: workflow ${name} would call itself`);
      const child = this.store.getWorkflow(name);
      if (!child) throw new MotiveError("not_found", `step ${step.id}: no stored workflow named ${name}`);
      requireScopeSubset(w, child, step.id);
      for (const [k, def] of Object.entries(child.inputs)) {
        if (def.secret && !(k in given)) throw new MotiveError("invalid_args", `step ${step.id}: secret input ${k} of ${name} must be passed explicitly`);
      }
      const { inputs } = resolveInputs(child, given);
      const childScope: Scope = { inputs, steps: {} };
      const failure = await this.runSequence(child, child.steps, childScope, { ...ctx, prefix: `${ctx.prefix}${step.id}/`, depth: ctx.depth + 1, chain: [...ctx.chain, name] });
      if (failure) throw new MotiveError(failure.code, `subflow ${name}: ${failure.message}`, { retryable: failure.retryable });
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(child.outputs)) out[k] = interpolate(v, childScope);
      scope.steps[step.id] = out;
      return { ...base, status: "succeeded", durationMs: Math.round(performance.now() - t0), attempts: 1, output: ctx.redact.value(out) };
    } catch (e) {
      const info = toErrorInfo(ctx.signal.aborted ? abortReason(ctx.signal) : e);
      scope.steps[step.id] = { error: info.message };
      return { ...base, status: "failed", durationMs: Math.round(performance.now() - t0), attempts: 1, error: ctx.redact.value(info) };
    }
  }

  private async runStep(w: Workflow, step: Step, index: number, op: OpDef, scope: Scope, signal: AbortSignal, redact: Redactor, ai?: ModelProvider): Promise<StepRecord> {
    const t0 = performance.now();
    let attempts = 0;
    const base = { index, stepId: step.id, op: step.op };
    let parsedArgs: Record<string, unknown> | undefined;
    try {
      this.check(step.pre, scope, "precondition_failed", step.id);
      const args = interpolate(step.args, scope);
      const parsed = op.args.safeParse(args);
      if (!parsed.success) {
        const i = parsed.error.issues[0];
        throw new MotiveError("invalid_args", `step ${step.id}: ${i?.path.join(".") || "args"}: ${i?.message}`);
      }
      parsedArgs = parsed.data as Record<string, unknown>;
      const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
      const stepDeadline = Date.now() + timeoutMs;
      const maxAttempts = step.retry?.max ?? 1;
      let output: Record<string, unknown> | undefined;

      for (;;) {
        attempts++;
        try {
          output = await this.attempt(op, parsed.data, w, step, scope, signal, stepDeadline);
          break;
        } catch (e) {
          const info = toErrorInfo(e);
          if (signal.aborted || info.code === "cancelled" || attempts >= maxAttempts || !(info.retryable || step.retry)) throw e;
          if (info.code === "scope_denied" || info.code === "invalid_args" || info.code === "unsupported") throw e;
          await sleep(step.retry?.backoffMs ?? 250, signal);
        }
      }
      scope.steps[step.id] = output!;
      return { ...base, status: "succeeded", durationMs: Math.round(performance.now() - t0), attempts, output: redact.value(output) };
    } catch (e) {
      let info = toErrorInfo(signal.aborted ? abortReason(signal) : e);
      if (!signal.aborted && parsedArgs) info = await this.withProposals(info, op, step, parsedArgs, w, signal, ai);
      scope.steps[step.id] = { error: info.message };
      return { ...base, status: "failed", durationMs: Math.round(performance.now() - t0), attempts, error: redact.value(info) };
    }
  }

  /**
   * When a recorded target no longer resolves, tests the alternatives captured at record time and attaches those that
   * resolve to exactly one control as proposals. Nothing is changed or retried: the run still fails and the user decides.
   */
  private async withProposals(info: ErrorInfo, op: OpDef, step: Step, args: Record<string, unknown>, w: Workflow, signal: AbortSignal, ai?: ModelProvider): Promise<ErrorInfo> {
    if (!["not_found", "ambiguous", "timeout"].includes(info.code) || !op.probe || !("target" in args)) return info;
    const proposals: { target: unknown; source?: string; reason?: string }[] = [];
    for (const alt of step.alternatives ?? []) {
      if (signal.aborted) break;
      const candidate = op.args.safeParse({ ...args, target: alt });
      if (!candidate.success) continue;
      const ok = await op.probe(candidate.data, { signal, budgetMs: 1500, scopes: w.scopes }).catch(() => false);
      if (ok) proposals.push({ target: alt });
    }
    // No recorded alternative works: if this run opted in, ask the local model to choose among the controls really on
    // screen. Its choice is only a proposal, and only if it resolves to exactly one control.
    if (!proposals.length && ai && op.candidates && !signal.aborted) {
      try {
        const ctx = { signal, budgetMs: 3000, scopes: w.scopes };
        const candidates = await op.candidates(args, ctx);
        const pick = await suggestTarget(ai, { stepId: step.id, op: step.op, ...(w.description ? { description: w.description } : {}), original: args.target, candidates }, signal);
        if (pick) {
          const candidate = op.args.safeParse({ ...args, target: pick.candidate.selector });
          if (candidate.success && (await op.probe(candidate.data, ctx).catch(() => false))) {
            proposals.push({ target: pick.candidate.selector, source: `local model ${ai.model}`, reason: pick.reason });
          }
        }
      } catch {
        // the model or the screen read failed: no suggestion, the run fails as it would without AI
      }
    }
    return proposals.length ? { ...info, details: { ...info.details, proposals } } : info;
  }

  /** One attempt: run the op, then check postconditions, polling idempotent ops until the step deadline. */
  private async attempt(op: OpDef, args: unknown, w: Workflow, step: Step, scope: Scope, signal: AbortSignal, stepDeadline: number): Promise<Record<string, unknown>> {
    for (;;) {
      const budgetMs = Math.max(100, stepDeadline - Date.now());
      const output = await withDeadline(op.run(args, { signal, budgetMs, scopes: w.scopes }), signal, budgetMs + 2000, step.id);
      if (!step.post?.length) return output;
      const failed = firstFailure(step.post, { ...scope, out: output });
      if (!failed) return output;
      if (!op.idempotent || Date.now() + POLL_MS >= stepDeadline) {
        throw new MotiveError("postcondition_failed", `step ${step.id}: ${failed}`, { details: { output } });
      }
      await sleep(POLL_MS, signal);
    }
  }

  private check(conds: Condition[] | undefined, scope: Scope, code: "precondition_failed", stepId: string): void {
    const failed = conds && firstFailure(conds, scope);
    if (failed) throw new MotiveError(code, `step ${stepId}: ${failed}`);
  }
}

function firstFailure(conds: Condition[], scope: Scope): string | undefined {
  for (const c of conds) {
    const r = evaluate(c, scope);
    if (!r.ok) return r.why;
  }
  return undefined;
}

/** Returns why a `when` guard is false, or undefined when the step should run. A broken reference fails the run. */
function whenSkipReason(conds: Condition[], scope: Scope): string | undefined {
  return firstFailure(conds, scope);
}

function abortReason(signal: AbortSignal): MotiveError {
  return signal.reason instanceof MotiveError ? signal.reason : new MotiveError("cancelled", "cancelled");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(abortReason(signal));
      },
      { once: true },
    );
  });
}

/** Races the op against cancellation and a hard ceiling, so a stuck adapter cannot hold a run. */
function withDeadline<T>(p: Promise<T>, signal: AbortSignal, ms: number, stepId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const timer = setTimeout(() => reject(new MotiveError("timeout", `step ${stepId} did not finish in ${ms} ms`, { retryable: true })), ms);
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

// ---- inputs and secrets --------------------------------------------------------------------------------------

export function resolveInputs(w: Workflow, raw: Record<string, unknown>): { inputs: Record<string, unknown>; secrets: string[] } {
  const inputs: Record<string, unknown> = {};
  const secrets: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!(key in w.inputs)) throw new MotiveError("invalid_args", `unknown input ${key}`);
  }
  for (const [name, def] of Object.entries(w.inputs)) {
    let v: unknown = raw[name];
    if (v === undefined && def.secret) v = process.env[`MOTIVE_SECRET_${name.toUpperCase()}`];
    if (v === undefined) v = def.default;
    if (v === undefined) throw new MotiveError("invalid_args", `input ${name} is required${def.secret ? ` (set MOTIVE_SECRET_${name.toUpperCase()})` : ""}`);
    if (def.type === "number") {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) throw new MotiveError("invalid_args", `input ${name} must be a number`);
      v = n;
    } else if (def.type === "boolean") {
      if (v === "true") v = true;
      else if (v === "false") v = false;
      if (typeof v !== "boolean") throw new MotiveError("invalid_args", `input ${name} must be true or false`);
    } else {
      v = String(v);
    }
    inputs[name] = v;
    if (def.secret && String(v).length > 0) secrets.push(String(v));
  }
  return { inputs, secrets };
}

function redactInputs(w: Workflow, inputs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, w.inputs[k]?.secret ? "***" : v]));
}

export interface Redactor {
  text(s: string): string;
  value<T>(v: T): T;
}

export function makeRedactor(secrets: string[]): Redactor {
  const list = secrets.filter(Boolean).sort((a, b) => b.length - a.length);
  const text = (s: string) => list.reduce((acc, sec) => acc.split(sec).join("***"), s);
  return {
    text,
    value: <T>(v: T): T => (list.length === 0 || v === undefined ? v : (JSON.parse(text(JSON.stringify(v))) as T)),
  };
}
