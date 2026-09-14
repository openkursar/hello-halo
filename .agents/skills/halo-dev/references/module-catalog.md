# Module Catalog

Quick jump list for engineers who already know the target area.

## Apps Modules

| Module | Purpose | Primary Files | Design Doc |
|---|---|---|---|
| `apps/spec` | App spec parse/normalize/validate | `src/main/apps/spec/index.ts`, `src/main/apps/spec/schema.ts` | `src/main/apps/spec/DESIGN.md` |
| `apps/manager` | install/uninstall/status/config persistence | `src/main/apps/manager/index.ts`, `src/main/apps/manager/service.ts`, `src/main/apps/manager/store.ts` | `src/main/apps/manager/DESIGN.md` |
| `apps/runtime` | activation, execution, activity, escalation | `src/main/apps/runtime/index.ts`, `src/main/apps/runtime/service.ts`, `src/main/apps/runtime/execute.ts`, `src/main/apps/runtime/report-tool.ts` | `src/main/apps/runtime/DESIGN.md` |
| `apps/conversation-mcp` | in-process MCP server for app management tools | `src/main/apps/conversation-mcp/index.ts` | N/A |

## Platform Modules

| Module | Purpose | Primary Files | Design Doc |
|---|---|---|---|
| `platform/store` | SQLite manager + migration runner | `src/main/platform/store/index.ts`, `src/main/platform/store/database-manager.ts` | `src/main/platform/store/DESIGN.md` |
| `platform/scheduler` | persistent schedule engine and run logs | `src/main/platform/scheduler/index.ts`, `src/main/platform/scheduler/timer.ts`, `src/main/platform/scheduler/store.ts` | `src/main/platform/scheduler/DESIGN.md` |
| `platform/event` | event routing, filtering, dedup, adapters | `src/main/platform/event/index.ts`, `src/main/platform/event/event-bus.ts`, `src/main/platform/event/sources/*.ts` | N/A |
| `platform/memory` | scoped memory tools and file management | `src/main/platform/memory/index.ts`, `src/main/platform/memory/tools.ts`, `src/main/platform/memory/paths.ts` | `src/main/platform/memory/DESIGN.md` |
| `platform/background` | keep-alive, tray, daemon browser | `src/main/platform/background/index.ts`, `src/main/platform/background/daemon-browser.ts`, `src/main/platform/background/keep-alive.ts` | `src/main/platform/background/DESIGN.md` |

## Integration Modules

| Area | Purpose | Primary Files |
|---|---|---|
| bootstrap | startup/shutdown orchestration | `src/main/bootstrap/essential.ts`, `src/main/bootstrap/extended.ts`, `src/main/bootstrap/state.ts` |
| IPC | desktop transport handlers | `src/main/ipc/app.ts`, plus other channels in `src/main/ipc/*.ts` |
| HTTP routes | remote REST transport | `src/main/http/routes/index.ts` |
| WebSocket | remote real-time broadcast | `src/main/http/websocket.ts` |
| preload bridge | renderer-safe IPC exposure | `src/preload/index.ts` |
| renderer API adapter | IPC/HTTP unified client | `src/renderer/api/index.ts`, `src/renderer/api/transport.ts` |

## Shared Contracts

| Contract | Files |
|---|---|
| app spec shared types | `src/shared/apps/spec-types.ts` |
| app runtime shared types | `src/shared/apps/app-types.ts` |

## Renderer App-related State

| Store | Purpose |
|---|---|
| `src/renderer/stores/apps.store.ts` | installed apps, runtime state, activity data |
| `src/renderer/stores/apps-page.store.ts` | Apps-page UI navigation state |
