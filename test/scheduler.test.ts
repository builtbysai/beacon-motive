import { test } from "node:test";
import assert from "node:assert/strict";
import { coreAdapter } from "../src/adapters/core.ts";
import { Engine } from "../src/engine.ts";
import { nextFire, ScheduleSpec, Scheduler } from "../src/scheduler.ts";
import { startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { parseWorkflow } from "../src/workflow.ts";

// The clock is faked so firing logic can be tested without waiting; the workflow runs for real on the core adapter.
function setup(start: Date) {
  const store = new Store(":memory:");
  const engine = new Engine(store, { adapters: [coreAdapter] });
  let now = start;
  const scheduler = new Scheduler(store, engine, () => now);
  store.saveWorkflow(parseWorkflow({ format: "motive.workflow/1", name: "ping", inputs: { n: { type: "number", default: 1 }, pw: { type: "string", secret: true, default: "x" } }, steps: [{ id: "s", op: "core.set", args: { value: "${inputs.n}" } }] }));
  return { store, engine, scheduler, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

test("nextFire: interval and daily schedules fire strictly in the future, daily in local time", () => {
  const from = new Date(2026, 9, 15, 10, 30, 0);
  assert.equal(nextFire({ kind: "minutes", value: 5 }, from).getTime(), from.getTime() + 300_000);
  assert.equal(nextFire({ kind: "daily", at: "11:00" }, from).getHours(), 11);
  assert.equal(nextFire({ kind: "daily", at: "11:00" }, from).getDate(), 15);
  assert.equal(nextFire({ kind: "daily", at: "10:30" }, from).getDate(), 16, "the same minute is already past");
  assert.equal(nextFire({ kind: "daily", at: "09:00" }, from).getDate(), 16);
});

test("scheduler fires when due, runs the workflow, records it, and never replays downtime", async () => {
  const { store, engine, scheduler, advance } = setup(new Date(2026, 9, 15, 10, 0, 0));
  const s = scheduler.add(ScheduleSpec.parse({ workflow: "ping", inputs: { n: 7 }, every: { kind: "minutes", value: 10 } }));
  scheduler.tick();
  assert.equal(store.listRuns().length, 0, "not due yet");
  advance(10 * 60_000);
  scheduler.tick();
  await new Promise((r) => setTimeout(r, 100));
  const runs = store.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, "succeeded");
  assert.deepEqual(store.getRun(runs[0]!.id)!.inputs, { n: 7, pw: "***" });
  assert.ok(store.listAudit(20).some((a) => a.action === "schedule.fire"));
  assert.match(scheduler.list()[0]!.lastResult ?? "", /started run/);

  // A long gap fires once, not once per missed interval.
  advance(5 * 3600_000);
  scheduler.tick();
  scheduler.tick();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(store.listRuns().length, 2);

  // Disabled and removed schedules stay quiet.
  scheduler.setEnabled(s.id, false);
  advance(60 * 60_000);
  scheduler.tick();
  assert.equal(store.listRuns().length, 2);
  assert.equal(scheduler.remove(s.id), true);
  assert.equal(engine.activeRuns().length, 0);
});

test("scheduler skips (and says so) when the engine is busy, and refuses secret inputs or unknown workflows", async () => {
  const { store, engine, scheduler, advance } = setup(new Date(2026, 9, 15, 10, 0, 0));
  store.saveWorkflow(parseWorkflow({ format: "motive.workflow/1", name: "slow", steps: [{ id: "z", op: "core.sleep", args: { ms: 400 } }] }));
  scheduler.add(ScheduleSpec.parse({ workflow: "ping", every: { kind: "minutes", value: 1 } }));
  const busy = engine.start(store.getWorkflow("slow")!);
  advance(60_000);
  scheduler.tick();
  assert.match(scheduler.list()[0]!.lastResult ?? "", /^skipped: .*already active/);
  assert.ok(store.listAudit(20).some((a) => a.action === "schedule.skip"));
  await busy.done;

  assert.throws(() => scheduler.add(ScheduleSpec.parse({ workflow: "ping", inputs: { pw: "hunter2" }, every: { kind: "minutes", value: 1 } })), /secret/);
  assert.throws(() => scheduler.add(ScheduleSpec.parse({ workflow: "ping", inputs: { nope: 1 }, every: { kind: "minutes", value: 1 } })), /no input/);
  assert.throws(() => scheduler.add(ScheduleSpec.parse({ workflow: "missing", every: { kind: "minutes", value: 1 } })), /no stored workflow/);
  assert.equal(ScheduleSpec.safeParse({ workflow: "ping", every: { kind: "daily", at: "25:00" } }).success, false);
  assert.equal(ScheduleSpec.safeParse({ workflow: "ping", every: { kind: "minutes", value: 0 } }).success, false);
});

test("schedules API: create, list, disable, delete", async () => {
  const { store, engine, scheduler } = setup(new Date(2026, 9, 15, 10, 0, 0));
  const server = await startServer(engine, "tok", 0, undefined, scheduler);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { authorization: "Bearer tok" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    const made = await call("POST", "/v1/schedules", { workflow: "ping", every: { kind: "daily", at: "08:15" } });
    assert.equal(made.status, 201);
    assert.equal((await call("GET", "/v1/schedules")).body.schedules.length, 1);
    assert.equal((await call("POST", `/v1/schedules/${made.body.id}/disable`)).status, 200);
    assert.equal((await call("GET", "/v1/schedules")).body.schedules[0].enabled, false);
    assert.equal((await call("POST", "/v1/schedules", { workflow: "ping", inputs: { pw: "x" }, every: { kind: "minutes", value: 5 } })).status, 400);
    assert.equal((await call("DELETE", `/v1/schedules/${made.body.id}`)).body.removed, true);
    assert.equal(store.listAudit(20).filter((a) => a.action.startsWith("schedule.")).length >= 3, true);
  } finally {
    await server.close();
  }
});
