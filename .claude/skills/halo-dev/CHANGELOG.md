# Halo Architecture Changelog (Indexed v2)

> Focus: architectural and module-level milestones relevant to engineering decisions.

## 2026-02-21 - AI Workstation Foundation (Phase 0-3)

Major milestone delivering foundational Apps/Platform layers:

- Added `src/main/apps/` modules:
  - `spec` (YAML schema parsing/validation)
  - `manager` (installation/lifecycle/state persistence)
  - `runtime` (execution orchestration, activity thread, escalation handling)
- Added `src/main/platform/` modules:
  - `store` (SQLite manager + namespaced migrations)
  - `scheduler` (persistent scheduling + backoff)
  - `event-bus` (adapters, filters, dedup)
  - `memory` (scoped memory tools and files)
  - `background` (keep-alive/tray/daemon browser)
- Added app integration surfaces:
  - IPC: `src/main/ipc/app.ts` with app lifecycle and runtime channels
  - HTTP: `/api/apps/*` routes in `src/main/http/routes/index.ts`
  - Renderer bridge: app methods in `src/preload/index.ts` and `src/renderer/api/index.ts`
- Updated bootstrap and lifecycle behavior:
  - extended bootstrap now initializes platform/apps asynchronously
  - `window-all-closed` now respects background keep-alive
- Added shared app types for renderer-safe usage:
  - `src/shared/apps/spec-types.ts`
  - `src/shared/apps/app-types.ts`
- Added unit coverage for new module layers:
  - `tests/unit/apps/*`
  - `tests/unit/platform/*`

## Earlier major milestones (pre-foundation)

- Multi-provider AI sources and auth model
- Content Canvas file preview architecture
- AI Browser tool stack and stealth subsystem
- Remote access HTTP + WebSocket architecture
- Space path/data model refinements
- Conversation thoughts separation and backend SSOT improvements
- Health and performance infrastructure

## 2026-07-18 - Digital Team Federation & Unified Feed Substrate

Cross-machine digital-team offices reached release candidate:

- Added `src/main/apps/team` + `src/main/apps/runtime/team` (coordination kernel:
  message-bus, blackboard, orchestration — transport-free).
- Added `src/main/apps/federation` + `src/main/apps/runtime/federation`
  (join/presence coordinator, host/joiner manager, M2 authority
  election/replication/handover, activity relay, device-key identity).
- Added the unified feed substrate (`runtime/federation/log/` + `ctrl-feed` +
  `session-feed`): durable per-author outbox (effectively-once wake/turn-complete),
  multi-replica session transcripts with local-first history reads, WAN-tolerant
  delivery semantics (reconnect grace, bounded give-up as the sole undeliverable
  arbiter).
- Added `gateway/` (repo-root Go module): dumb relay for off-LAN offices.
- Added the cluster regression tier `tests/decentralized/` (real multi-process
  nodes; 62-scenario federation suite).
- Integration surfaces: `ipc/team.ts`, `http/routes/team.routes.ts`, `team:*`
  event family (incl. `team:member-history` replica-refresh), `components/team/`,
  `stores/team.store.ts`.
- Location-transparent artifact reads (`team_read_artifact`): logic lives in
  `apps/runtime/team/artifact-read.ts` (bootstrap only wires seams); published-ref
  semantics (finding ref OR task resultRef) are a single source of truth in
  `apps/team/artifact-refs.ts`, shared with the federation owner-serve gate;
  remote fetch failures are classified by exported codes
  (`classifyArtifactFetchFailure`), never by message prose.
- ARCHITECTURE.md §24 documents the model + invariants.

## Notes

For detailed per-module design rationale, use:

- `src/main/apps/*/DESIGN.md`
- `src/main/platform/*/DESIGN.md`
