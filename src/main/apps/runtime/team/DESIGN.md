# runtime/team — Coordination Kernel

The in-process coordination kernel for the Digital Team feature. This module is
a peer of `runtime/im-channels`: pure runtime orchestration primitives. It owns
the **Message Bus** (Actor-model directed messaging), the **Blackboard** (shared
coordination facade over the team store), and the **team MCP tools** the digital
humans call.

The kernel primitives (`message-bus`, `blackboard`, `checks`, `team-tools`) do
NOT import the session layer (`app-chat`, `report-tool`). The session-integration files in
this same directory (`orchestration`, `index`, `team-prompt`, `lead`) provide the
`TeamDeliveryHooks` implementation, the epoch lifecycle, the prompt layers, and
the lead template, and wire the kernel to `app-chat` through injected deps — the
direction stays downward and the cycle is broken by the runtime accessor in
`index.ts` (mirrors `im-channels` `setActiveImChannelManager`, ARCHITECTURE §22.5).

## Layer position

```
runtime/team  (this module)
  ├── may import: apps/team (TeamStore), platform/scheduler (SchedulerService),
  │               services/agent/resolved-sdk (tool/createSdkMcpServer),
  │               http/websocket (broadcastToAll), foundation/window.service (sendToRenderer)
  └── MUST NOT import: app-chat.ts, orchestration.ts, report-tool.ts (the session layer)
```

The session layer depends downward on this module; this module never imports it.
The coupling is inverted through `TeamDeliveryHooks` (see "Integration seam").

## Files

- `message-bus.ts` — Registry/addressing, topology enforcement, mailbox
  buffering, wait=true/false reply mechanics, turn-completion routing, per-epoch
  circuit breaker. Exports `createMessageBus(deps)` and the `TeamDeliveryHooks`
  /`TurnCompletion` contract the session layer implements.
- `blackboard.ts` — Scoped-write facade over `TeamStore` that emits
  `team:blackboard` after each write, plus `readBoard()` returning a
  `BlackboardSnapshot`. Roster live status is injected via `getMemberStatus`.
  Besides tasks and findings it owns `postActivity` — the office RECORD (see
  below). The agent-facing snapshot carries acts with their bodies stripped and
  only a recent tail; the full rows are for the UI, which reads the store.
- `board-digest.ts` — what a member missed, rendered into the top of its turn.
  Two halves, answering different questions: what CHANGED since this member last
  looked (a delta against a per-member, in-memory watermark), and what has NOT
  changed but should have — its own tasks sitting still, its own messages with no
  answer. The second half exists because a pure delta structurally cannot see it:
  "nothing happened" is not an event. The watermark advances to the newest act
  ACCOUNTED FOR, never to wall-clock, since two acts can share a millisecond and
  a clock-based mark would skip the second forever. Rendered twice — into the
  envelope (`orchestration.withDigest`) and onto a `team_read_board` result — from
  one implementation, so the two can never drift.
