# Runtime Flows Reference

Scope: end-to-end paths across apps, platform, transport, and service layers.

## 1) Install and Activate Automation App

1. caller requests install (`app:install` or `POST /api/apps/install`)
2. `apps/manager.install(...)` persists app and creates work directories
3. if app type is automation and runtime is ready, runtime `activate(appId)` is called
4. runtime registers:
   - scheduler jobs for schedule subscriptions
   - event listeners for event-driven subscriptions
   - keep-alive reason via background service
5. runtime emits status updates (`app:status_changed`)

Primary files:

- `src/main/ipc/app.ts`
- `src/main/http/routes/index.ts`
- `src/main/apps/manager/service.ts`
- `src/main/apps/runtime/service.ts`

## 2) Scheduled Run Flow

1. scheduler determines job due
2. runtime job callback builds trigger context
3. runtime enforces concurrency via semaphore
4. `executeRun(...)` creates run record and isolated SDK session
5. memory MCP + report MCP are injected
6. run completes and writes:
   - run status in `automation_runs`
   - activity entries in `activity_entries`
7. runtime updates app status and last-run metadata

Primary files:

- `src/main/platform/scheduler/timer.ts`
- `src/main/apps/runtime/service.ts`
- `src/main/apps/runtime/execute.ts`
- `src/main/apps/runtime/store.ts`

## 3) Event-driven Run Flow

1. source emits event into event (`file-watcher`, `schedule-bridge`, optional others)
2. runtime subscription handler receives matching event
3. runtime builds event trigger context and executes run

Primary files:

- `src/main/platform/event/event-bus.ts`
- `src/main/platform/event/sources/*.ts`
- `src/main/apps/runtime/service.ts`

## 4) Escalation Flow

1. AI calls `report_to_user` with `type="escalation"`
2. runtime stores escalation activity entry
3. runtime broadcasts:
   - `app:activity_entry:new`
   - `app:escalation:new`
4. app status transitions to `waiting_user`
5. user responds via `app:respond-escalation` or HTTP equivalent
6. runtime triggers escalation follow-up run with user response context

Primary files:

- `src/main/apps/runtime/report-tool.ts`
- `src/main/apps/runtime/service.ts`
- `src/main/ipc/app.ts`
- `src/main/http/routes/index.ts`

## 5) Process Keep-Alive and Background Mode

1. active automation workloads register keep-alive reasons
2. user closes all windows
3. main process checks `background.shouldKeepAlive()`
4. if true, process remains alive and may hide dock icon on macOS
5. cleanup eventually occurs on explicit quit/shutdown path

Primary files:

- `src/main/platform/background/index.ts`
- `src/main/index.ts`
- `src/main/bootstrap/extended.ts`

## 6) Failure and Recovery Hooks

- scheduler backoff and auto-disable on repeated errors
- runtime inserts run_error activity on failures
- bootstrap not-ready guards return user-facing errors until async init completes
- websocket and renderer receive status/activity broadcasts for visibility

## 7) Fast Debug Checklist by Symptom

- **App installs but never runs**
  - check runtime activation logs
  - inspect scheduler jobs for app metadata
- **Runs happen but no activity appears**
  - inspect `report_to_user` calls and `activity_entries` insertion
- **Remote sees stale app state**
  - inspect websocket broadcast and channel subscriptions
- **App config works in desktop but not remote**
  - verify HTTP route coverage for config/frequency endpoints
