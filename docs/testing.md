# Validation boundaries

## Routine checks without desktop interaction

```powershell
npm ci --ignore-scripts
npm run typecheck
npm run test:ci
npm audit --audit-level=high
npm --prefix apps/desktop audit --package-lock-only --audit-level=high
```

`test:ci` explicitly selects engine, API security, AI proposal/redaction, recording-service, scheduler, Android payload/parser isolation and MCP protocol tests. Tests run serially. API tests use an OS-assigned loopback port, in-memory SQLite and core/synthetic adapters. The MCP test owns a temporary profile and exercises the actual stdio CLI with core-only workflows; normal CLI adapter discovery can inspect availability, but no UI/device operations are requested. The fake provider tests do not start Ollama or run a model.

The API-security regression lives in api.test.ts so checking authentication, Host/Origin rejection, audit and workflow execution does not import the app-driving integration suite. Do not replace the explicit CI file list with a wildcard: other tests intentionally operate Windows apps, browsers or opt-in phones/models.

`.github/workflows/ci.yml` runs these checks on Windows and Ubuntu with Node 22.22.0, read-only repository access, pinned actions and no persisted checkout credentials. It runs on pull requests, main/codex branch pushes and manual dispatch. The workflow neither downloads browsers/models nor installs a Windows service. Windows/Linux engine results do not prove corresponding desktop adapter support. The separate all-target desktop Rust warning gate remains open as described in development-status.md.

## Interactive and hardware checks

The original `npm test` command still includes application/recording/inspection tests. Inspect those tests before running them: they may manipulate Calculator, a native fixture, browser windows or other UI state. Run serially in a deliberate session with unrelated windows safe. Actual phone and live-model checks require their documented opt-ins; do not enable them in routine CI. Audio tests remain excluded.

Human teaching, actual client-app integration, clean-machine packaging, permissions/Stop behavior on devices, DPI and multiple monitors require their own evidence. Report the tested app/device/build and observed result. Do not infer these gates from compilation, protocol fixtures or a green hosted run.