- `checks.ts` — periodic checks: one member's standing instruction for another
  ("from now on, every half hour, look at this"). Two rules shape it: the alarm
  is armed only on the machine that OWNS the target (so the setter can shut their
  computer, and an away owner simply does not wake), and the row is office-shared
  through an injected `publish` seam (so every node's board shows the same list
  and any member — or the user — can stop one it did not set). A due RECURRING
  check whose target is mid-turn is SKIPPED, never queued (probed here, then
  enforced again at the bus's dispatch gate, which also sees wakes in flight).
  Because that second gate can still refuse, the injected `wake` returns the
  bus's `WakeDisposition` and a skipped round leaves no trace — `runCount`,
  `lastRunAt` and the replicated row are what the panel and the agent read. A
  `once` check inverts both rules, having no next round: it QUEUES on a busy
  target (`onBusy: 'buffer'`), and once handed over it is RETIRED — row dropped,
  delete replicated, because the turn it starts is the record of it. Retiring
  its alarm is left to the scheduler, which disables a one-shot job by itself:
  deleting a job from inside its own due handler pulls it out from under the run
  log written on the way out, so leftovers are swept at `rehydrate()`. Checks
  end with the epoch they were set inside.
- `team-tools.ts` — `createTeamMcpServer(context)` building the `halo-team` MCP
  server with the team tools. Topology/unknown-member violations surface as
  error tool_results so the LLM sees them. A ref reaching `team_post_finding` or
  `team_update_task` is resolved through `artifact-path` BEFORE the board write
  and the whole call is refused when it does not resolve — publishing something
  unreadable used to succeed here and fail hours later on another machine, with
  the publisher sure it had shared the file and the reader sure it never
  arrived, neither holding enough of the truth to fix it.
- `artifact-path.ts` — what a published `ref` MEANS: a file inside the producing
  member's WORKING directory, stored relative to it. Two rules earn their own
  module because publishing and reading must never disagree about them. First,
  the root is the directory the agent actually works in (`getSpaceDir`), never
  the space's internal bookkeeping path — for a space pointed at a project
  folder the two differ, and resolving against the wrong one makes every
  artifact unreadable while every default-space test stays green. Second, an
  absolute path INSIDE that root is folded back to relative rather than refused:
  the model sees absolute paths everywhere, and only the relative form survives
  the trip to a teammate whose copy of the project sits elsewhere. Symlinks are
  resolved before the containment test.
- `artifact-read.ts` — the location-transparent logic behind
  `team_read_artifact`. Resolves the producing member through the published-ref
  SSOT (`apps/team/artifact-refs`: a finding's ref OR a task's resultRef), then
  reads bytes locally (`createLocalArtifactResolver`, resolving through
  `artifact-path`, shared with the federation owner-serve path) or through the
  injected remote fetch.
  Applies a binary guard and a UTF-8-boundary-safe inline ceiling. Remote
  failures arrive as the typed `RemoteArtifactError` contract (bootstrap maps
  federation codes via `classifyArtifactFetchFailure`), so raw transport codes
  never reach the agent-facing message. No remote fetch injected → cross-machine
  reads report an honest "unavailable".

## The two channels (do not conflate)

- **Mailbox (directed)**: `team_send` drops an envelope into a target's mailbox
  and wakes its team-channel turn. The message becomes that turn's input. 1:1.
- **Blackboard (shared)**: tasks/findings/activity/roster the whole team reads via
  `team_read_board` and writes via scoped tools. No directed delivery.

**The board is not the source of truth, and nothing may treat it as one.** It is
a record of what was written down. What is on it is reliable; what is missing
from it proves nothing — a member can finish work and not record it. The truth
about delivery lives in the mailbox, which has a receipt; the truth about work
lives with whoever did it. Both the Entry prompt and the digest say so
explicitly, because the failure this cost us was an agent reasoning "the task is
still pending, therefore it was not done".

## The office record (`team_activity`)

State and history are different things, and the board only had state. Tasks keep
their latest status, findings are their own content — and directed messages had
no home at all: each one only passes through the sender's transcript (as a tool
argument) and the receiver's (as a turn input), on machines that may not even be
the same. Nowhere did "who contacted whom" exist as a fact.

`team_activity` is that record. Three properties shape it:

- **Append-only.** A reply is a NEW act carrying the original's `correlationId`,
  never an edit of the message row. So "answered / awaiting reply" is derived
  (`answeredCorrelationIds` / `isAwaitingReply` in `shared/apps/team-types`, one
  rule shared by the digest and the renderer), replication is a single idempotent
  insert, and a rejected shadow write rolls back to a plain delete.
- **Recorded where the system already knows.** Messages and replies are recorded
  by the BUS (`send`, `completeTurn`, `resolvePendingWaitsForMember`) because
  that is the one point every teammate message path converges — a member's
  `team_send`, an escalation routed to the lead. Board acts are recorded by the
  tool layer. Neither depends on an agent choosing to keep a log.
- **Only digital humans act.** The record is what the digital humans did among
  themselves; a person's words are never on it. The bus keys this on
  `fromAppId === null` (see below), and `PostActivityInput.actorAppId` is
  non-nullable so the rule cannot be broken by accident: there is no way to
  file an act with no actor.
- **Content, not sentences.** A row stores the task title / message first line in
  `subject` plus the kind; the renderer composes the localized sentence and the
  digest composes an agent-facing one. Full message text is kept in `body` and is
  never put in a snapshot or a digest.

Reads (`team_read_board`, `team_read_artifact`) are deliberately NOT recorded:
they change nothing, they are frequent, and they would push the acts that matter
off the feed. "Who has seen what" is the digest's watermark, not a row.

