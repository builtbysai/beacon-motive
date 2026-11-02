import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { coreAdapter } from "../src/adapters/core.ts";
import { Engine } from "../src/engine.ts";
import { startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

// Uses a core-only engine, in-memory data and an OS-assigned loopback port.
// This authentication boundary must not enumerate or control desktop/phone adapters.
// ---- API security ------------------------------------------------------------------------------------------

function request(port: number, opts: { path: string; method?: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request({ host: "127.0.0.1", port, path: opts.path, method: opts.method ?? "GET", headers: { ...(data ? { "content-type": "application/json" } : {}), ...opts.headers } }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode!, json: buf ? JSON.parse(buf) : undefined }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

test("local API: token, host and origin checks; save, run and read back", async () => {
  const store = new Store(":memory:");
  const engine = new Engine(store, { adapters: [coreAdapter] });
  const token = "test-token-abc";
  const s = await startServer(engine, token);
  try {
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await request(s.port, { path: "/v1/workflows" })).status, 401);
    assert.equal((await request(s.port, { path: "/v1/workflows", headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await request(s.port, { path: "/v1/workflows", headers: { ...auth, origin: "https://evil.example" } })).status, 403);
    assert.equal((await request(s.port, { path: "/v1/workflows", headers: { ...auth, host: "evil.example" } })).status, 403);
    const library = await request(s.port, { path: "/v1/workflows", headers: auth });
    assert.equal(library.status, 200);
    assert.deepEqual(library.json.workflows, []);

    const wfBody = { format: "motive.workflow/1", name: "api-demo", steps: [{ id: "s", op: "core.set", args: { value: "ok" } }], outputs: { v: "${steps.s.value}" } };
    assert.equal((await request(s.port, { path: "/v1/workflows/api-demo", method: "PUT", headers: auth, body: wfBody })).status, 200);
    assert.equal((await request(s.port, { path: "/v1/workflows/other", method: "PUT", headers: auth, body: wfBody })).status, 400);
    const started = await request(s.port, { path: "/v1/runs", method: "POST", headers: auth, body: { workflow: "api-demo" } });
    assert.equal(started.status, 202);
    let completed = false;
    for (let i = 0; i < 50; i++) {
      const run = await request(s.port, { path: `/v1/runs/${started.json.id}`, headers: auth });
      if (run.json.status !== "running") {
        assert.equal(run.json.status, "succeeded");
        assert.equal(run.json.outputs.v, "ok");
        completed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(completed, "the API workflow must finish before its polling deadline");
    const audit = await request(s.port, { path: "/v1/audit", headers: auth });
    assert.ok(audit.json.audit.some((a: any) => a.action === "denied"), "denied requests are audited");
  } finally {
    await s.close();
  }
});

