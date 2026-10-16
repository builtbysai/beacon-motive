import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { ollamaProvider } from "../src/ai/provider.ts";
import { sidecarPath } from "../src/adapters/windows.ts";
import { Engine } from "../src/engine.ts";
import { proposalsFor } from "../src/heal.ts";
import { Store } from "../src/store.ts";
import { parseWorkflow } from "../src/workflow.ts";

// Opt-in: needs a running Ollama with the model pulled (MOTIVE_TEST_OLLAMA=1). These use the real model on real apps; they
// check that its choices are validated, not that a model is always right.
const on = process.env.MOTIVE_TEST_OLLAMA === "1";
const fixture = existsSync("target/fixtures/MotiveFixture.exe") && process.platform === "win32" && Boolean(sidecarPath());
const kill = () => {
  try {
    execFileSync("taskkill", ["/IM", "MotiveFixture.exe", "/F"], { stdio: "ignore" });
  } catch {
    /* not running */
  }
};

test("real local model: a typo in a native control id is repaired with a validated suggestion, nothing applied", { skip: (!on && "set MOTIVE_TEST_OLLAMA=1 with Ollama running") || (!fixture && "needs the native fixture: npm run build:fixture") }, async () => {
  const provider = ollamaProvider();
  assert.equal(await provider.unavailableReason(), undefined);
  kill();
  const w = parseWorkflow({
    format: "motive.workflow/1",
    name: "ai-live-win",
    description: "Fills the name box of the test form and presses Go",
    scopes: { apps: ["MotiveFixture.exe"] },
    steps: [
      { id: "open", op: "win.launch", args: { command: "./target/fixtures/MotiveFixture.exe", window: { name: "Motive Fixture" } }, timeoutMs: 15000 },
      { id: "go", op: "win.click", args: { window: { name: "Motive Fixture" }, target: { automationId: "goButtn" } }, timeoutMs: 3000 },
    ],
  });
  try {
    const e = new Engine(new Store(":memory:"));
    const r = await e.start(w, {}, { ai: provider }).done;
    assert.equal(r.status, "failed");
    const props = proposalsFor(r);
    assert.equal(props.length, 1, "the model made a suggestion");
    assert.deepEqual(props[0]!.targets, [{ automationId: "goButton" }]);
    assert.match(props[0]!.notes[0] ?? "", /suggested by local model/);
  } finally {
    kill();
  }
});
