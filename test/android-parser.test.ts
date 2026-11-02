import { test } from "node:test";
import assert from "node:assert/strict";
import { matches, parseDump } from "../src/adapters/android.ts";
import { toNodes } from "../src/adapters/android-helper.ts";

// XML/helper payload parsing only. Never constructs an adapter or probes adb/devices.
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
