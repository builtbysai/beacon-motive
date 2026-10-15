# 0003 — Local API security

Status: accepted (Milestone 1)

- Binds `127.0.0.1` only (never `0.0.0.0`); port configurable.
- Every request needs `Authorization: Bearer <token>`. The token is 32 random bytes generated on first `motive serve`, stored in the data directory with owner-only permissions, compared in constant time. It is never logged or returned by the API.
- The `Host` header must be a loopback name with our port (blocks DNS rebinding). Requests carrying an `Origin` header are rejected, so a web page cannot call the API even if it somehow learns the token; no CORS headers are ever sent.
- Request bodies are size-limited and schema-validated.
- One workflow run at a time by default (`maxConcurrentRuns`, default 1); `POST /v1/runs/:id/cancel` and `POST /v1/stop` (emergency stop: cancels all runs) work at any time.
- Every run, cancel and denied request is written to the audit table.
- No telemetry, no outbound connections other than what a workflow itself does.
- A future Beacon Remote connector is a separate client with its own token and scopes; it does not inherit anything.
