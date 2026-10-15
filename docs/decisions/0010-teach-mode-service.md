# 0010 — Teach Mode as a service (API and desktop screens)

Status: accepted (Milestone 5)

The recorders (ADR 0004 browser, ADR 0007 Windows) were CLI-only. The desktop app needs them behind the local API, without weakening the recording rules.

## Decision

`src/recording.ts` (`RecordingManager`) and routes under `/v1/record`:

| Route | Meaning |
| --- | --- |
| `POST /v1/record` | start a demonstration: `{kind:"browser", name, url, expectText?}` or `{kind:"windows", name, window, command?, expect?}` (schema-validated, strict) |
| `GET /v1/record/:id` | state: starting, recording, finished (with the draft workflow and warnings), failed, discarded |
| `POST /v1/record/:id/finish` | the user is done (same as closing the browser window) |
| `POST /v1/record/:id/save` | the only way a recording reaches the library |
| `DELETE /v1/record/:id` | stop and keep nothing |

Rules kept from the CLI:

- **Explicit and visible.** A recording exists only because a client asked for it. The browser recorder opens a real, visible Chrome window; the Windows recorder shows its red indicator. The desktop screen also shows a pulsing "Recording" banner with Finish and Discard.
- **One at a time** (409 otherwise). Emergency stop (`POST /v1/stop`) also discards an active recording.
- **Draft, then save.** A finished recording is a draft held in memory with its warnings (absolute file paths, no expected result, ambiguous targets are refused at compile time). It is saved only by an explicit `save` call; the desktop review screen lists inputs (secret ones show "not recorded") and steps first.
- Passwords and card-like fields are never captured (unchanged). Start, end, discard and save are written to the audit log.
- Drafts are in memory only: restarting the engine loses an unsaved draft.

## Verification and limits

- `test/recording.test.ts` covers start, finish, draft not in library until saved, one-at-a-time, discard, emergency stop and bad specs, using a stand-in recorder that waits for the abort signal. It proves the service mechanics, not a human session.
- In the built desktop app (driven through the WebView2 debug port, no desktop mouse input): Teach Mode started a real visible Chrome, Finish produced the review screen with the expected warnings, Save put the workflow in the library. The demonstration was empty (just the opening page) because nobody was operating the recorded browser; a real demonstration by a person is still outstanding.
- Windows recording through the API and the Windows form are implemented but have only been exercised through the same stand-in test, not in the app.
- Induction (merging several demonstrations) and healing are still CLI-only.
