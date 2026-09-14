# Integration Contracts Reference

Scope: bootstrap sequencing, IPC/HTTP/WS contracts, preload, and renderer API integration.

## 1) Bootstrap Contracts

## 1.1 Entry points

- Main process startup: `src/main/index.ts`
- Bootstrap public module: `src/main/bootstrap/index.ts`
- Essential phase: `src/main/bootstrap/essential.ts`
- Extended phase: `src/main/bootstrap/extended.ts`

## 1.2 Apps and Platform initialization

`initPlatformAndApps()` in `extended.ts` runs:

1. `initStore()`
2. `initScheduler({ db })`, `initEventBus()`, `initMemory()` in parallel
3. event source registration (`FileWatcherSource`, `ScheduleBridgeSource`)
4. `initAppManager({ db })`
5. `initAppRuntime({ ... })`
6. `scheduler.start()` and `eventBus.start()`

Important behavior:

- app handlers are registered before full async init completes
- manager/runtime lookups can return not-ready responses early in process lifetime

## 2) IPC Contracts

## 2.1 App channels (`src/main/ipc/app.ts`)

Lifecycle and runtime channels:

- `app:install`
- `app:uninstall`
- `app:list`
- `app:get`
- `app:pause`
- `app:resume`
- `app:trigger`
- `app:get-state`
- `app:get-activity`
- `app:respond-escalation`
- `app:update-config`
- `app:update-frequency`

Runtime event channels sent to renderer:

- `app:status_changed`
- `app:activity_entry:new`
- `app:escalation:new`

## 2.2 IPC registration pattern

- `registerAppHandlers()` is called directly in `src/main/bootstrap/extended.ts`.
- `src/main/ipc/index.ts` currently does not re-export app handler registration.

## 3) HTTP Contracts

Defined in `src/main/http/routes/index.ts`.

## 3.1 App routes implemented

- `GET /api/apps`
- `POST /api/apps/install`
- `GET /api/apps/:appId`
- `DELETE /api/apps/:appId`
- `POST /api/apps/:appId/pause`
- `POST /api/apps/:appId/resume`
- `POST /api/apps/:appId/trigger`
- `GET /api/apps/:appId/activity`
- `POST /api/apps/:appId/escalation/:entryId/respond`
- `GET /api/apps/:appId/state`

## 3.2 App route gaps and mismatches

No known gaps at this time. All app-related HTTP routes are implemented, including config and frequency endpoints.

## 4) WebSocket Contracts

Core WS manager: `src/main/http/websocket.ts`.

Current semantics:

- conversation subscription model is still present (`subscribe` with `conversationId`)
- app runtime events are broadcast via `broadcastToAll(...)` and delivered as generic event frames

App event channels currently broadcast:

- `app:status_changed`
- `app:activity_entry:new`
- `app:escalation:new`

## 5) Preload and Renderer API Contracts

## 5.1 Preload bridge

`src/preload/index.ts` exposes app methods:

- `appList`, `appGet`, `appInstall`, `appUninstall`
- `appPause`, `appResume`, `appTrigger`
- `appGetState`, `appGetActivity`, `appRespondEscalation`
- `appUpdateConfig`, `appUpdateFrequency`

and app event listeners:

- `onAppStatusChanged`
- `onAppActivityEntry`
- `onAppEscalation`

## 5.2 Renderer adapter

`src/renderer/api/index.ts` provides IPC-or-HTTP unified methods with the same app API surface.

## 5.3 Transport mapping

`src/renderer/api/transport.ts` includes method map entries for app event channels.

## 6) Event Bridging Contracts

Runtime emits app events through both:

- `sendToRenderer(...)` for desktop renderer
- `broadcastToAll(...)` for remote websocket clients

Primary source files:

- `src/main/apps/runtime/service.ts`
- `src/main/apps/runtime/report-tool.ts`

## 7) Integration Watchouts

- Keep transport contract names aligned across IPC, preload, renderer API, and HTTP.
- If new app event channels are added, update:
  1. IPC sender
  2. preload listener
  3. renderer transport method map
  4. renderer API wrapper
