# Research

Status: Milestone 0. Facts marked **(verified)** were read from the upstream project's own page on 2026-10-14. Facts marked **(background)** come from prior knowledge and must be re-checked before they drive a decision. Nothing here is a benchmark; measurements live in `docs/benchmarks.md`.

## Summary of conclusions

| Question | Answer |
| --- | --- |
| Reuse OpenAdapt Flow as the workflow engine? | **Not now.** Study and interoperate later. It is Python 3.10–3.12, its native desktop backends are described as experimental, and it is a bundle/certification system around one surface per bundle. Our first slice needs a TypeScript/Node-native Playwright path and a mixed browser+desktop+filesystem workflow. Revisit at Milestone 2 (Teach Mode) through an isolated worker. |
| Reuse UFO? | **Reference only.** It requires an LLM, is Windows-first Python, and its value (hybrid GUI/API choice, speculative batching, RAG over demos) is intelligence-layer design. Our core must run with no model. |
| Browser automation | **Playwright** (`playwright-core`, Apache-2.0) driving the user's installed Chrome/Edge. No browser download. |
| Windows native | **UI Automation through a small Rust sidecar** (`uiautomation` crate, MIT) speaking JSON lines on stdio. |
| Core language | **TypeScript on Node 22** (run directly, type-checked with `tsc`), because Playwright is Node-native and the engine is I/O orchestration. |
| Persistence | **SQLite via `node:sqlite`** (built in, no native add-on to ship). |
| Desktop UI | **Deferred.** Tauri 2 remains the likely shell; it talks to the same local API. |

## OpenAdapt and OpenAdapt Flow

Sources: <https://github.com/OpenAdaptAI/openadapt-flow>, <https://github.com/OpenAdaptAI/OpenAdapt> (README).

- Layout **(verified)**: `OpenAdapt` is the installer and `openadapt` command; `openadapt-flow` is the compiler and runtime; companion packages cover capture, privacy scrubbing, a desktop app and an MCP exposure (`openadapt-agent`). ML research packages are separate and not needed for record/compile/replay.
- License **(verified)**: MIT for launcher, compiler, runtime, desktop app, adapters. A Git checkout also contains an isolated openIMIS reference environment under **AGPL-3.0-only**; the PyPI wheels exclude it. Consequence: never vendor a repository checkout; depend on published wheels only, or copy nothing.
- Model: record a demonstration, `compile` to a bundle, `lint`, `certify` against a policy, `replay`/`run`. A healthy run makes **no model calls** **(verified)**. Each step is resolved through recorded DOM/accessibility element, then image crop, label text, position; repairs are written as proposals and never applied automatically; the run halts when nothing matches and refuses irreversible steps found only by position **(verified)**. This is the same safety stance we want.
- Surfaces **(verified)**: Playwright for web, native accessibility APIs for Windows/macOS/Linux, pixel replay for RDP/Citrix. One surface per bundle; `flow compose` sequences bundles.
- Maturity **(verified)**: version cited as 0.1.0 (July 2026); the README states zoom, display-scaling and font-size changes stopped runs at the first step in its own tests; "a stop is not a rollback". The proven path is browser.
- Integration points **(verified)**: CLI; `serve-execute` loopback HTTP server with bearer token and an MCP endpoint; `emit-mcp` per-bundle MCP server.
- Python 3.10–3.12 **(verified)**; this PC has 3.14, so using it needs `uv` plus a pinned interpreter.

Decision: do not adopt its bundle format as our workflow format. Our format must mix surfaces in one workflow and carry typed inputs/outputs. We copy the *ideas* that are independently sound (healing as reviewable proposals, halting on ambiguity, read-back verification, no autonomous repairs) and keep the option of an isolated-worker import of its recordings at Milestone 2. No source has been copied.

## Microsoft UFO² / UFO³ (Galaxy)

Source: <https://github.com/microsoft/UFO>.