Office-shared: it rides the same single-writer replication plane as tasks and
findings (`ReplicationOp: 'post_activity'`), because a shared conversation record
that is only true on one machine is worse than none.

## A person is not a member (`fromAppId === null`)

A person's 1:1 message to a member travels this same bus — that is how it
reaches a member owned by another machine — but it is **not team traffic**.
`SendInput.fromAppId` is null for it, and that one fact gates all three forms of
team bookkeeping: no act on the record, no circuit charge, no `team:message`
flow signal. The bus delivers, and does nothing else.

Three reasons, and the first is the one that matters:

- **A chat is not the office's business.** Everyone talks to their own digital
  human freely. Putting those words on a shared board turns a working tool into
  a room being watched, and pushes them into every OTHER member's digest —
  people who were never part of that conversation. What the office should see is
  what the digital humans DO: the tasks they hand out, the results they file.
  How a person phrased the request is the member's input, not the team's record.
- **Attribution must be true.** A person has no member identity, so a recorded
  act had to borrow one (it borrowed the lead's). That put words in the mouth of
  a digital human that never ran — visible to everyone, and fed back to the lead
  itself as "you asked X and got no answer" about a question it never asked.
- **The budget guards AI loops.** The circuit breaker exists to stop digital
  humans ping-ponging without supervision. A person cannot loop: every message
  costs them a keystroke. Charging one only let a chat eat the run's allowance
  and start `maxDurationMs` before the team began working.

This is also what makes remote match local: a local 1:1 chat never touched the
bus at all (`app-chat` runs the turn directly), so the record stayed clean —
only the remote path, which needs the bus to cross machines, was filing acts.

`TeamTriggerContext` carries the same distinction in two fields, because they
answer different questions: `fromAppId` is WHO acted (identity — what the record
and the budget key on), and `kind` is HOW the turn should read (`'human_message'`
delivers a person's words verbatim, with no `[Team message from …]` framing
impersonating a teammate). A person's send has `fromAppId: null` and
`kind: 'human_message'`; a run start has `fromAppId: null` and no person behind
it, which is why one flag could not carry both.

## Integration seam — `TeamDeliveryHooks`

The bus cannot import the session layer, so waking a target and observing
business state is injected. The session layer implements:

```ts
interface TeamDeliveryHooks {
  wakeTarget(params: {
    sessionKey, appId, teamId, epochId, envelope, trigger
  }): Promise<void>          // resolves when the woken turn STARTS being processed
  isBusy(sessionKey: string): boolean
}
```

`wakeTarget` injects the envelope as a team-channel turn with the trigger
context. Its returned promise is NOT the turn outcome — the outcome is reported
back asynchronously through `bus.completeTurn(...)` when the turn ends (any of
the four §5.6 exits). This keeps the lead non-blocking: it fires `wait=false`
sends and is re-woken later, exactly mirroring §5.6 "fire-and-get-woken".

`isBusy` lets the bus decide buffer-vs-deliver: if the target session is
mid-turn — or a wake is already IN FLIGHT for it (the busy probe only turns
true once the session layer registers the turn, so the bus reserves the key
synchronously at dispatch to keep two racing deliveries from running two
concurrent turns on one session) — the envelope is enqueued in its mailbox and
drained when the current turn completes (mirrors `dispatch-inbound`
supplement-buffering).

Mailbox liveness has three drains, because a team session also runs turns the
bus never sees (a human 1:1 chat with a member uses the same session key):
1. `completeTurn` — after every BUS-driven turn (the primary path);
2. the session layer's turn-end nudge — app-chat calls `bus.drainMailbox` when
   ANY team-session turn ends, so mail buffered behind a human turn is not
   stranded until the next bus turn (which may never come);
3. a per-session recheck timer armed at buffering — covers the race where the
   target went idle between the busy probe and the buffer push.

## Bus public API

`createMessageBus({ store, hooks, circuitOverrides? }) → MessageBus`

- `send(input) → Promise<TeamSendAsyncResult | TeamSendSyncResult>`
  Resolves member name→appId, enforces topology, and — for a teammate send only
  (`fromAppId !== null`, see "A person is not a member") — bumps circuit
  counters, records the act and emits `team:message`. Then builds the
  `TeamEnvelope` and:
  - `wait=false`: enqueue + wake target, resolve immediately with `{ messageId }`.
  - `wait=true`: enqueue + wake target, return a promise held until the target's
    turn completes (resolved by `completeTurn`) or the wait timeout fires.
  Throws `TopologyError` / `UnknownMemberError` / `CircuitBreakerError` (the tool
  layer converts these to error tool_results).
- `deliverRuntimeWake({ envelope, trigger, onBusy }) → Promise<WakeDisposition>`
  A turn the RUNTIME asked for, not a member's `team_send`: the escalation
  resume, the quiescence nudge, a due periodic check. No delivery receipt, no
  circuit charge — but the SAME busy gate as `send`, because the bus is the only
  component that knows a session already has a turn running or a wake in flight.
  A path that calls `wakeTarget` directly starts a second concurrent turn on one
  session key, and the loser's subprocess is torn down mid-stream.
  `onBusy` picks the semantics, and only the caller knows which applies:
  `'buffer'` (mailbox it, deliver at turn end) for a wake that must not be lost
  — an escalation answer is the member's ONLY way back to life, and a one-shot
  check has no second chance; `'skip'` for one that comes round again on its own
  rhythm (a recurring check).
- `completeTurn({ sessionKey, trigger, outcome })`
  Called by the session layer when a woken team turn ends. Routes per §5.2/5.3:
  - `trigger.wait=true` → resolve the pending send promise (`ok` / `timeout`).
  - `trigger.wait=false` → build a completion envelope and wake the ORIGINAL
    sender (a fresh turn) so it can reconcile against the board.
  Then releases the session's wake reservation and drains any buffered mailbox
  envelopes for that `sessionKey`.
- `drainMailbox(sessionKey)` — the session layer's liveness nudge (drain #2
  above). Idempotent; a busy or reserved session is a no-op.
