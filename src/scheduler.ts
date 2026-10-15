import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Engine } from "./engine.ts";
import { MotiveError } from "./errors.ts";
import type { Store } from "./store.ts";

// Time-based triggers (ADR 0011). Schedules live in the library database and fire only while the engine process
// (`motive serve`, or the desktop app that started it) is running: there is no background service. A tick that finds the
// engine busy skips that firing and says so in the audit log; missed firings are never replayed after downtime.

const Name = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const ScheduleSpec = z
  .object({
    workflow: Name,
    // Non-secret inputs only. Secret inputs of a scheduled workflow come from MOTIVE_SECRET_* in the engine's environment.
    inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    every: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("minutes"), value: z.number().int().min(1).max(10_080) }).strict(),
      z.object({ kind: z.literal("daily"), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).strict(),
    ]),
    enabled: z.boolean().default(true),
  })
  .strict();
export type ScheduleSpec = z.infer<typeof ScheduleSpec>;

export interface Schedule extends ScheduleSpec {
  id: string;
  createdAt: string;
  lastFiredAt?: string;
  lastResult?: string;
}

/** The first firing strictly after `from` (local time for daily schedules). */
export function nextFire(every: ScheduleSpec["every"], from: Date): Date {
  if (every.kind === "minutes") return new Date(from.getTime() + every.value * 60_000);
  const [h, m] = every.at.split(":").map(Number) as [number, number];
  const next = new Date(from);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export class Scheduler {
  private store: Store;
  private engine: Engine;
  private now: () => Date;
  private timer?: NodeJS.Timeout;
  // The next firing per schedule, computed from when it was loaded or last fired, so downtime is never replayed.
  private due = new Map<string, Date>();

  constructor(store: Store, engine: Engine, now: () => Date = () => new Date()) {
    this.store = store;
    this.engine = engine;
    this.now = now;
    store.db.exec("create table if not exists schedules (id text primary key, body text not null, created_at text not null, last_fired_at text, last_result text)");
  }

  list(): Schedule[] {
    return (this.store.db.prepare("select * from schedules order by created_at").all() as any[]).map((r) => ({
      ...(JSON.parse(r.body) as ScheduleSpec),
      id: r.id,
      createdAt: r.created_at,
      ...(r.last_fired_at ? { lastFiredAt: r.last_fired_at } : {}),
      ...(r.last_result ? { lastResult: r.last_result } : {}),
    }));
  }

  add(spec: ScheduleSpec, actor = "api"): Schedule {
    const w = this.store.getWorkflow(spec.workflow);
    if (!w) throw new MotiveError("not_found", `no stored workflow named ${spec.workflow}`);
    for (const k of Object.keys(spec.inputs)) {
      const def = w.inputs[k];
      if (!def) throw new MotiveError("invalid_args", `workflow ${spec.workflow} has no input ${k}`);
      if (def.secret) throw new MotiveError("invalid_args", `input ${k} is secret and cannot be stored in a schedule`);
    }
    const id = randomUUID();
    this.store.db.prepare("insert into schedules(id, body, created_at) values(?,?,?)").run(id, JSON.stringify(spec), this.now().toISOString());
    this.store.audit(actor, "schedule.add", { id, workflow: spec.workflow, every: spec.every });
    this.due.set(id, nextFire(spec.every, this.now()));
    return this.list().find((s) => s.id === id)!;
  }

  remove(id: string, actor = "api"): boolean {
    const n = Number(this.store.db.prepare("delete from schedules where id=?").run(id).changes);
    this.due.delete(id);
    if (n) this.store.audit(actor, "schedule.remove", { id });
    return n > 0;
  }

  setEnabled(id: string, enabled: boolean, actor = "api"): boolean {
    const row = this.store.db.prepare("select body from schedules where id=?").get(id) as { body: string } | undefined;
    if (!row) return false;
    const spec = { ...(JSON.parse(row.body) as ScheduleSpec), enabled };
    this.store.db.prepare("update schedules set body=? where id=?").run(JSON.stringify(spec), id);
    this.due.set(id, nextFire(spec.every, this.now()));
    this.store.audit(actor, enabled ? "schedule.enable" : "schedule.disable", { id });
    return true;
  }

  /** Fires every schedule whose time has come. Called by the timer; exposed so tests can drive a fake clock. */
  tick(): void {
    const now = this.now();
    for (const s of this.list()) {
      if (!s.enabled) continue;
      let due = this.due.get(s.id);
      if (!due) {
        due = nextFire(s.every, now);
        this.due.set(s.id, due);
      }
      if (due.getTime() > now.getTime()) continue;
      this.due.set(s.id, nextFire(s.every, now));
      this.fire(s, now);
    }
  }

  private fire(s: Schedule, now: Date): void {
    const w = this.store.getWorkflow(s.workflow);
    let result: string;
    try {
      if (!w) throw new MotiveError("not_found", "workflow no longer exists");
      const run = this.engine.start(w, s.inputs, { actor: `schedule:${s.id}` });
      this.store.audit("scheduler", "schedule.fire", { id: s.id, workflow: s.workflow, run: run.id });
      result = `started run ${run.id}`;
    } catch (e) {
      result = `skipped: ${e instanceof Error ? e.message : String(e)}`;
      this.store.audit("scheduler", "schedule.skip", { id: s.id, workflow: s.workflow, reason: result });
    }
    this.store.db.prepare("update schedules set last_fired_at=?, last_result=? where id=?").run(now.toISOString(), result, s.id);
  }

  start(intervalMs = 15_000): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
