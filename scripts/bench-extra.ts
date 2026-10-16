// Measures what bench.ts does not: Windows helper cold start, idle helper CPU and memory, accessibility-tree read time on a
// larger tree, and the engine process's own CPU time during a run. Windows only; needs the built helper and, for the tree
// figure, the built desktop app (a WebView2 window has a large tree).
// Usage: node --disable-warning=ExperimentalWarning scripts/bench-extra.ts
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { sidecarPath, WinClient } from "../src/adapters/windows.ts";
import { Engine } from "../src/engine.ts";
import { Store } from "../src/store.ts";
import { parseWorkflow } from "../src/workflow.ts";

const exe = sidecarPath();
if (process.platform !== "win32" || !exe) throw new Error("needs Windows and: npm run build:win");
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const count = (n: any): number => 1 + (n.children ?? []).reduce((s: number, c: any) => s + count(c), 0);
const ps = (cmd: string) => execFileSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).trim();

console.log(`node ${process.version} on ${process.platform}\n`);

// 1. Cold start: spawn the helper and wait for its first reply.
const cold: number[] = [];
for (let i = 0; i < 10; i++) {
  const t0 = performance.now();
  const c = new WinClient(exe);
  await c.call("ping");
  cold.push(performance.now() - t0);
  c.close();
}
console.log(`helper cold start (spawn to first reply), 10 runs: median ${Math.round(median(cold))} ms, max ${Math.round(Math.max(...cold))} ms`);

// 2. Idle helper: CPU seconds used over 10 s and working set.
const idle = new WinClient(exe);
await idle.call("ping");
const pid = Number(ps(`(Get-Process motive-win-uia | Sort-Object StartTime -Descending | Select-Object -First 1).Id`));
const cpu0 = Number(ps(`(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`));
await new Promise((r) => setTimeout(r, 10_000));
const cpu1 = Number(ps(`(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`));
const ws = Number(ps(`(Get-Process -Id ${pid}).WorkingSet64`)) / 1048576;
console.log(`idle helper over 10 s: ${Math.round(cpu1 - cpu0)} ms CPU, working set ${ws.toFixed(1)} MB`);

// 3. Tree reads, on the desktop app's window if it is open.
try {
  const wins: any[] = (await idle.call("windows.list")) as any[];
  const target = wins.find((w) => w.name === "Beacon Motive");
  if (!target) console.log("tree read: open the desktop app (apps/desktop release exe) to measure a large tree");
  else {
    for (const depth of [3, 6, 10]) {
      const times: number[] = [];
      let nodes = 0;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const tree = await idle.call("tree", { window: { name: "Beacon Motive" }, depth });
        times.push(performance.now() - t0);
        nodes = count(tree);
      }
      console.log(`tree of "Beacon Motive" depth ${depth}: ${nodes} nodes, median ${Math.round(median(times))} ms (5 reads)`);
    }
  }
} finally {
  idle.close();
}

// 4. The engine process's own CPU during runs (excludes Chrome, which does the browser work).
process.env.MOTIVE_SECRET_PASSWORD = "bench-password";
const engine = new Engine(new Store(":memory:"));
const w = parseWorkflow(JSON.parse(readFileSync(new URL("../examples/browser-greet.json", import.meta.url), "utf8")));
const before = process.cpuUsage();
const t0 = performance.now();
let ok = 0;
for (let i = 0; i < 10; i++) if ((await engine.start(w).done).status === "succeeded") ok++;
const wall = performance.now() - t0;
const used = process.cpuUsage(before);
console.log(`engine process CPU over 10 browser-greet runs: ${Math.round((used.user + used.system) / 1000)} ms CPU in ${Math.round(wall)} ms wall (${ok}/10 succeeded; Chrome not included)`);
void spawn;
