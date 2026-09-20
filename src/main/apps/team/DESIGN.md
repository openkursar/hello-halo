# apps/team -- Design Decisions

> Module owner: apps/team
> Status: Implementation (data layer)

---

## 1. Module Role

Persistence and lifecycle service for the Digital Team feature. Peer of `apps/manager`.

Owns team persistence and migrations. The `service.ts` facade handles creation,
membership, lead provisioning and task projections; execution is delegated to
the injected `runtime/team` contract. The coordination kernel consumes the store
through its exported contract.

The store does not execute agents, route messages or own transport handlers.
Business rules live in the service; live coordination belongs to `runtime/team`.

Persistence depends on `platform/store`. The service receives manager and runtime
behavior through injected contracts; provisioning and artifact services are
lower-tier dependencies. Runtime execution must not move into transport.

`lead.ts` (`buildLeadSystemPrompt` + `provisionLeadSpec`) also lives here: the
lead app spec is side-effect-free provisioning data the service installs, so it
belongs in this layer rather than in `runtime/team` (keeping the service free of
an upward runtime dependency). Live turn mechanics remain in
`runtime/team/team-prompt.ts`.

---

## 2. Table Ownership

All team tables live in the shared app-level database (`halo.db`), versioned
under the isolated migration namespace `app_team`.

| Table | Grain | Lifetime |
|-------|-------|----------|
| `teams` | one row per team | long-lived definition |
| `team_members` | (team_id, app_id) | long-lived definition |
| `team_edges` | (team_id, from, to) | long-lived definition (structured mode only) |
| `blackboard_tasks` | one row per task | per-epoch; retained after seal for history |
| `blackboard_findings` | append-only | per-epoch; retained after seal for history |
| `team_activity` | append-only | per-epoch; retained after seal (it IS the history) |
| `team_epochs` | one row per run OR conversation, including business task metadata | retained for history; resource teardown does not imply business completion |
| `team_triggers` | one row per trigger | long-lived definition |
| `team_checks` | one row per periodic check | per-epoch; deleted when its epoch ends |

Epoch-scoped rows are never auto-deleted on seal — they remain as the durable,
observable record of a run (技术 §8.2 persistence layering).

### Member-owned columns (v10, extended in v13)

Four `team_members` columns are written by the member's OWNER and by nobody
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
- `awaiting_decision` (v13) — the member asked its own person something and is
  waiting. The question is answerable only on the owner's machine, so without
  sharing this the rest of the office reads the member as idle and the work looks
  stopped rather than blocked on a human. Written only by the owning machine, and
  DERIVED rather than pushed: the runtime recomputes it from the persisted
  escalation at every team turn end, when an answer is recorded, and at startup
  (`orchestration.reconcileAwaitingDecision`) — a mark written only where an
  escalation is routed missed every turn path that does not route one. Projected
  into the member's roster status as `waiting_user`, office-shared through
  `member_profile`, and persisted because an unanswered question outlives a
  restart. The request and answer are paired append-only `team_activity` records
  sharing the escalation id. This gives every teammate the task and question
  context without making the local activity entry or answer control portable.

`materializeJoinedOffice` replaces the roster wholesale (the authority is the
single writer) but exempts these for members owned by THIS node: a snapshot
taken before the owner's latest edit reached the authority must not undo it.

### Schema notes / deviations from 技术 §8.2

- `is_system_coordinator` (v16) identifies the dedicated coordinator created
  with a team. It is independent of `is_lead`: an existing human promoted to
  lead stays in the personal directory. The local summary projects this bit;
  joined snapshots retain the owning node's value. Legacy recovery requires
  AI provisioning provenance plus the exact system-generated prompt, author
  and description. Ambiguous/custom legacy records stay visible.

- `team_members` carries an extra column `ai_provisioned INTEGER NOT NULL
  DEFAULT 0`, present in the frozen `TeamMember` contract but not shown in
  §8.2. It marks members whose app was auto-created for this team (AI sourcing)
  so the service can clean up orphans on dissolve. Manual members are never
  auto-deleted.
- Business task metadata is stored on `team_epochs`; see the task lifetime contract below.

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
  There is deliberately no "has this been answered?" query, and no derivation of
  one either: a successful reply is a fresh `message` act with its own correlation
  id, never a `reply` act, so these rows can show that a message FAILED but never
  that one was answered. Do not build "is this still waiting?" on top of them.
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


## Task persistence and lifetime

A workbench task currently has exactly one epoch. Its title, creator, entry member,
completion status and update timestamp live on `team_epochs`. `TeamWorkItem` is a
projection of those columns, with `id === epoch.id`; it is not an independent
identity and does not imply a one-to-many execution model. Reusing the existing
context after a resource pause needs no additional identity or satellite table.

Migration 14 introduced a satellite table during development. Migration 15 moves
that data onto the owning epoch and removes the table. Existing history and known
creators are preserved; unknown creators remain unknown. New native tasks record
the bootstrap-injected stable viewer identity. The service owns viewer relationship
projection; renderer preferences cannot grant ownership or access.

The optional `workItem` snapshot travels inside the existing epoch replication
envelope. Creation and replica apply are transactional. A missing snapshot does
not erase newer business metadata; timestamp guards reject stale updates.
Malformed business metadata cannot abort application of an otherwise valid epoch
replication record.

Resource sealing (`stopped`) preserves the task and can resume its existing
context. Explicit archival completes the task and ends its execution. Only a
human request may reopen a completed task; a background wake cannot unarchive it.
IM `/clear` uses a distinct terminal `cleared` reason: the next inbound message
creates a fresh epoch and model context. Looking up a task never wakes it.
Creating a native task always creates a unique chat key, including when an entry
member is specified; member selection is not a task identity.

The conversation list includes historical and current native tasks, reception and
automatic runs. Direct member channels remain addressable but are excluded from
the task list. Reception entries carry their serving member. List projections
use relationship and output metadata rather than materializing activity bodies.
Team cards use immutable creation order, newest first; runtime and decision
updates do not move cards under the pointer.

Rendering, navigation and audience rules are owned by
[`components/team/workbench/DESIGN.md`](../../../renderer/components/team/workbench/DESIGN.md).

The public store exposes a single lightweight directory-membership projection for
cross-team people filtering. It returns local app/team IDs, names and coordinator
flags without loading every team's tasks, transcripts or full member specs.
