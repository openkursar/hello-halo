# apps/runtime -- Design Decisions

> Module owner: apps/runtime
> Date: 2026-02-21
> Status: Implementation

---

## 1. Module Role

Core glue layer that connects all platform modules and the existing Agent service
to provide App execution capabilities. This is the **only module** that crosses
layer boundaries (apps/ → platform/ → services/).

Responsibilities:
- Translate App subscriptions into scheduler jobs + event-bus subscriptions
- Execute App runs: create Agent session → inject prompt/tools → process results
- Manage the Activity Layer (automation_runs + activity_entries)
- Provide `report_to_user` MCP tool for AI-to-user communication
- Handle escalation lifecycle (waiting_user → user responds → new run with context)
- Enforce concurrency limits (global maxConcurrentRuns)

Does NOT:
- Install/configure Apps (that's apps/manager)
- Implement scheduling algorithms (that's platform/scheduler)
- Filter events (that's platform/event-bus)
- Directly operate AI Browser DOM (AI does that via MCP tools + Task tool)

---

## 2. Key Design Decisions

### 2.1 Own SDK Sessions (No sendMessage Modification)

**Decision**: Runtime creates its own V2 sessions using `unstable_v2_createSession`
directly, rather than modifying the existing `sendMessage()` in `services/agent/`.

**Rationale**:
- `sendMessage()` is 946 lines of complex code tightly coupled to conversation UI
  (mainWindow IPC, thought accumulation, streaming display, conversation persistence).
- Runtime's execution needs are fundamentally different: no UI streaming, no
  conversation persistence, different MCP tool set, different error handling.
- Modifying sendMessage risks breaking the core conversation flow.
- Runtime imports helper functions (`getApiCredentials`, `resolveCredentialsForSdk`,
  `buildBaseSdkOptions`, `getHeadlessElectronPath`) from the agent service but
  manages its own session lifecycle independently.

**Trade-off**: Some code duplication in stream processing. Acceptable because the
runtime's stream processing is much simpler (no thought accumulation, no UI events).

### 2.2 Stateless Runs (No Cross-Run Session Persistence)

**Decision**: Each run creates a fresh V2 session. Sessions are closed after
the run completes. No session reuse across runs.

**Rationale**:
- Conversation sessions benefit from reuse (user expects continuity within a chat).
- Automation runs are independent executions. Each should start clean.
- Keeping sessions alive for 24h (escalation wait) wastes resources and is fragile.
- The memory system provides continuity: AI reads memory at start, writes at end.
- Escalation responses durably queue a continuation of the original run and SDK
  session. Missing original context is a recoverable failure, never a silent fresh run.

### 2.3 Escalation as Run Boundary

**Decision**: When AI calls `report_to_user(type="escalation")`, the current run
records the escalation and releases execution resources. A user response resumes
the original work after its answer and continuation have been committed together.

**Rationale**:
- Holding a Claude Code subprocess alive for hours is resource-wasteful and fragile.
- The AI can write important context to memory before escalating.
- The resumed session receives the questions beside their corresponding answers.
- A persistent continuation survives a process exit without retaining a live subprocess.
- An unavailable original session is shown as a continuation failure with the answer retained.

**The ending is enforced by the runtime, not requested of the model.** The tool result used
to ask the model to stop; it frequently kept working, acting on the very decision it had
just said it could not make alone. `escalation-cut.ts` now ends the turn for it, and both
consumers apply the same rule — `execute.ts` reading the SDK stream, `app-chat-sink.ts`
observing it for chat and team turns. The cut waits for every tool call the turn issued to
have its result: a call left without one is a transcript some engines refuse to resume,
which would strand the conversation the answer is meant to return to. What the model
produced after asking is discarded.

The two cases differ only in what follows, and the tool result says so: a solo run is
genuinely suspended on the answer, while a team member keeps being woken by teammates and
periodic checks, so it is told the answer will arrive as its own wake quoting the question.

**One escalation may ask for several decisions.** `content.questions` carries them, and
`summary` then frames why they are being asked; a single-decision escalation leaves
`questions` empty and carries its question in `summary` as before. Because the run ends at
the escalation, splitting decisions across calls would interrupt the user once per
question and cost a round trip each — the array is what makes "ask for everything you need
first" possible. Read the shape through `getEscalationQuestions` and render answers
through `formatEscalationAnswer` (both in `shared/apps/app-types`, shared with the
renderer); no caller should branch on which shape was written, and the legacy
`content.question` field only exists for entries written before it moved into `summary`.

**An app may hold several unanswered questions.** Because the escalating run ends, the app
is idle from the executor's point of view, and a further trigger can produce a second
question before the first is answered. Each is an independent `activity_entries` row keyed
by its own run, and each is answerable in any order; answering one resumes only its own run.
Two consequences follow:
- **Automatic triggers stand down while any question is open** (`admitAutomaticRun`). The app
  asking is the app declaring it cannot proceed alone, so starting the next scheduled or
  event-driven run would route around the person it just asked. Manual triggers are
  unaffected — that is the user acting, not the app acting around the user.
- **Pending questions are resolved by query, never from the app record.** `waiting_user` and
  `pendingEscalationId` are caches of the same fact and can be stale or absent; the store is
  the authority (`hasPendingSoloEscalation`). Open questions are
  closed only by their own deadline or explicit task closure, never by a person-level status change.

### 2.4 report_to_user as SDK MCP Server

**Decision**: `report_to_user` is implemented as an SDK MCP server using
`tool()` + `createSdkMcpServer()`, same pattern as `platform/memory/tools.ts`
and `services/ai-browser/sdk-mcp-server.ts`.

**Rationale**:
- Consistent with existing Halo patterns for injecting custom tools.
- SDK MCP servers are first-class citizens in V2 sessions.
- The tool handler has direct access to the Activity store (closure capture).

### 2.5 Activity Layer in SQLite

**Decision**: `automation_runs` and `activity_entries` tables in the app-level
SQLite database, with FOREIGN KEY to `installed_apps` with CASCADE DELETE.

**Rationale**:
- Structured data enables querying (by app, by type, by time range).
- FK CASCADE ensures cleanup when an App is uninstalled.
- Matches the architecture doc's schema design exactly.

### 2.6 Concurrency: Simple Counting Semaphore

**Decision**: Module-level counting semaphore with configurable `maxConcurrent`.
Default: 10 concurrent runs. Each digital human has one serial standalone execution
lane; accepted answer continuations take the next free opportunity before new triggers.

**Rationale**:
- Each run spawns a Claude Code subprocess (significant resource usage).
- Simple acquire/release pattern. Callers that can't acquire are queued.
- No priority system in V1 (FIFO queue).
- The AI Browser lane (maxConcurrentAIBrowserRuns) is deferred to V2.

### 2.7 Activation Lifecycle

**Decision**: `activate(appId)` is idempotent. It reads the App's subscriptions,
creates scheduler jobs (for schedule-type) and event-bus subscriptions (for other
types), and registers a keep-alive reason.

`deactivate(appId)` removes scheduler jobs and event-bus subscriptions and unregisters
the keep-alive reason. It does not stop running work. Pause also removes queued
automatic work immediately; shutdown and explicit task closure abort their own work.

**State tracking**: An internal `Map<appId, ActivationState>` tracks the
scheduler job IDs, event-bus unsubscribe functions, and keep-alive disposer for
each activated App.

**Startup settles runs a previous process abandoned.** A run leaves `'running'`
only from inside the process executing it, so a crash or a forced quit strands
the row claiming to be live — invisible to pruning, and read by the UI as
neither live nor finished, which leaves the user with no way back into it.
`activateAll` therefore fails every `'running'` row not backed by a live
execution and writes it a `run_error` entry, which both restores it to the
timeline and makes it resumable through `continueFailedRun`. The live-execution
filter is what keeps the sweep safe if it is ever reached outside startup.

### 2.8 Trigger Context in Initial Message

**Decision**: The initial message sent to the Agent includes structured trigger
context (what triggered this run, when, user config values).

**Rationale**:
- The AI needs to know WHY it was triggered to decide what to do.
- For schedule triggers: "Scheduled run at 2026-02-21 14:30 (every 30m)"
- For event triggers: "Triggered by file change: /path/to/file"
- For escalation follow-ups: includes the original question + user's response
- User config values are included so the AI can use them (e.g., product URLs).

### 2.9 No IPC/HTTP Routes in This Module

**Decision**: Runtime module exposes only a TypeScript service interface.
IPC handlers and HTTP routes are a separate concern (Phase 3 task ⑫).

**Rationale**:
- Keeps the module focused on business logic.
- IPC/HTTP layer is thin routing that delegates to the service.
- Can be added independently without modifying runtime internals.

### 2.10 Stream Processing: Headless Run + JSONL Transcript (Observed by Read)

> A run is a **headless execution that produces a transcript**, not an
> interactive session. "Watching" a run is therefore a *read* over that
> transcript, not a live event subscription. This is the deliberate boundary:
> rendering and data model are unified with chat (same `MessageList` shell, same
> `Message[]`), but the live-update transport follows each surface's nature —
> chat pushes events (a user is present), a run is observed by reading its JSONL.
>
> History: an interim phase routed runs through the shared stream processor so
> they emitted `agent:*` events like chat. That coupled a headless batch process
> to the interactive real-time pipeline and made every unwatched run (up to
> `maxConcurrent` at once) push events to a renderer nobody was looking at — then
> needed viewer-gating to undo that cost. Reverted in favour of the model below.

**Decision**: `execute.ts` consumes each turn with its own **headless loop**
(`processStream`). The loop:
- appends each aggregate `assistant` / `user` message to the run JSONL
  (`session-store`) — the run-detail view reads it back via `app:get-session`;
- detects `report_to_user` (the completion signal) from `tool_use` blocks;
- collects final text, token usage, and the CC `session_id` (for resume);
- emits **no** `agent:*` renderer events.

`includePartialMessages` is **false**: with no live event consumer there is no
reason to stream token frames; only aggregate block-level messages arrive, one
JSONL append per completed block.

**Run-detail view** (`SessionDetailView`): renders through the shared
`MessageList` shell, fed by the run JSONL. While the run is live (authoritative
from the app runtime status — `running` + `runningRunId === runId`, broadcast via
`app:status_changed`) it **polls** `app:get-session` every 2s so new blocks/steps
appear incrementally; on live→idle it does one final reload. The poll exists only
while the view is open AND the run is live, so unwatched and finished runs incur
zero cost.

**Mid-run injection**: while a run is live it registers an `ActiveRunHandle` in
`active-runs.ts` (keyed by `runId`, holding the session + JSONL writer). The
run-detail input box sends a supplement through `app:inject-run` →
`service.injectIntoRun` → `injectIntoActiveRun`, which persists it to the run
JSONL and pushes it into the live SDK session (absorbed at the next tool
boundary, same mechanism as `agent/inject-message.ts`). The handle is
unregistered in `executeRun`'s `finally`, so only genuinely live runs are
injectable. Injection is independent of the (absent) event path: the injected
turn shows up on the next JSONL poll.

**Rationale**:
- Respects the headless-vs-interactive boundary; no batch process is forced
  through the real-time event pipeline, so there is nothing to viewer-gate.
- Unifies what is genuinely shared (the `MessageList` shell, `Message[]`, the
  JSONL storage adapter) without unifying the live transport, which differs by
  nature. This is the same "shell shared, source pluggable" boundary the chat
  surfaces use (space = conversation.service, digital-human = JSONL).
- Decouples runs from the chat agent pipeline → changes to chat streaming cannot
  regress the automation mainline, and vice-versa (smaller blast radius).
- Cost: an unwatched run touches the renderer **not at all**; a watched run costs
  one 2s file read. Per-run renderer/IPC/WS event cost is zero.
- Trade-off accepted: the watcher sees block/step-level updates at ~2s latency,
  not token-level typewriter. Sufficient for observing a run's progress. If
  sub-second smoothness for the rare watcher is ever wanted, push JSONL diffs via
  a file-watch while the view is open — still no events for unwatched runs.

### 2.11 Auto-Continue on Missing report_to_user

**Decision**: `report_to_user` is the definitive completion signal for
automation runs. If the LLM ends a turn without calling it (and no SDK error
occurred), the runtime automatically sends a follow-up message prompting the
AI to continue — up to `MAX_AUTO_CONTINUES` (10) times. If all auto-retries
are exhausted the run is marked as `error`, and the user may manually resume
via the "Continue" button (in the Activity Thread or Session Detail view).

**Auto-continue loop**:
- Each retry sends a single unified message: `"Continue. " + AUTO_CONTINUE_MESSAGE`
  (no graduated messaging — one clear, consistent reminder).
- `MAX_AUTO_CONTINUES = 10` (was 3). Raised to tolerate longer periods of
  context pressure or transient backend issues without user intervention.
- After all retries: the run's `sessionId` is persisted on the DB record so the
  session can be restored on user-initiated continue.

**User-initiated continue** (`trigger_type = 'continue_followup'`):
- Triggered by the "Continue" button on `run_error` activity entries where
  `content.error === 'report_to_user not called'`.
- Uses the same session restore pattern as `escalation_followup`:
  `getOrCreateV2Session(resumeSessionId)` preserves full conversation history.
- Same `runId` is reopened (`store.reopenRun()` resets status `error → running`)
  so the Activity Thread entry updates in-place (no duplicate entry).
- Sends only `"Continue."` as the initial message (no reminder — the user's
  intent is clear and context is already in the session).
- Resets the auto-continue counter to 0; the 10-retry loop runs again.
  This cycle repeats indefinitely until `report_to_user` is finally called.

**Rationale**:
- LLMs occasionally return `end_turn` prematurely due to model quirks, context
  issues, or non-deterministic behavior. In interactive sessions a human types
  "continue"; automation runs have no human operator.
- `report_to_user` is already mandated by the system prompt and powers the
  Activity Thread. Using it as the completion gate adds zero new concepts.
- `MAX_TURNS` raised from 30 → 100 to give autonomous runs more room before
  per-cycle turn limits are hit.

**Trade-off**: Up to 10 extra LLM round-trips per cycle in pathological cases,
plus indefinite user-driven cycles. Acceptable: the alternative is a silently
incomplete run with no recovery path.

### 2.12 App Chat Prompt Layering (Three-Layer Assembler)

**Decision**: The App chat system prompt is assembled from three ordered
layers — **Identity**, **Entry**, **Constraint** — by a channel-agnostic
assembler. Channel-specific content (IM session metadata, sender identity
rules, security rules) lives in the channel's module, not in the assembler.

```
src/main/apps/runtime/
├── prompt/
│   ├── assembler.ts        — assembleAppChatPrompt(fragments) — joins layers
│   ├── identity.ts         — buildIdentityFragments() — base + spec + memory + config + capability awareness
│   ├── capabilities.ts     — disabled + awaiting-setup capability guidance (Identity layer)
│   └── entry-native.ts     — NATIVE_CHAT_ENTRY — native UI entry (reply orientation only)
└── im-channels/
    └── im-prompt.ts        — buildImEntry / buildImConstraints / ImSessionContext
```

**Layer responsibilities**:

| Layer | Answers | Examples |
|---|---|---|
| Identity | Who am I, what do I do | Base Agent prompt, App spec, memory access, user config, capability awareness (disabled + awaiting-setup) |
| Entry | Where am I, how do I reply | IM group/direct session context, native UI reply orientation |
| Constraint | What I must not do | IM anti-impersonation rules when owners are configured |

**Rationale**:
- The previous flat builder kept growing channel-specific text every time a
  new entry point was added (IM bot, then native UI, then group vs direct
  variants). The file became a god-file that knew every channel.
- The assembler now only accepts pre-rendered string fragments and joins
  them with `\n\n---\n\n`. It never branches on channel.
- Adding a new entry channel (Feishu, Slack, voice, ...) requires one new
  builder file plus a one-line branch at the assembler call site in
  `app-chat.ts`. The assembler itself stays untouched.
- IM-specific knowledge lives in `im-channels/im-prompt.ts`, sibling to other
  IM concerns (provider impls, session registry, file-send MCP). Matches the
  hard rule "IM specifics live in im-channels".

**Single call site**: `app-chat.ts` is the only place that decides which
entry/constraint builder to invoke based on whether `imSession` is present.
The assembler call itself is one line:

```ts
const systemPrompt = assembleAppChatPrompt({ identity, entry, constraints })
```

**Trade-off**: One extra layer of indirection between `app-chat.ts` and the
final string. Acceptable: it caps the assembler's blast radius and prevents
the file from re-acquiring channel knowledge over time.

### 2.12a App Chat Runs on the Shared Consumer (Turn Sink)

**Problem**: app chat used to read the SDK stream once per user message
(`processStream` per `sendAppChatMessage`). Between messages nobody was in
`stream()`, so a turn CC produced on its own — a `run_in_background` task
finishing, a team agent reporting — stayed queued in the pipe. The next message
consumed that queued turn as its own answer, and from then on every reply lagged
one turn behind. Space chat was immune because its persistent consumer
(`services/agent/session-consumer.ts`) never leaves the stream.

**Decision**: app chat uses that same consumer. The surface-specific half is a
`TurnSink` (`services/agent/turn-sink.ts`) implemented by `app-chat-sink.ts`;
`sendAppChatMessage` no longer consumes anything, it only assembles the session
inputs and dispatches.

```
sendAppChatMessage
  ├── prompt / MCP / permission envelope   (unchanged)
  ├── getOrCreateV2Session(..., { displayModel, sink })   → consumer starts here
  ├── sink.writeUserMessage(text)          → run JSONL
  ├── sink.beginRound({ onProgress, onReply, onMessageAccepted })
  ├── markTurnDispatched + v2Session.send()
  └── await round.done
```

**Turn ownership**: the SDK stream carries no correlation between a `send()` and
the turn it causes, so ownership is decided by order. `beginRound` enqueues
immediately before `send()`; a turn claims the queue head at its `system:init`.
Consequences that matter:

- A turn that starts with an empty queue is **autonomous**. It is persisted like
  any other turn and, for IM sessions, pushed to the originating chat (the user
  asked for that work — its completion belongs in the conversation). Native and
  HTTP sessions need no push: the `agent:*` events already reached the client and
  `AppChatView` reloads the transcript on completion.
- A round enqueued while a turn is already running cannot be claimed by it, so
  the residual race is only the instant between enqueue and `system:init`. The
  IM busy check closes even that: `isAppChatConversationGenerating` counts an
  autonomous turn as busy, so an inbound message arriving then is buffered as a
  supplement instead of starting a round.
- A round that can never be answered is settled, not left hanging:
  `onConsumerStopped` rejects outstanding rounds when the session dies, and an
  empty interrupted/errored turn rejects rather than leaving an IM stream open.
- Those cover a session that *reports* its death. A session that simply never
  produces a turn — a resume against a transcript a crashed process left broken,
  an engine that failed to launch — reports nothing, and the caller would await a
  reply that can no longer arrive. `TURN_START_TIMEOUT_MS` bounds that wait, and
  what it measures is the one thing that distinguishes the two cases: **whether
  the engine is producing anything at all**. The clock runs only while no turn is
  running and something is queued; it is cleared for the whole duration of any
  turn, including one the digital human started itself, which claims no round but
  is proof of liveness all the same. Keying it on "a round is claimed" instead
  was a real defect — a message sent during background work was failed while the
  engine was plainly alive.
- On expiry the sink stops waiting; it does **not** declare the message
  undelivered. Acceptance is not observable from here, and a wrongly-confident
  "not delivered, send it again" invites duplicated work — the worse failure of
  the two. Supplements injected into a running turn never create a round, so
  this deadline does not apply to them at all.
- **Giving up the wait must not give up the queue slot.** The round is settled
  but stays in the queue, because the turn it was dispatched for may still
  arrive and ownership here is decided purely by order — removing it shifts
  every later pairing by one, which is precisely the one-turn-behind defect this
  module was built to eliminate. The abandoned slot is a marker nobody awaits:
  when its turn lands it claims that slot and is delivered as an unsolicited
  reply (so a late answer still reaches the user), and `hasActiveRound` excludes
  settled slots so the conversation does not read as permanently busy. Contrast
  `cancel()`, which *does* remove the round — it means the send itself threw, so
  nothing reached the engine and no turn is owed.

**Generating state moved off `activeSessions`**. App chat no longer registers
there; `isAppChatConversationGenerating` is the single predicate (queued round OR
consumer mid-turn) and every caller — stop, clear, restart, supplement buffering
— goes through it.

**Reading `activeSessions` for an app chat is always wrong, and it fails
silently.** `registerActiveSession` has no callers at all, so the map is empty
and every `activeSessions.has(...)` answers a confident, permanent `false` —
worse than an obvious break, because each caller reads a plausible answer and
none can tell it is a constant. Two probes were left on it and both are now
moved (`bootstrap/extended.ts`): the authority reconciler's owner-busy check,
where a streaming member read idle and had its in-progress task reassigned out
from under it on authority handover, and the session-feed's, where a turn's
provisional trailing message was published to other nodes as final. Anything
that reaches for that map again is to be read the same way until proven
otherwise.

**Which replacement depends on the question**, and the two are not
interchangeable. `bus.isSessionOccupied` answers "can this session take work" —
a streaming turn OR a slot reserved for one that has not started — and belongs
to scheduling decisions. `isAppChatConversationGenerating` answers "is text
being produced right now" and belongs to anything withholding provisional
output; a slot reserved for a turn that has not begun has nothing provisional
to withhold.

Session invalidation for app chat now takes the consumer path
(`pendingConsumerRebuilds`) instead of the legacy `pendingInvalidations` path,
which is also what makes stop/team-agent handling in `control.ts` apply to
digital humans for free.

Automation runs (`execute.ts`) are untouched: a headless run has no turn gaps to
lose, and its own `processStream` must remain the only reader of that stream.

### 2.13 Native Multi-Sessions (Local Channel + Session Fork)

**Decision**: A digital human's native client chat supports multiple named
sessions, modeled as a new `'local'` session **source** in the existing
`ImSessionRegistry` rather than a parallel store. The legacy single native
session (`app-chat:{appId}`, runId `chat`) is untouched and remains the
default; extra sessions are keyed `app-chat:{appId}:local:direct:{uuid}`.

**Why reuse the IM session plumbing**:
- The app-chat send path (`sendAppChatMessage`) already accepts an arbitrary
  `conversationId`; IM sessions proved the multi-conversation model in
  production. A `'local'` session is just another conversationId that flows
  through the same `parseAppChatKey` → `deriveRunId` → JSONL / V2-session path.
- `classifySessionSource` gains a `'local'` branch so local sessions are
  **exempt from HTTP eviction bounds** (a user's chat must never be auto-pruned)
  and are **excluded from pushable/proactive** results (no channel adapter).
- Listing and renaming reuse the generic `im-sessions` RPC
  (`getAllSessions` / `setCustomName`); only create / fork / delete need
  dedicated lifecycle (`createNativeChatSession` / `forkNativeChatSession` /
  `deleteNativeChatSession` in `app-chat.ts`).

**Session fork ("continue in client")**: forking an IM/other session into a
local one copies the source JSONL transcript (immediate history) and records
the source SDK sessionId as `pendingResumeSessionId` on the new record. On the
new session's **first** message, `sendAppChatMessage` resumes that source
context with `sdkOptions.forkSession = true`, so the SDK branches to a **new**
sessionId — the two windows evolve independently and the source is never
polluted. The pending marker is peeked (not consumed) at send start and cleared
only after the new forked sessionId is captured, so a failed first attempt can
retry. Fork requires the engine's `sessionFork` capability (CC / Halo SDK:
true; Codex `thread/resume` cannot branch: false); the UI gates the affordance
on it.

**Layer split in the renderer**: local sessions render in the interactive
`AppChatView` (keyed by conversationId for a clean remount on switch); IM/HTTP
sessions stay read-only in `ImChatView`. `AppChatContainer` branches on
`session.source === 'local'`.

### 2.14 Cross-Session Relay (Pending Relay Spool)

**Problem**: `notify_bot` pushes are pure SDK transport. The target session's
AI context records nothing — when the recipient later replies ("approved"),
the AI has no idea what it is a reply to, and cannot re-address the origin
contact. Cross-session workflows (employee requests → admin approves →
report back to employee) were structurally impossible.

**Decision**: A persistent spool (`pending-relays.ts`) records each successful
push against its **target** sessionKey. On the target's next inbound message,
`dispatch-inbound` **appends** a `<relay-context>` block to the message text —
the only engine-agnostic route into an engine's history (a string on a real
inbound message; rides into whatever history the engine keeps).

**Key properties**:
- **Deferred, not history writes**: engines own their history (anthropic /
  halo / codex via resolved-sdk); no engine interface changes. Between push
  and next inbound there is no live run, so nothing can consume the context
  earlier anyway.
- **Appended, never prefixed**: position 0 belongs to `<msg-sender>` — the IM
  identity rules define authority by position — and a prefix would also break
  slash commands and skills, which must start the message.
- **Sender side needs nothing**: the notify_bot call + result already live in
  the calling session's history.
- **Peek/commit, not drain**: events are removed only when the engine accepts
  the message (`onMessageAccepted`, fired on the first SDK message). Render
  errors, session-creation failures, model errors and crashes all leave the
  events queued, so relay context cannot be lost by a failed run. The reverse
  failure (accepted but not committed) re-delivers, which the model tolerates.
- **Event shape**: a `push` variant `{ id, at, source{key,appId,runId,label},
  subject?, originContact?, sourceOwner, message?, file?, quote? }` and a
  `collapsed` variant `{ id, at, count }` for bound overflow — deliberately
  attribution-free, since a collapsed range has no single origin.
  `source.key` reuses the conversationId system (no new ID namespace).
  `originContact` is the exact `instanceId:chatId` the recipient AI needs to
  report an outcome back.
- **Paths are never persisted**: transcript locations resolve at render time
  via `session-store.resolveTranscriptPath`, so directory rules stay private
  to session-store and stale keys cannot outlive a layout change.
- **Two-tier disclosure**: delivered content (`<pushed>`) always renders — it
  was already sent to that chat. Origin facts (`from_session`, `subject_*`,
  `reply_to`, `<quote>`) require the recipient to be an owner, matching the
  trust model that already governs tool access. Transcript paths additionally
  require an **explicitly configured** owner roster, not the permissive
  default where every sender counts as an owner: a path grants bulk read
  access to another session's history, so it is opt-in. Its absence costs
  nothing structural — subject and quote carry the working context.
- **Tag namespace is runtime-owned**: `sanitizeRuntimeTags` escapes runtime
  tag openings (including `<msg-sender>`) out of inbound bodies and relayed
  content, so no user or relayed text can forge or close a system tag.
- **Contract lives in the prompt layers**: `<relay-context>` semantics are
  declared in the IM Entry layer and its authority limits in the Constraint
  layer (§2.12), not in the injected message text — instructions in message
  text would compete with user input and repeat in history on every injection.
- **Quote**: captured by the runtime from the **raw inbound body** (assembled
  text carries runtime tags and, after a relay was consumed, the previous
  hop's block), never copied by the AI.
- **No TTL**: staleness is conveyed by the `at` timestamp and judged by the
  model. Bounded instead: per-target cap (10) with oldest-event collapse.
- **Durability**: `~/.halo/im-pending-relays.json`, versioned (unknown
  versions rejected, never guessed), write-behind (im-session-registry
  pattern) plus a synchronous flush at shutdown. Survives restarts —
  notification-style pushes may wait weeks for consumption.
- **Lifecycle**: cleared on `/halo-clear` (the conversation it belonged to is
  gone) and cascaded on session removal, so a chat re-registered under the
  same id never inherits stale relays.
- **Self-target skip**: pushes to the invoking session itself are not spooled
  (already in that session's tool history).

**Trade-off**: The relay context arrives only with the next inbound message —
acceptable because AI context is only ever consumed by a run, and runs are
inbound-triggered. Deep history beyond the quote requires the AI to Read/Grep
the source transcript, reusing existing tools instead of a new query API.

### 2.15 Knowledge Base Injection Mirrored Across Both Prompt Builders

**Decision**: `prompt.ts`'s `buildAppSystemPrompt()` (automation/headless
runs) and `prompt/identity.ts`'s `buildIdentityFragments()` (app-chat runs)
each independently call `getKBReferencesForApp(appId)` and render the same
`# Knowledge` section. There is no shared "add KB context" helper between
them.

**Rationale**: The two builders already have separate call signatures and
separate `promptCtx` shapes (§2.12 vs the headless template in `prompt.ts`)
by design — collapsing them into one shared entry point was rejected when
that layering was established, to keep the headless path free of app-chat's
channel/session concerns. Duplicating the three-line KB lookup + render is
cheaper than reintroducing coupling between the two paths for one shared
concern. Both call sites read the same `kb.appIds` binding
(`services/tlon`), so the two prompts never disagree about *which* KBs are
bound — only how the surrounding prompt is assembled.

**Trap for future readers**: any test that fully replaces (not
`importOriginal`-partial-mocks) `foundation/config.service` and then invokes
the real (unmocked) `buildAppSystemPrompt` must include a `getHaloDir` mock,
since `getKBReferencesForApp` resolves the KB index path through it. Omitting
it throws `No "getHaloDir" export is defined on the ... mock` the moment a
KB-aware code path runs, even in tests that never touch knowledge bases
directly.

### 2.16 Two Manual-Trigger Entries (Blocking vs Admission)

**Decision**: `triggerManually` resolves when the run finishes; `startManually`
resolves when the run is *admitted* and leaves it executing in the background.
Both share `admitManualRun()`, so they reject an unrunnable or already-busy app
identically before anything starts. Transport picks the one matching its
consumer:

| Consumer | Entry | Why |
|---|---|---|
| UI (`app:trigger`) / HTTP | `triggerManually` | The panel shows live progress from `app:status_changed` + the activity thread, so the pending call costs the user nothing. |
| `trigger_automation_app` MCP tool | `startManually` | The call sits inside a user's conversation. A run takes minutes; blocking it froze the conversation with no output, indistinguishable from a hang. |

**Why the conversation must not wait**: a digital human already owns its result
delivery — `report_to_user`, the configured output channel, the activity
timeline. Holding the conversation open to relay that result is duplicate
delivery bought with an unbounded stall. `get_automation_status` closes the loop
after the fact (`runtime_status` + `latest_run_output`) for the case where the
user does come back and ask.

**Admission signal**: `startManually` settles on the first of — `onQueued` (no
global slot free), `onStarted` (the run row exists, fired from `executeRun`'s
`onRunStarted`), or the run's own settlement. That last fallback is what
guarantees the caller is never left waiting on an admission that already
happened, e.g. when the run fails before inserting its row.

---

## 3. SQLite Schema

```sql
-- Each App execution run
CREATE TABLE automation_runs (
  run_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  trigger_type TEXT NOT NULL,
  trigger_data_json TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  tokens_used INTEGER,
  error_message TEXT,
  FOREIGN KEY (app_id) REFERENCES installed_apps(id) ON DELETE CASCADE
);
CREATE INDEX idx_runs_app ON automation_runs(app_id, started_at DESC);

-- Activity Thread entries (user-facing)
CREATE TABLE activity_entries (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL,
  session_key TEXT,
  content_json TEXT NOT NULL,
  user_response_json TEXT,
  FOREIGN KEY (app_id) REFERENCES installed_apps(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES automation_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX idx_entries_app ON activity_entries(app_id, ts DESC);
```

---

## 4. File Structure

```
src/main/apps/runtime/
  DESIGN.md                  -- This file
  types.ts                   -- AppRuntimeService, AppRunResult, AutomationAppState, ActivityEntry
  errors.ts                  -- Runtime-specific error types
  migrations.ts              -- Schema for automation_runs + activity_entries
  store.ts                   -- ActivityStore (CRUD for runs and entries)
  prompt.ts                  -- buildAppSystemPrompt() for automation (headless) sessions
  report-tool.ts             -- report_to_user SDK MCP tool
  escalation-cut.ts          -- when a turn that asked the user may be ended (§2.3); applied by execute.ts and app-chat-sink.ts
  notify-tool.ts             -- halo-notify SDK MCP tool (notify_channel + notify_bot)
  notify-availability.ts     -- resolveNotifyAvailability() — single source of truth for whether notify tools are actually loaded (mirrors notify-tool injection rules; consumed by chat + automation prompts)
  concurrency.ts              -- Counting semaphore
  execute.ts                 -- executeRun() core logic for automation runs
  service.ts                 -- AppRuntimeService implementation
  index.ts                   -- initAppRuntime(), shutdownAppRuntime(), re-exports

  -- Interactive chat with an App (separate from automation runs):
  app-chat.ts                -- sendAppChatMessage() and chat session lifecycle
  app-chat-sink.ts           -- TurnSink for chat: run JSONL + round/autonomous delivery (§2.12a)
  app-chat-live-turn.ts      -- The turn a chat is running RIGHT NOW: whether there is one (`isAppChatConversationGenerating` — the only truthful busy probe; app chat never writes the engine's legacy `activeSessions` map) and how to add a message to it. Its own leaf module because the team layer asks both synchronously, and app-chat.ts imports the team runtime accessor — a static edge back would close that cycle
  config-defaults.ts         -- Merge App config_schema defaults into userConfig
  dispatch-inbound.ts        -- Route IM inbound messages into app-chat
  im-permission-registry.ts  -- Per-conversation owner/guest context for SDK gating
  im-session-registry.ts     -- Persistent IM session list (per app + channel + chatId)
  pending-relays.ts          -- Cross-session relay spool + <relay-from> rendering (§2.14)
  progress-formatter.ts      -- Format streaming progress events for IM transports
  session-store.ts           -- JSONL persistence for chat history + SDK session IDs
  file-export-gate.ts        -- Filesystem boundary for AI-attached file delivery

  -- App chat system prompt (Identity / Entry / Constraint layers) — see §2.12:
  prompt/
    assembler.ts             -- assembleAppChatPrompt() — channel-agnostic joiner
    identity.ts              -- buildIdentityFragments() — identity layer
    capabilities.ts          -- disabled + awaiting-setup capability guidance
    entry-native.ts          -- NATIVE_CHAT_ENTRY — native UI entry fragment

  -- IM channel providers and IM-specific prompt content:
  im-channels/
    index.ts                 -- ImChannelManager + provider registration
    manager.ts               -- Generic channel lifecycle (provider-agnostic)
    im-prompt.ts             -- IM entry/constraint builders + ImSessionContext
    file-send-mcp.ts         -- send_file_to_chat MCP tool (pre-bound to session)
    file-send-resolve.ts     -- binds that capability to one chat, behind the export
                                gate. Shared: every dispatch path into a chat must
                                resolve it identically or the session is rebuilt
                                mid-turn (see runtime/team/DESIGN.md)
    identity-resolve.ts      -- Channel-agnostic opaque-chatId -> real-name resolution
                                (opt-in via ImChannelInstance.identityCapability)
    wecom-identity-resolve.ts -- WeCom-specific identityCapability implementation
                                (message_aibot_sessions_list over MCP Streamable HTTP)
    *.provider.ts            -- Brand-specific provider implementations
                                (wecom-bot.provider.ts, weixin-ilink.provider.ts, ...)
```

### 4.1 identityCapability pattern

Optional per-instance capability (same shape as `fileCapability`) letting a
channel resolve opaque platform-side chat IDs to real display names via a
separately-authorized directory lookup. Motivating case: WeCom anonymizes
sender IDs for bots created after its April 2026 change; a member-authorized
"message" permission can recover names for chats that have recently
interacted with the bot.

- `shared/types/im-channel.ts` — `ImIdentityCapability`, `ImIdentityAuthExpiredError`,
  `ImChannelInstance.identityCapability` / `.updateConfig()`,
  `ImChannelProvider.hotUpdatableConfigKeys`, `ImSessionRecord.resolvedName`,
  `ImChannelInstanceStatus.identityResolution`, `getImSessionDisplayName()`
  (single source of truth for the customName > resolvedName > displayName >
  chatId priority chain — main and renderer both import it).
- `im-channels/identity-resolve.ts` — throttled, coalesced, channel-agnostic
  resolution + status tracking. Takes the capability as a parameter from the
  caller rather than looking it up itself, to avoid a circular import back
  through `manager.ts` (which imports this file for status reporting).
- `dispatch-inbound.ts` — triggers resolution on inbound messages,
  fire-and-forget (never awaited — see the "no await between the busy check
  and generation start" invariant in that file). resolvedName only feeds
  sender identity for **direct** chats: a resolved chat_id/chat_name pair is
  session-level, so applying it to an individual sender inside a group would
  mislabel every member with the group's own name.
- `notify-tool.ts`, `prompt.ts` — the AI-facing contact directory and
  auto-sync awareness fragment also resolve through `getImSessionDisplayName()`.

A provider whose config carries a credential unrelated to its live
connection (WeCom's `nameResolveUrl`) should declare it in
`hotUpdatableConfigKeys` so `ImChannelManager.applyConfig` calls
`instance.updateConfig()` instead of a stop+recreate — otherwise every
change resets whatever connection-scoped state (WS session, reply-window
caches, ...) a full recreate would wipe.

Tests live in `tests/unit/apps/runtime/` mirroring the source layout.

---

## 5. Dependency Map

```
apps/runtime depends on:
├── apps/manager          getApp(), updateStatus(), updateLastRun(), onAppStatusChange()
├── apps/spec             AppSpec type (via manager)
├── platform/scheduler    addJob(), removeJob(), onJobDue(), getJob()
├── platform/event        on(), emit()
├── platform/memory       createTools(), getPromptInstructions()
├── platform/background   registerKeepAliveReason()
├── platform/store        DatabaseManager (for migrations + activity store)
├── services/agent        getApiCredentials (helpers), resolveCredentialsForSdk,
│                         buildBaseSdkOptions, getHeadlessElectronPath (sdk-config)
├── services/config       getConfig()
└── services/space        getSpace()
```

---

## 6. Interface Contract

```typescript
interface AppRuntimeService {
  activate(appId: string): Promise<void>
  deactivate(appId: string): Promise<void>
  triggerManually(appId: string): Promise<AppRunResult>      // resolves at run end
  startManually(appId: string): Promise<AppRunStartInfo>      // resolves at run start (§2.16)
  getAppState(appId: string): AutomationAppState
  respondToEscalation(appId: string, entryId: string, response: EscalationResponse): Promise<ActivityEntry>
  getActivityEntries(appId: string, options?: ActivityQueryOptions): ActivityEntry[]
  getEntriesForRun(runId: string): ActivityEntry[]
  getRun(runId: string): AutomationRun | null
  getRunsForApp(appId: string, limit?: number): AutomationRun[]
  activateAll(): Promise<void>
  deactivateAll(): Promise<void>
}
```


### Durable decisions, provenance and environment references

Migration 7 retains the pre-migration activity content and responses in
`runtime_decision_migration_backup`, then creates the continuation outbox,
legacy deadline policy and session-environment tables. Migrations run inside the
platform store transaction: a failure leaves the previous schema/data intact.
The backup is an audit/recovery source, not another live activity store. A rollback
requires restoring a pre-upgrade database copy before launching an older binary;
never lower the migration version on a live upgraded database.

An answer and its outbox row commit in one synchronous transaction. Repeating the
same answer returns the stored answer; a conflicting answer fails. Deadlines and
closure are checked against authoritative data in that transaction. Answer time is
server assigned. Multi-question forms must supply every answer in one submission.
The original answer remains visible if execution fails. Retry only requeues the
continuation; it does not write another answer.

Standalone continuations share the standalone execution lane and reuse the original
run/session. Team continuations retain their team, epoch and member. Busy team
sessions leave answers in the persistent outbox rather than the bounded in-memory
mailbox. The team runtime signals actual start and settlement; stable decision
correlation IDs suppress duplicate in-process delivery. Startup recovers interrupted
continuations. This is at-least-once recovery with deduplication, not an exactly-once
promise for external side effects such as email or file changes.

New installations have no implicit decision deadline. Explicit template deadlines
remain supported. Existing installations retain their prior configured/default
24-hour policy. Already-overdue unanswered historical requests retain their original
deadline plus `deadlineReviewRequired`; they require an explicit new deadline or
no-deadline choice before an answer. Other deadlines keep expiring normally.
Expiration writes a system resolution, never user-response text, and affects only
the corresponding request. Exact legacy system-shaped responses are reclassified with `attribution: unverified`
and retained verbatim in the resolution audit plus the migration backup. The old
schema has no actor evidence; matching reserved text does not prove who wrote it. No historical
closed work is restarted.

`ActivityStore.insertEntry` supplies trusted provenance for every producer. Team
reports of all kinds carry team/epoch/member attribution and an idempotent shared
activity with the same entry reference. Historical provenance is backfilled only
from a team context or an actual run record; otherwise it remains unknown.
Question summaries included in a model's report-tool result are scoped to the
current team task or standalone run, never another team's private question.

Run environments are immutable snapshots captured before new work begins. Chat
session environments are pinned when native sessions are created or other sessions first run. Forks retain their source environment. A one-time startup backfill pins provable legacy transcripts and registry sessions; a durable marker avoids rescanning their history on each launch. Changing future defaults pins any
provable legacy environments before moving; existing records keep their old
working/data/memory paths. Missing original storage blocks continuation rather than recreating empty memory or switching spaces. Connection bindings retain installed instance IDs: chat captures workspace inheritance minus explicit denials, while independent runs capture declared connections. Current revocations still apply, and replacing an original connection with a same-name account blocks continuation. Public runtime activity/state types re-export the shared
renderer-safe contract rather than maintaining another structural copy.

`getAppState` is a projection: automatic enablement, active execution, pending
questions and accepted continuations coexist. Manual execution and answering do
not enable automatic schedules. The legacy status field no longer closes questions
or overwrites the user's pause intent when an execution asks for a decision.


### Read-only identity and team awareness

`person-context` resolves current identity, membership and role from trusted runtime
context. Owners can query their digital human's visible teams; a borrowed team turn
is limited to its current team/task; guests do not receive the tool. A single narrow
schema exposes this read on demand without waking a team or injecting histories.
The space assistant's `halo-apps` read tool may query an authorized named digital
human but does not claim that person's identity. Links use stable team/task/member
identifiers and the renderer's guarded navigation path.

Changing the default space uses the runtime facade, pins provable legacy run/session
environments and rebinds future subscriptions without deactivating current work.
The manager's persisted data path keeps identity memory stable across the move.


### Activity write contract and recovery

All activity producers pass through `ActivityStore.insertEntry`. `report-tool.ts`
creates standalone and team reports/requests with explicit source snapshots;
ordinary native/IM chat does not mount this reporting tool. `execute.ts` creates
fallback completion/error entries linked to the persisted run. `service.ts`
records admission skips, interrupted startup runs and continuation state changes.
The store resolves standalone source only through an existing run, team source
through trusted team context, and otherwise uses `unknown`. Team reports retain
team/task names as display snapshots and stable IDs for navigation; the board
references the same activity ID rather than inventing another decision.

Canonical entries returned after answer acceptance and emitted activity upserts
include the durable continuation status. A stopped attempt may expose
`resumeAvailable` only when the original session exists and no unresolved or
expired authorization blocks it. Task closure remains terminal and distinct from
stopping an attempt. IM trigger history also reads the pinned session environment.

After an unexpected shutdown, startup settles interrupted attempts and requeues
persisted running continuations. Queued decisions remain durable if dependencies
are unavailable; failed continuations retain the accepted answer for explicit
retry. Operators should preserve the complete database plus transcript/storage
paths before upgrade or rollback. The migration backup preserves changed decision
records but is not a full database backup. Restoring only its rows into an active
newer database can disconnect outbox and task state and is not a supported rollback.

Capability inventory is a runtime facade over the manager's pure scope projection.
It adds retained session and unfinished-run instance bindings in one on-demand store
query, skips closed/completed work and metadata anchors, and applies current MCP
revocations before reporting consumers. The manager never reads runtime state.
Retained consumers are labelled as potential use, distinct from current default
workspace inheritance; no history content or connection secret enters this result.

Queued executions reload the installed person after obtaining their resource slot,
so permissions revoked during the wait apply before SDK creation. Continuations
without their original run/thread/engine-session identity fail explicitly; the
executor never substitutes a fresh conversation. Disk-reopen and competing-WAL
connection tests cover answer/outbox durability and close-versus-answer ordering,
and migration fault injection verifies schema, audit and row rollback together.

The people-directory facade combines the manager's bounded SQL projection with a
single membership query, grouped decision/continuation counts, one indexed recent
run query capped at five records per page item, and an in-memory runtime snapshot.
It does not call getAppState once per card or retrieve prompts/configuration. Page
size is capped at 100; stable installed-time/id ordering supports offset seeking.
The complete InstalledApp contract remains reserved for existing full-data flows
and on-demand detail hydration.

Legacy environment retention runs for paused and error-state people as well as
active ones, before continuation dispatch. An existing run without a retained
environment is blocked rather than resolved against its current default. Reopening
a run occurs only after resource admission; failures before SDK setup settle the
original run and preserve its accepted answer. The repeated-error circuit breaker
only disables enabled automatic work and never overwrites an explicit pause.

The desktop and remote Run once action uses `startManually` through `app:start-run`
and `POST /api/apps/:appId/runs/start`. It acknowledges admission without waiting
for model completion, so the automatic-task switch remains usable while work is
running. The existing public `/trigger` endpoint retains its completion response
for external integrations. Both paths share admission and concurrency checks.
