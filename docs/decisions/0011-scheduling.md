# 0011 — Scheduling

Status: accepted (Milestone 5); time-based triggers only

## Decision

Schedules are rows in the library database (`schedules` table), managed through `/v1/schedules` (GET, POST, DELETE `/:id`, POST `/:id/enable|disable`) and a Schedules screen in the desktop app. `src/scheduler.ts` ticks every 15 s inside the engine process (`motive serve`, or the desktop app that started it) and starts due workflows through the normal engine, so every scheduled run has the same scopes, limits, history and audit as a manual one (actor `schedule:<id>`).

- Kinds: every N minutes (1–10080) and daily at HH:MM local time. No cron expressions, no event or file/network triggers.
- **No background service.** If the engine is not running, nothing fires. Downtime is never replayed: a schedule computes its next firing from when it was loaded, so a long gap produces one firing, not a burst.
- **Busy engine:** the default limit is one run at a time, so a firing that finds a run active is skipped, recorded as `schedule.skip` in the audit log and in the schedule's `lastResult`. Nothing is queued.
- **Secrets:** a schedule stores no secret input (refused at creation). A scheduled workflow with a secret input reads it from `MOTIVE_SECRET_<NAME>` in the engine's environment, like any CLI run; without it the run fails visibly.
- Added, removed, enabled, disabled, fired and skipped are audited. The whole feature is local; nothing leaves the machine.

## Verification and limits

- `test/scheduler.test.ts`: next-firing arithmetic (daily/local time, strictly future), firing with a fake clock and a real workflow run, one firing after a long gap, pause/remove, busy skip, secret/unknown-input/unknown-workflow refusal, API round trip. The clock is faked in those tests.
- In the built desktop app a one-minute schedule added through the UI fired on the real timer about a minute later (21:01:00), the run succeeded (`browser-greet`) and the audit log has `schedule.fire`. One observation, one machine; the engine had to be running.
- Not done: surviving sleep/hibernate semantics beyond "next tick", daylight-saving edge cases for daily times (a daily time that does not exist on a spring-forward day follows JavaScript `Date` rules), launch-at-login for the engine, catch-up policies, event triggers.
