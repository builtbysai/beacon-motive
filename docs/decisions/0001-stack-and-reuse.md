# 0001 — Stack and what to reuse

Status: accepted (Milestone 0)

## Context

We need a local, AI-optional engine that runs mixed browser, desktop and filesystem workflows deterministically. `docs/research.md` compares OpenAdapt Flow, UFO, Playwright and native APIs.

## Decision

- **Build** the workflow format, executor, store, API and CLI in TypeScript on Node 22 (run directly, `tsc --noEmit` for types).
- **Reuse** Playwright (`playwright-core`) for the browser, driving the installed Chrome; no browser download.
- **Build** a small Rust sidecar, `motive-win-uia`, for Windows UI Automation, using the `uiautomation` crate. The engine talks to it with newline-delimited JSON over stdio. The sidecar is the platform boundary: macOS and Linux get sibling adapters implementing the same protocol.
- **Do not adopt** OpenAdapt Flow or UFO as dependencies now. Re-evaluate OpenAdapt Flow for recording import at Milestone 2 behind an isolated worker. Keep UFO as a design reference and a possible optional intelligence provider.
- **Persist** with `node:sqlite`.

## Why

- A mixed-surface workflow is the core product; Flow bundles are single-surface and Python-bound, UFO needs a model.
- Playwright is Node-native; a Python core would force a bridge for the most important adapter.
- A separate native sidecar isolates COM/threading hazards and crashes from the engine, and is replaceable per OS.
- `node:sqlite` avoids shipping a native add-on.

## Consequences

- Requires Node >= 22.13 and, on Windows, a Rust toolchain to build the sidecar (a prebuilt binary is a Milestone 5 packaging task).
- `node:sqlite` is marked experimental in Node 22; the store is behind one module so it can be swapped.
- We carry our own recorder in Milestone 2.
