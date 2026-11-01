# Beacon Motive development workspace

Beacon Motive is the independent local automation engine. This checkout is D:/Dev/beacon-motive. It does not inherit View or Remote permissions, infrastructure or release status.

## Run and validate

Read `roadmap.md`, README and applicable security ADRs for implemented/experimental scope. Node >=22.13, Rust/MSVC and installed Chrome/Edge support the current Windows workflows. `npm ci` restores root dependencies; `npm --prefix apps/desktop ci` restores the independent Tauri CLI dependency set. Neither requires copying links to another checkout. `npm run typecheck` uses tsc --noEmit. `npm run build:win` builds the native helper; the desktop shell has its own `npm --prefix apps/desktop run build` workflow and Rust/Tauri requirements.

Dot-sourcing the shell setup sets `MOTIVE_HOME` to the private root's `motive` directory. This holds the preserved `api-token`, SQLite database and private recordings/fixtures as real files, not a link. Never publish workflow secret values, private UI dumps, notifications or token-bearing state. The API remains authenticated loopback-only. An ordinary install without an override retains its OS user-data default.

`npm test` can launch Windows/browser fixtures and interact with apps. Tests run serially; inspect fixtures first and keep unrelated windows safe. Phone tests and live Ollama evaluation are opt-in. No audio tests should be run. Focused engine, policy/redaction, scheduler, MCP and Android parser tests can validate deterministic boundaries without phone input; hardware/desktop support requires separate actual acceptance. Do not cite test counts as correctness evidence.

Optional portable Ollama lives in `D:/Dev/_tools/ollama`, with its models subdirectory. It must bind loopback. Do not start it or download models just for routine typechecking. Set OLLAMA_HOST/OLLAMA_MODELS deliberately from the actual current path rather than old C-path examples. Motive does not inherit Remote or View permissions and has no verified Oracle deployment.

## Workspace and private data

The active Windows workspace is `D:/Dev`. The sibling `D:/Beacon-Private` holds real files, with a restricted owner/SYSTEM/Administrators ACL; it is outside all repositories. Never commit its contents. The encrypted independent workstation backup is under `C:/Users/Saiha/Beacon-Backups`, outside the retired `C:/Dev` tree. Its password is in the private root; a current-Windows-user DPAPI-protected recovery copy is beside the backup. That DPAPI copy is not a portable password-manager escrow. Before changing PCs, export the password securely to the owner's credential store and restore-test it on the destination.

Dot-source `. ./scripts/Enter-Workspace.ps1` before local development. If the workspace/private folder is elsewhere, pass `-PrivateRoot <actual-private-folder>` or set `BEACON_PRIVATE_DIR`; never substitute blank/default credentials when a key is missing. This sets paths, not secret values. Keep the repositories independent. Do not confuse dev, disposable tests, hosted acceptance and production.

Development credentials, local deployment-config copies, signing material, SSH keys and retained test profiles were centralized. Installed apps' live identities/browser sessions, Android/Windows credential stores and server secrets retain their required runtime locations by owner choice. DPAPI identities still depend on the original Windows user/machine; moving their files does not make them portable identities.

Motive runs locally. It has no shared View/Remote database, relay or deployed Oracle service. Keep its authenticated API, token, workflows and test ownership independent. A future Remote connector requires separate credentials and explicit scope.

The old audit, archive and migration directories have been removed. Use this guide, the roadmap and development-status.md for current work. Never recover occupied ports by stopping their owners. Back up before installs/moves/cleanup and test restoration; GitHub protects pushed source, not ignored secrets, databases or enrolled identities.

Last validated checkpoint: [development-status.md](development-status.md). This records the actual checks and remaining acceptance gates.


## Next development steps

Use roadmap.md as the implementation source of truth. Highest-value next work is human-operated browser/Windows recording on real apps, broader Windows DPI/control and Android acceptance, and desktop packaging. macOS/Linux adapters and a Remote connector need separately scoped work. Tests that share Windows fixtures run serially; never terminate an unrelated listener or app to obtain a test port. A running local API may use older source: inspect its identity and stop it through its owning workflow before retesting.
