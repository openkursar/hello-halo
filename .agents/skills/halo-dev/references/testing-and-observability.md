# Testing and Observability Reference

Scope: validation strategy for apps/platform layers and runtime diagnostics.

## 1) Unit Test Surface

Current unit test areas:

- apps:
  - `tests/unit/apps/spec/*`
  - `tests/unit/apps/manager/*`
  - `tests/unit/apps/runtime/*`
- platform:
  - `tests/unit/platform/store/*`
  - `tests/unit/platform/scheduler/*`
  - `tests/unit/platform/event/*`
  - `tests/unit/platform/memory/*`
  - `tests/unit/platform/background/*`
- existing services:
  - `tests/unit/services/*.test.ts`

## 2) Common Commands

- run full unit suite:
  - `npm run test:unit`
- run full test gate:
  - `npm run test`
- typecheck:
  - `npx tsc --noEmit`

## 3) Minimum Validation for Apps/Platform Changes

1. typecheck clean
2. affected module unit tests pass
3. integration sanity check for transport paths:
   - desktop IPC path
   - remote HTTP path where applicable
4. verify startup/shutdown behavior if bootstrap or background code changed

## 4) Logging Surface

Main logging setup:

- `src/main/index.ts` initializes `electron-log` early
- console methods are routed through electron-log

Useful prefixes for triage:

- `[Bootstrap]`
- `[Store]`
- `[Scheduler]`
- `[EventBus]`
- `[Memory]`
- `[Background]`
- `[AppManager]`
- `[Runtime]`
- `[AppIPC]`
- `[HTTP]`
- `[WS]`

## 5) Runtime Observability Channels

Desktop renderer channels:

- `app:status_changed`
- `app:activity_entry:new`
- `app:escalation:new`

Remote websocket channels (broadcast):

- same channel names emitted via generic event frame payloads

## 6) High-Value Regression Areas

- startup order regressions in async init
- transport contract mismatches across IPC/HTTP/preload/renderer API
- schema drift between main types and shared app mirrors
- keep-alive and shutdown race conditions
- app lifecycle state transitions and escalation handling
