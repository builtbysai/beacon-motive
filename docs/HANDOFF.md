# Handoff: beacon-motive

Read this first, then `docs/roadmap.md` (the source of truth for what is done), then the ADRs in `docs/decisions/` as needed. Last updated at commit after `038ee54`.

## What this is

A standalone, open-source, local-first, **AI-optional** automation engine ("universal automation"): one JSON workflow can mix browser, Windows-desktop, Android and filesystem steps, runs deterministically through semantic selectors (DOM roles/labels, UI Automation, UI Automator), verifies the state it expects, and makes **zero model calls**. A user can also demonstrate a task (Teach Mode) and replay it with new values. It is independent of Beacon Remote and Beacon View: **do not modify those**, and do not add any dependency on Beacon infrastructure. The only Beacon tie is a future, separately authorised, local-API client.

Repo: https://github.com/builtbysai/beacon-motive (branch `main`, local clone `C:\Dev\beacon-motive`). The user has been authorising commits and pushes to `main` of this repo; commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Original brief (condensed, still binding)

Independent product; free and local-first; cross-platform architecture (Windows, macOS, Linux, browsers, later Android); AI-optional core; learning by demonstration (no model training); fast execution (APIs and accessibility trees before OCR/vision, no fixed sleeps, no screenshot-per-action LLM loops); every meaningful action state-checked, with timeouts, cancellation, bounded retries; honest capability reporting (never call experimental support production-ready, never claim performance without measurement, no mocked outputs as proof). Security: explicit recording activation and visible state, never capture passwords, scoped permissions, never bypass UAC/consent/auth, no silent shell execution, local-only authenticated API, cancellation + emergency stop + audit trail, no telemetry. Milestones: 0 research, 1 foundation, 2 Teach and Replay, 3 platform expansion, 4 adaptive intelligence (local models/OCR/vision), 5 integration and polish (desktop UI, installer, scheduling, plugins, Beacon Remote connector).

## Current state (verified on this machine)

Milestone 0 done. Milestone 1 done for Windows + Chrome. Milestone 2 working for the browser and Windows apps. Milestone 3: Android started. Latest verified: `npm test` = 29 pass, 1 skipped (opt-in phone test), ~63 s, `tsc` clean.

| Area | Where | State |
| --- | --- | --- |
| Workflow format v1, interpolation, conditions | `src/workflow.ts`, ADR 0002 | done; branches/loops/subflows/schedule reserved, not built |
| Engine (cancel, deadline, retry, postcondition polling, redaction, concurrency=1, emergency stop, healing proposals) | `src/engine.ts` | done |
| Adapters | `src/adapters/{core,fs,browser,windows,android}.ts` | browser/windows validated; android partial |
| Windows helper (Rust, UI Automation, JSON lines over stdio) | `crates/win-uia/` | cached lookups, invoke/toggle/select/expand, setValue, type, whitelisted keys, record events |
| Store (node:sqlite), CLI, local API | `src/store.ts`, `src/cli.ts`, `src/server.ts`, ADR 0003 | done |
| Browser Teach Mode | `src/record/{page-script.js,recorder.ts,compile.ts,induce.ts}`, ADR 0004 | record, compile, `motive induce` |
| Repair proposals | `src/heal.ts`, ADR 0006 | `motive heal` (browser + Windows; not Android) |
| Windows Teach Mode | `src/record/{windows.ts,indicator.ts}`, ADR 0007 | `motive record-win` |
| Android | `src/adapters/android.ts`, ADR 0005 | adb + `uiautomator dump`, package-scoped filtering |
| Examples/fixtures | `examples/*.json`, `examples/fixtures/` (HTML pages, WinForms app source) | used by tests and benchmarks |
| Benchmarks | `scripts/bench.ts`, `docs/benchmarks.md` | real numbers, one machine |

Real validations done: Chrome fixture workflows (10/10), Windows Calculator (10/10), mixed desktop+file+browser (10/10), native WinForms fixture (10/10), recording round trips (browser and Windows) replayed with different values, healing end to end, Pixel 7a (Android 17) Settings tour (2 runs).

## How to run

Needs Windows, Node >= 22.13, Rust, Chrome or Edge (no browser is downloaded).

```powershell
cd C:\Dev\beacon-motive
npm install
npm run build:win        # Rust UI Automation helper -> crates/win-uia/target/release
npm run build:fixture    # native WinForms test app -> target/fixtures (uses the .NET csc.exe that ships with Windows)
npm test                 # sequential; MOTIVE_TEST_ANDROID=1 also drives the connected phone
npm run motive -- capabilities
```

Secret inputs come only from `MOTIVE_SECRET_<NAME>` or the API body, never from the command line. Dev data goes to `.motive/` (git-ignored; set `MOTIVE_HOME=$PWD/.motive`).

## Remaining work, highest value first

