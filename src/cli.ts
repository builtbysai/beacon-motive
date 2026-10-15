#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Engine, type RunEvent } from "./engine.ts";
import { toErrorInfo } from "./errors.ts";
import { apiToken, dbPath, tokenFile } from "./paths.ts";
import { startServer } from "./server.ts";
import { Store } from "./store.ts";
import { sidecarPath, WinClient } from "./adapters/windows.ts";
import { parseWorkflow, type Workflow } from "./workflow.ts";
import { compile } from "./record/compile.ts";
import { recordSession } from "./record/recorder.ts";
import { writeFileSync } from "node:fs";

const USAGE = `motive <command>

  capabilities                       what this machine can automate, and why not when it cannot
  validate <file.json>               check a workflow file
  save <file.json>                   store a workflow
  list                               stored workflows
  run <name|file.json> [-i k=v ...]  run a workflow (Ctrl-C cancels); --json prints the final record
  history [run-id]                   past runs, or one run in detail
  record <url> --name <n> [--out f.json] [--expect-text t] [--save]
                                     Teach Mode: demonstrate in a visible browser, close it to finish
  inspect windows                    top-level windows (Windows)
  inspect tree --window <name> [--depth n]
  serve [--port n]                   local API on 127.0.0.1 (token in ${tokenFile()})
  audit                              recent audit entries

Secret inputs are never taken on the command line: set MOTIVE_SECRET_<NAME>.`;

function loadWorkflow(arg: string, store: Store): Workflow {
  if (arg.endsWith(".json")) return parseWorkflow(JSON.parse(readFileSync(arg, "utf8")));
  const w = store.getWorkflow(arg);
  if (!w) throw new Error(`no stored workflow named ${arg} (give a .json file or save it first)`);
  return w;
}

