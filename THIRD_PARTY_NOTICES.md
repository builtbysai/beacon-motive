# Third-party notices

No third-party source code is copied into this repository. Direct dependencies (used as libraries, under their own licences):

| Package | Licence |
| --- | --- |
| playwright-core | Apache-2.0 |
| zod | MIT |
| uiautomation (Rust) | MIT |
| serde, serde_json (Rust) | MIT OR Apache-2.0 |
| tauri, tauri-build, @tauri-apps/cli (apps/desktop; their transitive crates are mostly MIT OR Apache-2.0, not individually audited) | MIT OR Apache-2.0 |
| ureq (apps/desktop) | MIT OR Apache-2.0 |
| typescript, @types/node (development) | Apache-2.0, MIT |

Optional, run separately by the user and not bundled or required: Ollama (MIT) and the Qwen2.5 model family (Apache 2.0 for the 0.5B/1.5B sizes) for the local repair suggestions in ADR 0015.

OpenAdapt / OpenAdapt Flow (MIT; its Git checkout also contains an AGPL-3.0 reference environment) and Microsoft UFO (MIT) were studied only through their public documentation. If code is ever copied from them, its notice must be added here first.
