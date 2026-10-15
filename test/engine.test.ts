import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Adapter, OpDef } from "../src/adapters/types.ts";
import { fsAdapter } from "../src/adapters/fs.ts";
import { coreAdapter } from "../src/adapters/core.ts";
import { Engine } from "../src/engine.ts";
import { Store } from "../src/store.ts";
import { parseWorkflow, interpolate } from "../src/workflow.ts";

// A controllable adapter for engine mechanics only; real adapters are exercised in integration.test.ts.
function probe() {
  const state = { flakyCalls: 0, polled: 0, ran: [] as string[] };
  const ops: OpDef[] = [
    {
      name: "probe.flaky",
      idempotent: false,
      args: z.object({ failTimes: z.number() }).strict(),
      async run(a: { failTimes: number }) {
        state.flakyCalls++;
        if (state.flakyCalls <= a.failTimes) throw new (await import("../src/errors.ts")).MotiveError("timeout", "not yet", { retryable: true });
        return { calls: state.flakyCalls };
      },
    },
    {
      name: "probe.counter",
      idempotent: true,
      args: z.object({}).strict(),
      run: async () => ({ n: ++state.polled }),
    },
    {
      name: "probe.record",
      idempotent: false,
      args: z.object({ tag: z.string() }).strict(),
      async run(a: { tag: string }) {
        state.ran.push(a.tag);
        return { tag: a.tag };
      },
    },
    {
      name: "probe.hang",
      idempotent: false,
      args: z.object({}).strict(),
      run: (_a, ctx) => new Promise((_res, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("aborted")))),
    },
    {
      name: "probe.echo",
      idempotent: true,
      args: z.object({ value: z.string() }).strict(),
      run: async (a: { value: string }) => ({ value: a.value, note: `got ${a.value}` }),
    },
  ];
  const adapter: Adapter = { id: "probe", ops, capability: () => ({ adapter: "probe", available: true, ops: ops.map((o) => o.name) }), dispose: async () => {} };
  return { state, factory: () => adapter };
}

function engineWith(...extra: (() => Adapter)[]) {
  return new Engine(new Store(":memory:"), { adapters: [coreAdapter, fsAdapter, ...extra] });
}
const wf = (steps: unknown[], extra: Record<string, unknown> = {}) => parseWorkflow({ format: "motive.workflow/1", name: "t", steps, ...extra });

test("interpolation keeps types for whole references and fails loudly on missing ones", () => {
  const scope = { inputs: { n: 5, s: "x" }, steps: { a: { v: true } } };
  assert.equal(interpolate("${inputs.n}", scope), 5);
  assert.equal(interpolate("n=${inputs.n}", scope), "n=5");
  assert.throws(() => interpolate("${steps.zzz.v}", scope), /does not exist/);
});

test("rejects bad workflows before running", () => {
  assert.throws(() => parseWorkflow({ format: "motive.workflow/1", name: "x", steps: [{ id: "a", op: "core.set" }, { id: "a", op: "core.set" }] }), /duplicate step id/);
  assert.throws(() => parseWorkflow({ format: "motive.workflow/2", name: "x", steps: [] }), /invalid_workflow|Invalid/i);
});

test("unknown op and unavailable adapters fail before any step runs", async () => {
  const p = probe();
  const e = engineWith(p.factory);
  const r = await e.start(wf([{ id: "a", op: "probe.record", args: { tag: "first" } }, { id: "b", op: "nope.nothing" }])).done;
  assert.equal(r.status, "failed");
  assert.equal(r.error?.code, "unknown_op");
  assert.deepEqual(p.state.ran, [], "no step may run when the workflow cannot run at all");
});

