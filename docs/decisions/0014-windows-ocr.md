# 0014 — OCR for windows the accessibility tree cannot describe

Status: accepted (Milestone 4, first piece); Windows only

## Decision

`win.ocr {window, rect?}` reads the text drawn in one window with **Windows.Media.Ocr**, the on-device engine that ships with Windows. No model or binary is downloaded, nothing leaves the machine, and the core engine still works with it absent (it only needs a Windows OCR language, which a normal user profile has). It is for content UI Automation does not expose (custom-drawn or canvas UI); accessibility selectors stay the first choice.

- The window is rendered with `PrintWindow`, so only **that window's own pixels** are read: not overlapping windows, not the rest of the screen. Nothing is written to disk or logged; only recognised text and line rectangles are returned.
- **Scope:** the window's program must be named in `scopes.apps` (matched by executable name; `window.find` now also reports `process`). Otherwise `scope_denied` before any pixel is captured. UWP apps run inside `ApplicationFrameHost.exe`, so reading one needs that name in scopes (broad: it covers every UWP window).
- The image is upscaled 2x/3x (nearest neighbour) before recognition, because Windows OCR misses much of the small UI text at 100% size. Rectangles are mapped back to window pixels. The helper turns on per-monitor DPI awareness so sizes are physical pixels.
- Returns `{text, lines:[{text, rect}], width, height}` (at most 500 lines).

## Limits

- **Approximate.** On the native test app (9 pt text) it read the title, menu, "Shout", "Small", "Red", "Blue" and "Ready", misread "Green" as "Gtren" and missed the "Go" button caption. Postconditions should use words it reads reliably; positions are hints. No claim is made about other fonts, languages, themes or DPI settings.
- No clicking by recognised text (that would need synthetic mouse input, which this project does not do). No Android or browser OCR, no vision model, no visual grounding.
- Protected or elevated windows refuse to render (`adapter_failed`), and a window larger than 8000 px or the engine limit needs a `rect`.
- Speed: ~150 ms for a 624x599 window on one machine (one measurement, not a benchmark).
- Verified by `test/integration.test.ts` on the real WinForms app (reads "Ready"; refuses a workflow that does not name the program).
