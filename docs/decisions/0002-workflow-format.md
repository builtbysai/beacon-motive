# 0002 — Workflow format v1

Status: accepted (Milestone 0)

A workflow is one JSON document, validated on load and on every API write.

```json
{
  "format": "motive.workflow/1",
  "name": "calculator-add",
  "inputs": { "a": { "type": "number" }, "b": { "type": "number" } },
  "steps": [
    { "id": "open", "op": "win.launch", "args": { "command": "calc.exe", "window": { "name": "Calculator" } } },
    { "id": "sum", "op": "win.read", "args": { "window": { "name": "Calculator" }, "target": { "automationId": "CalculatorResults" } },
      "post": [{ "equals": { "value": "${steps.sum.text}", "to": "Display is 5" } }] }
  ],
  "outputs": { "result": "${steps.sum.text}" }
}
```

## Rules

- **Typed operations** are namespaced `surface.verb` and declared by adapters (`browser.*`, `win.*`, `fs.*`, `core.*`). Unknown ops fail validation before anything runs.
- **Semantic selectors only.** Browser: role+name, label, text, test id, css (last resort). Windows: window {name, className, process}, then control {automationId, name, controlType}. Absolute coordinates are not part of v1 and have no field.
- **Inputs** are typed (`string|number|boolean`); an input with `secret: true` is supplied only at run time (CLI prompt-free env var `MOTIVE_SECRET_<NAME>` or API body field), never stored in the workflow, run history or audit log, and is shown as `***` in step records.
- **Interpolation** uses `${inputs.x}`, `${steps.id.field}`. Resolved lazily; a missing reference is a structured error, not an empty string.
- **Per step:** `timeoutMs`, `retry {max, backoffMs}` (bounded, default none), `pre`/`post` conditions, `onError: "fail"|"continue"`. Postconditions are mandatory for steps that change state in a way the engine can read back; the linter warns otherwise.
- **Deadline:** workflow-level `deadlineMs`; cancellation aborts the active step through an `AbortSignal`.
- **Conditional steps (added, backward compatible):** optional `when: [conditions]` on a step. All must hold or the step is recorded as `skipped` (reason in its output) and does not run. Same condition kinds as `pre`/`post`. Referencing a skipped step's output later fails with `unresolved_reference` rather than yielding an empty value. Unlike `pre`, a false `when` is not an error. No `else`: use a second step with the opposite guard.
- **Loops (added, backward compatible):** optional `forEach: {items, separator?}` on a step runs it once per item with `${loop.item}` and `${loop.index}`. `items` is an array, or a reference resolving to an array or to a string split on `separator`. Limit 100 items, no nesting. Each iteration is its own step record (`id[i]`) and honours the step's timeout, retry, `post` and `onError`; the first failing iteration stops the loop unless `onError: "continue"`. Later steps read `${steps.id.count}` and `${steps.id.results}`. `when` is checked once, before the loop.
- **Reserved, not implemented in v1:** `call` (subflows), `schedule`. The `format` version gates their addition.
- **Privileged ops** (`core.shell`, `fs.delete`, anything outside the workflow's declared `scopes`) require explicit approval at run time; v1 ships `fs.read`/`fs.write` restricted to declared directories and no shell op.
