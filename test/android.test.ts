import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { androidAdapter } from "../src/adapters/android.ts";
import { Engine } from "../src/engine.ts";
import { applyProposal, proposalsFor } from "../src/heal.ts";
import { Store } from "../src/store.ts";
import { parseWorkflow } from "../src/workflow.ts";

test("android: a workflow with no declared package cannot read or press anything", async () => {
  const e = new Engine(new Store(":memory:"), { adapters: [androidAdapter] });
  if (!androidAdapter().capability().available) return; // no device: the preflight refusal is covered by the capability check
  const w = parseWorkflow({ format: "motive.workflow/1", name: "t", steps: [{ id: "k", op: "android.key", args: { key: "home" } }] });
  assert.equal((await e.start(w).done).error?.code, "scope_denied");
  const w2 = parseWorkflow({ format: "motive.workflow/1", name: "t", scopes: { apps: ["com.android.settings"] }, steps: [{ id: "l", op: "android.launch", args: { package: "com.other.app" } }] });
  assert.equal((await e.start(w2).done).error?.code, "scope_denied");
});

const optIn = process.env.MOTIVE_TEST_ANDROID === "1" && androidAdapter().capability().available;
test("real Android phone: Settings tour verifies and changes nothing", { skip: !optIn && "set MOTIVE_TEST_ANDROID=1 with an unlocked, authorised phone" }, async () => {
  const w = parseWorkflow(JSON.parse(readFileSync(new URL("../examples/android-settings-tour.json", import.meta.url), "utf8")));
  const r = await new Engine(new Store(":memory:")).start(w).done;
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  assert.equal(r.outputs?.reached, "Default apps");
});

const helperOptIn = optIn && process.env.MOTIVE_TEST_ANDROID_HELPER === "1";
test("real Android phone with the helper: scroll and type non-ASCII text", { skip: !helperOptIn && "set MOTIVE_TEST_ANDROID=1 and MOTIVE_TEST_ANDROID_HELPER=1 with the helper installed" }, async () => {
  const w = parseWorkflow(JSON.parse(readFileSync(new URL("../examples/android-settings-swipe-search.json", import.meta.url), "utf8")));
  const r = await new Engine(new Store(":memory:")).start(w).done;
  assert.equal(r.status, "succeeded", JSON.stringify(r.error));
  assert.equal(r.outputs?.typed, "Zoë café 日本");
});

test("real Android device: a stale target fails with a validated proposal, the repair is applied, and the rerun passes", { skip: !optIn && "set MOTIVE_TEST_ANDROID=1 with an unlocked, authorised device (and MOTIVE_ANDROID_SERIAL if several)" }, async () => {
  const w = parseWorkflow(JSON.parse(readFileSync(new URL("../examples/android-heal-demo.json", import.meta.url), "utf8")));
  const engine = new Engine(new Store(":memory:"));
  const failed = await engine.start(w).done;
  assert.equal(failed.status, "failed");
  const proposals = proposalsFor(failed);
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0]!.targets, [{ resourceId: "title", text: "Apps" }], "the alternative that matches nothing is not proposed");
  const fixed = applyProposal(w, "apps", 0, proposals);
  const rerun = await engine.start(fixed).done;
  assert.equal(rerun.status, "succeeded", JSON.stringify(rerun.error));
  assert.equal(rerun.outputs?.reached, "Default apps");
});
