# Halo Architecture Changelog (Indexed v2)

> Focus: architectural and module-level milestones relevant to engineering decisions.

## 2026-07-18 - P2P Office Resilience: transferable authority, survivable host loss

The office authority is no longer welded to the creator node; any surviving
majority self-heals after the host dies (LAN and relay alike):

- `runtime/federation/coordinator.ts`: presence-tracking split — "address
  known" (office_nodes row) vs "silence measured" (direct transport) via the
  `isPresenceTracked` seam; untracked peer rows adopt the authority's presence
  projection into the ledger. `onNodeAdmitted` seam feeds the committed roster.
- `runtime/federation/manager.ts`: joiner persists PEER contact cards from the
  roster projection (address book + candidate order survive restart); joined
  offices route through an upstream/peer-session/dial-leg router; election-
  window direct legs (`openElectionLegs`) carry claims/votes when the authority
  dies; an elected survivor serves the re-formed star through inbound peer
  sessions; `deliverInbound` attributes dialed-leg frames to the dialed peer.
- `authority/*`: freshness-vetoed candidates (STALE_LOG/STALE_ROSTER) catch up
  from the vetoing voter then re-claim (bounded → honest pause);
  `authority-announce` frame accelerates loser convergence; roster
  admissions/departures ride the replicated log (`replicateNodeAdmitted`/
  `replicateNodeLeft`) so the quorum denominator is the COMMITTED roster;
  catch-up responses carry committedSeq.
- `gateway/` (v2-gw, negotiated on auth with explicit incompatibility reject):
  term-locked host pin (higher term takes over immediately, stale term
  refused) + hostless member↔member relay of the election vocabulary
  (rate-limited, admitted-only); TS side claims a relay room on election win.
- Regression tiers: `survivor-election.test.ts` (real managers, full
  self-heal chain incl. post-handover SECOND failure), `_rig/resilience-
  upgrade.rig.test.ts` (veto→catch-up→win, committed roster + concurrent-write
  epoch convergence, 2-node honest pause), `presence-tracking.test.ts`,
  gateway `resilience_v2_test.go` (term lock, v1/v2 mixed takeover, hostless
  relay incl. addressed frames + rate limit).
- Review hardening (three-reviewer pass): elected authority adopts full host-
  semantics presence tracking + a win-time grace window; roster commits adopt
  the ABSOLUTE payload epoch (no authority/replica drift under concurrent
  writes); a v1 gateway takeover resets the pin's term; hostless election
  relay honors addressed envelopes (`to` threaded through the member client);
  election-budget cleanup on member departure.

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
  (`classifyArtifactFetchFailure`), never by message prose. A ref belongs to one
  member per epoch: the publish gate refuses a name another member holds, and a
  ref claimed twice anyway is refused as ambiguous instead of resolved to
  whichever row sorted first.
- ARCHITECTURE.md §24 documents the model + invariants.

## Notes

For detailed per-module design rationale, use:

- `src/main/apps/*/DESIGN.md`
- `src/main/platform/*/DESIGN.md`
