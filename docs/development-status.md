# Development status

Latest development validation: November 2, 2026. Earlier implementation/build records below are from November 1; re-run relevant checks after later changes.

## Connected Pixel check — November 4, 2026

Pixel 7a (Android 17/API 37), USB serial `34171JEHN07672`, authorized ADB and the existing Motive helper were verified. The unchanged `examples/android-settings-tour.json` ran against current source with an isolated MOTIVE_HOME and an explicit device serial: it reached Default apps and returned Home in 5.139 seconds without changing settings. This is a narrow real-device replay pass, not teaching, emergency Stop, installer or general Android acceptance.

The first attempt timed out finding Apps while the observed layout included a clipped/inverted target; the selector correctly rejected that target. A diagnostic variant adding a swipe also timed out. The unchanged fixture subsequently passed with the display in portrait. Layout changed between observations, so landscape behavior and the precise cause remain unresolved; no selector safety guard was relaxed. No audio or model test ran, and canonical workflow/token/database state was untouched.

## Deterministic CI follow-up

Added a read-only, SHA-pinned GitHub Actions workflow for Windows/Ubuntu, locked JavaScript installs, strict TypeScript, an explicit non-UI test command and root/desktop JavaScript audit gates. The API boundary regression now lives outside application-driving integration tests and fails if workflow polling never completes. Existing Android parser/package-isolation regressions now run independently of device opt-ins. These are moved existing tests, not duplicated or replaced hardware acceptance.

Local typechecking, the deterministic suite, the extracted API/Android parser checks and both JavaScript audits passed. No application-driving full suite, phone, audio, live model or service/reboot acceptance was run. Hosted deterministic checks passed on both Windows 2025 and Ubuntu 24.04 in [run 41455547820](https://github.com/builtbysai/beacon-motive/actions/runs/41455547820) at `61f5f18`. The initial workflow attempt failed before jobs started because runner context was used at job-env scope; the corrected step-scoped profile passed. These checks do not include native desktop/platform acceptance.

## Dependency audit limits

Root and independent desktop npm audits passed at the high-severity threshold with no reported advisories. RustSec audit with warnings denied passed for the native UI Automation helper. The desktop Rust lockfile audit reported no vulnerability entries, but **failed its strict warning gate** on [unmaintained proc-macro-error](https://rustsec.org/advisories/RUSTSEC-2024-0370.html) and [GLib VariantStrIter unsoundness](https://rustsec.org/advisories/RUSTSEC-2024-0429.html). Cargo's Windows target dependency trees include neither affected package; the all-target tree resolves the GLib issue through GTK/WebKit dependencies. This is a remaining non-Windows dependency/release gate, not an audit pass. Do not suppress the warnings or force an incompatible GLib major override; update the upstream-compatible desktop dependency chain and validate the affected platform as separate work. Windows builds do not prove Linux safety.

The owner authorized external private state, documentation, source publication and verified obsolete-file cleanup. No new automation milestone, integration, model download or production service was introduced.

Root and desktop `npm ci` completed from their existing lockfiles. Root `npm run typecheck` passed. The focused sequential engine, AI proposal/redaction, healing, scheduler, Android parsing/permission and MCP tests passed; real-phone/live-model portions remained opt-in and were not run. The entire desktop/browser integration suite was not claimed as executed. No audio tests or real-device input were performed.

The native Windows helper built with `cargo build --release --locked --manifest-path crates/win-uia/Cargo.toml`. The independent Tauri desktop build (`npm --prefix apps/desktop run build`) succeeded, producing its release executable. Compilation does not establish UI/other-platform acceptance.

The dot-sourced shell setup selects the existing real private Motive token/database/fixture directory through MOTIVE_HOME; it does not create replacement identities or print token values. No active source/dependency reparse points were found. New PowerShell scripts parse. Gitleaks staged-candidate scanning and final diff review precede publication. Independent encrypted snapshots preserve ignored data; the source-only Git push does not cover it.

Existing application/runtime identities and server secrets remain in their required locations by owner choice. DPAPI recovery is still Windows-user/machine dependent. Read workspace.md for current setup instead of older C-path examples. No existing test was added or removed for this documentation/path-only change.
