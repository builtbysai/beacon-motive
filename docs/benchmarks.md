# Benchmarks

Real runs from `scripts/bench.ts`, 10 runs each, on one Windows 11 PC (the developer machine; Node 22.22, Chrome stable, Windows Calculator 11.2607). Model calls: 0. These are single-machine numbers with no manual-speed comparison, so they support no claim about being faster than a person.

| Workflow | Success | Wall median | Wall p95 |
| --- | --- | --- | --- |
| `browser-greet` (5 steps, local page with a 400 ms delayed result) | 10/10 | 1218 ms | 1259 ms |
| `windows-calculator-add` (8 steps incl. launch and close) | 10/10 | 1242 ms | 1256 ms |

Per operation (median / p95, ms):

| Op | Median | p95 | Note |
| --- | --- | --- | --- |
| browser.open | 423 | 448 | includes launching Chrome (new process each run) |
| browser.fill | 22 | 26 | |
| browser.click | 196 | 229 | Playwright actionability checks (visible, stable, enabled) |
| browser.read | 451 | 464 | waits out the page's own 400 ms delay; no fixed sleep is used |
| win.launch | 718 | 730 | process start plus waiting for the window to appear |
| win.click | 80 | 99 | window re-resolved on every call; known optimisation target |
| win.read | 70 | 76 | |
| win.close | 41 | 43 | |

Engine process peak RSS 136 MB (excludes Chrome and Calculator). Run `node --disable-warning=ExperimentalWarning scripts/bench.ts 10` to reproduce.

Not measured yet: CPU use, large trees, cold start of the sidecar, other hardware.
