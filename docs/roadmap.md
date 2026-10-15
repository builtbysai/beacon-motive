# Roadmap

Legend: **Done** = implemented and exercised on a real target in this repository. **Partial** = works but limited as noted. **Not started**. Nothing is "production ready".

## Milestone 0 — Research and architecture: done

- `docs/research.md`, ADRs 0001–0003. OpenAdapt Flow and UFO studied from their published pages (not yet from source); neither adopted (reasons in ADR 0001).
- Not yet done: reading OpenAdapt Flow's source to confirm its recording schema before a Milestone 2 import decision; licence review of transitive dependencies beyond direct ones.

## Milestone 1 — Working foundation: mostly done

| Item | State | Evidence / limit |
| --- | --- | --- |
| Workflow format v1 + validation | Done | `test/engine.test.ts`; step-level `when` guards and `forEach` loops (max 100 items, no nesting) added, tested with a controllable adapter only, not yet on a real target; subflows (`flow.call`, max depth 3, scopes can only narrow) added the same way; time-based schedules live outside the workflow format (ADR 0011); no event triggers |
| Engine: cancel, deadline, retry, postcondition polling, concurrency, emergency stop | Done | unit tests with a controllable adapter, plus real runs |
| Browser adapter (Playwright, installed Chrome) | Partial | open/fill/click/read/wait validated on a local fixture page in Chrome; Edge, Firefox, multiple tabs/frames, downloads, file upload not done |
| Windows adapter | Partial | Validated on Calculator (UWP) and a purpose-built native WinForms app (`npm run build:fixture`): launch, press/toggle/select/expand, setValue, keyboard typing (`win.type`), list select, combo via value, menus, read text/toggle state, close. Shells/interpreters can never be launched. Password boxes are never read. Not done: trees/grids, element change events, drag, elevated windows (reported unreachable by design), DPI/multi-monitor, combos that only open via a popup window, WPF/Qt/Electron/Java apps (untested). Resolved windows/controls are cached (a window renamed in place would still match until it goes away) |
| Filesystem adapter | Done (minimal) | read/write inside declared dirs; symlink/junction escape tested |
| SQLite persistence | Done | `node:sqlite` is experimental in Node 22 |
| CLI | Done | `capabilities validate save list run history inspect serve audit` |
| Local API | Partial | auth, Host/Origin checks, SSE events, cancel, stop, audit tested; no rate limit, no HTTPS (loopback only) |
| Secrets | Partial | redacted in history/outputs/errors (tested); not in OS keychain; typed text could still be visible on screen |
| Cross-application workflow | Done | `examples/mixed-calc-to-web.json`: Calculator → file → read back → web form, verified end to end (test + 10/10 benchmark) |

## Milestone 2 — Teach and Replay: started (browser only)

| Item | State | Evidence / limit |
| --- | --- | --- |
| Explicit, visible browser recorder (`motive record`) | Partial | headed launch + abort checked by hand; two demonstrations recorded headless in tests; the interactive "close the window" flow has not been used by a person yet |
| Semantic targets verified against the touched element | Done | tests; ambiguous actions are refused |
| Secret fields never captured | Done for password/otp/card-like fields | tested with a password and a card number; detection is heuristic |
| Compile with variables, secrets, scopes | Done | recorded workflow replayed with different values and passed |
| Expected-result verification | Partial | `--expect-text` only; no in-page marking |
| Multi-demonstration induction (`motive induce`) | Done for browser recordings | two demonstrations of an order form: select value constant, customer variable; merged workflow replayed with a third value. Structural differences are refused. Identical values are treated as constant and flagged, since they cannot prove it |
| Healing proposals when a target stops matching | Done for browser and Windows controls | record → relabel the page → replay fails with one validated proposal (ambiguous selectors rejected) → `motive heal --apply` → replay passes. Alternatives only; no fuzzy search; not for Android. ADR 0006 |
| Windows (desktop) recording (`motive record-win`, ADR 0007) | Partial | Calculator: 5 recorded invocations compiled and replayed to the right result. Native WinForms app: typed values, password (not captured), combo and list choices recorded and replayed. WinForms raises no events for button presses or checkbox toggles so those are not recorded there; real mouse-click events, WPF/Qt/Electron/Java untested; interactive Ctrl-C session not used by a person yet |
| Edit/review UI | Partial | desktop app shows a review screen (inputs, steps, warnings) before save; no editing of steps yet |
| Teach Mode through the API (`/v1/record`, ADR 0010) | Done (service); not yet used by a person | lifecycle tested with a stand-in recorder; browser path started and finished from the desktop app against a real Chrome |

Decision still pending on importing OpenAdapt recordings through an isolated Python worker. See ADR 0004.

## Milestone 3 — Platform expansion: Android started; macOS and Linux not started

| Item | State | Evidence / limit |
| --- | --- | --- |
| Android via adb + UI Automator (ADR 0005) | Partial | Pixel 7a, Android 17: Settings tour passes; package-scoped filtering, selectors and scope refusal unit-tested. Without the helper: 2.3 s per observation (tour 10.7 s) |
| Android resident helper (`apps/android-helper`, ADR 0009) | Partial | Optional instrumentation APK, no permissions, abstract-socket + token. Same tour 4.6 s (6/6 runs); reads 15–35 ms; `android.swipe` and non-ASCII `setText` verified on the phone. Debug-signed only; one device; multi-touch, pinch and secure windows not done; real-phone tests are opt-in |
| Audio on any platform | Not tested | deliberately excluded for now |

macOS (AXUIElement; needs a Mac), Linux (AT-SPI; X11 first, Wayland via portals). Nothing is claimed for either.

## Milestone 4 — Adaptive intelligence: not started

Optional local model provider (Ollama/llama.cpp), OCR, visual grounding, supervised recovery proposals. The core must keep working with none of these installed.

## Milestone 5 — Integration and polish: started (desktop shell only)

| Item | State | Evidence / limit |
| --- | --- | --- |
| Desktop app (`apps/desktop`, Tauri 2, ADR 0008) | Partial | Workflow library, inputs form, live run view with cancel, run history, audit log, always-visible stop. Built and driven in the real window on Windows 11 (start engine, run with a secret, succeeded); screenshots in `docs/desktop/`; manual check, not in `npm test`. Teach Mode screen added (ADR 0010: visible recording, review, explicit save; verified with a real Chrome but an empty demonstration). No inspector, permissions or editing screens; needs the repo checkout and `node`; unsigned, no installer |

| Scheduling (`/v1/schedules`, ADR 0011) | Partial | every-N-minutes and daily-at-time triggers; fires only while the engine runs; busy runs are skipped, never queued; secrets never stored. Fake-clock tests plus one real firing from the desktop app. No cron, event triggers, catch-up or launch-at-login |

Not started: installer and prebuilt helper, plugin interface, optional Beacon Remote connector (separate token and scopes), MCP adapter.

## Next highest-value work

1. Real use of `motive record` by a person on a real website, to find what the fixtures hide (iframes, new tabs, shadow DOM).
