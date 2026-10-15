# Benchmarks

Real runs from `scripts/bench.ts`, 10 runs each, on one Windows 11 PC (the developer machine; Node 22.22, Chrome stable, Windows Calculator 11.2607). Model calls: 0. These are single-machine numbers with no manual-speed comparison, so they support no claim about being faster than a person.

| Workflow | Success | Wall median | Wall p95 |
| --- | --- | --- | --- |
| `browser-greet` (5 steps, local page with a 400 ms delayed result) | 10/10 | 1181 ms | 1235 ms |
| `windows-calculator-add` (8 steps incl. launch and close) | 10/10 | 1051 ms | 1096 ms |
| `mixed-calc-to-web` (14 steps: desktop, file, browser) | 10/10 | 2261 ms | 2743 ms |

Per operation, medians in ms (p95 in the script output): browser.open 419–433 (includes launching Chrome), browser.fill 23–28, browser.click 184–188 (Playwright actionability checks), browser.read 413–416 (waits out the page's own 400 ms delay, no fixed sleep), win.launch 681–684 (process start plus waiting for the window), win.click 43, win.read 32, win.close 108–111 (now waits until the window is really gone), fs.write/read 1.

Change since the first measurement: the Windows helper now caches resolved windows and controls (re-validated on every use). `win.click` went from 80 ms to 43 ms and `win.read` from 70 ms to 32 ms. `win.close` became slower on purpose (41 → 108 ms) because it now confirms the window closed; the earlier 1 ms intermediate figure was the close request only.

Engine process peak RSS about 115–137 MB (excludes Chrome and Calculator). One Windows 11 PC, Node 22.22, Chrome stable, Calculator 11.2607; no manual-speed comparison, so no claim about beating a person. Reproduce: `node --disable-warning=ExperimentalWarning scripts/bench.ts 10`.

Not measured yet: CPU use, large trees, cold start of the helper, other hardware.

## Native Windows Forms app (`windows-form-fixture`, 14 steps)

10/10 successful, wall median 1053 ms (p95 1184 ms): typing two fields, toggling a checkbox, choosing a combo and a list item, a button, a menu, close. Per op median: win.launch 228, win.type 257 (8 ms per character pacing, 11 + 5 characters), win.click 56, win.setValue 48, win.select 55, win.read 5, win.close 15 ms.

## Android (Pixel 7a, Android 17, USB)

`android-settings-tour` (7 steps), 2 real runs: 10.5 s and 10.9 s, both successful. Per op: android.key about 70–90 ms, android.launch 420–880 ms, each click/read/wait that observes the screen 2.2–2.8 s (dominated by `uiautomator dump`). Two runs is not a benchmark; it is a sanity figure.
