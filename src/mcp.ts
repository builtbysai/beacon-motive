import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Engine } from "./engine.ts";
import { toErrorInfo } from "./errors.ts";
import type { Store } from "./store.ts";

// A Model Context Protocol server over stdio (ADR 0013), so an AI client can use saved workflows as tools. The engine
// itself stays AI-free: this is just another front door to the same engine, with the same scopes and limits.
//
// Consent boundary: listing and describing workflows is always allowed; RUNNING one is allowed only for names passed to
// `motive mcp --allow a,b`. Secret inputs are never accepted through MCP (they come from MOTIVE_SECRET_* in the server's
// environment, which the client does not control). Results never include secret values (the engine redacts them).

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "beacon-motive", version: "0.1.0" };

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: any;
}

const TOOLS = [
  {
    name: "motive_capabilities",
    description: "Which automation adapters work on this machine (browser, windows, android, filesystem) and why any do not.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "motive_list_workflows",
    description: "Names of the saved workflows.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "motive_describe_workflow",
    description: "A saved workflow's description, inputs (and which are secret), declared scopes and steps. Read this before running it.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "motive_run_workflow",
    description: "Runs a saved workflow that the user has allowed for MCP and waits for it to finish. It acts on the user's real browser, apps, files or phone within the workflow's declared scopes. Secret inputs cannot be passed here.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, inputs: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } } }, required: ["name"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "motive_get_run",
    description: "The outcome of a past run: status, outputs, and each step's result.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });

export async function callTool(engine: Engine, store: Store, allow: string[], name: string, args: Record<string, any>) {
  try {
    switch (name) {
      case "motive_capabilities":
        return text({ adapters: await engine.capabilities() });
      case "motive_list_workflows":
        return text({ workflows: store.listWorkflows().map((w) => w.name) });
      case "motive_describe_workflow": {
        const w = store.getWorkflow(String(args.name ?? ""));
        if (!w) return text("no such workflow", true);
        return text({
          name: w.name,
          description: w.description ?? "",
          inputs: Object.fromEntries(Object.entries(w.inputs).map(([k, d]) => [k, { type: d.type, secret: d.secret, ...(d.secret ? {} : d.default !== undefined ? { default: d.default } : {}) }])),
          scopes: w.scopes,
          steps: w.steps.map((s) => ({ id: s.id, op: s.op })),
          allowedForMcp: allow.includes(w.name),
        });
      }
      case "motive_run_workflow": {
        const wfName = String(args.name ?? "");
        if (!allow.includes(wfName)) return text(`workflow "${wfName}" is not allowed for MCP. The user must start the server with --allow ${wfName}.`, true);
        const w = store.getWorkflow(wfName);
        if (!w) return text("no such workflow", true);
        const inputs = (args.inputs ?? {}) as Record<string, unknown>;
        for (const k of Object.keys(inputs)) if (w.inputs[k]?.secret) return text(`input ${k} is secret and cannot be passed through MCP`, true);
        const run = engine.start(w, inputs, { actor: "mcp" });
        const r = await run.done;
        return text({ id: r.id, status: r.status, durationMs: r.durationMs, outputs: r.outputs ?? {}, ...(r.error ? { error: r.error } : {}) }, r.status !== "succeeded");
      }
      case "motive_get_run": {
        const r = store.getRun(String(args.id ?? ""));
        return r ? text({ id: r.id, workflow: r.workflow, status: r.status, outputs: r.outputs ?? {}, error: r.error, steps: r.steps.map((s) => ({ id: s.stepId, op: s.op, status: s.status, error: s.error })) }) : text("no such run", true);
      }
      default:
        return text(`unknown tool ${name}`, true);
    }
  } catch (e) {
    const info = toErrorInfo(e);
    return text(`${info.code}: ${info.message}`, true);
  }
}

export async function handle(engine: Engine, store: Store, allow: string[], msg: Rpc): Promise<object | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return undefined; // notifications (initialized, cancelled) need no reply
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return reply({ protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: "Saved Beacon Motive workflows as tools. Describe a workflow before running it; running is limited to the workflows the user allowed." });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call":
      return reply(await callTool(engine, store, allow, String(msg.params?.name ?? ""), msg.params?.arguments ?? {}));
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

/** Serves JSON-RPC lines from `input` to `output` until the input ends. Diagnostics go to stderr, never to stdout. */
export async function serveMcp(engine: Engine, store: Store, allow: string[], input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const rl = createInterface({ input });
  const pending: Promise<void>[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    pending.push(
      (async () => {
        let msg: Rpc;
        try {
          msg = JSON.parse(line) as Rpc;
        } catch {
          output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
          return;
        }
        const res = await handle(engine, store, allow, msg);
        if (res) output.write(JSON.stringify(res) + "\n");
      })(),
    );
  }
  await Promise.all(pending);
}
