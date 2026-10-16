import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { Adapter, Candidate, OpDef } from "../src/adapters/types.ts";
import { ollamaConfig, type ModelProvider } from "../src/ai/provider.ts";
import { suggestTarget } from "../src/ai/recovery.ts";
import { MotiveError } from "../src/errors.ts";
import { Engine } from "../src/engine.ts";
import { applyProposal, proposalsFor } from "../src/heal.ts";
import { Store } from "../src/store.ts";
import { parseWorkflow } from "../src/workflow.ts";

// Mechanics only: a stand-in provider answers with fixed choices so the safety rules can be tested exactly. Whether a real
// local model picks well is tested separately against Ollama (ai-live.test.ts, opt-in).
const isVerify = (schema: any) => Boolean(schema?.properties?.same_job);
const provider = (answer: () => unknown, verdict = true): ModelProvider => ({ id: "stub", model: "stub-1", unavailableReason: async () => undefined, json: async (_s, _u, schema: any) => (isVerify(schema) ? { same_job: verdict, reason: "stub" } : answer()) });

/** Answers with the listed control whose text starts with `prefix`. */
const textProvider = (prefix: string, reason: string): ModelProvider => ({ id: "stub", model: "stub-1", unavailableReason: async () => undefined, json: async (_s, _u, schema: any) => (isVerify(schema) ? { same_job: true, reason: "stub" } : { choice: (schema.properties.choice.enum as string[]).find((t) => t.startsWith(prefix)), reason }) });

function screen() {
  const state = { candidatesCalls: 0, clicked: [] as string[] };
  const present = [{ id: "goButton", label: "Go" }, { id: "cancelButton", label: "Cancel" }];
  const candidates = async (): Promise<Candidate[]> => {
    state.candidatesCalls++;
    return present.map((p) => ({ selector: { id: p.id }, describe: `Button "${p.label}"` }));
  };
  const click: OpDef = {
    name: "fake.click",
    idempotent: false,
    args: z.object({ target: z.object({ id: z.string() }).strict() }).strict(),
    probe: async (a: { target: { id: string } }) => present.some((p) => p.id === a.target.id),
    candidates,
    async run(a: { target: { id: string } }) {
      if (!present.some((p) => p.id === a.target.id)) throw new MotiveError("not_found", `no control ${a.target.id}`);
      state.clicked.push(a.target.id);
      return { ok: true };
    },
  };
  const adapter: Adapter = { id: "fake", ops: [click], capability: () => ({ adapter: "fake", available: true, ops: ["fake.click"] }), dispose: async () => {} };
  return { state, factory: () => adapter };
}
const wf = parseWorkflow({ format: "motive.workflow/1", name: "t", description: "presses Go", steps: [{ id: "go", op: "fake.click", args: { target: { id: "goButtn" } }, timeoutMs: 1000 }] });

test("the model provider only talks to this machine", () => {
  assert.throws(() => ollamaConfig({ MOTIVE_OLLAMA_HOST: "http://192.168.1.20:11434" }), /loopback/);
  assert.throws(() => ollamaConfig({ MOTIVE_OLLAMA_HOST: "http://example.com:11434" }), /loopback/);
  assert.throws(() => ollamaConfig({ MOTIVE_OLLAMA_HOST: "https://127.0.0.1:11434" }), /http/);
  assert.equal(ollamaConfig({}).base.hostname, "127.0.0.1");
  assert.equal(ollamaConfig({ MOTIVE_OLLAMA_HOST: "http://localhost:9999", MOTIVE_OLLAMA_MODEL: "x:1b" }).model, "x:1b");
});

test("suggestTarget accepts only the text of a listed control, and ranks the closest control first", async () => {
  const candidates: Candidate[] = [
    { selector: { id: "closeButton" }, describe: 'Button "Close"' },
    { selector: { id: "goButton" }, describe: 'Button "Go" (id goButton)' },
    { selector: { id: "nameBox" }, describe: 'Edit "Name" (id nameBox)' },
  ];
  const ask = { stepId: "s", op: "fake.click", original: { id: "goButtn" }, candidates };
  const seen: string[] = [];
  const answers = (pick: (texts: string[]) => unknown): ModelProvider => ({ id: "stub", model: "stub-1", unavailableReason: async () => undefined, json: async (_s, user, schema: any) => { if (isVerify(schema)) return { same_job: true, reason: "stub" }; seen.push(user); return pick(schema.properties.choice.enum); } });
  const right = await suggestTarget(answers((t) => ({ choice: t[0], reason: "same id, one letter off" })), ask);
  assert.equal(right?.candidate.selector.id, "goButton", "the closest control is listed first, so it is the one the stub took first");
  assert.ok(seen[0]!.indexOf('Button "Go"') < seen[0]!.indexOf('Button "Close"'), "most similar listed first");
  for (const bad of [{ choice: "none of these", reason: "unsure" }, { choice: "Button \"Invented\"", reason: "x" }, { choice: 3, reason: "x" }, { choice: null, reason: "x" }, {}]) {
    assert.equal(await suggestTarget(answers(() => bad), ask), undefined, JSON.stringify(bad));
  }
  assert.equal(await suggestTarget(answers(() => ({})), { ...ask, candidates: [] }), undefined);
});

