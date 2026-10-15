import { EventEmitter } from "node:events";
import type { Adapter, Capability, OpDef } from "./adapters/types.ts";
import { browserAdapter } from "./adapters/browser.ts";
import { coreAdapter } from "./adapters/core.ts";
import { fsAdapter } from "./adapters/fs.ts";
import { windowsAdapter } from "./adapters/windows.ts";
import { androidAdapter } from "./adapters/android.ts";
import { MotiveError, toErrorInfo, type ErrorInfo } from "./errors.ts";
import type { RunRecord, StepRecord, Store } from "./store.ts";
import { evaluate, interpolate, type Condition, type Scope, type Step, type Workflow } from "./workflow.ts";

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

  start(workflow: Workflow, rawInputs: Record<string, unknown> = {}, opts: { actor?: string } = {}): ActiveRun {
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
    run.done = this.execute(workflow, inputs, redact, record, adapters, controller).finally(() => this.active.delete(record.id));
    return run;
  }

  private emit(e: RunEvent): void {
    this.events.emit("event", e);
    this.events.emit(`run:${e.runId}`, e);
  }

  private async execute(w: Workflow, inputs: Record<string, unknown>, redact: Redactor, record: RunRecord, adapters: Adapter[], controller: AbortController): Promise<RunRecord> {
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
      // Fail before any side effect if the workflow cannot run here at all.
      for (const s of w.steps) {
        const found = ops.get(s.op);
        if (!found) throw new MotiveError("unknown_op", `step ${s.id}: unknown operation ${s.op}`);
        const cap = found.adapter.capability();
        if (!cap.available) throw new MotiveError("unsupported", `step ${s.id}: ${s.op} is unavailable: ${cap.reason}`);
      }

      for (const [index, step] of w.steps.entries()) {
        if (signal.aborted) throw abortReason(signal);
        const { op } = ops.get(step.op)!;
        this.emit({ type: "step.start", runId: record.id, step: { stepId: step.id, op: step.op } });
        const sr = await this.runStep(w, step, index, op, scope, signal, redact);
        this.store.addStep(record.id, sr);
        record.steps.push(sr);
        this.emit({ type: "step.end", runId: record.id, step: sr });
        if (sr.status === "failed") {
          if (step.onError === "fail") {
            failure = sr.error!;
            break;
          }
        }
      }

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

  private async runStep(w: Workflow, step: Step, index: number, op: OpDef, scope: Scope, signal: AbortSignal, redact: Redactor): Promise<StepRecord> {
    const t0 = performance.now();
    let attempts = 0;
    const base = { index, stepId: step.id, op: step.op };
    try {
      this.check(step.pre, scope, "precondition_failed", step.id);
      const args = interpolate(step.args, scope);
      const parsed = op.args.safeParse(args);
      if (!parsed.success) {
        const i = parsed.error.issues[0];
        throw new MotiveError("invalid_args", `step ${step.id}: ${i?.path.join(".") || "args"}: ${i?.message}`);
      }
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
      const info = toErrorInfo(signal.aborted ? abortReason(signal) : e);
      scope.steps[step.id] = { error: info.message };
      return { ...base, status: "failed", durationMs: Math.round(performance.now() - t0), attempts, error: redact.value(info) };
    }
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
