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

### 2.1 Own Session Assembly on the Shared Engine

**Decision**: Runtime assembles its own sessions (automation runs in `execute.ts`,
digital-human chat in `app-chat.ts`) rather than routing through the space chat's
`sendMessage()` — but it builds on the same engine layer, not a copy of it.

**What is shared** (from `services/agent`):
- Credentials: `getApiCredentials` / `getApiCredentialsForSource` (helpers),
  `resolveCredentialsForSdk`.
- Options: `buildUserSessionSdkOptions` (sdk-config). It reads the user's global AI
  settings (`maxTurns`, `disabledTools`, `promptProfile`, digital-humans switch) and
  the config directory itself, so a run or a chat turn follows them without passing
  anything. Never pass these from here, and never build options by hand.
- Prompt: `buildSystemPrompt` (system-prompt), which the digital-human prompt layers
  (`prompt.ts`, `prompt/identity.ts`) start from, so it inherits the same settings.
- Tools: `buildBaseToolset` (`toolsets/base.ts`) — web search, Halo documentation and,
  while digital humans are enabled, `halo-apps`. Each entry starts from it and states
  its exclusions where it builds (automation: no `halo-apps`; a disposable team
  member: no `halo-apps`). Everything else an entry mounts — notify, report,
  team, browser, terminal, OCR, email, Halo API, person context, IM file send — is
  its own, granted by app permission and caller.
- Session engine: chat acquires an `acquireV2Session` lease with a `TurnSink`
  (2.12a); fresh automation runs use `createSession`, while follow-ups acquire a
  lease without a consumer. Automation drives its own stream (2.10).
  The manager protects each leased instance before handing it to its caller, so
  asynchronous thinking/memory preparation cannot be interrupted by credential
  invalidation or another source's acquisition. Chat dispatch transfers that
  protection to awaiting-init/the consumer only after awaited SDK acceptance;
  a rejected send reports through the lease's instance-owned synchronous failure
  callback, closes only its owned instance and cancels its round. A retired
  rejection reaches the original caller without publishing into its replacement;
  preparation and round failures check the lease's current instance before reporting.
  The public chat wrapper reports setup errors only, never repeats an inner report.
  On retirement or a thrown stream, the consumer supplies the acknowledged turn's
  authoritative partial snapshot synchronously. The chat sink writes one
  `turn_snapshot` checkpoint, preserving open streaming blocks without per-token
  JSONL writes; replay replaces the current turn's aggregates with that checkpoint
  rather than duplicating them. Partial retirement still rejects the waiting round,
  never delivers it as a successful reply. Abandoned preparation releases in `finally`.
  A manager-owned follow-up holds its lease and active session for the entire
  execution, including auto-continue, then closes its own instance and releases
  before unregistering. Its cleanup cannot close a successor; transient runs close directly.

**What is Runtime's own**: session lifecycle and persistence (the run JSONL, not the
conversation store), the per-entry tool list, the capability policy for callers who
are not the owner, and error handling.

**Rationale**: `sendMessage()` is coupled to the space conversation store and its UI
events, which neither surface has. But the settings, base tools and prompt were
duplicated per entry and drifted (a tool the user disabled still worked in a digital
human; automation shipped without the documentation). What is the same for every
entry now lives once below the entries; what varies stays flat in each entry, and
`tests/unit/services/agent/entry-capability-matrix.test.ts` compares them.

**Trade-off**: Some code duplication in stream processing. Acceptable because the
runtime's stream processing is much simpler (no thought accumulation, no UI events).

### 2.2 Stateless Runs (No Cross-Run Session Persistence)

**Decision**: Independent runs create fresh V2 sessions. Every execution closes
its live session when it ends; follow-ups restore the original recorded engine
session rather than keeping its process alive between executions.

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
`summary` then frames why they are being asked; a single-decision escalation normally leaves
`questions` empty and carries its question in `summary` as before, though models do send a
one-element `questions` and that is equally valid. Because the run ends at
the escalation, splitting decisions across calls would interrupt the user once per
question and cost a round trip each — the array is what makes "ask for everything you need
first" possible. Read the shape through `getEscalationQuestions`, read answers through
`getEscalationAnswers` (a single decision may be answered flat or as a one-element list),
and render them through `formatEscalationAnswer` (all in `shared/apps/app-types`, shared
with the renderer); no caller — including answer validation — should branch on which shape
was written, and the legacy `content.question` field only exists for entries written before
it moved into `summary`.

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
`tool()` + `createSdkMcpServer()`, same pattern as
`services/ai-browser/sdk-mcp-server.ts`. Memory uses native file tools, not an MCP server.

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

### 2.6a Session Budget: Resident Engine Sessions Are Budgeted Here

**Decision**: every resident chat session (space chat, digital-human chat, IM,
team member) keeps one engine process alive between turns, so their number is
the first resource to run out as digital humans multiply. `session-budget.ts`
owns the policy: limit = `agent.maxResidentSessions` (Settings → Advanced,
clamped 2–50, default 10 — `shared/constants/session-budget.ts`), halved while
memory pressure (`platform/background/memory-pressure`) is above normal. The
limit is pushed down to the engine (`setResidentSessionLimit`), which enforces it
before creating any NEW session by closing least-recently-used idle ones; the
policy re-pushes on config and pressure changes and trims immediately when the
limit drops. Fresh automation runs create transient sessions outside that path,
so `execute.ts` calls `admitTransientSession()` first. Resumed follow-ups use the
manager and its resident admission path instead. An epoch seal releases that
epoch's idle member sessions (`releaseTeamEpochSessions`).

