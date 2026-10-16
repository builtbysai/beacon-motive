import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { androidAdapter, matches, parseDump } from "../src/adapters/android.ts";
import { toNodes } from "../src/adapters/android-helper.ts";
import { Engine } from "../src/engine.ts";
import { applyProposal, proposalsFor } from "../src/heal.ts";
import { Store } from "../src/store.ts";
import { parseWorkflow } from "../src/workflow.ts";

const node = (pkg: string, attrs: string) =>
  `<node index="0" text="" resource-id="" class="android.widget.TextView" package="${pkg}" content-desc="" clickable="false" enabled="true" password="false" checked="false" bounds="[0,0][100,50]" ${attrs} />`;

test("android dump: nodes outside the allowed packages are dropped before anything can read them", () => {
  const xml = `<hierarchy>${node("com.android.systemui", 'text="Secret notification"')}${node("com.android.settings", 'text="Apps &amp; more"')}</hierarchy>`;
  const nodes = parseDump(xml, ["com.android.settings"]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.text, "Apps & more");
  assert.equal(JSON.stringify(nodes).includes("Secret"), false);
  assert.equal(parseDump(xml, []).length, 0);
});

test("android helper: nodes of other packages are dropped on the computer too, even if the helper sent them", () => {
  const raw = (pkg: string, text: string) => ({ text, resourceId: "", className: "x", package: pkg, contentDesc: "", clickable: false, enabled: true, password: false, checked: false, editable: false, bounds: [0, 0, 10, 10] as [number, number, number, number] });
  const nodes = toNodes([raw("com.android.systemui", "Secret notification"), raw("com.android.settings", "Apps")], ["com.android.settings"]);
  assert.deepEqual(nodes.map((n) => n.text), ["Apps"]);
  assert.deepEqual(nodes[0]!.bounds, { left: 0, top: 0, right: 10, bottom: 10 });
  assert.equal(toNodes([raw("a.b", "x")], []).length, 0);
});

test("android selectors: short resource ids, case-insensitive contains, zero-area nodes never match", () => {
  const [n] = parseDump(`<hierarchy>${node("p.q", 'text="Network &amp; internet"').replace('resource-id=""', 'resource-id="p.q:id/title"')}</hierarchy>`, ["p.q"]);
  assert.ok(matches(n!, { resourceId: "title", text: "Network & internet" }));
  assert.ok(matches(n!, { textContains: "NETWORK" }));
  assert.ok(!matches(n!, { resourceId: "summary" }));
  assert.ok(!matches({ ...n!, bounds: { left: 0, top: 0, right: 0, bottom: 0 } }, { textContains: "network" }));
});

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
