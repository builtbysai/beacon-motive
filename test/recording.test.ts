import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.ts";
import { RecordingManager, type Recorders } from "../src/recording.ts";
import { startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { RecordedStep } from "../src/record/compile.ts";

// The lifecycle (start, finish, review, save, discard, stop) is tested with a stand-in recorder that waits for the
// abort signal the way a real session waits for the browser to close. The real recorders are tested in record.test.ts
// and record-win.test.ts; nobody is at the keyboard here, so this proves the service mechanics, not a human session.
const steps: RecordedStep[] = [
  { kind: "open", url: "http://127.0.0.1:1/form.html" },
  { kind: "fill", verified: "unique", label: "Name", target: { label: "Name", exact: true }, value: "Ada", secret: false },
  { kind: "click", verified: "unique", label: "Go", target: { role: "button", name: "Go", exact: true } },
];
const fake: Recorders = {
  browser: (_url, onStarted, signal) =>
    new Promise((resolve) => {
      onStarted();
      signal.addEventListener("abort", () => resolve(steps), { once: true });
    }),
  windows: () => Promise.reject(new Error("not used")),
};

async function setup() {
  const store = new Store(":memory:");
  const engine = new Engine(store, { adapters: [] });
  const server = await startServer(engine, "tok", 0, new RecordingManager(store, fake));
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { authorization: "Bearer tok" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { store, server, call };
}

test("recording service: finish gives a draft that reaches the library only when saved", async () => {
  const { store, server, call } = await setup();
  try {
    const started = await call("POST", "/v1/record", { kind: "browser", name: "demo", url: "http://127.0.0.1:1/form.html" });
    assert.equal(started.status, 202);
    const id = started.body.id;
    assert.equal((await call("GET", `/v1/record/${id}`)).body.status, "recording");
    assert.equal((await call("POST", "/v1/record", { kind: "browser", name: "other", url: "http://127.0.0.1:1/" })).status, 409, "one recording at a time");

    const done = await call("POST", `/v1/record/${id}/finish`);
    assert.equal(done.body.status, "finished");
    assert.equal(done.body.workflow.name, "demo");
    assert.ok("name" in done.body.workflow.inputs, "typed text became an input");
    assert.equal(store.getWorkflow("demo"), undefined, "a draft is not in the library");

    assert.equal((await call("POST", `/v1/record/${id}/save`)).status, 200);
    assert.ok(store.getWorkflow("demo"));
    assert.ok(store.listAudit(20).some((a) => a.action === "record.start") && store.listAudit(20).some((a) => a.action === "record.end"));
  } finally {
    await server.close();
  }
});

test("recording service: discard keeps nothing, emergency stop ends a session, bad specs are refused", async () => {
  const { store, server, call } = await setup();
  try {
    const a = (await call("POST", "/v1/record", { kind: "browser", name: "gone", url: "http://127.0.0.1:1/" })).body.id;
    assert.equal((await call("DELETE", `/v1/record/${a}`)).status, 200);
    const after = (await call("GET", `/v1/record/${a}`)).body;
    assert.equal(after.status, "discarded");
    assert.equal(after.workflow, undefined);
    assert.equal((await call("POST", `/v1/record/${a}/save`)).status, 409);

    const b = (await call("POST", "/v1/record", { kind: "browser", name: "stopped", url: "http://127.0.0.1:1/" })).body.id;
    await call("POST", "/v1/stop");
    assert.equal((await call("GET", `/v1/record/${b}`)).body.status, "discarded");
    assert.equal(store.getWorkflow("stopped"), undefined);

    assert.equal((await call("POST", "/v1/record", { kind: "browser", name: "Bad Name", url: "http://x/" })).status, 400);
    assert.equal((await call("POST", "/v1/record", { kind: "browser", name: "ok", url: "not a url" })).status, 400);
    assert.equal((await call("POST", "/v1/record", { kind: "shell", name: "ok" })).status, 400);
  } finally {
    await server.close();
  }
});