- `assertCanContact(teamId, fromAppId, toAppId, collabMode)` — topology check;
  `free` allows all, `structured` uses `store.isEdgeAllowed`.
- `getEpochStats(epochId)` / `resetEpoch(epochId)` — circuit-breaker observability
  and lifecycle reset (session layer calls `resetEpoch` on seal).
- `onBreach(cb)` — subscribe to circuit-breaker breaches (orchestration polls /
  reacts; see below).

### Turn completion union

```ts
type TurnCompletion =
  | { kind: 'report_result'; content: string; taskId?: string }
  | { kind: 'report_escalation'; content: string }
  | { kind: 'no_report' }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
```

These are exactly the §5.6 four exits (plus the explicit result/escalation
report cases). The session layer maps each turn ending to one of these.

## Circuit breaker (§13.3)

Per-epoch counters centralized here, defaults from `TEAM_CIRCUIT_DEFAULTS`,
team-level overridable via `circuitOverrides`:

- `maxMessages` — total `team_send` count per epoch.
- `maxForwardDepth` — envelope chain depth (each completion-wake carries
  `forwardDepth = parent + 1`); guards A↔B ping-pong.
- `maxDurationMs` — wall-clock since the epoch's first TEAMMATE send.

A person's 1:1 message charges nothing at all (see "A person is not a member").

On breach, `send()` throws `CircuitBreakerError` (the offending action is
stopped and the LLM sees the error) AND the bus invokes `onBreach` listeners.
The session-layer orchestration subscribes via `onBreach` and turns a breach
into an escalation to the user + epoch stop. The bus does not import
orchestration; it only surfaces the signal. Surfacing is therefore two-pronged:
a thrown error at the call site, and an `onBreach` event for the supervisor.

## Blackboard facade

`createBlackboard({ store, getMemberStatus? }) → Blackboard`

- `postTask({ teamId, epochId, callerAppId, title, assignee, assigneeAppId, parentId? }) → { taskId }`
- `updateTask({ teamId, epochId, taskId, status, resultRef?, note? })`
- `postFinding({ teamId, epochId, callerAppId, content?, ref? }) → { findingId }`
- `postActivity({ teamId, epochId, kind, actorAppId, subject, ... }) → { activityId }`
- `readBoard(teamId, epochId, callerAppId, filter?) → BlackboardSnapshot`

Each task/finding write emits `team:blackboard`. `getMemberStatus(appId)` is
injected (defaults to `'idle'`) because live member status lives in runtime, not
the store — keeping the blackboard decoupled from session state.

## Team MCP context

