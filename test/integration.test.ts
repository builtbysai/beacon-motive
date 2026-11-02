import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Engine } from "../src/engine.ts";
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
