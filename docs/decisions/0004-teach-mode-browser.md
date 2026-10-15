# 0004 — Teach Mode for the browser (first slice)

Status: accepted (Milestone 2, started)

## Decision

`motive record <url> --name n` opens a visible Chrome with a recorder attached. Recording exists only while that command runs; a red "Recording" badge is injected into every page. Closing the window or Ctrl-C ends it and writes a reviewable workflow file. Nothing is saved to the library unless `--save` is given.

- **Capture** is at the DOM-event level in the page (`src/record/page-script.js`): trusted clicks, committed field values (`change`, or Enter), select choices, Enter. Raw keystrokes are never reported.
- **Sensitive fields** (type=password, autocomplete password/one-time-code/cc-*, or name/id matching pass|pwd|secret|token|otp|cvv|card|ssn|pin) are reported without their value. They compile to `secret: true` inputs with no default, supplied at replay time through `MOTIVE_SECRET_<NAME>`.
- **Target identification** produces candidates in order (test id, role+name, label, text, css). Each is checked against Playwright's own matcher and against the exact element the user touched; the first that matches exactly that one element wins. If none does, the action is `ambiguous` and compilation **refuses** instead of guessing. If the page navigated before the check could run, the action is `unverified` and a warning is emitted.
- **Constants vs variables:** typed text and selected options become inputs defaulting to the demonstrated value; clicks, keys and navigation stay constants. One demonstration cannot distinguish a constant text from a variable, so typed text is treated as variable and flagged in the output for review. `motive induce a.json b.json --name n` merges two or more demonstrations (`src/record/induce.ts`): structure and targets must be identical or it refuses; inputs whose value differs stay variables, inputs with the same value everywhere become constants and are reported as such.
- **Verification:** `--expect-text` adds a final wait for that text; any demonstrated input value inside it is replaced by the input reference, so replay with another value expects the other value. Without it, the output warns that the outcome is not verified.
- **Scopes** are derived from visited hosts and are shown for review.

## Not done

Desktop (Windows) recording, drag/hover/scroll/file upload/iframes/shadow DOM/new tabs, healing proposals when a target stops matching, in-page UI to mark the expected result.