test("when: a false guard skips the step, a true guard runs it, and a skipped step's output is not readable", async () => {
  const p = probe();
  const e = engineWith(p.factory);
  const inputs = { mode: { type: "string" } };
  const steps = [
    { id: "a", op: "probe.record", args: { tag: "a" }, when: [{ equals: { value: "${inputs.mode}", to: "fast" } }] },
    { id: "b", op: "probe.record", args: { tag: "b" }, when: [{ equals: { value: "${inputs.mode}", to: "slow" } }] },
  ];
  const r = await e.start(wf(steps, { inputs }), { mode: "fast" }).done;
  assert.equal(r.status, "succeeded");
  assert.deepEqual(p.state.ran, ["a"]);
  assert.deepEqual(r.steps.map((s) => s.status), ["succeeded", "skipped"]);

  const p2 = probe();
  const bad = await engineWith(p2.factory).start(wf([...steps, { id: "c", op: "probe.record", args: { tag: "${steps.b.tag}" } }], { inputs }), { mode: "fast" }).done;
  assert.equal(bad.status, "failed");
  assert.equal(bad.steps.at(-1)?.error?.code, "unresolved_reference");
});

test("forEach: runs once per item with loop.item/index, aggregates results, stops on first failure", async () => {
  const p = probe();
  const e = engineWith(p.factory);
  const inputs = { names: { type: "string" } };
  const loop = { id: "each", op: "probe.record", args: { tag: "${loop.index}:${loop.item}" }, forEach: { items: "${inputs.names}", separator: "," } };
  const r = await e.start(wf([loop, { id: "after", op: "probe.record", args: { tag: "n=${steps.each.count}" } }], { inputs }), { names: "x, y,z" }).done;
  assert.equal(r.status, "succeeded");
  assert.deepEqual(p.state.ran, ["0:x", "1:y", "2:z", "n=3"]);
  assert.deepEqual(r.steps.map((s) => s.stepId), ["each[0]", "each[1]", "each[2]", "after"]);

  const p2 = probe();
  const lit = { id: "f", op: "probe.flaky", args: { failTimes: 1 }, forEach: { items: [1, 2, 3] } };
  const bad = await engineWith(p2.factory).start(wf([lit])).done;
  assert.equal(bad.status, "failed");
  assert.equal(bad.steps.length, 1, "first failing iteration stops the loop");

  const big = await engineWith(probe().factory).start(wf([{ id: "g", op: "probe.record", args: { tag: "t" }, forEach: { items: Array.from({ length: 101 }, (_, i) => i) } }])).done;
  assert.equal(big.error?.code, "invalid_args");
});

test("flow.call: runs a stored subflow with inputs, returns its outputs, records prefixed steps", async () => {
  const p = probe();
  const e = engineWith(p.factory);
  e.store.saveWorkflow(parseWorkflow({ format: "motive.workflow/1", name: "child", inputs: { who: { type: "string" } }, steps: [{ id: "hi", op: "probe.echo", args: { value: "hello ${inputs.who}" } }], outputs: { greeting: "${steps.hi.note}" } }));
  const parent = wf(
    [
      { id: "first", op: "probe.record", args: { tag: "before" } },
      { id: "sub", op: "flow.call", args: { workflow: "child", inputs: { who: "${inputs.name}" } } },
      { id: "after", op: "probe.record", args: { tag: "${steps.sub.greeting}" } },
    ],
    { inputs: { name: { type: "string" } }, outputs: { said: "${steps.sub.greeting}" } },
  );
  const r = await e.start(parent, { name: "Ada" }).done;
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  assert.deepEqual(p.state.ran, ["before", "got hello Ada"]);
  assert.deepEqual(r.steps.map((s) => s.stepId), ["first", "sub/hi", "sub", "after"]);
  assert.deepEqual(r.steps.map((s) => s.index), [0, 1, 2, 3]);
  assert.equal(r.outputs?.said, "got hello Ada");
});