**Never refuses**: a busy session is never evicted; if all are busy the new one
goes over budget (warned once per crossing). An evicted conversation resumes from
its stored session id on its next turn — the same path as the idle sweep.

**Runs in flight** are indexed by app (`running-runs.ts`) — status queries are
O(1), not a prefix scan — and each app with a run in flight holds a keep-alive
reason (`automation-run:<appId>`), so a manual run of an inactive app survives
the window closing.

**File subscriptions hold their space's watcher**: watchers are reference-counted
(`services/watcher-host`), so activation retains the App's space
(`AppRuntimeDeps.fileWatch`, holder `automation:<appId>`) while it has a `file`
subscription and releases it on deactivate or when the subscription goes away.

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

**Not included: IM chats.** A scheduled or manual run starts from its trigger
and the digital human's own memory. Excerpts of every IM chat used to be pasted
in; with hundreds of chats that cost hundreds of thousands of tokens per run,
read every chat file at start, and crowded the task out. What a chat taught that
is worth keeping belongs in memory, written during the chat.

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
  intent is clear and context is already in the session). Memory instructions
  retain the original run's author tag and trigger origin; no new History heading
  or opening snapshot is inserted for a continuation.
- Resets the auto-continue counter to 0; the 10-retry loop runs again.
  This cycle repeats indefinitely until `report_to_user` is finally called.

**Rationale**:
- LLMs occasionally return `end_turn` prematurely due to model quirks, context
  issues, or non-deterministic behavior. In interactive sessions a human types
  "continue"; automation runs have no human operator.
- `report_to_user` is already mandated by the system prompt and powers the
  Activity Thread. Using it as the completion gate adds zero new concepts.
