# Path Routing Matrix

Use this matrix to quickly load only necessary context.

## 1) Main Process by Path

| Path Prefix | Required Reading | Primary Source Files |
|---|---|---|
| `src/main/apps/spec/` | `apps-layer.md`, `storage-and-data-model.md` | `src/main/apps/spec/index.ts`, `src/main/apps/spec/schema.ts`, `src/main/apps/spec/DESIGN.md` |
| `src/main/apps/manager/` | `apps-layer.md`, `runtime-flows.md`, `storage-and-data-model.md` | `src/main/apps/manager/index.ts`, `src/main/apps/manager/types.ts`, `src/main/apps/manager/migrations.ts`, `src/main/apps/manager/DESIGN.md` |
| `src/main/apps/runtime/` | `apps-layer.md`, `runtime-flows.md`, `integration-contracts.md` | `src/main/apps/runtime/index.ts`, `src/main/apps/runtime/service.ts`, `src/main/apps/runtime/execute.ts`, `src/main/apps/runtime/report-tool.ts`, `src/main/apps/runtime/DESIGN.md` |
| `src/main/platform/store/` | `platform-layer.md`, `storage-and-data-model.md` | `src/main/platform/store/index.ts`, `src/main/platform/store/database-manager.ts`, `src/main/platform/store/DESIGN.md` |
| `src/main/platform/scheduler/` | `platform-layer.md`, `runtime-flows.md` | `src/main/platform/scheduler/index.ts`, `src/main/platform/scheduler/timer.ts`, `src/main/platform/scheduler/store.ts`, `src/main/platform/scheduler/DESIGN.md` |
| `src/main/platform/event/` | `platform-layer.md`, `integration-contracts.md` | `src/main/platform/event/index.ts`, `src/main/platform/event/event-bus.ts`, `src/main/platform/event/sources/*.ts` |
| `src/main/platform/memory/` | `platform-layer.md`, `storage-and-data-model.md`, `runtime-flows.md` | `src/main/platform/memory/index.ts`, `src/main/platform/memory/tools.ts`, `src/main/platform/memory/paths.ts`, `src/main/platform/memory/DESIGN.md` |
| `src/main/platform/background/` | `platform-layer.md`, `integration-contracts.md` | `src/main/platform/background/index.ts`, `src/main/platform/background/daemon-browser.ts`, `src/main/platform/background/keep-alive.ts`, `src/main/platform/background/DESIGN.md` |
| `src/main/bootstrap/` | `integration-contracts.md`, `runtime-flows.md` | `src/main/bootstrap/essential.ts`, `src/main/bootstrap/extended.ts`, `src/main/bootstrap/state.ts` |
| `src/main/ipc/` | `integration-contracts.md` | `src/main/ipc/app.ts`, `src/main/ipc/index.ts`, plus touched channel handler files |
| `src/main/http/` | `integration-contracts.md` | `src/main/http/routes/index.ts`, `src/main/http/websocket.ts`, `src/main/http/server.ts` |
| `src/main/services/agent/` | `runtime-flows.md`, `integration-contracts.md` | `src/main/services/agent/helpers.ts`, `src/main/services/agent/sdk-config.ts`, session and send-message services |
| `src/main/services/watcher-host.service.ts` | `platform-layer.md`, `integration-contracts.md` | `src/main/services/watcher-host.service.ts` |

## 2) Renderer and Shared Paths

| Path Prefix | Required Reading | Primary Source Files |
|---|---|---|
| `src/preload/` | `integration-contracts.md` | `src/preload/index.ts` |
| `src/renderer/api/` | `integration-contracts.md` | `src/renderer/api/index.ts`, `src/renderer/api/transport.ts` |
| `src/renderer/stores/apps*.ts` | `apps-layer.md`, `runtime-flows.md` | `src/renderer/stores/apps.store.ts`, `src/renderer/stores/apps-page.store.ts` |
| `src/shared/apps/` | `apps-layer.md`, `storage-and-data-model.md` | `src/shared/apps/spec-types.ts`, `src/shared/apps/app-types.ts` |

## 3) Tests

| Path Prefix | Required Reading | Primary Source Files |
|---|---|---|
| `tests/unit/apps/` | `apps-layer.md`, `runtime-flows.md`, `testing-and-observability.md` | `tests/unit/apps/*/*.test.ts` |
| `tests/unit/platform/` | `platform-layer.md`, `testing-and-observability.md` | `tests/unit/platform/*/*.test.ts` |
| `tests/unit/services/` | `integration-contracts.md`, `testing-and-observability.md` | `tests/unit/services/*.test.ts` |