1. **Use `motive record` on a real website with a person at the keyboard** to learn what the fixtures hide (iframes, new tabs, shadow DOM, file upload, drag/scroll). Likewise `motive record-win` interactively. Neither interactive "press Ctrl-C / close the window" flow has been used by a human yet.
2. **Android**: resident helper done (`apps/android-helper`, ADR 0009: tour 10.7 s to 4.6 s, swipe, Unicode text; `motive android-helper install`). Remaining: probe for healing on Android, multi-touch/pinch, more devices, release signing.
3. **Desktop UI**: first screens done (`apps/desktop`, ADR 0008; build with `cd apps/desktop && npm install && npx tauri build --no-bundle`; to inspect, run the exe with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<free port>` and drive it with Playwright `connectOverCDP`; port 9222 was already taken here). Teach Mode screen done (ADR 0010). Remaining: inspector, permissions, step editing, packaging. A stale `node ... cli.ts serve` can survive closing the app and answer on port 47615 with old code: kill it (PowerShell Get-CimInstance Win32_Process) before testing a new build. Original brief (Milestone 5, but the brief asks for one coded, visually reviewed representative screen before expanding): Tauri 2 shell over the local API; task input, workflow library, Teach Mode, inspector, run history, permissions. Research real productivity tool UIs first; avoid generic AI aesthetics; screenshots via the browser pane.
4. **Windows gaps**: events for real mouse clicks (untested), WPF/Qt/Electron/Java apps, trees/grids, drag, DPI/multi-monitor, elevated windows (report, never elevate), combos that open only a popup window, WinForms raises no Invoke/Toggle events (so those aren't recorded there).
5. **Workflow language**: step-level `when` and `forEach` are done (engine-tested only; try them on a real target); remaining: subflows, scheduling and event triggers (reserved in format v1, none built).
6. **macOS and Linux adapters** (AXUIElement; AT-SPI, Wayland via portals). Needs those machines; nothing is claimed for either.
7. **Milestone 4**: optional local model provider (Ollama/llama.cpp), OCR (Tesseract or Windows.Media.Ocr), visual grounding, supervised recovery for unfamiliar situations. Core must keep working with none of it.
8. **Milestone 5**: installer/prebuilt helper, updates, plugin interface, MCP adapter (optional), Beacon Remote connector (separate token/scopes, no inherited privileges).
9. Open decisions: import OpenAdapt recordings through an isolated Python worker (Flow is MIT but Python 3.10-3.12; read its source before deciding; never vendor a checkout, it contains AGPL material); `node:sqlite` is experimental in Node 22; local API has no rate limit.
10. Not yet measured: CPU use, large UIA trees, helper cold start, other hardware. Benchmarks are single-machine and make no "faster than a person" claim.

## Environment and standing user instructions

- Windows 11 PC; a **Pixel 7a (Android 17) was connected over USB** (`adb devices`; the user may disconnect it). The user said: **do not run any audio tests**; everything else is fine. Do not touch Sound settings or audio features.
- Phone privacy: UI dumps contain notifications from other apps. The Android adapter drops everything outside `scopes.apps` before use; never print or keep raw dumps. Do not point destructive workflows at the phone (the screen can change ~2 s between dump and tap).
- Downloads of files/browsers need explicit permission. No paid services. Ask before admin/elevation. Never commit credentials, keys, tokens, `.env`.
- Do not launch real mouse clicks on the user's desktop: an early helper click landed on a title-bar Close button (the helper is not DPI-aware); it was removed. Keyboard input goes through whitelisted `win.keys` / `win.type`.

## Traps learned

- **Shell heredocs collapse backslashes**: `\n` inside Python/heredoc-written code became a real newline and broke string literals (happened three times in `src/cli.ts`). Use the Edit/Write tools for any code containing backslashes; verify with `npx tsc --noEmit`.
- **Run test files sequentially** (`--test-concurrency=1`, already in `npm test`): they share Calculator, the fixture app and `taskkill`; parallel runs hung.
- Failed runs leave external apps open (by design: the engine does not kill apps it did not start). Clean up with `taskkill //IM MotiveFixture.exe //F` and `motive-win-uia.exe`. A suspended `CalculatorApp.exe` after closing its window is normal Windows behaviour.
- `uiautomation` crate needs the `event` feature for record mode. csc.exe treats forward-slash paths as options: pass absolute Windows paths.
- Regex `pattern` in workflow conditions is not interpolated (by design); use `contains`/`equals` for values built from inputs.
- Android `launch` resumes an app where it was left unless `fresh: true`.
- Line-ending warnings from git (LF to CRLF) are harmless.

## Working agreements for the next session

Keep `docs/roadmap.md` truthful (Done / Partial / Not started with evidence and limits); add an ADR for significant decisions; run `npx tsc --noEmit` and `npm test` before each commit; measure before claiming performance; prefer real applications or controlled local fixtures over mocks (mocks are acceptable only to test engine mechanics, and say so); commit coherent verified increments; summarise what works, what does not, and the next highest-value step.
