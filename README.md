# beacon-motive

A local-first, AI-optional automation engine. A workflow is one JSON file that can mix browser, Windows-desktop and filesystem steps. It runs deterministically through semantic selectors (accessibility tree, DOM roles and labels), checks the state it expects, and makes no model calls. Independent of Beacon Remote and Beacon View; it only exposes a local API they could use later.

**Status: Milestone 1 (foundation) done for Windows and Chrome, Milestone 2 (Teach Mode) started for the browser.** Windows and Chrome/Edge are validated on one machine. macOS and Linux are not implemented. See [`docs/roadmap.md`](docs/roadmap.md) for exactly what is and is not done.

## Try it (Windows, Node >= 22.13, Rust, Chrome or Edge)

```powershell
npm install
npm run build:win          # builds the UI Automation helper (crates/win-uia)
npm run motive -- capabilities
$env:MOTIVE_SECRET_PASSWORD = "anything"
npm run motive -- run examples/browser-greet.json
npm run motive -- run examples/windows-calculator-add.json -i a=4 -i b=6
npm run motive -- run examples/mixed-calc-to-web.json
npm run motive -- record ./examples/fixtures/form.html --name my-greet --expect-text "Hello"
npm test
```

No browser is downloaded; the installed Chrome or Edge is used (set `MOTIVE_CHROME` for another path).

## What exists

| Piece | Where |
| --- | --- |
| Workflow format v1 (typed ops, semantic selectors, inputs, secrets, scopes, conditions, retries, deadlines) | [`docs/decisions/0002-workflow-format.md`](docs/decisions/0002-workflow-format.md), `src/workflow.ts` |
| Engine: cancellation, deadlines, bounded retry, postcondition polling, secret redaction, concurrency limit, emergency stop | `src/engine.ts` |
| Adapters: browser (Playwright), Windows (UI Automation via Rust sidecar), filesystem, core | `src/adapters/`, `crates/win-uia` |
| SQLite persistence: workflows, runs, steps, audit | `src/store.ts` |
| CLI and authenticated loopback API | `src/cli.ts`, `src/server.ts`, [ADR 0003](docs/decisions/0003-local-api-security.md) |
| Teach Mode (browser): record, compile, replay with new values | `src/record/`, [ADR 0004](docs/decisions/0004-teach-mode-browser.md) |
| Research and decisions | [`docs/research.md`](docs/research.md), [`docs/decisions/`](docs/decisions/) |
| Measurements | [`docs/benchmarks.md`](docs/benchmarks.md) |

## Safety model in one paragraph

Workflows declare what they may touch (`scopes.hosts`, `dirs`, `apps`); everything else is refused. There is no shell operation. Secret inputs come from the environment or the API body, never from the command line, and are masked in history. The API listens on 127.0.0.1 only, needs a bearer token, and rejects browser-origin requests. Every run, cancel and denied request is audited. Nothing is sent anywhere.

## Licence

MIT. Third-party notices: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