test("flow.call: a subflow cannot widen scopes, cannot call itself, and is refused before anything runs", async () => {
  const p = probe();
  const e = engineWith(p.factory);
  e.store.saveWorkflow(parseWorkflow({ format: "motive.workflow/1", name: "wide", scopes: { dirs: ["/elsewhere"] }, steps: [{ id: "x", op: "probe.record", args: { tag: "wide" } }] }));
  e.store.saveWorkflow(parseWorkflow({ format: "motive.workflow/1", name: "loop-a", steps: [{ id: "c", op: "flow.call", args: { workflow: "loop-b" } }] }));
  e.store.saveWorkflow(parseWorkflow({ format: "motive.workflow/1", name: "loop-b", steps: [{ id: "c", op: "flow.call", args: { workflow: "loop-a" } }] }));
  const first = { id: "first", op: "probe.record", args: { tag: "must-not-run" } };

  const widen = await e.start(wf([first, { id: "w", op: "flow.call", args: { workflow: "wide" } }])).done;
  assert.equal(widen.error?.code, "scope_denied");
  const cycle = await e.start(wf([first, { id: "c", op: "flow.call", args: { workflow: "loop-a" } }])).done;
  assert.equal(cycle.error?.code, "invalid_workflow");
  const missing = await e.start(wf([first, { id: "m", op: "flow.call", args: { workflow: "nope" } }])).done;
  assert.equal(missing.error?.code, "not_found");
  assert.deepEqual(p.state.ran, [], "nothing runs when a subflow is refused up front");
});

test("flow.call: secrets must be passed explicitly; a failing subflow fails the caller with its name", async () => {
  const p = probe();
  const e = engineWith(p.factory);
  e.store.saveWorkflow(parseWorkflow({ format: "motive.workflow/1", name: "needs-secret", inputs: { pw: { type: "string", secret: true } }, steps: [{ id: "s", op: "probe.record", args: { tag: "x" } }] }));
  e.store.saveWorkflow(parseWorkflow({ format: "motive.workflow/1", name: "breaks", steps: [{ id: "f", op: "probe.flaky", args: { failTimes: 5 } }] }));
  process.env.MOTIVE_SECRET_PW = "from-env";
  try {
    const noPass = await e.start(wf([{ id: "a", op: "flow.call", args: { workflow: "needs-secret" } }])).done;
    assert.equal(noPass.error?.code, "invalid_args");
    assert.match(noPass.error?.message ?? "", /must be passed explicitly/);
  } finally {
    delete process.env.MOTIVE_SECRET_PW;
  }
  const bad = await e.start(wf([{ id: "b", op: "flow.call", args: { workflow: "breaks" } }])).done;
  assert.equal(bad.status, "failed");
  assert.match(bad.error?.message ?? "", /subflow breaks:/);
  assert.deepEqual(bad.steps.map((s) => s.stepId), ["b/f", "b"]);
});

test("bounded retry recovers a retryable failure and records attempts", async () => {
  const p = probe();
  const e = engineWith(p.factory);
  const r = await e.start(wf([{ id: "f", op: "probe.flaky", args: { failTimes: 2 }, retry: { max: 3, backoffMs: 0 } }])).done;
  assert.equal(r.status, "succeeded");
  assert.equal(r.steps[0]?.attempts, 3);
  const r2 = await e.start(wf([{ id: "f", op: "probe.flaky", args: { failTimes: 99 }, retry: { max: 2, backoffMs: 0 } }])).done;
  assert.equal(r2.status, "failed");
  assert.equal(r2.steps[0]?.attempts, 2);
});

test("postcondition on an idempotent op polls until true; on a side-effect op it fails at once", async () => {
  const p = probe();
  const e = engineWith(p.factory);
  const ok = await e.start(wf([{ id: "c", op: "probe.counter", post: [{ matches: { value: "${out.n}", pattern: "^[4-9]$" } }], timeoutMs: 5000 }])).done;
  assert.equal(ok.status, "succeeded");
  assert.ok(p.state.polled >= 4);
  const bad = await e.start(wf([{ id: "r", op: "probe.record", args: { tag: "once" }, post: [{ equals: { value: "${out.tag}", to: "other" } }] }])).done;
  assert.equal(bad.error?.code, "postcondition_failed");
  assert.equal(p.state.ran.filter((t) => t === "once").length, 1, "a side-effecting step must not be repeated by polling");
});

