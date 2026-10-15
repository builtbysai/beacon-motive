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
| Windows adapter | Partial | Calculator (UWP) driven by UI Automation: launch, invoke, read, close. Not done: window focus/keyboard text entry fallback, menus, trees/lists/grids, element change events, elevated windows (reported as unreachable by design), DPI/multi-monitor, per-call caching (each call costs ~70 ms because the window is re-resolved) |
| Filesystem adapter | Done (minimal) | read/write inside declared dirs; symlink/junction escape tested |
| SQLite persistence | Done | `node:sqlite` is experimental in Node 22 |
| CLI | Done | `capabilities validate save list run history inspect serve audit` |
| Local API | Partial | auth, Host/Origin checks, SSE events, cancel, stop, audit tested; no rate limit, no HTTPS (loopback only) |
| Secrets | Partial | redacted in history/outputs/errors (tested); not in OS keychain; typed text could still be visible on screen |
| Cross-application workflow | Not shown | each example is one surface; a mixed browser+desktop+file workflow still needs a demo |

## Milestone 2 — Teach and Replay: not started

Explicit recorder (browser first: DOM events → semantic steps), constant vs variable detection, multiple-demonstration induction, edit/review UI, redaction of password fields at capture. Decision pending on importing OpenAdapt recordings through an isolated Python worker.

## Milestone 3 — Platform expansion: not started

macOS (AXUIElement; needs a Mac), Linux (AT-SPI; X11 first, Wayland via portals). Nothing is claimed for either.

## Milestone 4 — Adaptive intelligence: not started

Optional local model provider (Ollama/llama.cpp), OCR, visual grounding, supervised recovery proposals. The core must keep working with none of these installed.

## Milestone 5 — Integration and polish: not started

Desktop app (Tauri 2 against the local API), installer and prebuilt helper, scheduling, plugin interface, optional Beacon Remote connector (separate token and scopes), MCP adapter.

## Next highest-value work

1. A mixed workflow (browser → desktop → file) and a Windows `win.type`/menu/list capability, using a second real app (Notepad or a purpose-built fixture window).
2. Cache the resolved window element in the sidecar to cut per-call latency.
3. Browser recorder (Milestone 2 start), since Teach Mode is the main differentiator.