`createTeamMcpServer(context) → halo-team` with tools `team_send`,
`team_post_task`, `team_update_task`, `team_post_finding`, `team_read_board`,
`team_read_artifact`, `team_schedule`, `team_unschedule`, `team_complete`
(`report` is the existing report_to_user, owned by the session layer — NOT here).
`team_read_board`'s snapshot carries the epoch's periodic `checks`, so the tool
that answers "what is already assigned" also answers "what is already watched".

```ts
interface TeamMcpContext {
  teamId: string
  epochId: string
  callerAppId: string
  collabMode: CollabMode
  bus: MessageBus
  blackboard: Blackboard
  checks?: TeamChecks
}
```

`team_send` / `team_post_task` resolve `assignee`/`to` member names → appIds and
enforce topology; unknown members and topology violations return
`isError: true` tool_results with a clear message so the LLM corrects course.

## Session integration layer

These files turn the kernel into a running feature. They sit in the same module
but depend on the session tier (`app-chat`, `report-tool`); they are the only
files here allowed to.

- `index.ts` — `createTeamRuntime({ store, session? })` constructs the bus +
  blackboard + orchestration and returns `{ bus, blackboard, startEpoch,
  ensureConversationEpoch, sealEpoch, requestSeal, captureReport,
  buildPromptContext }`. The bus is built first with a
  thin hook shim that forwards to the orchestration once it exists (breaking the
  bus↔orchestration construction cycle). `session` defaults to an app-chat-backed
  `OrchestrationSessionDeps` (loaded via dynamic import so app-chat stays out of
  the static graph). Also exposes the accessor `setActiveTeamRuntime` /
  `getActiveTeamRuntime` consumed by `app-chat` (MCP injection + prompt context)
  and `report-tool` (captureReport). Bootstrap (Task 4) calls
  `setActiveTeamRuntime(createTeamRuntime({ store }))` after the team store init.
- `orchestration.ts` — implements `TeamDeliveryHooks` (`wakeTarget` starts a
  team-channel turn via `sendAppChatMessage` and resolves once it STARTS; a
  detached chain maps the turn's ending to a `TurnCompletion` and calls
  `bus.completeTurn`). Owns `startEpoch` (wake the lead once) and `sealEpoch`
  (archive epoch, clear every member's team session, `bus.resetEpoch`, idle the
  team — tasks/findings retained for history). Subscribes `bus.onBreach` →
  escalate-to-user + seal. Provides `captureReport` (report sink), the
  `getMemberStatus` projection (working when the member's team session is
  mid-turn), and `buildPromptContext(teamId, selfAppId)` (roster + topology).
  Honors `escalationRouting`: a member escalation under `'lead'` is re-sent to
  the lead's mailbox and the report-tool suppresses its user-facing emission
  (no double-send); under `'user'` the report-tool's tagged entry stands and is
  surfaced to the user. Its own wakes (escalation resume, quiescence nudge,
  periodic check) go out through `bus.deliverRuntimeWake`, never `wakeTarget`
  directly — the bus owns the busy gate.
- `team-prompt.ts` — `buildTeamEntry(ctx)` / `buildTeamConstraints(ctx)`, the
  Team Entry/Constraint layers (parallel to `im-prompt`). Rendered from a
  `TeamPromptContext` built by orchestration; a team turn runs as a trusted
  member (never an IM guest).

  **The Entry is frozen at session creation, so it must be byte-stable for a
  (team, member) pair.** It is part of the agent session's reuse fingerprint
  (`computeSessionInputsFingerprint`), and a prompt that changes per turn rebuilds
  the CC subprocess on every turn — aborting whichever turn is still streaming.
  That is why `TeamPromptContext` carries no per-turn field: who started the turn
  and whether the sender is blocking on the reply are rendered into the message
  body by `renderEnvelope`, not into the prompt.
- Lead provisioning (`buildLeadSystemPrompt` + `provisionLeadSpec`) lives in the
  team data/lifecycle layer at `apps/team/lead.ts`, not here — the lead app spec
  is provisioning data the team service installs, so keeping it out of runtime
  avoids a persistence→runtime dependency. Live turn mechanics stay in
  `team-prompt.ts`.

### Report routing (§5.3)

