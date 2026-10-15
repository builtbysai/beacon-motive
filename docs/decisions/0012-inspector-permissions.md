# 0012 — Inspector and Permissions screens

Status: accepted (Milestone 5)

## Decision

- **Inspector.** `GET /v1/inspect/windows` and `GET /v1/inspect/tree?window=<title>&depth=<1-6>` (Windows only, needs the built helper) return what `motive inspect` returns: control metadata (type, name, automation id, class, position, enabled), never field values. Password controls are flagged and never read. The desktop screen lists windows, shows a window's tree and the selector fragment (`automationId` or `name`) for each control. Every look is written to the audit log with the window name (not its contents). It is a user action in the app; nothing runs in the background. Depth is capped at 6.
- **Permissions.** A read-only screen built from `GET /v1/capabilities` (which adapters work here and why not, with their operations) and each stored workflow's declared scopes (websites, folders, apps) and secret inputs. The enforcement stays where it was: adapters refuse anything outside the declared scopes. The screen is a view, not a switch; there is no per-workflow grant UI yet.

## A trap worth recording

Tauri sync commands run on the UI thread. The Inspector makes Windows describe every window, including the app's own, so a blocked UI thread stalled the helper until the 10 s HTTP timeout. All three app commands are now `async` so the blocking HTTP call runs on a worker thread. Found by driving the built app; the same call via `curl` was instant.

## Verification and limits

- `test/inspect.test.ts` (Windows only, real helper): lists real windows, reads a window tree, requires a window name, checks audit entries.
- Built app, driven through the WebView2 debug port: Inspector listed windows and read 22 controls of the WinForms fixture, flagging its password box; Permissions rendered all adapters and workflows. The window list is not captured in the committed screenshot because it shows the user's other windows.
- Windows only. Inspecting elevated windows is not possible (reported as unreachable, never elevated). No Android or browser inspector in the app yet. Permissions is read-only.