- MIT, Python 3.10–3.11 **(verified)**. Requires an LLM API (OpenAI/Azure examples; others possible) **(verified)**.
- UFO²: HostAgent plus per-application AppAgents, Windows UIA/Win32/WinCOM, hybrid GUI+API actions, hybrid visual+UIA control detection, speculative multi-action batches (claimed 51% fewer LLM calls), RAG over docs/demos/traces **(verified, as claims by the project; not reproduced here)**.
- UFO³ Galaxy: multi-device DAG orchestration over a WebSocket protocol, Windows/Linux/Android agents, MCP support **(verified)**.
- Use for us: architectural reference for "prefer API over GUI when an app offers one", for batching predictable actions, and for separating planning from execution. Optional provider later, never a dependency of the core.

## Playwright

Source: <https://playwright.dev/>; `playwright-core` 1.64.1, Apache-2.0 (checked with `npm view`).

- Semantic locators (`getByRole`, `getByLabel`, `getByText`, `getByTestId`), auto-waiting actionability checks, isolated browser contexts, web-first assertions, tracing **(background)**.
- `playwright-core` plus `channel: "chrome"` drives the installed Chrome with no browser download. This respects the "no silent downloads" rule; a bundled Chromium is opt-in.
- Codegen/recording exists for generating test code. For Teach Mode we need our own event capture so recordings land in our workflow format (Milestone 2).

## Native automation

| Platform | API | Key constraints (background unless noted) |
| --- | --- | --- |
| Windows | UI Automation (COM). `uiautomation` crate 0.25 (MIT) **(registry listing verified)**; FlaUI is .NET, would add a runtime. | UIA calls are cross-process COM and slow if chatty: use `CacheRequest`/targeted `FindFirst` with conditions, run on an MTA thread. Elevated windows cannot be driven from a non-elevated process (UIPI) — report, never elevate. Some apps (games, custom-drawn, Java without bridge, remote displays) expose no tree. Secure desktop (UAC, lock screen) is unreachable by design. |
| macOS | `AXUIElement` (Accessibility). | Requires user to grant Accessibility (and Screen Recording for capture) in System Settings; no programmatic bypass. Notarised/signed binaries keep the grant. |
| Linux | AT-SPI over D-Bus for X11 and many GTK/Qt apps; Wayland blocks synthetic input and global capture. | Input injection goes through XDG RemoteDesktop portal / libei with a consent prompt; behaviour is compositor-dependent. Treat Wayland desktop control as limited until validated per compositor. |

Cross-cutting: multi-monitor coordinates and per-monitor DPI (use element rectangles in physical pixels, never stored coordinates), focus-stealing prevention, locked sessions, and application lifecycle (UWP/Store apps such as Calculator launch through a broker, so the launched PID is not the window's PID — find windows by title/automation id, not PID).

## Local intelligence

- Ollama and llama.cpp **(background)**: MIT-licensed local runtimes with HTTP APIs; suitable as an optional provider behind a narrow interface.
- Tesseract (Apache-2.0) **(background)** for targeted OCR; Windows also ships `Windows.Media.Ocr`. Both are Milestone 4.
- Rule: no model call on a healthy replay.

## Other open-source alternatives considered

| Project | Fit |
| --- | --- |
| Playwright MCP / browser-use | Model-driven browser control; opposite of our deterministic-first stance. Possible MCP adapter later. |
| pywinauto / AutoHotkey / FlaUI | Mature Windows automation, but each pulls a language runtime or is not embeddable as a typed library. The Rust sidecar keeps one small binary. |
| Robot Framework / RPA frameworks | Heavy, keyword-DSL oriented, no semantic recording. |
| Temporal / n8n | Workflow orchestration services; contradicts "local, no infrastructure". |

(All "background"; rows are for orientation, not a licence review.)

## Open questions for later milestones

1. How reliably do Windows UIA names/automation ids survive an app update? (Measure on real apps in Milestone 2.)
2. Which Teach Mode events can be captured with no keylogging of secrets? (Design: capture at the control level — "set value of control X" — and redact password fields before anything is stored.)
3. Is isolated-worker import of OpenAdapt recordings worth the Python dependency?

## Sources and licences to preserve

`playwright-core` Apache-2.0; `zod` MIT; `uiautomation` MIT; `windows` MIT/Apache-2.0. Any future copied code must keep its notice in `THIRD_PARTY_NOTICES.md`. At the time of writing nothing is copied.