test("suggestTarget drops a choice that fails the separate same-job check", async () => {
  const candidates: Candidate[] = [{ selector: { id: "a" }, describe: 'Button "Add to basket"' }];
  const ask = { stepId: "s", op: "fake.click", original: { id: "exportPdf" }, candidates };
  assert.equal(await suggestTarget(provider(() => ({ choice: 'Button "Add to basket"', reason: "closest" }), false), ask), undefined);
  assert.ok(await suggestTarget(provider(() => ({ choice: 'Button "Add to basket"', reason: "closest" }), true), ask));
});

test("AI recovery: the model's choice becomes a reviewed proposal, never an automatic repair, and only for runs that opted in", async () => {
  const s = screen();
  const e = new Engine(new Store(":memory:"), { adapters: [s.factory] });

  // Without opting in, the screen is never read and nothing is proposed.
  const plain = await e.start(wf).done;
  assert.equal(plain.status, "failed");
  assert.equal(s.state.candidatesCalls, 0);
  assert.deepEqual(proposalsFor(plain), []);

  // Opted in: the model picks "goButton"; it is validated by a probe and offered, but the run still fails and nothing was clicked.
  const run = await e.start(wf, {}, { ai: textProvider("Button \"Go\"", "the label Go matches the typo goButtn") }).done;
  assert.equal(run.status, "failed");
  assert.deepEqual(s.state.clicked, []);
  const props = proposalsFor(run);
  assert.equal(props.length, 1);
  assert.deepEqual(props[0]!.targets, [{ id: "goButton" }]);
  assert.match(props[0]!.notes[0] ?? "", /suggested by local model stub-1: the label Go/);
  const fixed = applyProposal(wf, "go", 0, props);
  assert.deepEqual(fixed.steps[0]!.args.target, { id: "goButton" });
  assert.equal((await e.start(fixed).done).status, "succeeded");
});

test("AI recovery: a model that picks nothing, something unresolvable, or fails produces no proposal and no new failure mode", async () => {
  const s = screen();
  const e = new Engine(new Store(":memory:"), { adapters: [s.factory] });
  for (const answer of [() => ({ choice: "none of these", reason: "cannot tell" }), () => ({ choice: "Button \"Missing\"", reason: "x" }), () => { throw new MotiveError("adapter_failed", "model down"); }]) {
    const r = await e.start(wf, {}, { ai: provider(answer) }).done;
    assert.equal(r.status, "failed");
    assert.equal(r.error?.code, "not_found", "the original failure is what is reported");
    assert.deepEqual(proposalsFor(r), []);
  }
  // A recorded alternative that works wins; the model is not consulted.
  const withAlt = parseWorkflow({ ...wf, steps: [{ ...wf.steps[0]!, alternatives: [{ id: "cancelButton" }] }] });
  let asked = 0;
  const r = await e.start(withAlt, {}, { ai: provider(() => (asked++, { choice: "Button \"Go\"", reason: "x" })) }).done;
  assert.deepEqual(proposalsFor(r)[0]!.targets, [{ id: "cancelButton" }]);
  assert.equal(asked, 0);
});

test("API: AI recovery is refused clearly when no local model is reachable, and a proposal is applied only by an explicit heal call", async () => {
  const { startServer } = await import("../src/server.ts");
  const s = screen();
  const store = new Store(":memory:");
  const engine = new Engine(store, { adapters: [s.factory] });
  const withAlt = parseWorkflow({ ...wf, name: "healme", steps: [{ ...wf.steps[0]!, alternatives: [{ id: "goButton" }] }] });
  store.saveWorkflow(withAlt);
  const saved = process.env.MOTIVE_OLLAMA_HOST;
  process.env.MOTIVE_OLLAMA_HOST = "http://127.0.0.1:9"; // nothing listens here
  const server = await startServer(engine, "tok", 0);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { authorization: "Bearer tok" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    const refused = await call("POST", "/v1/runs", { workflow: "healme", aiRecovery: true });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /AI recovery is unavailable/);
    const caps = await call("GET", "/v1/capabilities");
    assert.equal(caps.body.ai.available, false);
    assert.equal(caps.body.ai.localOnly, true);

    const started = await call("POST", "/v1/runs", { workflow: "healme" });
    let run = (await call("GET", `/v1/runs/${started.body.id}`)).body;
    for (let i = 0; i < 60 && run.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      run = (await call("GET", `/v1/runs/${started.body.id}`)).body;
    }
    assert.equal(run.status, "failed");
    assert.equal((store.getWorkflow("healme")!.steps[0]!.args.target as { id: string }).id, "goButtn", "nothing changed by itself");
    const healed = await call("POST", `/v1/runs/${started.body.id}/heal`, { step: "go", index: 0 });
    assert.equal(healed.status, 200);
    assert.equal((store.getWorkflow("healme")!.steps[0]!.args.target as { id: string }).id, "goButton");
    assert.ok(store.listAudit(20).some((a) => a.action === "workflow.heal"));
  } finally {
    if (saved === undefined) delete process.env.MOTIVE_OLLAMA_HOST;
    else process.env.MOTIVE_OLLAMA_HOST = saved;
    await server.close();
  }
});
