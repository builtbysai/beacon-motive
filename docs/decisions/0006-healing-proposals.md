# 0006 — Healing is a reviewed proposal, never an automatic repair

Update: Android ops (`android.click/read/wait/setText`) now implement `probe` (one read, exactly one match). There is no Android recorder, so `alternatives` are hand-authored (see `examples/android-heal-demo.json`). Verified on the Android 16 emulator: stale target fails, the alternative that matches nothing is not proposed, `motive heal --apply` fixes the file, the rerun passes.

Status: accepted

When a recorded target stops matching (site redesign, renamed control), a replay that quietly picks "something similar" can click the wrong thing. We never do that.

- **Record time:** every selector that was verified to identify exactly the touched element is kept, in order. The first becomes `args.target`; the rest (at most 3, recorded) become the step's `alternatives`.
- **Failure time:** if a step fails with `not_found`, `ambiguous` or `timeout` and has alternatives, the engine probes each one with a side-effect-free `probe` (browser: the locator resolves to exactly one element; Windows: the helper finds exactly one control). Those that pass are attached to the error as `details.proposals`. The run still fails; nothing is retried with them.
- **Apply time:** `motive heal <run-id>` lists proposals; `motive heal <run-id> --apply <step>:<n> [--file f.json]` rewrites the target (the old target moves into `alternatives`) and writes an audit entry. A person decides.
- Alternatives are ordinary workflow data (`alternatives` on a step) and are validated like args when probed. Android has no probe yet (a dump costs ~2 s), so it proposes nothing.

Limits: only selectors captured at record time are tried; there is no fuzzy search for a "similar" control. A proposal can be the wrong control if the page changed meaning, so review it.