function line(e: RunEvent): string | undefined {
  if (e.type === "step.start" && e.step) return `  … ${"op" in e.step ? e.step.op : ""} ${e.step.stepId}`;
  if (e.type === "step.end" && e.step && "status" in e.step) {
    const mark = e.step.status === "succeeded" ? "✓" : "✗";
    return `  ${mark} ${e.step.stepId} (${e.step.op}) ${e.step.durationMs} ms${e.step.attempts > 1 ? `, ${e.step.attempts} attempts` : ""}${e.step.error ? ` — ${e.step.error.code}: ${e.step.error.message}` : ""}`;
  }
  return undefined;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: "string", short: "i", multiple: true },
      json: { type: "boolean", default: false },
      port: { type: "string" },
      window: { type: "string" },
      depth: { type: "string" },
      name: { type: "string" },
      out: { type: "string" },
      "expect-text": { type: "string" },
      save: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, arg] = positionals;
  if (!cmd || values.help) {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }

  if (cmd === "inspect") {
    const exe = sidecarPath();
    if (process.platform !== "win32" || !exe) {
      console.error("Windows inspection needs Windows and the built helper (npm run build:win).");
      return 1;
    }
    const c = new WinClient(exe);
    try {
      if (arg === "windows") console.log(JSON.stringify(await c.call("windows.list"), null, 2));
      else if (arg === "tree" && values.window) console.log(JSON.stringify(await c.call("tree", { window: { name: values.window }, depth: Number(values.depth ?? 4) }), null, 2));
      else {
        console.error("usage: motive inspect windows | motive inspect tree --window <name> [--depth n]");
        return 2;
      }
    } finally {
      c.close();
    }
    return 0;
  }

  const store = new Store(dbPath());
  try {
    const recovered = store.failInterruptedRuns();
    if (recovered) console.error(`(marked ${recovered} interrupted run(s) as failed)`);
    const engine = new Engine(store);

    switch (cmd) {
      case "capabilities": {
        const caps = await engine.capabilities();
        if (values.json) console.log(JSON.stringify(caps, null, 2));
        else for (const c of caps) console.log(`${c.available ? "available  " : "unavailable"} ${c.adapter.padEnd(8)} ${c.available ? c.ops.join(" ") : c.reason}`);
        return 0;
      }
      case "validate": {
        const w = parseWorkflow(JSON.parse(readFileSync(arg ?? "", "utf8")));
        console.log(`ok: ${w.name}, ${w.steps.length} steps`);
        return 0;
      }
      case "save": {
        const w = parseWorkflow(JSON.parse(readFileSync(arg ?? "", "utf8")));
        store.saveWorkflow(w);
        store.audit("cli", "workflow.save", { name: w.name });
        console.log(`saved ${w.name}`);
        return 0;
      }
      case "list":
        for (const w of store.listWorkflows()) console.log(`${w.name}  (${w.updatedAt})`);
        return 0;
      case "run": {
        const w = loadWorkflow(arg ?? "", store);
        const inputs: Record<string, unknown> = {};
        for (const kv of values.input ?? []) {
          const i = kv.indexOf("=");
          if (i < 1) throw new Error(`bad --input ${kv}; use name=value`);
          const key = kv.slice(0, i);
          if (w.inputs[key]?.secret) throw new Error(`input ${key} is secret; set MOTIVE_SECRET_${key.toUpperCase()} instead of passing it on the command line`);
          inputs[key] = kv.slice(i + 1);
        }
        const run = engine.start(w, inputs, { actor: "cli" });
        if (!values.json) {
          console.log(`run ${run.id} ${w.name}`);
          engine.events.on(`run:${run.id}`, (e: RunEvent) => {
            const l = line(e);
            if (l && e.type === "step.end") console.log(l);
          });
        }
        process.once("SIGINT", () => run.cancel("cancelled from the keyboard"));
        const r = await run.done;
        if (values.json) console.log(JSON.stringify(r, null, 2));
        else {
          console.log(`${r.status} in ${r.durationMs} ms`);
          if (r.outputs && Object.keys(r.outputs).length) console.log(JSON.stringify(r.outputs));
          if (r.error) console.log(`${r.error.code}: ${r.error.message}`);
        }
        return r.status === "succeeded" ? 0 : r.status === "cancelled" ? 130 : 1;
      }
      case "record": {
        if (!arg || !values.name) throw new Error("usage: motive record <url> --name <workflow-name> [--out file.json] [--expect-text t] [--save]");
        const abort = new AbortController();
        process.once("SIGINT", () => abort.abort());
        const steps = await recordSession(arg, () => console.log("● Recording. Do the task in the browser window; close it (or press Ctrl-C) to finish. Passwords are not captured."), abort.signal);
        const { workflow, warnings } = compile(steps, { name: values.name, ...(values["expect-text"] ? { expectText: values["expect-text"] } : {}) });
        const out = values.out ?? `${values.name}.json`;
        writeFileSync(out, JSON.stringify(workflow, null, 2) + "\n");
        console.log(`Wrote ${out}: ${workflow.steps.length} steps, inputs: ${Object.keys(workflow.inputs).join(", ") || "none"}, scopes: ${JSON.stringify(workflow.scopes)}`);
        for (const w of warnings) console.log(`  ! ${w}`);
        if (values.save) {
          store.saveWorkflow(workflow);
          store.audit("cli", "workflow.save", { name: workflow.name, recorded: true });
          console.log("Saved to the library.");
        } else console.log("Review the file, then: motive save " + out);
        return 0;
      }
      case "history": {
        if (arg) console.log(JSON.stringify(store.getRun(arg), null, 2));
        else for (const r of store.listRuns(20)) console.log(`${r.id}  ${r.status.padEnd(9)} ${String(r.durationMs ?? "").padStart(6)} ms  ${r.workflow}  ${r.startedAt}`);
        return 0;
      }
      case "audit":
        for (const a of store.listAudit(30)) console.log(`${a.ts}  ${a.actor}  ${a.action}  ${a.detail ? JSON.stringify(a.detail) : ""}`);
        return 0;
      case "serve": {
        const token = apiToken();
        const handle = await startServer(engine, token, Number(values.port ?? 0));
        console.log(`Local API on http://127.0.0.1:${handle.port}/v1 (loopback only).`);
        console.log(`Token: ${tokenFile()}  — send it as "Authorization: Bearer <token>". Ctrl-C stops.`);
        await new Promise<void>((resolve) => process.once("SIGINT", resolve));
        engine.stopAll("server stopping");
        await handle.close();
        return 0;
      }
      default:
        console.error(USAGE);
        return 2;
    }
  } finally {
    store.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    const info = toErrorInfo(e);
    console.error(`error: ${info.message}`);
    process.exit(1);
  },
);
