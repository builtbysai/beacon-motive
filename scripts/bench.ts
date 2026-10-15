// Runs the example workflows repeatedly and prints wall time, success rate and per-op latency.
// Usage: node --disable-warning=ExperimentalWarning scripts/bench.ts [runs]
import { readFileSync } from "node:fs";
import { Engine } from "../src/engine.ts";
import { Store } from "../src/store.ts";
import { parseWorkflow } from "../src/workflow.ts";

const runs = Number(process.argv[2] ?? 10);
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(a.length * 0.95) - 1)] ?? 0;

process.env.MOTIVE_SECRET_PASSWORD = "bench-password";
const engine = new Engine(new Store(":memory:"));
console.log(`node ${process.version} on ${process.platform}; ${runs} runs each; model calls: 0\n`);

for (const file of ["browser-greet.json", "windows-calculator-add.json", "mixed-calc-to-web.json"]) {
  const w = parseWorkflow(JSON.parse(readFileSync(new URL(`../examples/${file}`, import.meta.url), "utf8")));
  const cap = (await engine.capabilities()).filter((c) => !c.available && w.steps.some((s) => c.ops.includes(s.op)));
  if (cap.length) {
    console.log(`${w.name}: skipped (${cap[0]!.reason})`);
    continue;
  }
  const total: number[] = [];
  const perOp = new Map<string, number[]>();
  let ok = 0;
  const rss: number[] = [];
  for (let i = 0; i < runs; i++) {
    const r = await engine.start(w).done;
    if (r.status === "succeeded") ok++;
    total.push(r.durationMs!);
    for (const s of r.steps) (perOp.get(s.op) ?? perOp.set(s.op, []).get(s.op)!).push(s.durationMs);
    rss.push(process.memoryUsage().rss / 1048576);
  }
  console.log(`${w.name}: success ${ok}/${runs}, wall median ${median(total)} ms, p95 ${p95(total)} ms, engine RSS ${Math.round(Math.max(...rss))} MB`);
  for (const [op, v] of perOp) console.log(`   ${op.padEnd(14)} median ${String(median(v)).padStart(5)} ms  p95 ${String(p95(v)).padStart(5)} ms`);
}
