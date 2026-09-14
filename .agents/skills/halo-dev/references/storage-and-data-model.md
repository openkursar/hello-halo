# Storage and Data Model Reference

Scope: local filesystem layout, SQLite schema ownership, and shared app type contracts.

## 1) Local Storage Layers

## 1.1 Base local data directory

Resolved through `getHaloDir()` in `src/main/services/config.service.ts`.

Common artifacts under this directory include:

- `config.json`
- `spaces-index.json`
- `halo.db` (new app/platform persistence)
- `temp/`
- `spaces/`
- `user-memory.md` and `user-memory/` (memory module)

## 1.2 Space-level data paths

Space records have a data path and optional working directory.

- data path (`space.path`) is persistence-oriented
- working directory (`space.workingDir`) is user project-oriented

Legacy compatibility and migration details remain in space service docs and code.

## 2) SQLite Ownership Model

## 2.1 Database manager

Module: `src/main/platform/store`.

Responsibilities:

- open app DB connection
- apply migration namespaces
- maintain `_migrations(namespace, version, applied_at)`

## 2.2 Namespace-to-table mapping

| Namespace | Owner Module | Tables |
|---|---|---|
| `scheduler` | `platform/scheduler` | `scheduler_jobs`, `scheduler_run_log` |
| `app_manager` | `apps/manager` | `installed_apps` |
| `app_runtime` | `apps/runtime` | `automation_runs`, `activity_entries` |

## 3) Apps Persistence Model

## 3.1 Installed app records

`installed_apps` stores:

- app identity and spec snapshot
- app status and escalation linkage
- user config and overrides
- permission grants
- last run summary fields

Primary source:

- `src/main/apps/manager/migrations.ts`
- `src/main/apps/manager/types.ts`

## 3.2 Runtime activity records

`automation_runs` and `activity_entries` store:

- per-run status/timing/token/error details
- activity thread entries and optional user escalation responses

Primary source:

- `src/main/apps/runtime/migrations.ts`
- `src/main/apps/runtime/types.ts`
- `src/main/apps/runtime/store.ts`

## 4) Memory File Model

Module: `src/main/platform/memory`.

Resolved paths (`src/main/platform/memory/paths.ts`):

- user: `{haloDir}/user-memory.md` and `{haloDir}/user-memory/`
- space: `{spacePath}/.halo/memory.md` and `{spacePath}/.halo/memory/`
- app: `{spacePath}/apps/{appId}/memory.md` and `{spacePath}/apps/{appId}/memory/`

Tools:

- `memory_read`
- `memory_write`
- `memory_list`

## 5) Shared Type Contracts (Renderer-safe)

Use shared app contracts for renderer and web compatibility:

- `src/shared/apps/spec-types.ts`
- `src/shared/apps/app-types.ts`

These mirror main-process definitions but avoid Node/Electron imports.

## 6) Practical Schema-Change Checklist

When changing schemas:

1. add new migration version in owning module namespace
2. keep prior migrations immutable
3. update owning module types
4. update shared mirrored types if renderer contract changes
5. update unit tests for persistence and migration behavior