test("cancellation aborts a hung step promptly and is recorded as cancelled", async () => {
  const p = probe();
  const e = engineWith(p.factory);
  const run = e.start(wf([{ id: "h", op: "probe.hang", timeoutMs: 60000 }, { id: "after", op: "probe.record", args: { tag: "never" } }]));
  setTimeout(() => run.cancel("test"), 100);
  const t0 = Date.now();
  const r = await run.done;
  assert.equal(r.status, "cancelled");
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(p.state.ran, []);
  assert.ok(e.store.listAudit().some((a) => a.action === "run.cancel"));
});

test("workflow deadline stops a run", async () => {
  const p = probe();
  const e = engineWith(p.factory);
  const r = await e.start(wf([{ id: "h", op: "probe.hang", timeoutMs: 60000 }], { deadlineMs: 1000 })).done;
  assert.equal(r.status, "failed");
  assert.equal(r.error?.code, "timeout");
});

test("concurrency limit and emergency stop", async () => {
  const p = probe();
  const e = engineWith(p.factory);
  const a = e.start(wf([{ id: "h", op: "probe.hang", timeoutMs: 60000 }]));
  assert.throws(() => e.start(wf([{ id: "h", op: "probe.hang" }])), /already active/);
  assert.equal(e.stopAll(), 1);
  assert.equal((await a.done).status, "cancelled");
});

test("secret inputs never reach history, outputs or errors", async () => {
  const p = probe();
  const e = engineWith(p.factory);
  const w = wf([{ id: "x", op: "probe.echo", args: { value: "${inputs.pw}" } }, { id: "y", op: "core.set", args: { value: "${steps.x.note}" }, post: [{ equals: { value: "${out.value}", to: "never" } }] }], {
    inputs: { pw: { type: "string", secret: true } },
    outputs: { leaked: "${steps.x.note}" },
  });
  process.env.MOTIVE_SECRET_PW = "s3cr3t-value-123";
  const r = await e.start(w).done;
  delete process.env.MOTIVE_SECRET_PW;
  const dump = JSON.stringify([r, e.store.getRun(r.id), e.store.listAudit()]);
  assert.ok(!dump.includes("s3cr3t-value-123"), "secret leaked into persisted data");
  assert.ok(dump.includes("***"));
  assert.throws(() => e.start(w, { pw: "x", extra: "y" }), /unknown input/);
});

test("fs scope: inside allowed, outside and symlink escapes denied", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "motive-"));
  const allowed = path.join(base, "ok");
  const outside = path.join(base, "out");
  const e = engineWith();
  const scopes = { dirs: [allowed] };
  const good = await e.start(wf([{ id: "w", op: "fs.write", args: { path: path.join(allowed, "a.txt"), content: "hi" } }], { scopes })).done;
  assert.equal(good.status, "succeeded");
  assert.equal(readFileSync(path.join(allowed, "a.txt"), "utf8"), "hi");
  const bad = await e.start(wf([{ id: "w", op: "fs.write", args: { path: path.join(outside, "a.txt"), content: "no" } }], { scopes })).done;
  assert.equal(bad.error?.code, "scope_denied");
  const traversal = await e.start(wf([{ id: "w", op: "fs.write", args: { path: path.join(allowed, "..", "out", "b.txt"), content: "no" } }], { scopes })).done;
  assert.equal(traversal.error?.code, "scope_denied");
  try {
    symlinkSync(base, path.join(allowed, "link"), "junction");
    const esc = await e.start(wf([{ id: "w", op: "fs.write", args: { path: path.join(allowed, "link", "c.txt"), content: "no" } }], { scopes })).done;
    assert.equal(esc.error?.code, "scope_denied", "a junction/symlink must not escape the declared directory");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
  }
});
