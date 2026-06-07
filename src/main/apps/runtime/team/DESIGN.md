# runtime/team — Coordination Kernel

The in-process coordination kernel for the Digital Team feature. This module is
a peer of `runtime/im-channels`: pure runtime orchestration primitives. It owns
the **Message Bus** (Actor-model directed messaging), the **Blackboard** (shared
coordination facade over the team store), and the **team MCP tools** the digital
humans call.

The kernel primitives (`message-bus`, `blackboard`, `team-tools`) do NOT import
the session layer (`app-chat`, `report-tool`). The session-integration files in
this same directory (`orchestration`, `index`, `team-prompt`, `lead`) provide the
`TeamDeliveryHooks` implementation, the epoch lifecycle, the prompt layers, and
the lead template, and wire the kernel to `app-chat` through injected deps — the
direction stays downward and the cycle is broken by the runtime accessor in
`index.ts` (mirrors `im-channels` `setActiveImChannelManager`, ARCHITECTURE §22.5).

## Layer position

```
runtime/team  (this module)
  ├── may import: apps/team (TeamStore), services/agent/resolved-sdk (tool/createSdkMcpServer),
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
- `team-tools.ts` — `createTeamMcpServer(context)` building the `halo-team` MCP
  server with the 5 team tools. Topology/unknown-member violations surface as
  error tool_results so the LLM sees them.

## The two channels (do not conflate)

- **Mailbox (directed)**: `team_send` drops an envelope into a target's mailbox
  and wakes its team-channel turn. The message becomes that turn's input. 1:1.
- **Blackboard (shared)**: tasks/findings/roster the whole team reads via
  `team_read_board` and writes via scoped tools. No directed delivery.

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
mid-turn, the envelope is enqueued in its mailbox and drained when the current
turn completes (mirrors `dispatch-inbound` supplement-buffering).

## Bus public API

`createMessageBus({ store, hooks, circuitOverrides? }) → MessageBus`

- `send(input) → Promise<TeamSendAsyncResult | TeamSendSyncResult>`
  Resolves member name→appId, enforces topology, bumps circuit counters, builds
  the `TeamEnvelope`, emits `team:message`, then:
  - `wait=false`: enqueue + wake target, resolve immediately with `{ messageId }`.
  - `wait=true`: enqueue + wake target, return a promise held until the target's
    turn completes (resolved by `completeTurn`) or the wait timeout fires.
  Throws `TopologyError` / `UnknownMemberError` / `CircuitBreakerError` (the tool
  layer converts these to error tool_results).
- `completeTurn({ sessionKey, trigger, outcome })`
  Called by the session layer when a woken team turn ends. Routes per §5.2/5.3:
  - `trigger.wait=true` → resolve the pending send promise (`ok` / `timeout`).
  - `trigger.wait=false` → build a completion envelope and wake the ORIGINAL
    sender (a fresh turn) so it can reconcile against the board.
  Then drains any buffered mailbox envelopes for that `sessionKey`.
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
- `maxDurationMs` — wall-clock since the epoch's first send.

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
- `readBoard(teamId, epochId, callerAppId, filter?) → BlackboardSnapshot`

Each task/finding write emits `team:blackboard`. `getMemberStatus(appId)` is
injected (defaults to `'idle'`) because live member status lives in runtime, not
the store — keeping the blackboard decoupled from session state.

## Team MCP context

`createTeamMcpServer(context) → halo-team` with tools `team_send`,
`team_post_task`, `team_update_task`, `team_post_finding`, `team_read_board`
(`report` is the existing report_to_user, owned by the session layer — NOT here).

```ts
interface TeamMcpContext {
  teamId: string
  epochId: string
  callerAppId: string
  collabMode: CollabMode
  bus: MessageBus
  blackboard: Blackboard
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
  mid-turn), and `buildPromptContext` (roster + topology + message source).
  Honors `escalationRouting`: a member escalation under `'lead'` is re-sent to
  the lead's mailbox and the report-tool suppresses its user-facing emission
  (no double-send); under `'user'` the report-tool's tagged entry stands and is
  surfaced to the user.
- `team-prompt.ts` — `buildTeamEntry(ctx)` / `buildTeamConstraints(ctx)`, the
  Team Entry/Constraint layers (parallel to `im-prompt`). Rendered from a
  `TeamPromptContext` built by orchestration; a team turn runs as a trusted
  member (never an IM guest).
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

## Concurrency safety — by construction

No locks anywhere. Task writes are scoped by id, findings are append-only, the
roster is derived. Bus mailboxes are per-session arrays consumed serially (one
actor = one single-threaded turn). Pending wait-promises are keyed by
`correlationId`. Overlapping writes from different actors target disjoint keys,
so there is no clobber.
