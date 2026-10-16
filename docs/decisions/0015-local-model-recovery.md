# 0015 — Optional local model for repair suggestions

Status: accepted (Milestone 4, first piece). The core stays AI-free: with no model installed nothing changes, and no run touches a model unless it opts in.

## Decision

A local model (Ollama on this machine) may be asked, **only for a run that opted in and only after a step fails because its recorded target no longer resolves and no recorded alternative works**, which of the controls really on screen is the same control. Its answer is a *repair proposal*, handled exactly like the alternatives of ADR 0006: validated by a side-effect-free probe (must resolve to exactly one control), shown with its source and reason, and applied only by an explicit person action (`motive heal --apply`, or "Apply this repair" in the desktop run view). The run still fails, nothing is clicked, retried or edited by the model.

- **Opt-in per run:** `motive run --ai`, API `POST /v1/runs {aiRecovery: true}`, or the "Repair help" checkbox. Recorded in the audit log (`run.ai_recovery`). If the model is unreachable the CLI says so and runs without it; the API refuses the request with the reason.
- **Local only:** `MOTIVE_OLLAMA_HOST` must be a loopback `http://` address (default `http://127.0.0.1:11434`); anything else is refused, so screen content cannot be sent off the machine by this path. No cloud model, no API key, no telemetry.
- **What the model sees:** the recorded target (selector only), the step id and op, and a list of the on-screen controls it could replace it with: names, automation ids, roles and types. Never typed values, never password fields; window and page text beyond control names is not sent. The list is built at failure time, held in memory, and not stored; only the chosen selector and the model's one-sentence reason are kept in the run record. (The workflow description is deliberately not sent: it distracted the small model, see below.)
- **How it answers:** constrained JSON. A small model mis-indexed numbered lists (it described the right control and named the wrong row), so it answers with the exact text of a listed control or "none of these", reason first, candidates listed most-similar-first (edit distance against the recorded target). Then a **second, separate yes/no check** of just that pair ("same job?") has to pass; the first pass alone had a high false-positive rate.
- **Availability:** `motive ai status`; `/v1/capabilities` reports `ai: {provider, model, available, reason, localOnly}`; the Permissions/run screens show it. Model default `qwen2.5:1.5b` (`MOTIVE_OLLAMA_MODEL`).

Adapters supply candidates through an optional `candidates()` on their ops: Windows (control tree of the window), Android (screen nodes of the allowed apps), browser (visible interactive elements).

## Setup used here (not part of the repo)

Portable Ollama v0.40.5 zip (1,403 MB, sha256 verified against GitHub's digest) extracted to `C:\Dev\ollama-portable\app`, `OLLAMA_HOST=127.0.0.1:11434`, `OLLAMA_MODELS=C:\Dev\ollama-portable\models`, `ollama pull qwen2.5:1.5b` (986 MB, Apache 2.0). No installer, nothing registered for startup. Ollama and the model are separate tools the user chooses to run, not dependencies of this repo.

## Measured quality (one machine, CPU only, `scripts/ai-eval.ts`)

12 synthetic cases, 6 where a right replacement is on screen (typo in an id, id renamed, button relabelled, reworded, link reworded, field relabelled) and 6 where none is:

- **Right replacement present: 6/6 chosen correctly.**
- **No right replacement: 3/6 correctly answered "none"; 3/6 false positives** (it offered "Add to basket" for "Export to PDF", "Upload photo" and "Print receipt"). Before the second check: 1/6.
- Median 5 s per suggestion (two model calls on CPU); first call after idle is slower. One 60 s timeout seen during a tuning run (the provider's limit); the engine treats any model failure as "no suggestion".
- Real apps: the native test app with a typo'd id (3 of 3 runs, `test/ai-live.test.ts`, opt-in); a browser page where "Greet" became "Say hello" (proposed the right button); the Android path is implemented but not exercised with the model.
- A tuning lesson: with the workflow description in the prompt ("fills the name box ... presses Go") the model picked the Name box for a mistyped Go button, 3 of 3 times. Removing the description fixed it. Small models are easily distracted by extra context.
- A stricter "same job" wording cut false positives further but also dropped valid repairs and was rejected; this set is small and was used to tune, so the numbers are optimistic. They support "it handles obvious typos and rewordings and is often wrong when nothing fits", nothing more.

## Why a human still decides

Because of the false positives, the proposal is labelled "suggested by local model" with its reason, and `motive heal` prints "review before applying". It is a convenience for the person fixing a broken workflow, not an autonomous recovery. A larger model would likely do better (not tried: qwen2.5:3b is 1.9 GB under the Qwen licence).

## Not done

Vision or screenshot grounding; model-assisted workflow authoring; fine-tuning; any non-Ollama provider (the `ModelProvider` interface is small); a model-based answer for Android verified on a device.