`report-tool.ts` reads `ReportToolContext.teamContext` (a `TeamTriggerContext`).
On a team turn: a result is captured to the runtime (`captureReport(corr,
{kind:'report_result', content, taskId?})`) with NO user-facing entry; an
escalation writes a user entry tagged with `content.teamContext` (a `TeamContext`
persisted inside the `content_json` blob — no migration) AND captures
`{kind:'report_escalation'}`. Completion detection does NOT depend on this call —
the orchestration detects turn end regardless (§5.6); a captured report only
enriches the outcome.

## Triggers & entries — a team is triggerable like a digital human

A team is a first-class triggerable entity: every way a single digital human can
be invoked, a team can too. Two execution modes mirror the digital-human dual
path (§3.5):

- **Triggered run** (stateless ingress): `schedule` / `http` / `webhook` /
  `file`. Each trigger opens a fresh `'run'` epoch (`startEpoch`), wakes the lead
  once, and auto-seals on quiescence. Wiring lives in `team-triggers.ts`
  (`createTeamTriggerScheduler`): `schedule` triggers become `kind='team'`
  scheduler jobs; `webhook`/`file`/`wecom` triggers become EventRouter
  subscriptions via the shared `sourceConfigToEventFilter` mapping
  (`apps/runtime/event-filter-mapping.ts`, also used by the app runtime). Both
  paths converge on the injected `runTeam`, guarded by the team's
  `currentEpochId` so triggers never overlap a live run.
