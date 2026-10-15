import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.ts";
import { startServer } from "../src/server.ts";
import { sidecarPath } from "../src/adapters/windows.ts";
import { Store } from "../src/store.ts";

const can = process.platform === "win32" && Boolean(sidecarPath());

test("inspector API lists real windows and a window's control tree, and audits the look", { skip: !can && "needs Windows and the built helper" }, async () => {
  const store = new Store(":memory:");
  const server = await startServer(new Engine(store, { adapters: [] }), "tok");
  const get = async (path: string) => {
    const r = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { authorization: "Bearer tok" } });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    const list = await get("/v1/inspect/windows");
    assert.equal(list.status, 200);
    const windows = list.body.windows as { name: string }[];
    assert.ok(Array.isArray(windows) && windows.length > 0, "the desktop has windows");
    const named = windows.find((w) => w.name && w.name.length < 100);
    assert.ok(named);
    const tree = await get(`/v1/inspect/tree?window=${encodeURIComponent(named!.name)}&depth=2`);
    assert.equal(tree.status, 200);
    assert.ok(tree.body.tree);
    assert.equal((await get("/v1/inspect/tree")).status, 400, "a window name is required");
    const actions = store.listAudit(10).map((a) => a.action);
    assert.ok(actions.includes("inspect.windows") && actions.includes("inspect.tree"));
  } finally {
    await server.close();
  }
});
