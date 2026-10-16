# 0009 — Android on-device helper

Status: accepted (Milestone 3); validated on one phone (Pixel 7a, Android 17)

Replaces the cost that ADR 0005 recorded: `uiautomator dump` takes ~2.3 s per observation. An optional helper app keeps a UiAutomation connection open and answers in tens of milliseconds. The dump path remains the fallback and is used whenever the helper is not installed, fails to start, or `MOTIVE_ANDROID_HELPER=off`.

## Decision

An **instrumentation APK** (`apps/android-helper`), not an accessibility service.

- It has no activity, service, receiver or permission. It runs only while the computer holds an `adb shell am instrument` command open, so it cannot start itself, has no background presence, and disappears when the command ends (the adapter also force-stops it on dispose). An accessibility service would stay enabled after we leave and would need the user to switch it on in Settings.
- It does not suppress the user's accessibility services (`FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`).
- Transport: an **abstract local socket** (`LocalServerSocket`), reached through `adb forward tcp:0 localabstract:<name>`. No INTERNET permission, no TCP port on the phone. The name and a 24-byte token are random per session and passed on the command line to the instrumentation; every request must carry the token (constant-time compare).
- Protocol: one JSON object per line. Commands: `ping`, `tree`, `tap`, `swipe`, `setText`, `key`, `quit`.

## Privacy boundary (unchanged in principle from ADR 0005)

- Every request names the packages the workflow may use (`scopes.apps`); an empty list is refused.
- `tree` serialises only nodes of those packages; the computer filters again on receipt.
- `tap`, `swipe` and `setText` are refused unless the window at the point belongs to an allowed package; `back`/`enter`/`tab` need an allowed package in front. `home` is allowed anywhere because it only leaves the current app.
- Password fields are returned without text, are never read, and `setText` refuses them.
- Raw trees are not stored or logged.

## Behaviour that matters

- Text is set with `ACTION_SET_TEXT`, so non-ASCII works (verified with "Zoë café 日本"). Nodes that are not editable fall back to adb typing (ASCII only).
- A fast read can catch a screen mid-transition, where a button is still sliding and a tap at its old position is lost (observed: Settings "Navigate up" at x=155 instead of 42; the tour then failed 3 runs in 3). So the helper waits for accessibility idle (150 ms, capped 1.5 s) and the adapter requires the matched node to hold the same bounds across two reads 120 ms apart before acting.
- `android.swipe` scrolls within a target or across the allowed app's visible area.

## Measured (Pixel 7a, Android 17, one machine)

| | dump path | helper |
| --- | --- | --- |
| Settings tour, 7 steps, whole run | 10.7 s | 4.6 s (6 of 6 runs passed, 4.5–4.7 s) |
| One screen read | ~2.3 s | 15–35 ms steady state, ~140–280 ms first read |

The helper's start-up (~0.5 s) is included in the helper runs. Remaining time is mostly `android.launch` and the settle checks.

## Second device (Android 16 emulator, `Beacon_Phone`, run read-only with no audio)

The helper installed and ran there too (tour, swipe, non-ASCII text all passed). Speed gain is small on the emulator: tour 10.0 s with the helper vs 14.5 s without (software-rendered UI; idle waits and the app itself dominate). Treat the phone figures as the real-hardware result and the emulator as a functional check.

## Limits and risks

- Debug-signed APK, built locally; no release signing, no Play distribution, no auto-update.
- The abstract socket is reachable by other apps on the phone; the per-session token is what stops them. A malicious app that could read the adb command line could not, since it needs shell access it does not have.
- Starting the instrumentation needs USB debugging authorised for this computer; nothing is possible without that.
- Custom-drawn or FLAG_SECURE content is still invisible; `ua.windows` visibility depends on the OEM.
- Tapping is by injected touch events from UiAutomation; real devices differ. Validated on one phone only.
- Verified by hand and by two example workflows on the real phone; only the package filtering is in the default `npm test`. Real-phone tests are opt-in (`MOTIVE_TEST_ANDROID=1`, plus `MOTIVE_TEST_ANDROID_HELPER=1`).