- **Conversation** (message-driven ingress): user UI / IM. Each inbound message
  resumes the lead's session inside a long-lived `'conversation'` epoch scoped
  **per chat** (`orchestration.ensureConversationEpoch(teamId, chatKey)` —
  get-or-create by `(teamId, chatKey)`). One epoch per chat means 1:1 chats are
  per-person and group chats are per-group, matching how a single digital human
  keys IM sessions by `chatId`. Conversation epochs do NOT occupy
  `team.currentEpochId` (that pointer is for the single run epoch), so many chats
  — and a concurrent scheduled run — coexist without collision. They are never
  auto-sealed on quiescence (going quiet after a reply is the normal "awaiting
  next message" state); a single chat is sealed by `sealConversationEpoch` on
  `/clear`, and all end on dissolve. The mode is persisted on
  `team_epochs.lifecycle` (`'run' | 'conversation'`, v3) and the chat scope on
  `team_epochs.chat_key` (v4); `getCurrentEpochForTeam` is filtered to run epochs
  so open conversation epochs never shadow it.

### Team as an IM backend

An IM channel instance (`ImChannelInstanceConfig`) may set `teamId` (with
`appId` = the team's lead) to be backed by a team instead of a single human.
`dispatch-inbound.ts` resolves the lead fresh from the team, ensures the
conversation epoch for this chat (`chatKey = ${instanceId}:${chatId}`), and calls
`sendAppChatMessage` with BOTH `imSession` (reply path, file send) AND
`teamContext` (team tools + Entry). `app-chat` composes the
team Entry with `buildTeamImBridge` (front-desk framing: the message is from a
real person; the lead's final message goes back to the chat; delegate via team
tools, prefer `wait=true`). The lead runs as a trusted team peer — IM guest
hardening is intentionally not applied (no permission context for the team
session key). Provider-agnostic: any IM brand works, since the binding lives in
the generic config + dispatch path.

## Conversations & run outcomes (office-shared session model)

Epochs — runs AND conversations — are **office-shared objects** with the office
authority as the single writer, so every node sees the same session list and the
same history (mirrors the blackboard replication plane; no new protocol).

- `orchestration.ensureConversationEpoch(teamId, chatKey, title?)` get-or-creates
  a per-chat `'conversation'` epoch; `renameConversationEpoch` relabels it. Both
  fire `onEpochMutation(epoch)` — the replication capture wired by bootstrap to
  `federationManager.routeEpochWrite`, which captures into the authority's log
  (hosted) or routes a `blackboard-write { op:'epoch_upsert' }` to the host
  (joined). Replicas apply via `store.upsertEpoch` (idempotent whole-row, later
  write wins). `sealEpoch`/`noteEpochTurn`/`startEpoch` publish the same way, so
  conversation state and run history converge office-wide (P0-1, spec AC-S1).
- **`noteEpochTurn(teamId, epochId)`** is the single "a turn is entering this
  epoch" entry (app-chat calls it for every team turn, `sendToMember` for a human
  1:1): it stamps `last_activity_at` and, reversible-seal, wakes a hibernated
  epoch. Recency is stamped rather than derived because a conversation lives for
  weeks — ordering a work list by creation buries the thread used five minutes
  ago. The stamp is monotonic (`MAX`), so a replicated row that predates a local
  turn cannot pull it backwards.
- **Chat-key namespaces** (`shared/apps/im-keys`): `native:{uuid}` (a user "New
  session" from the Conversations tab), `direct:{appId}` (a 1:1 member thread),
  and `{instanceId}:{chatType}:{chatId}` (an IM chat). `apps/team/epoch-label.ts`
  is the SSOT that classifies a chatKey and resolves its human label (main-side;
  the renderer performs zero translation).
- **Naming — every "thing" is readable, auto-generated** (parity with the space
  chat, which titles a conversation from its first message):
  - a native conversation is auto-named from the person's first message via
    `orchestration.maybeAutoNameConversation` (→ `deriveConversationTitle`, ≤48
    chars, whitespace-collapsed), captured + replicated like a rename — so no node
    is left showing "New session". A teammate-driven turn never names it: the
    caller passes `fromHuman` (no trigger kind, or `kind: 'human_message'`), and
    the epoch must still be an untitled NATIVE conversation.
  - a member / IM conversation labels by the member / chat name (no title needed).
  - a RUN is an event instance, not a named object: history identifies it by
    time · trigger · outcome + the AI seal `summary`; the live Floor switcher —
    where at most ONE run exists — labels it with the **team name** (its standing
    purpose), never a fake "today's run".
- **Run outcome** (`EpochOutcome`, spec P0-4) is classified at seal by
  `classifyRunOutcome`: `failed` (error/timeout) > `escalation` (a decision still
  waiting) > `output` (a produced ref) > `no_action`. Stamped on the epoch row and
  replicated, it drives the History tab's badges + grouping.
- **Member busy projection** (`getMemberBusy`, spec P0-2): every OPEN epoch a
  member is actively serving, each with a human label — stamped into the roster
  (`RosterMember.busy`) and the federation snapshot so a board can truthfully say
  "busy with another conversation". `getMemberStatus` lights a member `working`
  for a run OR a conversation, and keeps it `waiting_user` after a run seal while
  a persisted escalation is unanswered (P0-5; `hasPendingEscalation` is the
  activity-store truth, the in-memory waiter set is only the live-window mirror).

The service (`apps/team`) exposes `listConversations` / `openConversation` /
`renameConversation` / `archiveConversation` and folds `pendingEscalations` into
`TeamDetail` (the cross-tab attention banner, C2). IPC/HTTP mirror these.

## Team identity: duty and delegated capabilities

Two facts about a member are per-TEAM and owner-authored, and they live on the
`team_members` row (see `apps/team/DESIGN.md`):

- **duty** — what it is responsible for here. Layered on top of the digital
  human's own persona, never replacing it, and applied only inside team turns:
  `buildPromptContext` puts the member's own duty in the Entry and every
  teammate's duty in the roster, in full (deciding who to hand work to is exactly
  what the text is for).
- **delegated policy** — what a TEAMMATE may make it do. Enforced in `app-chat`
  on the OWNER's machine, and only for turns started by another member: a person
  talking to a digital human in its own chat (`kind: 'human_message'`), and a
  person reaching the team over IM, are not teammates borrowing it. An unset
  policy withholds nothing. The team's own
  coordination servers (`halo-team`, `halo-report`) are never withheld — they are
  the channel the turn arrived on, not a capability being lent.

The shared vocabulary (which tools exist, what an unstated permission means) is
`shared/apps/capability-policy.ts`, and the enforcement is
`apps/runtime/capability-policy.ts` — the same pair the IM guest path uses, so
the two scenarios cannot drift.

## Concurrency safety — by construction

No locks anywhere. Task writes are scoped by id, findings and activity are
append-only (activity inserts are `OR IGNORE`, so a replica echo of a row this
node authored is a no-op rather than a clash), the roster is derived. Bus mailboxes are per-session arrays consumed serially (one
actor = one single-threaded turn). Pending wait-promises are keyed by
`correlationId`. Overlapping writes from different actors target disjoint keys,
so there is no clobber.