- The per-cycle turn limit is the user's `agent.maxTurns`, falling back to the
  shared `DEFAULT_MAX_TURNS` (`shared/constants/agent-limits.ts`) like every
  other entry point, so a run is not cut short before it can report.

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
  ├── beginAppChatTurnStart(conversationId)   → holds the conversation, before any await
  │                                             (or adopts request.turnStart, a hold its caller took)
  ├── who the turn answers to (request.imPermission, or the chat's last sender), fixed now
  ├── prompt / MCP / permission envelope   (unchanged)
  ├── acquireV2Session(..., { displayModel, sink })   → protected lease + consumer
  ├── prepare thinking / memory, sink.writeUserMessage(text) → run JSONL
  ├── stopped on the way? → send nothing, end
  ├── sink.beginRound({ onProgress, onReply, onMessageAccepted }); start.end()
  ├── await lease.send() → SDK acceptance, awaiting-init/consumer protection
  ├── await round.done
  └── finally: lease.release(); start.end()   (every exit)
```

**A message holds the conversation from the moment it is accepted.** Between
acceptance and `beginRound` lie credentials, tools and a session that may be
cold — seconds — and in that window neither the sink nor the engine knows the
message exists. Read as idle, the conversation let a second IM message start a
turn of its own; the engine folded both inputs into one turn with one result,
the first round claimed it (so the answer looked right), and the second round
waited for a turn that never came — failing much later, at session teardown or
the start deadline, with an error about a message that had in fact been answered,
and in between shifting every later pairing by one. `beginAppChatTurnStart`
(`app-chat-live-turn.ts`) closes the window inside the one predicate every entry
already asks, so IM buffering, the team bus, conversation interop, the status
endpoints and the browser reaper all see it without a change of their own. The
hold ends when the round is queued — the round answers from there — and on every
other exit. A caller that decides a turn before it can start it takes the hold
itself and passes it in (`request.turnStart`): a team wake queued for a
concurrency slot (team/DESIGN.md, "Team as an IM backend").

**Whatever waits on a conversation is woken by its changes, not by a clock.**
`app-chat-live-turn` announces every moment a conversation may have moved
between starting, queued, running and idle — a start ended, a stop was asked
for, and through the sink (`onAppChatRoundChange`) a turn began or a round
settled or was dropped — to its own waiters and to `onAppChatConversationChange`
listeners. Buffered IM supplements are released that way
(`dispatch-inbound.releaseSupplementsWhenIdle`, wired at runtime start): a
failed start, a stopped one, a team wake that gave its hold back and an
autonomous turn's end all owe them their turn, and no exit path has to remember
to say so. Their merged turn starts in the same tick as the check that found the
chat free — it does not retry the owner claim each of its messages already
tried, which would await in between.

Stopping reaches a message on its way (`abortAppChatTurn`): it is marked, keeps
holding the conversation until it unwinds — so nothing starts beside a turn that
is still building its session — and at the last point before `beginRound` it
sends nothing, disposes its IM stream ("stop means send nothing") and ends like a
stopped turn. If the setup it is still doing fails first, that is logged, not
reported: the stop already answered, and an error after "Generation stopped."
would report a failure of work the person halted.

A person adding to their own turn waits for a starting one to begin
(`injectIntoAppChatWhenLive`) instead of being told "nothing to add to", which
used to send the text as a second turn the engine folded into the first. The
wait has no deadline of its own: it ends when the turn begins (`delivered`), when
nothing is in flight any more (`no_turn` — the text becomes a turn of its own),
or when a stop is asked for (`stopped` — the composer gets the text back rather
than restarting the work just halted). A start always ends and a queued round is
bounded by the sink's own deadline, so the wait is bounded by theirs; a clock of
its own would answer "nothing in flight" while something still is.

**Turn ownership**: the SDK stream carries no correlation between a `send()` and
the turn it causes, so ownership is decided by order. `beginRound` enqueues
immediately before `send()`; a turn claims the queue head at its `system:init`.
Consequences that matter:

- A turn that starts with an empty queue is **autonomous**. It is persisted like
  any other turn and, for IM sessions, pushed to the originating chat (the user
  asked for that work — its completion belongs in the conversation). Native and
  HTTP sessions need no push: the `agent:*` events already reached the client and
  the chat page re-reads the transcript when the turn completes and settles it in
  place (see `renderer/stores/chat/DESIGN.md`).
- A round enqueued while a turn is already running cannot be claimed by it, so
  the residual race is only the instant between enqueue and `system:init`. The
  IM busy check closes even that: `isAppChatConversationGenerating` counts an
  autonomous turn as busy, so an inbound message arriving then is buffered as a
  supplement instead of starting a round.
- A round that can never be answered is settled, not left hanging:
  `onConsumerStopped` rejects outstanding rounds synchronously at consumer
  retirement (or once on natural exit). The sink outlives its SDK sessions, so a
  stopped predecessor cannot call it again when its stream finally exits or emit
  late turn hooks into a successor's rounds. A started turn's completion event is
  emitted during retirement, before replacement, so other clients and turn-end
  listeners also settle. Before `system:init`, acquisitions register an instance-owned
  failure callback: unexpected termination checkpoints the user message and failure,
  emits error/completion synchronously, then discards delayed predecessor failures.
  An empty interrupted/errored turn rejects rather than leaving an IM stream open.
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
there; `isAppChatConversationGenerating` is the single predicate (message still
starting OR queued round OR consumer mid-turn) and every caller — stop, clear,
restart, supplement buffering — goes through it.

**Reading `activeSessions` for an app chat is always wrong, and it fails
silently.** App chat never registers there; the map protects only headless
manager-owned run continuations. Every app-chat `activeSessions.has(...)` therefore
answers a confident, permanent `false` — worse than an obvious break, because each
caller reads a plausible answer and none can tell it is a constant. Two probes were left on it and both are now
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

**Layer split in the renderer**: the default and local sessions render in the
main chat page — the same `ChatView` as space conversations, with the chat
store's digital-human source behind it (`renderer/stores/chat/DESIGN.md`);
IM/HTTP sessions stay read-only in `ImChatView`, reached through
`ImSessionDetailView`.

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
- **No per-event TTL**: staleness is conveyed by the `at` timestamp and judged
  by the model. Bounded instead: per-target cap (10) with oldest-event
  collapse, and a target whose newest event is older than 90 days is dropped
  (logged) — the number of targets is otherwise unbounded (chats that never
  speak again).
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

### 2.17 A Stop Is Work for the Owner, Not a Status

**Decision**: when the runtime stops a person — consecutive failures hitting the
threshold, an expired sign-in — that is reported as an item waiting on the
owner, not only as a status. `app-state.ts` derives `AutomationAppState.blocked`
from the persisted status; `getPendingInbox` returns the same people beside the
unanswered questions and counts them in its total.

**Rationale**: a stop and an unanswered question are the same thing to the
owner — work that will not move until they act — and they end the same way, with
`resume()`. Carrying the stop only as a status produced a person marked as
needing the owner whose request list, which holds questions and nothing else,
was legitimately empty. A surface that claims someone needs the owner has to
carry the way out of it.

**`error` is a state, not a default**. It used to be the fall-through of the
status ladder in both derivations, so an unmapped status was indistinguishable
from a person the runtime had stopped — an uninstalled person read as one that
had failed. Every status is now mapped explicitly and the ladder exists once.

### 2.18 Transcript Read Model (Stable Ids, Pages, On-Demand Thoughts)

**Decision**: a digital-human session is read into the same message shape as a
space conversation — `TranscriptMessage` / `TranscriptPage`
(`shared/types/transcript.ts`, helpers in `shared/transcript.ts`) — and the
JSONL storage is unchanged (append-only, written by `session-store`).

- **Message id = `session-msg-<N>`**, `N` the physical 1-based file line of the
  message's first event: the user event, or for an assistant turn the first event
  that put a thought or text into it (a `result` envelope counts). The file only
  grows, so the id never changes while the turn is in flight, and never depends
  on how many messages precede it — which is what lets a reader parse or page
  anywhere in the file. Blank and malformed lines still count as lines. (The
  earlier `session-msg-<count>` did not drift on append-only reads; it was
  replaced because it tied identity to the parse, not to the file.)
- **Pages come from the newest backwards.** `readSessionTranscript(…, {before?, limit?})`
  returns `{messages, hasMoreBefore, cursor, total}`; `cursor` is the id of the
  oldest message in the page and is passed back as `before`. A `before` that no
  longer exists (history cleared) yields an empty page, never a restart from the
  newest. Limit defaults to 50, max 200.
- **Thoughts are not in a page.** Messages with a thought process carry
  `thoughts: null` + `thoughtsSummary`; `readSessionMessageThoughts` returns one
  message's thoughts (tool output included). The full read
  (`readSessionMessages`, used by IM, team-member and run-detail views) is
  unchanged. On a 13–16 MB team-member transcript the first 50-message page is
  ~0.13 MB over IPC versus 2–5 MB for the full read.
- **Parse cache** (`platform/file-cache`, `createStampedLru`): the parsed
  events and converted messages of a file are kept while its stamp (size +
  mtime + inode) is unchanged, LRU bounded to 8 files / 32 MB of file bytes (the
  parsed form costs 2–3x that on the heap). An append changes the stamp, and the
  next read parses only the bytes appended since (the cache hands the previous
  parse to the reader) before re-converting. Files are read in 1 MB chunks —
  never as one string. Callers get a copy of the array; the message objects in
  it are shared with the cache and must be treated as read-only.
- **Large files** (> 32 MB, `FULL_PARSE_MAX_BYTES`) are never parsed whole for
  paged reads and never cached whole (the cache refuses an entry heavier than its
  budget). A sparse line index (`session-file-reader.ts`: a checkpoint per MB,
  persisted as `<run>.lineidx.json` and extended only by appended bytes) maps a
  message id (`session-msg-<line>`) to its byte offset, so a page reads one
  8 MB window: the newest window for the first page, the window ending at
  `before` for older ones (its first message may be a partial turn and is
  dropped; the next older window reads it whole), and a thought load reads from
  the message's own line. Message ids equal a whole parse; `total` then counts
  the window, and thought ids are per read. A whole-transcript caller should pass
  `limit` (newest N from the last window); an unlimited whole read of a large file
  still works but is uncached and logged once.
- **Codec** (`session-transcript.ts`): the event → message conversion is pure
  and lives apart from the file I/O and the cache in `session-store.ts`.
- **Provenance.** A user-side record may carry `_source`
  (`injection` | `cross-conversation` | `cross-conversation-notice` |
  `team-message`) and `_metadata` (the flat fields space conversations persist:
  `fromConversationId/Title`, `summary`, `correlationId`, `forwardDepth`, team
  fields). The reader maps `_source` to `source` and to the role
  (`roleForTranscriptSource`: cross-conversation, its notice and team messages
  are `system`; injection is `user`); unknown sources and fields are ignored.
  Writers use `SessionWriter.writeTrigger(content, images, teamOrigin, provenance)`
  / `TurnSink.writeUserMessage(...)`, and write the text to *show*, not the
  framed text the model received.
- **Surface**: `app:chat-transcript` / `app:chat-message-thoughts` (IPC, contract in
  `shared/rpc/contracts/app.contract.ts`) and
  `GET /api/apps/:appId/chat/transcript`, `GET /api/apps/:appId/chat/messages/:messageId/thoughts`
  (HTTP, same `resolveAppChatTarget` trust boundary as the other chat routes).
  `app:chat-messages` keeps its full-array contract. Main-side loaders:
  `loadChatTranscriptForConversation`, `loadChatMessageThoughts`.
- **Jumping to a message.** `through: <messageId>` returns the newest page widened
  back to that message (plus a few above it, capped at 2000 messages), so a search
  hit older than the newest page can be revealed without walking cursors.
- **Global search** (`services/search.service.ts`) reads space conversations from
  their files (never `{id}.thoughts.json`; the query is matched literally) and
  digital-human sessions through the registered conversation sources — default and
  local sessions only, the same directory cross-conversation reads use — so a result
  carries the session key and the stable message id it navigates to. Transcripts
  are searched one at a time with a yield between them; a digital-human session
  costs one parse of its JSONL unless the parse cache still holds it.
- **What is shared, and what is not.** Only the message format and the paging
  rules (`pageTranscript`, `through`, the list-view projection) are shared. There is
  no unified reader: space conversations are still read whole through
  `conversation.service` (`getConversation` / `getMessageThoughts`), digital-human
  sessions through `session-store` as above.

### 2.19 Chat Browser Contexts (Resident vs Per-Turn, Live View)

**Decision**: each chat's AI browser context lives in `app-chat-browser.ts`, not
in a map inside `app-chat.ts`, and its lifetime depends on who is chatting:

| Session | Context lifetime |
|---|---|
| default (`app-chat:{appId}`) and local (`…:local:direct:{uuid}`) | **resident** — survives the turn, so the next message continues on the same page and the user can open the live view between turns |
| IM, HTTP, team | **per-turn** — destroyed in `runAppChatTurn`'s `finally`; nobody can watch them and they can be minted without limit |

Every context is created with `createScopedBrowserContext({ conversationId })`,
which is what makes `services/ai-browser` announce its active page under that
conversation (see that module's DESIGN, "Live view"). The renderer's "view live
feed" button for a digital-human chat depends on this and on nothing else here.

**Resident is bounded**, because every page is a Chromium renderer and local
sessions are unbounded (`MAX_RESIDENT_BROWSER_CONTEXTS`, `RESIDENT_BROWSER_IDLE_MS`):
- a context idle for 30 minutes is destroyed; cookies live in the shared
  `persist:browser` session, so only tabs and scroll state are lost;
- at most 6 contexts may hold pages; a new one evicts the least recently used
  idle one;
- never mid-turn (asked of `isAppChatConversationGenerating`) nor while a turn is
  starting — acquired and not yet ended, trusted for `TURN_TRUST_MS` (5 minutes)
  so a slow engine start is covered, after which only the live-turn answer
  counts, so a turn that died before reporting back cannot pin a context — and
  never while the user is watching one of its tabs (`ctx.hasRevealedView()`);
  over the cap rather than kill a live turn.
- a per-turn context still present after `TURN_TRUST_MS` lost its cleanup and is
  reclaimed by the same sweep.

**Teardown paths** (each one goes through `destroyChatBrowserContext`, which logs
the reason and closes the pages, and the pages' destruction announces `view-gone`):
session cleared/deleted (`clearSessionByConversationId`), team session closed,
manual "Restart agent" (`restartAppChat` with `interruptActive`; automatic
config-change restarts deliberately leave the pages), app uninstalled
(`onAppUninstalled` in `service.ts`), runtime shutdown, the AI-browser permission
revoked (next turn), and the sweep's `app-removed` check — deleting a space
hard-deletes its apps without an uninstall event, so a context of an app that no
longer exists is noticed on the next sweep (≤ 60 s) instead of being leaked.

Logging: one line per create/destroy (`reason`, view count) and a state line
every 5 minutes while any context exists (`[AppChatBrowser] State: contexts=…`).

### 2.20 Digital-Human Chats as Cross-Conversation Sources

`conversation_read` / `conversation_send` (`services/conversation-interop`)
address every conversation of a space through registered *sources*. The space's
own conversations are built in; this module registers the digital-human source
(`conversation-source.ts`) from `bootstrap/extended.ts`, right after
`initAppRuntime` — the interop module declares the slot and never imports this
tier (the same downward-registration shape as `app-bridge`). The source reads the
app manager and session registry lazily, so registration order against
`initConversationInterop` does not matter.

**What is exposed.** Only the sessions the desktop user holds with a digital
human: the default session (once it holds a conversation) and the local sessions
of the digital humans installed in the caller's space. IM, HTTP and team sessions
are neither listed, resolvable, readable nor deliverable to — `getMeta` returns
null for their keys, so even a guessed id or hashed handle finds nothing.
Uninstalled digital humans and `enableDigitalHumans: false` expose nothing.
Titles: the default session is the digital human's name, a local one
`Name: <custom name | first message | New chat>`. Counts come from the session
registry, which counts inbound turns, not stored messages.

**References.** `[#Title](conv:<8hex>)`: a space conversation keeps its uuid
prefix, a digital-human chat carries the first 8 hex of SHA-1 of its
conversation key (`shared/conversation-reference.ts`, a pure implementation so
the composer and the resolver derive the same handle). Collisions go through the
resolver's ambiguity answer with full ids; existing references stay valid.

**Reading.** `readTranscript` maps the session's parsed messages
(`loadChatMessagesForConversation`, served from the parse cache while the file is
unchanged) to clean lines in one pass, carrying no thoughts; interop applies its
own paging and 8000 character budget on top, identical for every source. The
parse of the file is the real cost and a tail read would pay it too, so the
source contract stays "the whole clean transcript" rather than growing a window.

**Delivering.** `dispatch` runs an ordinary `sendAppChatMessage` for the target's
conversation key, so the turn is assembled exactly like one the user typed. Two
things differ: the model reads the framed text (`message`), while
`AppChatRequest.recorded` makes the sink write the sender's own words with
`_source: 'cross-conversation'` and the provenance metadata; and dispatch
resolves when the engine *accepts* the message (`onMessageAccepted`), not when
the turn ends — a failure before that rejects (the sender sees `unreachable`), a
failure after it is only logged. Exclusivity is interop's turn gate, keyed by the
conversation key; `isBusy` is `isAppChatConversationGenerating` (it already
includes a queued round). The turn-end signal is the public
`agent:complete` / `agent:error` stream filtered to app-chat keys, and
`hasLiveSession` is `v2Sessions.has || hasActiveAppChatRound`, which is what lets
interop tell a still-starting turn from a leaked reservation.

**Sender side.** The rate-limit notice interop leaves in the *sender's*
conversation goes through `writeNotice`: a `_source: 'cross-conversation-notice'`
line appended through the sender's live sink (skipped with a warning when none is
open). A scheduled run acts under its own sender key (`app-run:{appId}:{runId}`,
`run-conversation-source.ts`), never the default chat: what it sends is a
one-way notice, a reply to it is refused, and only a `waitForReply` it is blocked
in gets an answer back.

**Collaboration switch on the target side.** The source reads
`isConversationCollabEnabled` on every call and marks a switched-off digital
human's chats `unavailable`; it does not hide them. The directory's admission
(`services/conversation-interop/admission.ts`) is what keeps other conversations'
AI from listing, reading or delivering to them — including a delivery queued
before the switch went off — and tells a caller naming one why. The user's own
features, global search included, still see them. The composer still shows its
chats in the # picker, greyed and labelled, not selectable.

**Who gets the tools** (`conversation-collab.ts`, one decision for `app-chat.ts`
and `execute.ts`): the owner's per-digital-human switch
`conversation-collab` (`isConversationCollabEnabled`, **off by default**, one
switch for read and send, settings → Capabilities), AND the caller is the owner
(an IM guest or a teammate's borrowed turn never gets them, switch or not — the
capability-policy tables do not list `halo-conversations`, so an applied policy
strips it too, and this gate holds where none is applied), AND the turn is not in
a team channel, AND the session is the digital human's default or a local one
(an owner's IM or HTTP session is not in the conversation directory, so replies to
it could not route back), AND the global `enableConversationInterop` master switch is not
off (`enableConversationSend: false` narrows to read-only). The tools load the
interop module on first use, so the turns that never mount them do not pay for
the engine session layer at load. Toggling the switch changes the session's
server set, which its inputs fingerprint already covers, so it takes effect on
the next message. `entry-capability-matrix.test.ts` pins every row.

### 2.21 An Author's Upgrade Reaches the Running Digital Human Here

An author's new version is merged over the user's edits by the manager
(`apps/manager/DESIGN.md` §2.13). Every upgrade path — the store's automatic
and manual updates, the bundled loader — ends in `upgradeSpec`, and the runtime
subscribes to its `onAppSpecUpgraded`, so an upgrade's effect on the running
digital human is decided once:

- **Reschedule**: `syncAppSubscriptions`. The paths themselves do not.
- **Note**: when fields kept the user's version, a `milestone` entry carrying
  `content.upgrade` (the outcome) and `source.kind: 'upgrade'`. It belongs to no
  run (sentinel run id `upgrade`, like chat reports), so run pruning never
  removes it; the app's deletion does. The renderer draws it from
  `content.upgrade` in the user's language; `summary` is an English fallback.
  The wording says the fields differ from the author's new version, never that
  the user changed them, since an upgrade with no earlier original cannot know.
- **Switching back**: `adoptAuthorVersion(appId, entryId, fields)` (IPC
  `app:adopt-author-version`, HTTP `POST /api/apps/:appId/activity/:entryId/adopt-author-version`)
  switches only fields the note kept, through the manager; reschedules when the
  run times switched; records them as `content.upgrade.adopted`; and publishes
  the note again. Both transports are user-only: whether an upgrade overrides
  the user's own edit is the user's call.

### 2.22 A Stop Reaches the Engine; What a Long Run Held Up Is Shown

A run has no time limit and no idle detection, and nothing reruns it: a long run
is left to run until it ends or the user stops it. Pause keeps its meaning
(§2.7) — it stops scheduling, not the run in progress.

- **Stop**: every stop from outside a run — "Stop this execution" (`stopRun`),
  closing the task (`closeRun`), removing the person (`abortApp`), quitting
  (`abortAll`) — aborts the execution's controller. The stream loop sees an
  abort only when the engine's next message arrives, so `execute.ts` also hands
  it to `engine-stop.ts`, which stops the engine the way a chat's Stop does: the
  turn is interrupted, and the session is closed (through its lease when it has
  one, and only once) when the run is still going 3 s later or the engine cannot
  interrupt. Closing ends the stream, so a run whose engine went silent (a hung
  tool, MCP server or model request) still ends within about 10 s. A run stopped
  while its engine was starting sends no turn at all. A stopped run that
  reported nothing ends `error` as "Stopped before it reported results".
- **Schedule after a stop**: the scheduler handler reports a stopped or closed
  run as `noop`, so the scheduler neither backs off the next time nor counts the
  stop toward disabling the job. The runtime's own consecutive-error count
  already ignores such runs.
- **Skipped times**: one execution per person (§2.6) means scheduled times that
  come due while it is queued or running are skipped (`admitAutomaticRun`; the
  job that started the run is not even dispatched meanwhile), which leaves no
  trace. When the execution ends, `noteSkippedSchedules` counts them from the
  schedules (`scheduler.countDueTimes` over the activation's jobs since the
  person became busy) and adds the count to the run's latest entry as
  `content.skippedSchedules` — one line on the timeline, not an entry per time.
  A job removed mid-run (pause) contributes nothing.
- **While it runs**: `AutomationAppState.runningAtMs` is the execution's own
  start, kept in memory by run id, because a continued run keeps its first start
  in the database. The activity thread shows it with the running time.

### 2.23 Run Transcripts Are Kept for a Person's Newest 200 Runs

Every run writes the transcript "View process" reads
(`{spacePath}/.halo/apps/{appId}/runs/{runId}.jsonl`), and the engine stores its
own session so the run can be continued. Neither was ever deleted, so a person
running every few minutes piled up a gigabyte within weeks, mostly younger than
any age limit would reach. `run-retention.ts` keeps both for the newest 200 runs
of each person:

- **When**: at the end of each of the person's executions, after the skipped
  count (§2.22), at most 50 runs per pass, so a backlog drains over the next
  runs instead of in one pause. Nothing scans at startup; there is no setting.
- **Which**: `listRunsPastTranscriptRetention` — runs past the newest 200 that
  still have a transcript, through the partial index
  `idx_runs_transcript_kept`, so a pass reads about 200 rows however long the
  history. Skipped runs never had a transcript and do not count. Never a run
  still going, waiting on a question or holding a queued, running or failed
  continuation (the same protections as `pruneOldData`).
- **What**: the run's own transcript and line index, by exact run id
  (`deleteRunTranscript`) — never a pattern, since the same folder holds the
  person's chat transcripts — in the space its environment names, or the
  person's current space for a run older than environments. Then, best effort,
  the engine's stored session through `services/agent`'s `deleteStoredSession`
  (CC-protocol engines; the engine that ran it is not recorded).
- **After**: `markTranscriptCleared` sets `transcript_cleared_at`, drops the
  run's session id and the `resumeAvailable` of its failure entries. The
  timeline keeps its entries (the one-year `pruneOldData` still removes them).
  Reading the process answers `RunProcessClearedError` (code
  `RUN_PROCESS_CLEARED` over IPC and HTTP), and `continueFailedRun` and
  `injectIntoRun` refuse the run: nothing is left to continue it from.

### 2.24 A Run Short of a Declared Connection Does Not Start

An independent run hands the model only the declared connections (`requires.mcps`)
that are running in its space. One that is not installed, turned off, waiting
for sign-in or failing used to be skipped with a log line, so the run started
without tools it was built around and failed with no visible reason.
`executeRun` — the one entry of scheduled, manual, event and continued runs —
now checks `missingConnections` after the environment checks and before
credentials or a session exist, so nothing reaches a model. A gap throws
`MissingConnectionsError`, which ends the run like any failure: `error`, counted
toward the consecutive-failure pause, and a `run_error` entry carrying
`content.missingConnections` (`{ id, name, state }`) that the timeline renders in
the user's language with the way to Tools & Resources. A dependency the owner
switched off for this person is a choice, not a gap; built-in capability ids are
not installable connections. Chat keeps inheriting its workspace's connections.

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
  -- later migrations: session_id, environment_json, stopped_at, transcript_cleared_at
  FOREIGN KEY (app_id) REFERENCES installed_apps(id) ON DELETE CASCADE
);
CREATE INDEX idx_runs_app ON automation_runs(app_id, started_at DESC);
-- Runs that still have their process transcript (§2.23)
CREATE INDEX idx_runs_transcript_kept ON automation_runs(app_id, started_at DESC)
  WHERE transcript_cleared_at IS NULL AND status != 'skipped';

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
  app-state.ts               -- persisted AppStatus + live execution facts -> AutomationAppState (status, blocked, automaticEnabled). Shared by getAppState and the directory page; two copies of this ladder is how they came to disagree
  people-directory.ts        -- bounded directory page projection
  prompt.ts                  -- buildAppSystemPrompt() for automation (headless) sessions
  report-tool.ts             -- report_to_user SDK MCP tool
  escalation-cut.ts          -- when a turn that asked the user may be ended (§2.3); applied by execute.ts and app-chat-sink.ts
  notify-tool.ts             -- halo-notify SDK MCP tool (notify_channel + notify_bot)
  notify-availability.ts     -- resolveNotifyAvailability() — single source of truth for whether notify tools are actually loaded (mirrors notify-tool injection rules; consumed by chat + automation prompts)
  concurrency.ts              -- Counting semaphore
  execute.ts                 -- executeRun() core logic for automation runs
  engine-stop.ts             -- makes a stop reach a run's engine: interrupt, then close after a grace period (§2.22)
  run-retention.ts           -- keeps run transcripts and engine sessions for a person's newest 200 runs (§2.23)
  service.ts                 -- AppRuntimeService implementation
  index.ts                   -- initAppRuntime(), shutdownAppRuntime(), re-exports

  -- Interactive chat with an App (separate from automation runs):
  app-chat.ts                -- sendAppChatMessage() and chat session lifecycle
  app-chat-sink.ts           -- TurnSink for chat: run JSONL + round/autonomous delivery (§2.12a)
  app-chat-browser.ts        -- The AI browser context each chat drives: resident for native chats, per-turn for IM/HTTP/team, idle/cap reaping, teardown by reason (§2.19)
  conversation-source.ts     -- The digital-human `ConversationSource` registered with services/conversation-interop (default + local sessions only; §2.20)
  run-conversation-source.ts -- A scheduled run's one-way sender identity for cross-conversation messages (§2.20)
  conversation-collab.ts     -- Who gets `halo-conversations` (owner's `conversation-collab` switch, owner-only, no team channel, global master switch) and the lazy server factory shared by app-chat.ts and execute.ts (§2.20)
  app-chat-live-turn.ts      -- The turn a chat is running RIGHT NOW: whether there is one (`isAppChatConversationGenerating` — the only truthful busy probe, counting a message still on its way to the engine (`beginAppChatTurnStart`, §2.12a) as well as a queued round and a live turn; app chat never writes the engine's legacy `activeSessions` map) and how to add a message to it (`injectIntoAppChat` for the team bus; `injectIntoAppChatWhenLive`, which waits for a starting turn to begin and answers delivered / no_turn / stopped, for the user adding to their own turn through `app:chat-inject` / `POST /chat/inject` — that path passes `{ source: 'injection' }`, which the transcript reader shows as an annotation on the reply), plus the change announcements everything waiting on a conversation is woken by (`onAppChatConversationChange`, §2.12a). Its own leaf module because the team layer asks both synchronously, and app-chat.ts imports the team runtime accessor — a static edge back would close that cycle
  config-defaults.ts         -- Merge App config_schema defaults into userConfig
  dispatch-inbound.ts        -- Route IM inbound messages into app-chat
  im-permission-registry.ts  -- The IM chat's last sender and their standing, for a turn with no sender of its own (a message's own turn carries its sender in `AppChatRequest.imPermission`)
  im-session-registry.ts     -- Persistent IM session list (per app + channel + chatId)
  pending-relays.ts          -- Cross-session relay spool + <relay-from> rendering (§2.14)
  progress-formatter.ts      -- Format streaming progress events for IM transports
  session-store.ts           -- JSONL persistence for chat history + SDK session IDs; transcript reads, paging and the parse cache (§2.18)
  session-transcript.ts      -- Pure codec: stored SDK events → `TranscriptMessage` (ids, thoughts, provenance; §2.18)
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
    message-parts.ts         -- A text longer than one platform message as ordered
                                `(i/n)` parts; the limit is each provider's (§4.2)
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

### 4.2 How long one message can be is the provider's

Generic code hands a reply, a push or a stream's final answer to the channel
whole (`ReplyHandle.send`, `StreamingHandle.finish`, `pushToChat` take any
length). It used to cut every IM reply to 4000 characters first, silently: the
rest of a long answer was lost on every channel, while WeCom's own `(i/n)`
splitting never triggered.

Each provider knows its platform's cap and states it once, in the unit that
platform counts — WeCom 20000 bytes (its stream frames, markdown replies and
markdown pushes are each limited to 20480), Feishu 3500 characters (the size
its SDK already splits markdown into, kept in step through `textChunkLimit`),
WeChat 4000 characters (what the platform's own bot plugin sends per message).
`im-channels/message-parts.ts` does the splitting for all of them, so a long
text reads the same everywhere: ordered parts labeled `(i/n)`, each sent once
the one before it settled, cut at a paragraph or line break near the cap and
never inside a character, a code block closed and reopened across a cut.

A WeCom stream that outgrows one message is closed on what fits plus a notice,
rather than sending a frame the server rejects — which left the stream stuck
mid-answer — and the whole answer follows as `(i/n)` pushes.

Tests live in `tests/unit/apps/runtime/` mirroring the source layout.

---

## 5. Dependency Map

```
apps/runtime depends on:
├── apps/manager          getApp(), updateStatus(), updateLastRun(), onAppStatusChange()
├── apps/spec             AppSpec type (via manager)
├── platform/scheduler    addJob(), removeJob(), onJobDue(), getJob()
├── platform/event        on(), emit()
├── platform/memory       layouts, snapshot + section, getPromptInstructions(), write guard
├── services/memory-consolidation  requestConsolidation() after runs and chat turns; consolidateNow()/status for settings (memory-control.ts)
├── platform/background   registerKeepAliveReason()
├── platform/store        DatabaseManager (for migrations + activity store)
├── services/agent        getApiCredentials (helpers), resolveCredentialsForSdk,
│                         buildUserSessionSdkOptions, getHeadlessElectronPath (sdk-config),
│                         buildBaseToolset (toolsets/base)
├── services/conversation-interop   ConversationSource type (registered from bootstrap), createConversationInteropMcpServer (lazy, when collaboration is on)
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
stopping an attempt.

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


## Memory and file boundaries of a digital human

- Its own memory: read and written by every turn (owner, team, IM guest), under
  the memory lock; off entirely when the owner turns memory off
  (`userOverrides.memory`).
- Its space's topics: offered read-only when `spaceMemoryAccess` is on and the
  space has memory on. Writes are refused by the write guard.
- A strict turn (an IM guest — of the digital human's own chat or of a chat it
  fronts for a team — or a teammate's turn on work that entered from outside) is
  held to `turn-file-access.ts`, enforced by a pre-tool hook and the delegation
  gate alike. A teammate from this machine is the owner's own: held to the tool
  switches only, with no path boundary, as before.
  - memory content (memory.md + topics; the space's topics per the rule above)
    and the files handed to the turn (IM attachments, persisted images) — always,
    even for a chat-only guest (`keepFileTools` keeps the file tools in the pool);
  - Read/Glob/Grep, when granted, only inside the workspace; Write/Edit, when
    granted, only inside the workspace. Path arguments are read as the engines
    read them (`foundation/path-containment`: `~` is the home folder);
  - the space's `.halo/` stays closed except for the memory above. Both engines
    get read-deny rules for it (`closedFolderDenyRules`, `Read(//…)` in
    `disallowedTools`) and apply them while walking — the Halo engine through
    its `utils/read-deny` — so a search from the workspace root never opens a
    closed file and nothing about its result window can depend on one. The one
    exception is `.halo/attachments`, which holds this turn's persisted images
    and is left to the hook, file by file. Two backstops sit behind the rules:
    a granted search is rewritten to run at the physical path that was judged
    (`searchPathRewrite`, the pre-tool hook's `updatedInput`; links resolved, so
    `/Volumes/Macintosh HD/…` runs as the workspace itself), and closed lines
    are removed from its output (`filterSearchOutput`) without a trace — no
    count of hidden lines, and the engine's own "no matches" text when nothing
    is left;
  - a file in the closed folder cannot be sent out either (`turnFileExportRefusal`,
    checked by the notify tool's export gate, the IM file-send tool and email
    attachments).
  - Bash and the terminal cannot be held to paths; they follow the policy only.
  - Codex runs no restricted turn at all (it cannot enforce a policy).
- TodoWrite is available to every caller (`ALWAYS_AVAILABLE_BUILTIN_TOOLS`).
- Memory's shared annotated format, mature example, recording policy, paths and current
  author tag are standing system instructions; opening memory data is bounded and
  injected only for a fresh run or chat. Resumed chats and forks still receive the
  destination author's tag in session configuration, without repeating the data.
- Authors come from runtime-owned origins (`chat`, `im`, `im-guest`, `team`, or the
  run's trigger) and a stable session/run digest, never a caller's display name.
  Owner/guest transitions update the tag and session inputs together.
- No per-turn running-instance roster or memory-status MCP tool is injected.
  Stop/reset enumeration still includes idle resident consumers. Automatic
  consolidation's busy probe counts queued rounds, active generation/subagents and
  active runs, not idle sessions; its existing repeated-deferral limit and the
  manual "consolidate now" override remain unchanged.
