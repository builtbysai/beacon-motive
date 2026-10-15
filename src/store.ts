import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ErrorInfo } from "./errors.ts";
import { parseWorkflow, type Workflow } from "./workflow.ts";

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type StepStatus = "succeeded" | "failed" | "skipped";

export interface StepRecord {
  index: number;
  stepId: string;
  op: string;
  status: StepStatus;
  durationMs: number;
  attempts: number;
  output?: unknown;
  error?: ErrorInfo;
}

export interface RunRecord {
  id: string;
  workflow: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: ErrorInfo;
  steps: StepRecord[];
}

const SCHEMA = `
create table if not exists workflows (name text primary key, body text not null, updated_at text not null);
create table if not exists runs (
  id text primary key, workflow text not null, status text not null, started_at text not null, ended_at text,
  duration_ms integer, inputs text not null, outputs text, error text);
create table if not exists run_steps (
  run_id text not null references runs(id) on delete cascade, idx integer not null, step_id text not null, op text not null,
  status text not null, duration_ms integer not null, attempts integer not null, output text, error text,
  primary key (run_id, idx));
create table if not exists audit (id integer primary key autoincrement, ts text not null, actor text not null, action text not null, detail text);
`;

export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
    this.db.exec(SCHEMA);
  }

  saveWorkflow(w: Workflow): void {
    this.db
      .prepare("insert into workflows(name, body, updated_at) values(?,?,?) on conflict(name) do update set body=excluded.body, updated_at=excluded.updated_at")
      .run(w.name, JSON.stringify(w), new Date().toISOString());
  }
  getWorkflow(name: string): Workflow | undefined {
    const row = this.db.prepare("select body from workflows where name=?").get(name) as { body: string } | undefined;
    return row ? parseWorkflow(JSON.parse(row.body)) : undefined;
  }
  listWorkflows(): { name: string; updatedAt: string }[] {
    return (this.db.prepare("select name, updated_at from workflows order by name").all() as { name: string; updated_at: string }[]).map((r) => ({
      name: r.name,
      updatedAt: r.updated_at,
    }));
  }
  deleteWorkflow(name: string): boolean {
    return Number(this.db.prepare("delete from workflows where name=?").run(name).changes) > 0;
  }

  createRun(workflow: string, inputs: Record<string, unknown>): RunRecord {
    const run: RunRecord = { id: randomUUID(), workflow, status: "running", startedAt: new Date().toISOString(), inputs, steps: [] };
    this.db.prepare("insert into runs(id, workflow, status, started_at, inputs) values(?,?,?,?,?)").run(run.id, workflow, run.status, run.startedAt, JSON.stringify(inputs));
    return run;
  }
  addStep(runId: string, s: StepRecord): void {
    this.db
      .prepare("insert into run_steps(run_id, idx, step_id, op, status, duration_ms, attempts, output, error) values(?,?,?,?,?,?,?,?,?)")
      .run(runId, s.index, s.stepId, s.op, s.status, s.durationMs, s.attempts, s.output === undefined ? null : JSON.stringify(s.output), s.error ? JSON.stringify(s.error) : null);
  }
  finishRun(run: RunRecord): void {
    this.db
      .prepare("update runs set status=?, ended_at=?, duration_ms=?, outputs=?, error=? where id=?")
      .run(run.status, run.endedAt!, run.durationMs!, run.outputs ? JSON.stringify(run.outputs) : null, run.error ? JSON.stringify(run.error) : null, run.id);
  }
  getRun(id: string): RunRecord | undefined {
    const r = this.db.prepare("select * from runs where id=?").get(id) as any;
    if (!r) return undefined;
    const steps = (this.db.prepare("select * from run_steps where run_id=? order by idx").all(id) as any[]).map(
      (s): StepRecord => ({
        index: s.idx,
        stepId: s.step_id,
        op: s.op,
        status: s.status,
        durationMs: s.duration_ms,
        attempts: s.attempts,
        ...(s.output ? { output: JSON.parse(s.output) } : {}),
        ...(s.error ? { error: JSON.parse(s.error) } : {}),
      }),
    );
    return {
      id: r.id,
      workflow: r.workflow,
      status: r.status,
      startedAt: r.started_at,
      ...(r.ended_at ? { endedAt: r.ended_at } : {}),
      ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
      inputs: JSON.parse(r.inputs),
      ...(r.outputs ? { outputs: JSON.parse(r.outputs) } : {}),
      ...(r.error ? { error: JSON.parse(r.error) } : {}),
      steps,
    };
  }
  listRuns(limit = 50): Omit<RunRecord, "steps" | "inputs">[] {
    return (this.db.prepare("select id, workflow, status, started_at, ended_at, duration_ms from runs order by started_at desc limit ?").all(limit) as any[]).map((r) => ({
      id: r.id,
      workflow: r.workflow,
      status: r.status,
      startedAt: r.started_at,
      ...(r.ended_at ? { endedAt: r.ended_at } : {}),
      ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
    }));
  }
  /** Runs left "running" by a crash can never finish; mark them so history is honest. */
  failInterruptedRuns(): number {
    const now = new Date().toISOString();
    const err = JSON.stringify({ code: "internal", message: "interrupted: the engine stopped while this run was active", retryable: false });
    return Number(this.db.prepare("update runs set status='failed', ended_at=?, error=? where status='running'").run(now, err).changes);
  }

  audit(actor: string, action: string, detail?: unknown): void {
    this.db.prepare("insert into audit(ts, actor, action, detail) values(?,?,?,?)").run(new Date().toISOString(), actor, action, detail === undefined ? null : JSON.stringify(detail));
  }
  listAudit(limit = 100): { ts: string; actor: string; action: string; detail?: unknown }[] {
    return (this.db.prepare("select ts, actor, action, detail from audit order by id desc limit ?").all(limit) as any[]).map((a) => ({
      ts: a.ts,
      actor: a.actor,
      action: a.action,
      ...(a.detail ? { detail: JSON.parse(a.detail) } : {}),
    }));
  }

  close(): void {
    this.db.close();
  }
}
