# apps/team -- Design Decisions

> Module owner: apps/team
> Status: Implementation (data layer)

---

## 1. Module Role

Pure data/persistence layer for the Digital Team feature. Peer of `apps/manager`.

Owns the six team tables and their migrations. Consumed by the future
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

All six tables live in the shared app-level database (`halo.db`), versioned
under the isolated migration namespace `app_team`.

| Table | Grain | Lifetime |
|-------|-------|----------|
| `teams` | one row per team | long-lived definition |
| `team_members` | (team_id, app_id) | long-lived definition |
| `team_edges` | (team_id, from, to) | long-lived definition (structured mode only) |
| `blackboard_tasks` | one row per task | per-epoch; retained after seal for history |
| `blackboard_findings` | append-only | per-epoch; retained after seal for history |
| `team_epochs` | one row per run | per-run; retained for history |

Epoch-scoped rows are never auto-deleted on seal — they remain as the durable,
observable record of a run (技术 §8.2 persistence layering).

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
  `getMemberByName` (team-unique addressing lookup), `listMembersByAppId`
  (cross-team membership lookup).
- **team_edges**: `replaceEdgesForTeam` (transactional clear + re-insert),
  `listEdgesByTeam`, `isEdgeAllowed(from, to)` (structured-mode permission).
- **blackboard_tasks**: `insertTask`, `getTaskById`, `updateTask` (partial
  patch by id), `listTasksByEpoch`, `listTasksByTeam`.
- **blackboard_findings**: `insertFinding` (append-only), `listFindingsByEpoch`
  (ordered by created_at then rowid for stable append order).
- **team_epochs**: `insertEpoch`, `getEpochById`, `endEpoch` (seal),
  `listEpochsByTeam`, `getCurrentEpochForTeam` (open epoch, or null when idle).

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
- Findings are append-only — every write is a fresh row, so concurrent appends
  never clobber each other.
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
