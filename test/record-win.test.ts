import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { sidecarPath, WinClient, windowsAdapter } from "../src/adapters/windows.ts";
import { Engine } from "../src/engine.ts";
import { compileWindow, recordWindow } from "../src/record/windows.ts";
import { Store } from "../src/store.ts";

const ok = windowsAdapter().capability().available;
const fixtureBuilt = existsSync(new URL("../target/fixtures/MotiveFixture.exe", import.meta.url));
const kill = (exe: string) => {
  try {
    execFileSync("taskkill", ["/IM", exe, "/F"], { stdio: "ignore" });
  } catch {
    /* not running */
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitWindow(c: WinClient, name: string) {
  for (let i = 0; i < 60; i++) {
    try {
      await c.call("window.find", { window: { name } });
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`${name} did not appear`);
}

test("Windows Teach Mode: Calculator actions are recorded, compiled and replayed", { skip: !ok && "needs Windows and the built helper" }, async () => {
  spawn("calc.exe", [], { detached: true, stdio: "ignore" }).unref();
  const driver = new WinClient(sidecarPath()!);
  const win = { name: "Calculator" };
  try {
    await waitWindow(driver, "Calculator");
    const ac = new AbortController();
    const rec = recordWindow(win, ac.signal, () => {});
    await sleep(1200);
    for (const id of ["clearButton", "num2Button", "plusButton", "num3Button", "equalButton"]) await driver.call("element.invoke", { window: win, target: { automationId: id } });
    await sleep(600);
    ac.abort();
    const steps = await rec;
    assert.deepEqual(steps.map((s) => s.target.automationId), ["clearButton", "num2Button", "plusButton", "num3Button", "equalButton"]);
    assert.ok(steps.every((s) => s.verified === "unique"));

    const { workflow } = compileWindow(steps, { name: "calc-recorded", window: "Calculator", command: "calc.exe", expect: { automationId: "CalculatorResults", text: "Display is 5" } });
    assert.deepEqual(workflow.scopes.apps, ["calc.exe"]);
    const r = await new Engine(new Store(":memory:")).start(workflow).done;
    assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  } finally {
    await driver.call("window.close", { window: win }).catch(() => {});
    driver.close();
  }
});

test("Windows Teach Mode: typed values become inputs, a password never leaves the app", { skip: !(ok && fixtureBuilt) && "needs Windows and: npm run build:fixture" }, async () => {
  kill("MotiveFixture.exe");
  spawn("./target/fixtures/MotiveFixture.exe", [], { detached: true, stdio: "ignore" }).unref();
  const driver = new WinClient(sidecarPath()!);
  const win = { name: "Motive Fixture" };
  try {
    await waitWindow(driver, "Motive Fixture");
    const ac = new AbortController();
    const rec = recordWindow(win, ac.signal, () => {});
    await sleep(1200);
    const id = (a: string) => ({ automationId: a });
    await driver.call("element.type", { window: win, target: id("nameBox"), text: "Ada" });
    await driver.call("element.type", { window: win, target: id("pwBox"), text: "hunter2-recorded" });
    await driver.call("element.keys", { window: win, target: id("sizeBox"), keys: "{down}{down}" });
    await driver.call("element.keys", { window: win, target: id("colorList"), keys: "{down}{down}" });
    await sleep(600);
    ac.abort();
    const steps = await rec;
    assert.equal(JSON.stringify(steps).includes("hunter2-recorded"), false, "a password must never be captured");

    const { workflow } = compileWindow(steps, { name: "fixture-recorded", window: "Motive Fixture", command: "./target/fixtures/MotiveFixture.exe", expect: { automationId: "nameBox", text: "Ada" } });
    assert.equal(JSON.stringify(workflow).includes("hunter2-recorded"), false);
    assert.equal(workflow.inputs.secret?.secret, true);
    assert.equal(workflow.inputs.name?.default, "Ada");
    assert.equal(Object.keys(workflow.inputs).filter((k) => k.startsWith("size")).length, 1, "the combo box is one input, not one per intermediate choice");

    kill("MotiveFixture.exe");
    await sleep(500);
    process.env.MOTIVE_SECRET_SECRET = "replay-secret";
    const r = await new Engine(new Store(":memory:")).start(workflow, { name: "Bob" }).done;
    delete process.env.MOTIVE_SECRET_SECRET;
    assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  } finally {
    driver.close();
    kill("MotiveFixture.exe");
  }
});
