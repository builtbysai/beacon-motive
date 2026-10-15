# 0005 — Android adapter (adb and UI Automator)

Status: accepted (Milestone 3 groundwork; validated on one phone)

## Decision

`android.*` operations drive a connected phone through `adb` and `uiautomator dump`, using the same semantic selectors, scopes and result model as the other adapters. No app is installed on the phone.

- **Scope is the privacy boundary.** `scopes.apps` lists Android package names. The UI dump is filtered to those packages immediately after it is read; notifications, the status bar and other apps never reach step output, history or logs (tested). A workflow with an empty `scopes.apps` cannot launch, read, tap or even press keys. Launching a package outside the list is refused.
- **Selectors:** `resourceId` (full or short), `text`, `textContains`, `contentDesc`, `contentDescContains`, `className`. Exactly one on-screen node must match (a single clickable one wins when a row and its label both match); otherwise `ambiguous`. Taps use the node's current centre, computed at run time; no stored coordinates.
- **Never read:** password fields.
- **Input:** `android.setText` types printable ASCII only (adb `input text` limitation) and is refused otherwise. Keys: back, home, enter, tab.
- **Device choice:** the single authorised device, or `MOTIVE_ANDROID_SERIAL`. Unauthorised or multiple devices produce a capability reason, not a guess.
- **State:** `android.launch` resumes an app where it was left unless `fresh: true`, which force-stops that package first (only allowed packages can be stopped).

## Limits

- Each observation costs about 2.3 s on a Pixel 7a (`uiautomator dump` start-up), so a 7-step navigation takes about 10 s. A resident on-device helper (instrumentation or accessibility service) would be needed for interactive speed; not built.
- The screen can change between the dump and the tap (about 2 s on this device). Do not point destructive workflows at a phone with this adapter.
- Secure windows (FLAG_SECURE), custom-drawn views (games, some Flutter/Compose content without semantics) are invisible to the dump.
- Only validated on one device: Pixel 7a, Android 17.
