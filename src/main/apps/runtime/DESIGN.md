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
- Escalation responses trigger a NEW run with the escalation context injected into
  the initial message, not a session resume. This is simpler and more robust.

### 2.3 Escalation as Run Boundary

**Decision**: When AI calls `report_to_user(type="escalation")`, the current run
records the escalation and ends. User response triggers a new run.

**Rationale**:
- Holding a Claude Code subprocess alive for hours is resource-wasteful and fragile.
- The AI can write important context to memory before escalating.
- The new run receives: escalation question + user response + memory context.
- This is simpler than session hibernation and more resilient to process crashes.
- V2 could introduce session persistence if needed, but V1 prioritizes robustness.

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
Default: 2 concurrent runs.

**Rationale**:
- Each run spawns a Claude Code subprocess (significant resource usage).
- Simple acquire/release pattern. Callers that can't acquire are queued.
- No priority system in V1 (FIFO queue).
- The AI Browser lane (maxConcurrentAIBrowserRuns) is deferred to V2.

### 2.7 Activation Lifecycle

**Decision**: `activate(appId)` is idempotent. It reads the App's subscriptions,
creates scheduler jobs (for schedule-type) and event-bus subscriptions (for other
types), and registers a keep-alive reason.

`deactivate(appId)` removes all scheduler jobs and event-bus subscriptions for
the App and unregisters the keep-alive reason.

**State tracking**: An internal `Map<appId, ActivationState>` tracks the
scheduler job IDs, event-bus unsubscribe functions, and keep-alive disposer for
each activated App.

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
│   ├── identity.ts         — buildIdentityFragments() — base + spec + memory + config
│   └── entry-native.ts     — NATIVE_CHAT_ENTRY — native UI fallback
└── im-channels/
    └── im-prompt.ts        — buildImEntry / buildImConstraints / ImSessionContext
```

**Layer responsibilities**:

| Layer | Answers | Examples |
|---|---|---|
| Identity | Who am I, what do I do | Base Agent prompt, App spec, memory access, user config |
| Entry | Where am I, how do I reply | IM group/direct session context, native UI notification tools |
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
  notify-tool.ts             -- halo-notify SDK MCP tool (notify_channel + notify_bot)
  concurrency.ts              -- Counting semaphore
  execute.ts                 -- executeRun() core logic for automation runs
  service.ts                 -- AppRuntimeService implementation
  index.ts                   -- initAppRuntime(), shutdownAppRuntime(), re-exports

  -- Interactive chat with an App (separate from automation runs):
  app-chat.ts                -- sendAppChatMessage() and chat session lifecycle
  config-defaults.ts         -- Merge App config_schema defaults into userConfig
  dispatch-inbound.ts        -- Route IM inbound messages into app-chat
  im-permission-registry.ts  -- Per-conversation owner/guest context for SDK gating
  im-session-registry.ts     -- Persistent IM session list (per app + channel + chatId)
  progress-formatter.ts      -- Format streaming progress events for IM transports
  session-store.ts           -- JSONL persistence for chat history + SDK session IDs
  file-export-gate.ts        -- Filesystem boundary for AI-attached file delivery

  -- App chat system prompt (Identity / Entry / Constraint layers) — see §2.12:
  prompt/
    assembler.ts             -- assembleAppChatPrompt() — channel-agnostic joiner
    identity.ts              -- buildIdentityFragments() — identity layer
    entry-native.ts          -- NATIVE_CHAT_ENTRY — native UI entry fragment

  -- IM channel providers and IM-specific prompt content:
  im-channels/
    index.ts                 -- ImChannelManager + provider registration
    manager.ts               -- Generic channel lifecycle (provider-agnostic)
    im-prompt.ts             -- IM entry/constraint builders + ImSessionContext
    file-send-mcp.ts         -- send_file_to_chat MCP tool (pre-bound to session)
    *.provider.ts            -- Brand-specific provider implementations
                                (wecom-bot.provider.ts, weixin-ilink.provider.ts, ...)
```

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
  triggerManually(appId: string): Promise<AppRunResult>
  getAppState(appId: string): AutomationAppState
  respondToEscalation(appId: string, entryId: string, response: EscalationResponse): Promise<void>
  getActivityEntries(appId: string, options?: ActivityQueryOptions): ActivityEntry[]
  getRun(runId: string): AutomationRun | null
  getRunsForApp(appId: string, limit?: number): AutomationRun[]
  activateAll(): Promise<void>
  deactivateAll(): Promise<void>
}
```
