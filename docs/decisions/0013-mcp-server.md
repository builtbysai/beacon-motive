# 0013 — MCP server (optional)

Status: accepted (Milestone 5)

`motive mcp [--allow a,b]` is a Model Context Protocol server on stdio (JSON-RPC lines; protocol versions 2025-06-18, 2025-03-26, 2024-11-05; no SDK dependency). It lets an AI client use saved workflows as tools. The engine stays AI-free and makes no model calls: this is one more front door to the same engine, with the same scopes, limits, history and audit (actor `mcp`).

Tools: `motive_capabilities`, `motive_list_workflows`, `motive_describe_workflow`, `motive_run_workflow`, `motive_get_run`.

## Consent boundary

- Listing, describing and reading runs are always allowed (read-only hints set).
- **Running is allowed only for workflows named in `--allow`.** With no `--allow`, nothing can run; the tool says what flag the user must add. The user, not the model, decides which workflows an AI may start, and `describe` shows `allowedForMcp` so the client can tell.
- **Secrets never pass through MCP.** Passing a secret input is refused; a secret's default is not shown; secret inputs of an allowed workflow come from `MOTIVE_SECRET_*` in the server's environment, which the client does not control. Run results come from the engine's redacted records.
- Scopes still bind the workflow: an AI cannot widen what a workflow may touch, and cannot edit workflows through MCP (no save/edit/delete/schedule/record tools exist).
- One run at a time (the engine's default limit); a second concurrent call gets the engine's "already active" error.
- stdout carries only protocol messages; diagnostics go to stderr.

## Verification and limits

`test/mcp.test.ts` spawns the real `motive mcp` process and drives it over stdio like a client: initialize, tools/list, list/describe, an allowed run with inputs and outputs, `get_run`, a refused non-allowed run, a refused secret, an unknown method. It uses core-only workflows; it has not been tried against a real MCP client application (Claude Desktop, an IDE), and the tool `annotations` are hints, not enforcement. Running a workflow acts on the user's real apps, so only allow workflows you would run yourself. No resources, prompts, progress notifications, cancellation or HTTP transport.
