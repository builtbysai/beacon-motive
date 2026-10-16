import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Store } from "../src/store.ts";
import { parseWorkflow } from "../src/workflow.ts";

// Drives the real `motive mcp` process over stdio, as an MCP client would. The workflows use the core adapter only.
test("MCP server: lists and describes freely, runs only allowed workflows, never takes secrets", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "motive-mcp-"));
  const store = new Store(path.join(home, "motive.db"));
  store.saveWorkflow(parseWorkflow({ format: "motive.workflow/1", name: "echo", description: "carries a value", inputs: { n: { type: "number", default: 1 } }, steps: [{ id: "s", op: "core.set", args: { value: "${inputs.n}" } }], outputs: { got: "${steps.s.value}" } }));
  store.saveWorkflow(parseWorkflow({ format: "motive.workflow/1", name: "locked", inputs: { pw: { type: "string", secret: true, default: "x" } }, steps: [{ id: "s", op: "core.set", args: { value: "ok" } }] }));
  store.saveWorkflow(parseWorkflow({ format: "motive.workflow/1", name: "blocked", steps: [{ id: "s", op: "core.set", args: { value: "no" } }] }));
  store.close();

  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.ts", "mcp", "--allow", "echo,locked"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, MOTIVE_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map<number, (m: any) => void>();
  createInterface({ input: child.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let nextId = 1;
  const rpc = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const tool = async (name: string, args: unknown = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  const body = (r: any) => JSON.parse(r.content[0].text);

  try {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "beacon-motive");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const tools = (await rpc("tools/list")).result.tools.map((t: any) => t.name);
    assert.deepEqual(tools, ["motive_capabilities", "motive_list_workflows", "motive_describe_workflow", "motive_run_workflow", "motive_get_run"]);

    assert.deepEqual(body(await tool("motive_list_workflows")).workflows.sort(), ["blocked", "echo", "locked"]);
    const d = body(await tool("motive_describe_workflow", { name: "locked" }));
    assert.equal(d.inputs.pw.secret, true);
    assert.equal(d.inputs.pw.default, undefined, "a secret's default is never shown");
    assert.equal(d.allowedForMcp, true);
    assert.equal(body(await tool("motive_describe_workflow", { name: "blocked" })).allowedForMcp, false);

    const ran = await tool("motive_run_workflow", { name: "echo", inputs: { n: 42 } });
    assert.equal(ran.isError, undefined);
    const out = body(ran);
    assert.equal(out.status, "succeeded");
    assert.equal(out.outputs.got, 42);
    const again = body(await tool("motive_get_run", { id: out.id }));
    assert.equal(again.steps[0].status, "succeeded");

    const refused = await tool("motive_run_workflow", { name: "blocked" });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /not allowed for MCP/);
    const secret = await tool("motive_run_workflow", { name: "locked", inputs: { pw: "hunter2" } });
    assert.equal(secret.isError, true);
    assert.match(secret.content[0].text, /secret/);

    assert.equal((await rpc("nope/nothing")).error.code, -32601);
  } finally {
    child.stdin.end();
    child.kill();
  }
});
