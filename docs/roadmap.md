# Roadmap

Legend: **Done** = implemented and exercised on a real target in this repository. **Partial** = works but limited as noted. **Not started**. Nothing is "production ready".

## Milestone 0 — Research and architecture: done

- `docs/research.md`, ADRs 0001–0003. OpenAdapt Flow and UFO studied from their published pages (not yet from source); neither adopted (reasons in ADR 0001).
- Not yet done: reading OpenAdapt Flow's source to confirm its recording schema before a Milestone 2 import decision; licence review of transitive dependencies beyond direct ones.

## Milestone 1 — Working foundation: mostly done

| Item | State | Evidence / limit |
| --- | --- | --- |
| Workflow format v1 + validation | Done | `test/engine.test.ts`; no branches/loops/subflows yet (reserved) |
| Engine: cancel, deadline, retry, postcondition polling, concurrency, emergency stop | Done | unit tests with a controllable adapter, plus real runs |
| Browser adapter (Playwright, installed Chrome) | Partial | open/fill/click/read/wait validated on a local fixture page in Chrome; Edge, Firefox, multiple tabs/frames, downloads, file upload not done |
| Windows adapter | Partial | Calculator (UWP) driven by UI Automation: launch, invoke, read, close. Not done: window focus/keyboard text entry fallback, menus, trees/lists/grids, element change events, elevated windows (reported as unreachable by design), DPI/multi-monitor, menus; resolved windows/controls are cached (re-validated each use; a window renamed in place would still be matched until it goes away) |
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
| Multi-demonstration induction, healing proposals | Not started | |
| Windows (desktop) recording | Not started | needs UIA event subscription; design pending |
| Edit/review UI | Not started | file is plain JSON for now |

Decision still pending on importing OpenAdapt recordings through an isolated Python worker. See ADR 0004.

## Milestone 3 — Platform expansion: not started

macOS (AXUIElement; needs a Mac), Linux (AT-SPI; X11 first, Wayland via portals). Nothing is claimed for either.

## Milestone 4 — Adaptive intelligence: not started

Optional local model provider (Ollama/llama.cpp), OCR, visual grounding, supervised recovery proposals. The core must keep working with none of these installed.

## Milestone 5 — Integration and polish: not started

Desktop app (Tauri 2 against the local API), installer and prebuilt helper, scheduling, plugin interface, optional Beacon Remote connector (separate token and scopes), MCP adapter.

## Next highest-value work

1. Multi-demonstration induction (diff two recordings to separate constants from variables) and healing proposals when a recorded target stops matching.
2. A Windows `win.type`/menu/list capability and a second real app (Notepad or a purpose-built fixture window), then Windows recording via UIA events.
3. Real use of `motive record` by a person on a real website, to find what the fixtures hide (iframes, new tabs, shadow DOM).
