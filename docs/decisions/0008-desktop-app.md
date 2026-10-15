# 0008 — Desktop app (Tauri 2 over the local API)

Status: accepted (Milestone 5, first representative screen set)

`apps/desktop` is a Tauri 2 shell. It is a client of the local API (ADR 0003), not a second engine: it adds no automation capability and no new privileges.

## Decisions

- **The web view never holds the API token and makes no network requests.** The API rejects requests that carry an `Origin` header, which a web view always sends, so the Rust side makes the loopback calls (`ureq`) and exposes three commands: `engine_status`, `start_engine`, `api`. `api` accepts only GET/PUT/POST/DELETE on paths starting with `/v1/`. The token is read from the data directory per call.
- **Locked-down web view.** CSP `default-src 'none'`, scripts and styles from the app only, `connect-src` limited to Tauri IPC. No inline script or style. The capability file grants no plugins (no filesystem, shell, network or opener). UI text is set with `textContent`, never `innerHTML`.
- **Engine lifecycle.** "Start engine" runs `node src/cli.ts serve --port 47615` with fixed arguments (nothing from the UI reaches the process). An engine this app started is stopped on exit (after `POST /v1/stop`); one the user started is left alone. Port: `MOTIVE_PORT`; data dir: `MOTIVE_HOME` as in the CLI.
- **Always-visible emergency stop** in the title bar, calling `POST /v1/stop`.
- **Plain HTML/CSS/JS, no framework or bundler**, to keep the dependency surface small (only `@tauri-apps/cli` and the Tauri crates).
- Secret inputs use password fields and travel in the API body only; they are not stored by the UI.

## Not done

Teach Mode, inspector, permissions screens, workflow editing, scheduling UI, installer/bundling, code signing, auto-update. The engine is started from the repository checkout (`node` on PATH); a packaged build needs a bundled runtime.

## Verification

Release build run on Windows 11 (WebView2); driven through the WebView2 DevTools port with Playwright (no desktop mouse input): start engine from the UI, browse workflows, run `browser-greet` with a secret, watch it succeed, open history and audit. The typed secret did not appear in the page. Screenshots in `docs/desktop/`. This is a manual check, not part of `npm test`.
