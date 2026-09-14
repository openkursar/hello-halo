# Platform Layer Reference

Scope: `src/main/platform/**`.

## 1) Layer Role

Platform modules provide reusable infrastructure consumed by Apps runtime and integration layers.

Current modules:

- store
- scheduler
- event
- memory
- background

## 2) Module Contracts

## 2.1 `platform/store`

Purpose:

- open and manage SQLite connections
- apply pragmas and corruption recovery
- run namespaced migrations via `_migrations`

Key files:

- `src/main/platform/store/index.ts`
- `src/main/platform/store/database-manager.ts`
- `src/main/platform/store/types.ts`
- `src/main/platform/store/DESIGN.md`

Key invariants:

- app database path: `${haloDir}/halo.db`
- migration namespace is mandatory per consumer module

## 2.2 `platform/scheduler`

Purpose:

- persistent schedule-driven job engine
- computes next run time (`every`, `cron`, `once`)
- tracks run log and stats
- handles backoff and auto-disable after repeated errors

Key files:

- `src/main/platform/scheduler/index.ts`
- `src/main/platform/scheduler/timer.ts`
- `src/main/platform/scheduler/store.ts`
- `src/main/platform/scheduler/schedule.ts`
- `src/main/platform/scheduler/types.ts`
- `src/main/platform/scheduler/DESIGN.md`

Operational notes:

- recursive `setTimeout` loop with delay clamp
- default stuck job threshold: 2 hours
- default max consecutive errors before disable: 5

## 2.3 `platform/event`

Purpose:

- normalize event ingestion from adapters
- apply filter matching and dedup
- dispatch events to subscribers with handler isolation

Key files:

- `src/main/platform/event/index.ts`
- `src/main/platform/event/event-bus.ts`
- `src/main/platform/event/filter.ts`
- `src/main/platform/event/dedup.ts`
- `src/main/platform/event/sources/file-watcher.source.ts`
- `src/main/platform/event/sources/schedule-bridge.source.ts`
- `src/main/platform/event/sources/webhook.source.ts`

Current source wiring in bootstrap:

- `FileWatcherSource` wired
- `ScheduleBridgeSource` wired
- `WebhookSource` implementation exists but is not wired in bootstrap yet

## 2.4 `platform/memory`

Purpose:

- provide memory MCP tools (`memory_read`, `memory_write`, `memory_list`)
- enforce scope permissions
- resolve memory file locations and compaction/summary utilities

Key files:

- `src/main/platform/memory/index.ts`
- `src/main/platform/memory/tools.ts`
- `src/main/platform/memory/paths.ts`
- `src/main/platform/memory/permissions.ts`
- `src/main/platform/memory/file-ops.ts`
- `src/main/platform/memory/prompt.ts`
- `src/main/platform/memory/types.ts`
- `src/main/platform/memory/DESIGN.md`

Path model:

- user memory: `{haloDir}/user-memory.md` and `{haloDir}/user-memory/`
- space memory: `{spacePath}/.halo/memory.md` and `{spacePath}/.halo/memory/`
- app memory: `{spacePath}/apps/{appId}/memory.md` and `{spacePath}/apps/{appId}/memory/`

## 2.5 `platform/background`

Purpose:

- keep process alive after windows close when required
- manage tray integration and online/offline status
- manage hidden daemon browser window lifecycle

Key files:

- `src/main/platform/background/index.ts`
- `src/main/platform/background/keep-alive.ts`
- `src/main/platform/background/tray.ts`
- `src/main/platform/background/daemon-browser.ts`
- `src/main/platform/background/partition.ts`
- `src/main/platform/background/types.ts`
- `src/main/platform/background/DESIGN.md`

Integration points:

- checked from `src/main/index.ts` in `window-all-closed`
- initialized in `src/main/bootstrap/extended.ts`

## 3) Dependency Shape

```
apps/runtime
  -> platform/store
  -> platform/scheduler
  -> platform/event
  -> platform/memory
  -> platform/background
```

Platform modules should not depend on Apps modules.

## 4) Testing Surface

Platform unit tests:

- `tests/unit/platform/store/database-manager.test.ts`
- `tests/unit/platform/scheduler/scheduler.test.ts`
- `tests/unit/platform/event/event.test.ts`
- `tests/unit/platform/memory/memory.test.ts`
- `tests/unit/platform/background/background.test.ts`
