# apps/team -- Design Decisions

> Module owner: apps/team
> Status: Implementation (data layer)

---

## 1. Module Role

Pure data/persistence layer for the Digital Team feature. Peer of `apps/manager`.

Owns the nine team tables and their migrations. Consumed by the future
`apps/team` service (lifecycle: create/dissolve/manage, lead provisioning, AI
auto-build, epoch start/seal) and by the `runtime/team` coordination kernel
(Message Bus + Blackboard facade).

Does NOT: run teams, route messages, enforce collaboration topology, call
agents, or own any IPC. The store enforces only SQLite constraints; all business
rules live above it.

Dependency direction: `apps/team` depends downward on `platform/store` only. It
never imports `apps/runtime` or `services/*` business logic.

`lead.ts` (`buildLeadSystemPrompt` + `provisionLeadSpec`) also lives here: the
lead app spec is side-effect-free provisioning data the service installs, so it
belongs in this layer rather than in `runtime/team` (keeping the service free of
an upward runtime dependency). Live turn mechanics remain in
`runtime/team/team-prompt.ts`.

---

## 2. Table Ownership

All nine tables live in the shared app-level database (`halo.db`), versioned
under the isolated migration namespace `app_team`.

| Table | Grain | Lifetime |
|-------|-------|----------|
| `teams` | one row per team | long-lived definition |
| `team_members` | (team_id, app_id) | long-lived definition |
| `team_edges` | (team_id, from, to) | long-lived definition (structured mode only) |
| `blackboard_tasks` | one row per task | per-epoch; retained after seal for history |
| `blackboard_findings` | append-only | per-epoch; retained after seal for history |
| `team_activity` | append-only | per-epoch; retained after seal (it IS the history) |
| `team_epochs` | one row per run OR conversation | per-epoch; retained for history |
| `team_triggers` | one row per trigger | long-lived definition |
| `team_checks` | one row per periodic check | per-epoch; deleted when its epoch ends |

Epoch-scoped rows are never auto-deleted on seal — they remain as the durable,
observable record of a run (技术 §8.2 persistence layering).

### Member-owned columns (v10)

Three `team_members` columns are written by the member's OWNER and by nobody
else:

- `duty` — what the member is responsible for **in this team**. Office-shared:
  teammates read it in full (roster snapshot + `member_profile` replication). It
  is the ONLY home for that text: an AI-proposed member's `responsibility` seeds
  this column and is deliberately kept out of the app spec it provisions, since
  a copy frozen in the system prompt could never be reached by the owner's later
  edits and would leave the member holding two conflicting job descriptions.
- `delegated_policy_json` — what a teammate may make it do. NULL = unrestricted,
  so a team that never opened the screen behaves exactly as before. **Never
  replicated**: it guards one person's machine, so only that machine needs it.
- `accepts_checks` — the single bit of that policy other nodes do need, so a
  teammate is refused a periodic check early and readably instead of at the far
  end. Derived from the policy on write.

`materializeJoinedOffice` replaces the roster wholesale (the authority is the
single writer) but exempts these three for members owned by THIS node: a snapshot
taken before the owner's latest edit reached the authority must not undo it.

### Schema notes / deviations from 技术 §8.2

- `team_members` carries an extra column `ai_provisioned INTEGER NOT NULL
  DEFAULT 0`, present in the frozen `TeamMember` contract but not shown in
  §8.2. It marks members whose app was auto-created for this team (AI sourcing)
  so the service can clean up orphans on dissolve. Manual members are never
  auto-deleted.
- All other columns, indexes, and unique constraints match §8.2 exactly.

---

## 3. Store Method Catalog

`TeamStore` (prepared statements, synchronous). Grouped by table:

- **teams**: `insertTeam`, `getTeamById`, `listTeams`, `listTeamsBySpace`,
  `updateTeamFields` (partial: name/goal/strategy enums), `updateTeamStatus`,
  `updateTeamLeadAppId`, `updateTeamCurrentEpoch`, `deleteTeam`.
- **team_members**: `addMember`, `removeMember`, `listMembersByTeam`,
  `getMemberByName` (team-unique addressing lookup), `getMember` (by app id),
  `listMembersByAppId` (cross-team membership lookup), `updateMemberFields`
  (partial: duty / delegated policy / accepts-checks), `setMemberLead`,
  `setMemberScope`.
- **team_edges**: `replaceEdgesForTeam` (transactional clear + re-insert),
  `listEdgesByTeam`, `isEdgeAllowed(from, to)` (structured-mode permission).
- **blackboard_tasks**: `insertTask`, `getTaskById`, `updateTask` (partial
  patch by id), `listTasksByEpoch`, `listTasksByTeam`.
- **blackboard_findings**: `insertFinding` (append-only), `listFindingsByEpoch`
  (ordered by created_at then rowid for stable append order).
- **team_activity** (v12): `insertActivity` (append-only AND idempotent by id —
  `INSERT OR IGNORE`, since the same immutable row arrives twice on the
  replication paths), `deleteActivity` (shadow-write rollback / snapshot
  reconcile), `listActivityByEpoch`, `listActivityByTeam` (replication snapshot).
  There is deliberately no "has this been answered?" query: every reader already
  holds the epoch's acts, and deriving it from them (`answeredCorrelationIds` in
  `shared/apps/team-types`) keeps one rule rather than two that can disagree.
- **team_epochs**: `insertEpoch`, `getEpochById`, `endEpoch` (seal),
  `touchEpoch` (stamp `last_activity_at`, monotonic), `listEpochsByTeam`,
  `getCurrentEpochForTeam` (open epoch, or null when idle).
- **team_checks**: `upsertCheck` (idempotent whole-row — the row is office-shared
  and later writes win), `getCheckById`, `deleteCheck`, `listChecksByEpoch`,
  `listChecksByTeam`, `listAllChecks` (boot rehydration),
  `deleteChecksByEpoch` (returns the removed rows so the caller disarms alarms).

Partial updates (`updateTeamFields`, `updateTask`) build the SET clause from
only the supplied fields and always bump the relevant timestamp; omitted fields
are preserved.

---

## 4. Concurrency

No in-process locking is required, by construction:

- Team/task/epoch writes target a single primary key; member/edge writes target
  a composite primary key. Different actors writing the blackboard never touch
  the same key (tasks are owned by id; the lead creates, the assignee updates
  its own row).
- Findings and activity are append-only — every write is a fresh row, so
  concurrent appends never clobber each other. Activity goes further and is
  idempotent by id, because the replication plane can deliver the same immutable
  row twice (an author's optimistic copy echoed back, or a catch-up replay).
- This mirrors the product trade-off of not introducing file locks or heavy
  concurrency control (技术 §6). better-sqlite3 + WAL (configured by
  platform/store) serializes the single writer safely.

---

## 5. Initialization

`initTeamStore({ db })` (synchronous): gets the shared app database, runs the
`app_team` migrations, constructs the `TeamStore`, and stores the singleton.
`getTeamStore()` returns the singleton or null. `shutdownTeamStore()` clears the
singleton (SQLite connections are owned by platform/store).

Bootstrap wiring (a later task) calls `initTeamStore({ db })` after `initStore()`
in `bootstrap/extended.ts`, alongside `initAppManager({ db })`.
