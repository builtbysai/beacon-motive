import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Engine } from "../src/engine.ts";
import { startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { parseWorkflow } from "../src/workflow.ts";
import { browserAdapter } from "../src/adapters/browser.ts";
import { windowsAdapter } from "../src/adapters/windows.ts";

const example = (f: string) => parseWorkflow(JSON.parse(readFileSync(new URL(`../examples/${f}`, import.meta.url), "utf8")));
const hasBrowser = browserAdapter().capability().available;
const hasWindows = windowsAdapter().capability().available;

test("real browser: fill, click, wait for delayed state, verify", { skip: !hasBrowser && "no Chrome/Edge" }, async () => {
  const e = new Engine(new Store(":memory:"));
  process.env.MOTIVE_SECRET_PASSWORD = "p-w-12345";
  const r = await e.start(example("browser-greet.json"), { name: "Grace" }).done;
  delete process.env.MOTIVE_SECRET_PASSWORD;
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  assert.match(String(r.outputs?.greeting), /^Hello, Grace!/);
  assert.ok(!JSON.stringify(e.store.getRun(r.id)).includes("p-w-12345"));
});

test("real browser: a wrong expectation fails with a structured postcondition error", { skip: !hasBrowser && "no Chrome/Edge" }, async () => {
  const e = new Engine(new Store(":memory:"));
  process.env.MOTIVE_SECRET_PASSWORD = "x";
  const w = example("browser-greet.json");
  w.steps[4]!.post = [{ contains: { value: "${out.text}", text: "Goodbye" } }];
  w.steps[4]!.timeoutMs = 1500;
  const r = await e.start(w).done;
  delete process.env.MOTIVE_SECRET_PASSWORD;
  assert.equal(r.status, "failed");
  assert.equal(r.error?.code, "postcondition_failed");
});

test("browser scope: a host that was not declared is refused", { skip: !hasBrowser && "no Chrome/Edge" }, async () => {
  const e = new Engine(new Store(":memory:"));
  const w = parseWorkflow({ format: "motive.workflow/1", name: "t", steps: [{ id: "o", op: "browser.open", args: { url: "https://example.com" } }] });
  assert.equal((await e.start(w).done).error?.code, "scope_denied");
});

test("real Windows app: Calculator adds through UI Automation and verifies", { skip: !hasWindows && "needs Windows and the built helper" }, async () => {
  const e = new Engine(new Store(":memory:"));
  const r = await e.start(example("windows-calculator-add.json"), { a: 4, b: 6 }).done;
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  assert.equal(r.outputs?.display, "Display is 10");
});

test("real desktop + file + browser in one workflow", { skip: (!hasWindows || !hasBrowser) && "needs Windows helper and Chrome" }, async () => {
  const e = new Engine(new Store(":memory:"));
  const r = await e.start(example("mixed-calc-to-web.json"), { a: 9, b: 9 }).done;
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  assert.equal(r.outputs?.greeting, "Hello, Display is 18!");
});

const fixtureBuilt = existsSync(new URL("../target/fixtures/MotiveFixture.exe", import.meta.url));
const winForms = hasWindows && fixtureBuilt;
const killFixture = () => {
  try {
    execFileSync("taskkill", ["/IM", "MotiveFixture.exe", "/F"], { stdio: "ignore" });
  } catch {
    /* not running */
  }
};

test("real native form: typing, secret field, checkbox, combo, list and menu", { skip: !winForms && "needs Windows and: npm run build:fixture" }, async () => {
  killFixture();
  const e = new Engine(new Store(":memory:"));
  process.env.MOTIVE_SECRET_SECRET = "native-secret-xyz";
  try {
    const r = await e.start(example("windows-form-fixture.json"), { name: "Linus" }).done;
    assert.equal(r.status, "succeeded", JSON.stringify(r.error));
    assert.match(String(r.outputs?.result), /^Name=Linus;Loud=True;Size=Large;Color=Green;Secret=17$/);
    assert.ok(!JSON.stringify(e.store.getRun(r.id)).includes("native-secret-xyz"));
  } finally {
    delete process.env.MOTIVE_SECRET_SECRET;
    killFixture();
  }
});

test("native password boxes are never read back", { skip: !winForms && "needs Windows and: npm run build:fixture" }, async () => {
  killFixture();
  const e = new Engine(new Store(":memory:"));
  const w = parseWorkflow({
    format: "motive.workflow/1",
    name: "t",
    scopes: { apps: ["MotiveFixture.exe"] },
    steps: [
      { id: "o", op: "win.launch", args: { command: "./target/fixtures/MotiveFixture.exe", window: { name: "Motive Fixture" } } },
      { id: "t", op: "win.type", args: { window: { name: "Motive Fixture" }, target: { automationId: "pwBox" }, text: "abc" } },
      { id: "r", op: "win.read", args: { window: { name: "Motive Fixture" }, target: { automationId: "pwBox" } } },
    ],
  });
  try {
    const r = await e.start(w).done;
    assert.equal(r.status, "failed");
    assert.equal(r.error?.code, "permission_denied");
  } finally {
    killFixture();
  }
});

test("a shell or interpreter can never be launched, even if the workflow lists it", { skip: !hasWindows && "needs the Windows helper" }, async () => {
  const e = new Engine(new Store(":memory:"));
  const w = parseWorkflow({
    format: "motive.workflow/1",
    name: "t",
    scopes: { apps: ["powershell.exe"] },
    steps: [{ id: "o", op: "win.launch", args: { command: "powershell.exe", args: ["-Command", "echo hi"], window: { name: "x" } } }],
  });
  const r = await e.start(w).done;
  assert.equal(r.error?.code, "scope_denied");
  assert.match(r.error!.message, /shell or interpreter/);
});

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
  const engine = new Engine(store);
  const token = "test-token-abc";
  const s = await startServer(engine, token);
  try {
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await request(s.port, { path: "/v1/capabilities" })).status, 401);
    assert.equal((await request(s.port, { path: "/v1/capabilities", headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await request(s.port, { path: "/v1/capabilities", headers: { ...auth, origin: "https://evil.example" } })).status, 403);
    assert.equal((await request(s.port, { path: "/v1/capabilities", headers: { ...auth, host: "evil.example" } })).status, 403);
    const caps = await request(s.port, { path: "/v1/capabilities", headers: auth });
    assert.equal(caps.status, 200);
    assert.ok(caps.json.adapters.some((a: any) => a.adapter === "core"));

    const wfBody = { format: "motive.workflow/1", name: "api-demo", steps: [{ id: "s", op: "core.set", args: { value: "ok" } }], outputs: { v: "${steps.s.value}" } };
    assert.equal((await request(s.port, { path: "/v1/workflows/api-demo", method: "PUT", headers: auth, body: wfBody })).status, 200);
    assert.equal((await request(s.port, { path: "/v1/workflows/other", method: "PUT", headers: auth, body: wfBody })).status, 400);
    const started = await request(s.port, { path: "/v1/runs", method: "POST", headers: auth, body: { workflow: "api-demo" } });
    assert.equal(started.status, 202);
    for (let i = 0; i < 50; i++) {
      const run = await request(s.port, { path: `/v1/runs/${started.json.id}`, headers: auth });
      if (run.json.status !== "running") {
        assert.equal(run.json.status, "succeeded");
        assert.equal(run.json.outputs.v, "ok");
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const audit = await request(s.port, { path: "/v1/audit", headers: auth });
    assert.ok(audit.json.audit.some((a: any) => a.action === "denied"), "denied requests are audited");
  } finally {
    await s.close();
  }
});

test("real native window: win.ocr reads on-screen text with the Windows OCR engine, and refuses a program outside scopes.apps", { skip: !winForms && "needs Windows and: npm run build:fixture" }, async () => {
  killFixture();
  const e = new Engine(new Store(":memory:"));
  try {
    const r = await e.start(example("windows-ocr-fixture.json")).done;
    assert.equal(r.status, "succeeded", JSON.stringify(r.error));
    assert.match(String(r.outputs?.seen), /Ready/);

    // The window is still open (the first workflow closed it, so reopen): a workflow that does not name its program reads nothing.
    const reopen = parseWorkflow({ format: "motive.workflow/1", name: "t", scopes: { apps: ["MotiveFixture.exe"] }, steps: [{ id: "open", op: "win.launch", args: { command: "./target/fixtures/MotiveFixture.exe", window: { name: "Motive Fixture" } }, timeoutMs: 15000 }] });
    assert.equal((await e.start(reopen).done).status, "succeeded");
    const wrong = parseWorkflow({
      format: "motive.workflow/1",
      name: "t2",
      scopes: { apps: ["calc.exe"] },
      steps: [{ id: "read", op: "win.ocr", args: { window: { name: "Motive Fixture" } }, timeoutMs: 8000 }],
    });
    const w = await e.start(wrong).done;
    assert.equal(w.status, "failed");
    assert.equal(w.error?.code, "scope_denied");
  } finally {
    killFixture();
  }
});
