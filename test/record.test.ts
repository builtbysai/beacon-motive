import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { chromePath } from "../src/adapters/browser.ts";
import { Engine } from "../src/engine.ts";
import { Recorder } from "../src/record/recorder.ts";
import { AmbiguousRecording, compile, type RecordedStep } from "../src/record/compile.ts";
import { Store } from "../src/store.ts";

const exe = chromePath();
const fixture = (f: string) => pathToFileURL(path.resolve("examples/fixtures", f)).href;

async function demonstrate(file: string, act: (page: import("playwright-core").Page) => Promise<void>): Promise<RecordedStep[]> {
  const browser = await chromium.launch({ executablePath: exe!, headless: true });
  try {
    const context = await browser.newContext();
    const rec = new Recorder();
    await rec.attach(context, fixture(file));
    const page = await context.newPage();
    await page.goto(fixture(file));
    await act(page);
    await rec.idle();
    return rec.steps;
  } finally {
    await browser.close();
  }
}

test("Teach Mode: record a demonstration, compile, replay with new values", { skip: !exe && "no Chrome/Edge" }, async () => {
  const steps = await demonstrate("form.html", async (page) => {
    await page.getByLabel("Your name").pressSequentially("Grace");
    await page.getByLabel("Password").pressSequentially("correct-horse-battery");
    await page.getByRole("button", { name: "Greet" }).click();
    await page.getByRole("status").filter({ hasText: "Hello" }).waitFor();
    await page.waitForTimeout(100);
  });

  assert.deepEqual(steps.map((s) => s.kind), ["open", "fill", "fill", "click"]);
  assert.ok(steps.slice(1).every((s) => s.verified === "unique"), "every action must be tied to exactly one element");
  assert.equal(JSON.stringify(steps).includes("correct-horse-battery"), false, "a password must never be captured");

  const { workflow, warnings } = compile(steps, { name: "recorded-greet", expectText: "Hello, Grace!" });
  assert.equal(warnings.some((w) => /No expected result/.test(w)), false);
  assert.deepEqual(Object.keys(workflow.inputs), ["yourName", "password"]);
  assert.equal(workflow.inputs.password?.secret, true);
  assert.equal(workflow.inputs.yourName?.default, "Grace");
  assert.equal(JSON.stringify(workflow).includes("correct-horse-battery"), false);
  assert.deepEqual(workflow.scopes.hosts, []);
  assert.equal(workflow.steps.at(-1)?.args.target && JSON.stringify(workflow.steps.at(-1)!.args.target), '{"text":"Hello, ${inputs.yourName}!"}');

  // Replay the compiled workflow with a different value; the expected text follows the input.
  const engine = new Engine(new Store(":memory:"));
  process.env.MOTIVE_SECRET_PASSWORD = "another-secret";
  const r = await engine.start(workflow, { yourName: "Linus" }).done;
  delete process.env.MOTIVE_SECRET_PASSWORD;
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  assert.ok(r.steps.at(-1)?.durationMs !== undefined);
});

test("Teach Mode: select and Enter are captured; card field is treated as secret", { skip: !exe && "no Chrome/Edge" }, async () => {
  const steps = await demonstrate("order.html", async (page) => {
    await page.getByLabel("Size").selectOption("Large");
    await page.getByLabel("Card number").pressSequentially("4111111111111111");
    await page.getByLabel("Customer").pressSequentially("Ada");
    await page.keyboard.press("Enter");
    await page.getByRole("status").filter({ hasText: "Ordered" }).waitFor();
    await page.waitForTimeout(100);
  });
  assert.deepEqual(steps.map((s) => s.kind), ["open", "select", "fill", "fill", "press"]);
  assert.equal(JSON.stringify(steps).includes("4111111111111111"), false);
  const { workflow } = compile(steps, { name: "recorded-order", expectText: "Ordered Large for Ada" });
  assert.equal(workflow.inputs.cardNumber?.secret, true);

  const engine = new Engine(new Store(":memory:"));
  process.env.MOTIVE_SECRET_CARDNUMBER = "4000000000000002";
  const r = await engine.start(workflow, { size: "Small", customer: "Bob" }).done;
  delete process.env.MOTIVE_SECRET_CARDNUMBER;
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
});

test("compile refuses to guess an action it cannot identify", () => {
  const steps: RecordedStep[] = [{ kind: "open", url: "https://example.com/" }, { kind: "click", verified: "ambiguous", label: "OK", target: { text: "OK", exact: false } }];
  assert.throws(() => compile(steps, { name: "x" }), AmbiguousRecording);
});
