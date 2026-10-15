# 0007 — Teach Mode for Windows applications

Status: accepted (first slice; validated on Calculator and a native WinForms app)

`motive record-win --window <title> --name n [--command exe] [--expect id:text]` records one window from UI Automation **events**, not from global input hooks.

- **Why events, not hooks:** a global keyboard or mouse hook sees every keystroke in every program, including passwords typed elsewhere. UIA events are scoped to one window's subtree and report the control and its new value, so a password box can be reported without its contents (`IsPassword`). Recording is explicit, scoped to one window, and a red always-on-top indicator (a separate process that exits if the recorder dies) is shown while it runs.
- **Captured:** Invoke events, selection events, Value and Toggle property changes. Consecutive edits of one field collapse to its final value. Targets are the automation id, with name+type as alternatives (healing proposals, ADR 0006); each is checked to resolve to exactly one control. Ambiguous actions are refused at compile time.
- **Compiled to:** `win.click`, `win.select`, `win.setValue` (typed values become inputs defaulting to the demonstrated value) and `win.type` for password boxes (secret inputs with no stored value). `--command` adds `win.launch` and the app to `scopes.apps`; without it the workflow waits for the already-running window.
- **Verification:** `--expect automationId:text` adds a polling read of that control; demonstrated input values inside the text follow the input.

## Findings that limit it

- **Apps decide what events exist.** Calculator (UWP) raises Invoke events: five button presses were recorded and replayed to "Display is 5". A native WinForms app raised value and selection events from keyboard input but **no** Invoke event for a button press and **no** Toggle event for a checkbox, so those actions are not recorded there. WPF, Qt, Electron and Java apps are untested.
- **Combo boxes report twice** (the dropdown item and the box's value). Unfindable dropdown items followed by a value change are folded into the value.
- **Pointer input is deliberately not provided.** A trial real-mouse click helper in the Windows helper landed on the wrong control (a title-bar Close button) because the helper is not DPI-aware. It was removed. `win.keys` sends only a fixed set of navigation keys ({enter} {tab} {esc} {space} arrows {backspace} {delete} {home} {end}) to a chosen control.
- Events from a person's real mouse clicks are untested; tests produce events through UIA patterns and keyboard input.
