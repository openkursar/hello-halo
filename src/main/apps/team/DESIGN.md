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
| `team_tool_audit` | append-only | local-only; pruned by age, never replicated |

Not a table: `team-retained-duties.json` beside `halo.db` (see "A duty outlives
leaving a joined team").

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
- `delegated_policy_json` — what a request from another machine may make it
  do. **Never replicated**: it guards one person's machine, so only that machine
  needs it. The owner's own digital humans are never held to it. How it reads is
  the runtime's (see `apps/runtime/team/DESIGN.md`): NULL, or a policy granting
  everything (`grantsEverything`), lends a colleague's request the owner's own
  reach; anything else is read strictly. The settings screen shows exactly that
  reading.

  A team **crosses machines** once it was joined from elsewhere, holds a member
  from another machine, or an invite to it was ever created — revoked or
  expired ones too (`crossesMachines`, projected as `TeamDetail.crossesMachines`;
  the invite ledger is injected as `hasIssuedInvite`). Every member of this node
  that becomes reachable from another machine is given a policy someone chose:
  the first invite saves the screen's answer (read-only by default) for every
  local member once the call that may create the link returns, unless it
  answers that it created none (Remote Access off; `first-invite.ts` in the
  renderer); joining saves it for the brought members, whose rows
  `materializeJoinedOffice` first writes read-only so the moment between join
  and that save lends nothing; a member added to a team that already crosses
  machines carries the answer chosen while adding
  (`TeamMemberInput.delegatedPolicy`), or read-only when none was given — the
  lead a saved collaboration provisions on its first run included
  (`startingDelegatedPolicy`).

  Rows written before these writes existed keep what they hold, NULL included:
  on a team that already crossed machines that NULL lends a colleague's request
  everything, which is what the settings screen shows. Nothing rewrites them
  without the owner — an invite on such a team saves only an answer the owner
  clicks.
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

### A duty outlives leaving a joined team

Leaving a team hosted elsewhere deletes this node's rows for it, and the host
removes the members' rows on its side; the duty lived only there, and a member
without one is mute. So whenever members of this node leave — all of them
(leaving the team) or one (taken out while the rest stay) — the controller
keeps each one's duty (`retainMemberDuties`): before a leave, and once a
withdraw was sent (a refused one keeps nothing). Entries are keyed by (team id,
app id): the team id is the office id, which every invite to the same team
carries again, so a different team with the same name never inherits one. An
empty duty keeps nothing and forgets an entry kept before.

Invariant: while a member still has a row, its entry (if any) follows the row —
`updateMemberFields` rewrites it on every duty write that changed a row, and an
empty duty forgets it. An entry and a row coexist only while a removal is on
its way or after one never arrived; nothing new is kept by an edit.

`materializeJoinedOffice` gives a kept duty back to a member of this node that
enters the office with no row here, consumes it, and returns those members
(`dutiesRestored`) so the owner publishes the profile (`member_profile`) — a
rejoin brings no duty, the join request carries none. Only the owner writes a
duty and the entry followed the row until it left, so the kept copy is never
older than one the office may still hold, and it wins. A member in the
caller's `departed` (it left during this joining; federation DESIGN) has not
re-entered: a roster still listing it is behind, so its entry is neither given
back nor used up. Kept only for exits this node starts: a host's removal keeps
nothing, as before. A team never rejoined keeps its entries — one per member
that left with a duty.

They live in `team-retained-duties.json` beside `halo.db` (`retained-duties.ts`;
an in-memory database keeps them in memory), not in a table: a migration copies
the whole database on every machine's first start and stops older builds that
share the data folder from opening it, which a few entries written on leaving
do not justify. Read on first use (entries of the wrong shape are skipped and
logged), written through on every change.

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
  Dissolve also removes the team folders of every epoch the team had
  (`runtime.teamFolders.remove`, see `apps/runtime/team` DESIGN), reading the
  epoch ids before the team row goes.

- `teams.ephemeral` + `teams.coordinator_conversation_id` (v18) mark a
  TEMPORARY SPACE COLLABORATION: a team the space agent assembled for one
  piece of work, coordinated by the space conversation itself rather than a
  lead app. Its `lead_app_id` holds the coordinator SENTINEL
  (`spaceCoordinatorAppId(conversationId)`, `shared/apps/team-types`), which
  also occupies a member row (`member_name = 'coordinator'`, `is_lead`,
  `is_system_coordinator`, `ai_provisioned = 0` so dissolve never tries to
  uninstall an app that does not exist). Consequences the code keeps:
  - the sentinel has no app record, so anything keyed on "the app's space"
    reads the team's `owning_space_id` for it instead (`listArtifacts`, and the
    runtime's `createMemberWorkDirResolver`).
  - hidden everywhere person-facing: `listDirectoryMemberships` carries the
    flag (directory exclusion), `listTeamItems` carries it (Teams page and
    picker filtering), and one collaboration exists per conversation
    (`getCollabTeamByConversation`).
  - `runTeam` refuses an ephemeral team; "save as team" (`saveCollab`) only
    clears the flag — the real lead is provisioned lazily on the saved team's
    first standalone run, so saving never disturbs the live collaboration.
  - collaboration creation requires the coordinator session's captured source and
    model, passed through the toolset scope (never read again from global selection
    or a conversation whose picker may have changed mid-turn). Before any member
    can be dispatched, the service persists both in its existing app overrides.
    Missing capture refuses creation; no credentials are copied. Saving preserves
    the pins, and the later standalone lead inherits the saved members' selection.
    Existing, independently configured digital humans are not rewritten.
  - a member the team BUILT is disposable: the app dies with the collaboration,
    so what only pays off over a longer life is withheld from its turns — its
    memory, and managing other digital humans (it would otherwise be creating
    artifacts that outlive it). A member the person installed is never
    disposable. The predicate and its consequences live in the runtime (see
    `apps/runtime/team` DESIGN, `selfIsDisposable`).
  - its one epoch is a `'conversation'` epoch keyed
    `space:{conversationId}` (`spaceCollabChatKey`), so it never occupies
    `current_epoch_id`, never auto-seals on quiescence, and seals through
    `completeCollab` (team_complete) as `completed`.
  - the disposable-member gating (`selfIsDisposable`, stripping memory and the
    digital-human MCPs from a member's turn) applies to TEAM turns only —
    `app-chat` is the sole entry point that carries a team context. It is
    deliberately absent from `apps/runtime/execute.ts`: an ephemeral member's
    spec declares no subscriptions, so the automation path is unreachable by
    construction, and a manual out-of-band trigger (HTTP trigger by appId)
    runs it as a plain app — the same pre-existing semantic every
    AI-provisioned team member has had. The gating is a token-cost trim on the
    team hot path, not a security boundary; do not mirror it into execute. That epoch projects as
    `kind: 'collab'` (`epoch-label`), which is how a surface finds the room its
    coordinating conversation owns instead of inferring it from the team shape.
  - `openConversation` refuses an ephemeral team: the collaboration works in ONE
    conversation, so a second one here would be a context nobody coordinates and
    that `getCollabForConversation` could not find again. Saving the team is what
    makes separate tasks possible.
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
- **joined offices**: `materializeJoinedOffice` (wholesale roster mirror;
  returns the members whose kept duty it gave back; optional `departed`),
  `purgeJoinedOffice`, `retainMemberDuties` (see "A duty outlives leaving a
  joined team").
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
- **team_tool_audit** (v17): `insertToolAudit` (append-only, idempotent by id),
  `listToolAudit` (newest first, optionally one member), `pruneToolAudit`.
  The one table here that is NOT office state: it records what a member did on
  THIS machine while somebody else drove it, which is a fact about the owner's
  computer rather than about the office. So it is absent from the replication
  snapshot, absent from the office-member HTTP allowlist, and read only over
  desktop IPC — replicating it would hand every teammate a map of the owner's
  filesystem. It is the counterpart to `delegated_policy_json`, and stays local
  for the same reason.
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

