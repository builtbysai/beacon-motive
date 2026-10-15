import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { chromePath } from "../src/adapters/browser.ts";
import { Engine } from "../src/engine.ts";
import { applyProposal, proposalsFor } from "../src/heal.ts";
import { Recorder } from "../src/record/recorder.ts";
import { compile } from "../src/record/compile.ts";
import { Store } from "../src/store.ts";

const exe = chromePath();
const url = (f: string) => pathToFileURL(path.resolve("examples/fixtures", f)).href;

test("healing: a recorded click survives a relabelled button only as a reviewed proposal", { skip: !exe && "no Chrome/Edge" }, async () => {
  // 1. Record on the original page.
  const browser = await chromium.launch({ executablePath: exe!, headless: true });
  const context = await browser.newContext();
  const rec = new Recorder();
  await rec.attach(context, url("form.html"));
  const page = await context.newPage();
  await page.goto(url("form.html"));
  await page.getByLabel("Your name").pressSequentially("Grace");
  await page.getByRole("button", { name: "Greet" }).click();
  await page.getByRole("status").filter({ hasText: "Hello" }).waitFor();
  await rec.idle();
  await browser.close();

  const { workflow } = compile(rec.steps, { name: "greet-recorded", expectText: "Hello, Grace!" });
  const click = workflow.steps.find((s) => s.op === "browser.click")!;
  assert.deepEqual(click.args.target, { role: "button", name: "Greet" });
  assert.ok(click.alternatives?.some((a) => a.css === "#go"), "the recorder keeps other verified selectors as alternatives");
  assert.ok(!click.alternatives?.some((a) => a.text === "Greet" && !a.exact), "a selector that also matches the heading must not be kept without exact matching");

  // 2. The site is redesigned: same page structure, button now says "Say hello".
  const drifted = structuredClone(workflow);
  drifted.steps[0]!.args.url = url("form-v2.html");
  drifted.steps.find((s) => s.op === "browser.click")!.timeoutMs = 1500;

  const engine = new Engine(new Store(":memory:"));
  const failed = await engine.start(drifted).done;
  assert.equal(failed.status, "failed", "replay must not silently self-repair");
  const bad = failed.steps.find((s) => s.status === "failed")!;
  assert.equal(bad.op, "browser.click");
  const proposals = proposalsFor(engine.store.getRun(failed.id)!);
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0]!.targets, [{ css: "#go" }]);

  // 3. Nothing changed until the user applies it; then the workflow works again.
  assert.deepEqual(drifted.steps.find((s) => s.op === "browser.click")!.args.target, { role: "button", name: "Greet" });
  const fixed = applyProposal(drifted, bad.stepId, 0, proposals);
  assert.deepEqual(fixed.steps.find((s) => s.id === bad.stepId)!.args.target, { css: "#go" });
  const ok = await engine.start(fixed).done;
  assert.equal(ok.status, "succeeded", JSON.stringify(ok.error));
});
