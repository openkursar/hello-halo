# Halo v2 Reference Index

This folder is the progressive-disclosure layer for the `halo-dev2` skill.

Read this file after `../ARCHITECTURE.md`, then open only what your task needs.

## 1) Document Map

| Document | Scope | Open When |
|---|---|---|
| `path-routing.md` | path-to-doc routing matrix | you know touched files and want minimal required reading |
| `apps-layer.md` | `src/main/apps/**` | app spec, install lifecycle, runtime execution, activity thread |
| `platform-layer.md` | `src/main/platform/**` | store, scheduler, event, memory, background |
| `integration-contracts.md` | cross-layer integration | bootstrap, IPC, HTTP, WebSocket, preload, renderer API |
| `storage-and-data-model.md` | persistence model | SQLite tables, local file layout, shared types |
| `runtime-flows.md` | end-to-end execution | install/activate/run/escalate/recover flows |
| `testing-and-observability.md` | quality and diagnostics | test scope, logging, validation checklist |
| `module-catalog.md` | module quick index | jump directly to module and its design/source files |

## 2) Quick Task Entry Points

- **Implement or refactor a module**
  1. `path-routing.md`
  2. target layer doc (`apps-layer.md` or `platform-layer.md`)
  3. module design doc in `src/main/*/*/DESIGN.md`
- **Add or change APIs/events**
  1. `integration-contracts.md`
  2. `path-routing.md`
  3. impacted transport files (`ipc`, `http/routes`, `preload`, `renderer/api`)
- **Change data schema or storage path**
  1. `storage-and-data-model.md`
  2. module migration files
  3. related shared type definitions
- **Debug behavior across modules**
  1. `runtime-flows.md`
  2. `integration-contracts.md`
  3. `testing-and-observability.md`

## 3) Source of Truth Reminder

When this index and code diverge, code wins.

Primary truth layers:

1. `src/**` implementation
2. module `DESIGN.md` files
3. these reference docs
