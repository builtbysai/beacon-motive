import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { androidAdapter, matches, parseDump } from "../src/adapters/android.ts";
import { Engine } from "../src/engine.ts";
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
