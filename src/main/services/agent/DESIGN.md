# services/agent — Agent Engine

> The largest single subsystem in the main process. Wraps a Claude Code-compatible SDK protocol into a session-oriented, stream-driven, MCP-aware engine that drives every conversation in Halo. Claude Code remains the canonical/default protocol; alternate engines must adapt to that protocol instead of changing the main flow.
>
> Read this file before touching anything under `src/main/services/agent/`.

## 1) Core Responsibilities

| Responsibility | Primary file(s) | Notes |
|---|---|---|
| Session lifecycle (create / reuse / destroy / batch-invalidate on config change) | `session-manager.ts` | Largest file. V2 Session model. Registers callback on `config.service.ts` to auto-clean when API config changes. |
| SDK stream → Thought[] translation | `stream-processor.ts` | Second largest. Incremental push, partial tool calls, interruption recovery. |
| SDK invocation & configuration | `sdk-config.ts`, `resolved-sdk.ts`, `codex/`, `dsh/` | Provider selection, model resolution, SDK option assembly through two named entries (`buildUserSessionSdkOptions`, `buildInternalTaskSdkOptions`; see §11). Alternate SDK engines are loaded only through `resolved-sdk.ts`; engine-specific translation is isolated under `codex/` and `dsh/`. |
| User AI settings | `user-agent-settings.ts` | The one reader of the user's global AI settings for a session (`maxTurns`, `disabledTools`, `promptProfile`, digital-humans switch). Entries never pass them. See §11. |
| Thinking depth → engine options | `reasoning-effort.ts` | Combines a picked level (conversation / digital human / API send), the per-request thinking flag and the per-model effort level into `effort` / `maxThinkingTokens` / Codex `model_reasoning_effort` / the router's picked level. Every SDK call site goes through `applyReasoningEffort`. See §9. |
| Engine availability probe | `engine-availability.ts` | Detects which engine runtimes shipped in this build (manifest + entry file, platform binary for Codex, interpreter version for dsh) so `resolved-sdk.ts` can fall back instead of crashing at startup. Probed per engine on first demand and cached per process: startup asks only for the configured engine plus `FALLBACK_ORDER`, Settings asks for all of them (`agent:get-engine-availability`). |
| System prompt composition | `system-prompt.ts` | Space context, conversation context, tool availability injection. `buildKnowledgeSection` is exported separately for creation-time append. On the `halo` engine the Claude Code-derived template is not used: `buildSystemPrompt` yields only Halo's product context, and every site that sets `sdkOptions.systemPrompt` wraps it with `toEngineSystemPrompt` into the engine's `{ preset: 'default', append }`. Code that later extends or reads the prompt goes through `appendToSystemPrompt` / `hostSystemPromptText`, never assumes a string. |
| Knowledge context resolution | `knowledge-context.ts` | Conversation `knowledgeBaseIds` → injectable `KBReference[]` (agent→tlon dependency collector). Cheap id-only variant feeds the session knowledge fingerprint. |
| Space memory | `space-memory.ts` | Space chat's shared memory (platform/memory, scope `space`, per-space settings): the shared compact format, recording policy, file paths and conversation author tag appended to the Halo system prompt, plus the write guard at session setup, the bounded memory block on a new conversation's first message. Whether memory was on is passed as `SessionGates.creationContext`, so a session warmed before the setting flipped is rebuilt. Every concern that watches tool calls adds its hooks with `addSdkHooks` (sdk-config) — never by assigning `hooks`. Consolidation is not here — `services/memory-consolidation` listens for turn ends. |
| Subagent orchestration | `subagent-handler.ts` | Nested agent invocations — Halo supports agents spawning agents. |
| Permission gating | `permission-handler.ts` | AskUserQuestion, and the optional `ToolGate` a caller supplies for calls the engine left undecided. Knows nothing about what a policy says — only whom to ask. |
| MCP server routing | `mcp-manager.ts` | Registration, discovery, per-session MCP bindings. Owns the shared status cache (`agent:mcp-status` broadcast). |
| MCP connection probe | `mcp-probe.ts` | Native initialize+tools/list handshake via `@modelcontextprotocol/sdk` — no agent session, no token cost. Classifies failures (401→needs-auth, refused/timeout→failed + `errorDetail`). Triggered by app lifecycle events (install/resume/spec-update, wired in `apps/runtime`), by SDK-reported `failed`/`needs-auth` (stream-processor follow-up), and manually via `agent:probe-mcp` IPC. A probe that connects also clears the server's CC auth record. |
| CC MCP auth state | `mcp-auth-state.ts` | Removes stale OAuth records CC persists under `CLAUDE_CONFIG_DIR` after any 4xx from a URL-based MCP server. Such a record has no expiry and makes CC skip the server entirely, so it is cleared before session creation and after a successful probe. Mirrors CC-internal formats; a mismatch degrades to a no-op. |
| MCP for out-of-process engines | `mcp/` | Engine-neutral. `partition.ts` splits `mcpServers` into in-process instances and external records, normalizing the latter; `sdk-bridge.ts` publishes the in-process ones on loopback so a child can dial them. Each engine keeps only a renderer from the normalized shape into its own dialect — `codex/mcp-config.ts`, `dsh/runtime/mcp-plugins.ts`. Do NOT add a second bridge. |
| Skill locations | `skills.ts` | The two roots `apps/manager/skill-sync.ts` writes to. The default engine finds them through SDK discovery; a child process has to be told where they are. |
| External message injection | `inject-message.ts` | Entry point for IM inbound / programmatic triggers to push messages into a session. |
| Session control | `control.ts` | Interrupt / pause / switch-model mid-session. |
| Conversation goal | `goal/` | Reads/sets the engine session's goal on the user's behalf (engines with `features.goal`; halo only). The engine owns and persists it; `goal/index.ts` routes to the live session (starting it like a conversation switch), `goal/draft.ts` holds the goal of a conversation with no recorded engine session id and `session-manager` seeds it into each fresh session (`goal` option). Model-side changes arrive as `system`/`goal_updated` frames, forwarded by `stream-processor` as `agent:goal-updated`. `agent:goal-set` starts no turn; a `goal` on the send request (space chat only) is set on the session right before that message is sent. |
| Outbound message composition | `send-message.ts`, `message-utils.ts` | User message assembly, attachment handling, token counting. |
| References and built-in tasks | `references.ts`, `prompt-text.ts` | A user message's `metadata.references` (places the user pointed at) and `metadata.task` (a code review started from the changes view) stay records in the transcript; the model reads them as the `<halo_references>` / `<halo_task>` blocks built here, between the canvas context and the image fallback. Every entry builds them through `formatTurnAttachments` / `formatReferencesBlock` (space chat, injection, digital-human chat and injection, run follow-ups), so a reference reads the same everywhere; a person's message to a team member crosses the team bus as text, so its block is written after the words before it leaves (`controllers/team-member-message.controller.ts`). A task's instructions are its owner's (`services/code-review` writes a review's and passes them as `AgentRequest.taskInstructions`, in-process only); the engine only frames them and knows nothing about what they ask. Text that is not the user's own (file names, terminal and conversation titles) passes `prompt-text.ts`, exported for those owners too, so it cannot end its line or block. No transport carries a task. |
| Non-vision image fallback | `image-attachments.ts` | For models without vision: persists pasted images into the space's `attachments/` dir (content-addressed, mirrors the conversation-dir layout) and replaces the outbound image blocks with a `<halo_attachments>` path block for the `ocr_image` tool. Vision models bypass it entirely. Broker-free by design — ensuring ocr_image is present is the caller's concern: `send-message.ts` auto-opens the OCR toolset (opener `system`, before session creation so the rebuild seeds the same turn); app chat (`apps/runtime/app-chat.ts`) seeds the OCR MCP server unconditionally. |
| Session consumption loop | `session-consumer.ts` | Persistent per-session loop over SDK turns; dispatches into stream-processor. Surface-agnostic — see §3.1. |
| Model-request retries | `api-retry.ts` | Parses the engine's `system`/`api_retry` frame (same shape on Claude Code and the Halo SDK) into `shared/types/api-retry`, keeps the one pending retry on `SessionState.apiRetry`, and emits `agent:api-retry` (payload `retry`, `null` once a resent request answers or the turn ends). `stream-processor` drives it and voids the open blocks of an attempt the engine abandoned; `control.getSessionState` returns the pending retry with its remaining wait so a client arriving mid-wait shows the countdown. Never persisted. |
| Turn destination | `turn-sink.ts`, `conversation-sink.ts` | `TurnSink` is where a consumed turn goes (persistence + delivery). `conversation-sink.ts` is the space-chat implementation; `apps/runtime/app-chat-sink.ts` is the digital-human one. |
| Top-level orchestration | `agents.ts`, `index.ts` | Public surface; wires everything together. |
| Constants & shared types | `constants.ts`, `types.ts`, `events.ts`, `helpers.ts` | — |

## 2) Single Source of Truth Contract

- **Session state (thoughts, tool calls, token usage) is authoritative in the main process.** The renderer consumes events and must not persist agent state independently.
- **API config changes rebuild only affected sources.** `config.service.ts` exposes `onApiConfigChange(callback)` with an optional `{ sourceIds, selectionChanged }` payload. V2 source configuration, account-routing and capability changes advance only those sources' versions; the global epoch advances only for legacy `api` changes (an undefined callback payload invalidates all sessions). Sessions carry the non-secret `sourceId`, resolved from `HALO_AI_SOURCE_ID` or their encoded backend descriptor. Changing one account never invalidates another account's sessions. An OAuth token rotation (refresh, same-account reauthentication) changes no version at all: the router swaps each request's credential for the account's current one (`openai-compat-router` `setRequestCredentialResolver`, implemented by `AISourceManager.resolveRequestCredentials`), so neither the source signature nor `computeCredentialsFingerprint` includes a sourced account's token or credential headers. Rebuilds destroy and recreate sessions at safe boundaries; session options are never mutated in place.
- **Model selection is per-conversation.** A conversation pins its own `{ modelSourceId, modelId }`, stamped at creation from the active global selection and resolved at send/warm time by `helpers.ts getApiCredentialsForConversation`. Only conversations with no source pin use the global selection. A missing, unconfigured or unauthenticated explicit source fails rather than substituting another account. Credential resolution captures a source id before refreshing OAuth, then re-reads that same source through the manager's public `getSourceConfig`; a concurrent change to `currentId` cannot redirect the request. A pin change is detected by the per-conversation `credentialsFingerprint` and rebuilds that conversation's session. The desktop `ModelSelector` also updates the global selection — the last-used seed for new conversations and non-chat surfaces (apps use their own `userOverrides`). A selection-only change invalidates only legacy sessions without a source marker; managed unpinned sends re-resolve the selection and reconcile through their fingerprint. Concurrent creation never shares a different source's session, and a source switch while busy refuses (`SessionOptionsStaleError`, reason `source-switch`) rather than running on the previous account.
- **Session identity & rebuild triggers.** A conversation's live session is keyed by `conversationId` and rebuilt when its captured `credentialsGeneration` (global legacy epoch plus source id and source epoch), `credentialsFingerprint` (model/env, account identity headers — plus the key and credential headers only for descriptors without a source — profile ARN and selected-model Codex capabilities), `knowledgeFingerprint` (the RESOLVED knowledge-base set + workDir), or eager `inputsFingerprint` differs. Generations travel with the credential snapshot through asynchronous SDK preparation and are captured before asynchronous creation work for legacy callers, never after it, so a racing config change cannot bless stale credentials. Source epoch storage is bounded by configured sources; deletion removes an epoch and re-adding the id receives a fresh epoch. Volatile request ids and catalog fetch timestamps do not churn fingerprints. Knowledge ids are computed cheaply per send via `knowledge-context.ts resolveConversationKnowledgeBaseIds`; resolved-not-declared so a KB whose indexing finishes after creation triggers a rebuild, and workDir so KB-chat vs normal turns never share a mis-rooted session. Rebuild requests converge on `pendingConsumerRebuilds` and are applied at safe points only: turn end (consumer), idle reuse (`hasConsumablePendingRebuild`), or immediately when safely idle. Busy windows that defer a rebuild: a caller-held session lease, an active turn, running background tasks or team agents, in-flight creation, and a dispatched-but-unacknowledged turn (`turnsAwaitingInit`, cleared at `system:init`). Sending entries use `acquireV2Session`: the manager establishes its lease before resolving the acquisition, including callers sharing a warm-up's creation. The lease protects asynchronous thinking/memory preparation and SDK send acceptance. Both chat entries await `lease.send()`: dispatch marks awaiting-init before sending, retains the lease until the SDK's synchronous or asynchronous send settles, and closes only the owned instance on rejection before releasing in `finally`. Successful dispatch transfers protection to awaiting-init/the consumer; abandoned preparation releases in `finally`. Lease cleanup is instance-owned and never closes a successor under the same conversation id. Dispatch failure reporting runs through the lease's synchronous `onFailure` callback while that instance is still current, before cleanup; obsolete rejections still reach their original caller but cannot publish events or mutate conversation state. Preparation errors check `lease.isCurrent` before reporting. Neither check depends on a reservation surviving successful dispatch. Headless follow-ups retain the lease for their whole active execution and close it in `finally`; warm-up uses the unleased `getOrCreateV2Session`.
- **Creation-time assembly is deferred and owned by the creation path.** `getOrCreateV2Session` deduplicates concurrent calls per conversation (in-flight promise map — a warm-up racing a send must never spawn two CC processes). Expensive/stateful inputs are passed as thunks and materialized only when a session is actually created, after any cleanup of the previous one: `buildMcpServers` (in-process MCP instances bind to exactly one session transport; a pre-built record could carry instances still bound to a torn-down session, whose connect failure the SDK swallows — tools silently vanish) and `resolveKnowledgeBases` (index.md reads + `# Knowledge` prompt section; deferred for cost — a reused session throws the resolution away).

- **Engine credentials are a captured snapshot.** `resolveCredentialsForSdk` retains the selected `ApiCredentials` with its source generation; both SDK option builders pass that snapshot as `apiCredentials`. Codex and dsh read it through `getSdkApiCredentials`, never resolve the global source again. API validation and MCP connection tests construct options directly and attach their own captured credentials too. Standalone options can supply an encoded backend or direct Anthropic env without a stored source. Missing or delegated credentials are refused by these adapters, not replaced with another account.

- **SDK protocol boundary.** `@anthropic-ai/claude-agent-sdk` is the default engine and defines Halo's internal stream/session protocol. `@hello-halo/agent-sdk`, `@openai/codex-sdk`, `@deepseek-ai/dsh`, and future engines must expose the same `tool` / `createSdkMcpServer` / `createSession` / `query` surface through `resolved-sdk.ts`. Native engine events must be normalized before they reach `session-consumer.ts` or `stream-processor.ts`.

  | Engine (`config.agent.sdkEngine`) | Runtime | Adapter |
  |---|---|---|
  | `anthropic` (default) | `@anthropic-ai/claude-agent-sdk` in-process | — (canonical protocol) |
  | `halo` | `@hello-halo/agent-sdk` in-process | — (same protocol surface) |
  | `codex` | `codex app-server` child process (binary from `@openai/codex`) | `codex/` |
  | `dsh` | prebuilt single-file runtime, child process, stdio JSON-RPC | `dsh/` |

  A configured engine whose runtime did not ship degrades to the first available entry of `FALLBACK_ORDER` rather than aborting startup. `dsh` is deliberately absent from that order: it is opt-in and most builds do not carry it, so it is only ever loaded when named, never as someone else's fallback. Its protocol has no cancel method and never sends a request back to Halo, so interrupt is a process kill and there is no approval prompt. That missing reverse channel does NOT rule out Halo's in-process MCP tools: the bridge in `mcp/sdk-bridge.ts` inverts the direction, and the runtime's own MCP client dials in. Everything the model can do is a plugin `dsh/runtime/cordis-config.ts` composes — including the MCP client and the skill provider — so that file, not the protocol, is where a dsh capability is granted or withheld. The limits that remain are declared in `dsh/capabilities.ts` and surfaced in Settings.

  **dsh is the one engine Halo compiles itself, and it lives outside the app's dependency graph.** Upstream publishes it as ~400 npm packages; they are declared in `runtimes/dsh/package.json` (own lockfile, same shape as `runtimes/office/`), never in the app's `package.json`, and `runtimes/dsh/build.mjs` bundles them into `resources/dsh-runtime/`, registering each cordis plugin as a loader builtin so nothing resolves from disk. Everything the bundle cannot inline — node-pty, koffi, ripgrep, sharp, @xterm/headless — is planted beside it as a private copy with per-platform native companions (`runtimes/dsh/manifest.cjs`), and `afterPack.cjs` keeps the target's alone; the runtime never resolves an app package. Two consequences bind the code: `cordis-config.ts` must name plugins `cordis:<id>` rather than by package, and every plugin it can mount must be listed in the manifest (`tests/unit/services/agent/dsh/runtime-manifest.test.ts` enforces both). Because Halo compiles the bundle, it can also add its own plugins (`HALO_PLUGINS`, sources under `runtimes/dsh/plugins/`, run inside the child only): `assistant-stream.ts` relays the live token stream, which the SDK protocol does not carry since session format V3. The runtime needs Node >= 22.19; an Electron whose bundled Node is older falls back to a `node` on PATH (or `HALO_DSH_NODE`), and without one Settings shows the engine as unavailable. Upgrading dsh = bump the pins in `runtimes/dsh/`, rebuild, re-record `dsh/__fixtures__/runtime-notifications.jsonl` with `DSH_E2E=1 DSH_E2E_CAPTURE=1` (`tests/unit/services/agent/dsh/runtime-e2e.test.ts`), and re-read the composition against upstream's `sdk-minimal` bundle.

  **Experimental engines are attachments, not main line.** The main line (CC, the halo engine) must build, start and run identically whether an experimental engine (today dsh) builds, ships, fails or is deleted. Four rules keep that true, and a new experimental engine follows the same ones:
  1. *Single entry.* Outside its adapter directory the engine is reached only at its registration points — `capabilities.ts` (descriptor), `resolved-sdk.ts` (loader) and `engine-availability.ts` (probe) — and the last two load it with a dynamic `import()`. Any other need goes through the capability descriptor or the engine interface, never an import of `<engine>/**`. For dsh this is enforced by `tests/unit/services/agent/dsh/boundary.test.ts`.
  2. *Opt-in cost.* Nothing it does runs unless it is selected or Settings lists it: it is absent from `FALLBACK_ORDER`, and startup does not probe it.
  3. *Optional build.* Its build is not on the path of `npm run dev`, and the app build runs it with `--optional`: a failure removes its output and the artifact ships without it (Settings shows it unavailable). `afterPack.cjs` and `tests/check/binaries.mjs` treat its absence as normal.
  4. *Removable.* Its footprint outside its own directories is listed below and kept current, so removing it is a checklist, not an investigation.

  dsh footprint. Owned (delete wholesale): `services/agent/dsh/`, `runtimes/dsh/`, `tests/unit/services/agent/dsh/`, `resources/dsh-runtime/` (build output). Registrations (remove the dsh entry): `EngineId` and `defaultCapabilitiesFor` in `capabilities.ts`; `ENGINE_LABELS`, `normalizeEngineId`, `loadEngine` in `resolved-sdk.ts`; `ALL_ENGINE_IDS` and `probeDsh` in `engine-availability.ts`; the `sdkEngine` / `engineId` unions in `foundation/config.service.ts`, `services/conversation.service.ts`, `renderer/types/index.ts`; `AdvancedSection.tsx` (`ENGINE_IDS`, `ENGINE_COPY`) and `EngineBadge.tsx`; build glue in `package.json` (`runtime:dsh`, `prebuild`), `electron-builder.cjs` (asarUnpack), `scripts/afterPack.cjs` (dsh private externals, node-pty prune, bundle check), `scripts/engine-runtimes.cjs`, `scripts/typecheck-changed.mjs` + `tsconfig.node.json` (`runtimes/*/plugins`, drop only if no runtime has plugins left), `.gitignore`, `runtimes/README.md`. Keep on removal — shared with other engines: `mcp/` (Codex uses it), `skills.ts`, `clampModelRuntimeLimits`; `prompt.nativeAgentGuidance` + `buildEngineNeutralTemplate` in `system-prompt.ts` have no other user and may go too.

  Codex predates these rules and is shipped, so it is a known exception rather than a model: `ipc/agent.ts` imports `./codex` statically (pending-question routing), `openai-compat-router/` carries its Responses handler and model table, and `shared/constants/codex-models.ts` holds engine constants. Bring it under the same rules as a separate change; do not copy its pattern.

  **A dsh session lives exactly as long as its runtime process.** The SDK protocol can create a session but never resume one, so Halo composes no session persistence: a persisted log could never be read back, and a second process meeting the same id would refuse it as already existing. A replayed conversation id therefore starts an empty runtime session — `sessionResume: false` — while Halo keeps the transcript. The runtime's home (`DSH_HOME`: credential store, anonymous id, upload index) is Halo's data directory, never the user's `~/.dsh`.

  **Whether an engine's MCP tools exist when its runtime first answers depends on how the servers were handed over.** Codex passes them as `thread/start` parameters, so the request it already awaits does not return until they are connected. dsh loads them out of band — its cordis plugin loader is still activating while `initialize` is being answered — so a session handed out at that moment accepts a prompt the model answers without them. `SdkMcpBridge.whenDialled()` closes that specific gap and only `dsh/session-adapter.ts` awaits it; do not read it as a rule every adapter owes. A future engine needs it only if its runtime reports ready before its MCP client has dialled. Servers an engine connects to directly are outside the signal either way.

  Per-turn output contract (REQUIRED of every engine adapter, not just Claude). Adapters that emit only token-level `stream_event` frames silently break consumers that key off top-level envelopes (apps/runtime `execute.ts`, app-chat `lastAssistantText`, session-store JSONL replay):

  | Frame | When | Carries |
  |---|---|---|
  | `system.init` | Once at turn start | session_id, model, tools, mcp_servers |
  | `stream_event` (message_start / content_block_* / message_delta / message_stop) | Token-level | UI streaming deltas; `message_start.message.id` + `message_delta.usage` are also the per-call token accounting an adapter MUST carry when its provider reports usage only at stream end (see `context-usage.ts extractStreamDeltaUsage`) |
  | `assistant` (aggregate) | At each block boundary | One content block in final form. **For `tool_use` blocks this MUST precede the corresponding `user.tool_result`** so id-based linking works during JSONL replay. |
  | `user` (tool_result) | When a tool item completes | `tool_use_id`, content, is_error |
  | `result` | Once at turn end | stop_reason, cumulative usage |

  Adding a new engine = implement an adapter under `services/agent/<engine>/` that produces this exact frame sequence. Do NOT add engine-specific branches in consumers; if a consumer needs engine awareness, the adapter contract is wrong.

- **An engine whose runtime writes its own tool guidance gets Halo's layers only.** `system-prompt.ts` keeps the Claude Code templates for the `anthropic` and `codex` engines and the product-context append for the `halo` engine unchanged. An engine that declares `prompt.nativeAgentGuidance` (today only dsh, which builds one prompt section per mounted cordis plugin) gets the engine-neutral template instead — identity, behavior and environment, nothing that names a tool or a harness — because CC's layer would name tools its runtime does not register (dsh has `todo_write`, not `TodoWrite`). Session bindings no runtime can discover — knowledge bases, optional toolsets, a digital human's instructions — are appended either way. The choice is data on the capability descriptor, resolved from the active engine.
- **How big the model is, is Halo's answer.** Output cap and context window come from the resolved capabilities on the credential (preset merged with the user's per-model override in Settings), bounded by the hard limits in `shared/constants/model-runtime-limits.ts` — CC through `sdk-config.ts`, dsh through `clampModelRuntimeLimits` there, named as the `initialize` output cap plus `DSH_CONTEXT_WINDOW` (`dsh/options.ts`). An engine SDK's own model defaults must be suppressed rather than inherited: dsh shipped for a while on its SDK's DeepSeek numbers (256K output, 1M window), which only DeepSeek's endpoint accepts.
- **No engine addresses a provider itself.** An AI source is not a URL and a key — it is also custom headers, a provider adapter, a wire format and a proxy policy, and `openai-compat-router` is the only code that turns that descriptor into an HTTP request. Every engine is therefore pointed at the loopback router and handed `encodeBackendConfig(credentialsToBackendConfig(...))` as its credential: CC and Codex as `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` (`sdk-config.ts`), dsh as `DEEPSEEK_BASE_URL` + `DEEPSEEK_API_KEY` (`dsh/options.ts`), each reaching the route that matches the dialect its runtime speaks (`/v1/messages` for CC and dsh, `/v1/responses` for Codex). dsh's own transport identity (the harness `User-Agent` and `x-deepseek-harness-*` ids) is removed inside its runtime before a request reaches the router, so the router needs no dsh-specific rule. An engine given the provider's own URL loses every part of the descriptor it cannot express: dsh shipped that way and sent the DeepSeek harness's hardcoded `User-Agent` to a provider gateway that checks it, which answered `HTTP 500 request illegal` — with the source's OAuth headers, its adapter and its error body all missing from the request and from the logs. A runtime whose transport cannot be configured is exactly the case that makes this mandatory, not the exception to it.
- **BrowserWindow safety.** Always check `!mainWindow.isDestroyed()` before sending events in async callbacks. Stream processing is full of async callbacks; violations will crash on window close.

- **Resident session limit.** Every resident session is one engine process, so their count is bounded by a number the budget policy owner pushes down: `setResidentSessionLimit(limit | null)` (set by `apps/runtime/session-budget.ts`; null = unlimited). Before a NEW session is created — never on reuse — the manager evicts least-recently-used idle sessions through `cleanupSession` until one more fits; busy, awaiting-init and in-creation sessions are never evicted, and if all are busy the new session is created over the limit (one warn per crossing, never refused). An evicted conversation resumes from its stored session id on its next turn, the same path as the 30-minute idle sweep. `listResidentSessions()` / `evictIdleSession(id, reason)` expose the same stats and safety check to callers that manage transient sessions (automation runs). The engine holds no memory logic; the limit is policy from above.

## 3) Stream Processing Model

```
SDK stream event
  → session-consumer (iterator loop)
  → stream-processor (SDK event → Thought)
  → appended to session Thought[]
  → emitted to renderer via agent:thought event
  → optional: trigger permission-handler / subagent-handler / inject side-effects
```

Key invariants:
- Thoughts are **append-only** during a turn. A turn ends when SDK emits `result` or `error`.
- Tool calls go through three states: `pending` → `running` → `completed`/`failed`. Each state transition is a separate thought event.
- `requiresApproval: true` tool calls **block** the stream until permission-handler resolves.

### 3.1) One consumption model, pluggable destinations

CC is a REPL: it produces turns from any input, not just user messages — a
background task finishing or a team agent reporting yields a turn with nobody
waiting for it. The consumer therefore **never leaves the stream**: it re-enters
`stream()` immediately after each turn, so such output is read as it appears.

A surface that instead read the stream once per user message would leave that
turn queued in the pipe, and the next message would consume it as its own answer
— every later reply then lagging one turn behind, permanently. Digital-human
chat had exactly this shape before it was moved onto the consumer.

What differs per surface is not consumption but **destination**, which is the
`TurnSink` contract (`turn-sink.ts`):

```
session-consumer (one loop per V2 session, surface-agnostic)
  ├── onTurnStart      — CC acknowledged a turn (system:init)
  ├── onRawMessage     — every SDK message of the turn
  ├── onTurnComplete   — the turn's StreamResult
  ├── onTurnError      — the turn threw
  └── onConsumerStopped — no further turn will arrive

  implementations:
    conversation-sink.ts            — conversation.service + chat UI (space chat)
    apps/runtime/app-chat-sink.ts   — run JSONL + reply delivery (digital humans)
```

A sink is supplied through `getOrCreateV2Session`'s `consumer` argument; its
presence is what starts a consumer at all. Automation runs
(`apps/runtime/execute.ts`) pass none and drive their own `processStream` — a
headless batch execution has no turn gaps to lose, and two readers would fight
over one stream. Manager-owned resumed runs register an active session for the
whole execution, including auto-continue, so account invalidation cannot close a
live stream. Their `finally` releases the manager-owned session and active state;
fresh transient runs remain outside the resident-session registry.

**Consumer retirement is synchronous and instance-owned.** `processStream` supplies
one lazy snapshot reader per turn, backed by its authoritative stream state rather
than a mirrored accumulator. On retirement or a thrown stream, the consumer passes
the acknowledged turn's partial snapshot to `onConsumerStopped` or `onTurnError`
before releasing it. A completed turn clears that reader before invoking its sink,
so reentrant retirement cannot persist it twice. `stop()` settles the sink once
before the manager can publish a replacement; eventual loop exit cannot settle it again. An acknowledged turn owes one `agent:complete`, emitted during
retirement before replacement rather than on delayed stream exit, so every client
and turn-end subscriber settles. An idle consumer owes no completion. A separate
`ProcessStreamParams.sessionSignal` ends retired session consumption before any
late frame or stream-end side effects and is rechecked after caller hooks. It is
not the per-turn abort: normal interruption still drains the result and persists
the partial turn. A retired consumer never clears a successor's awaiting-init/rebuild
state, persists its result, or emits a late completion into that conversation.

**Messages before acknowledgement have instance-owned failure settlement.** Chat acquisitions register `onFailureBeforeInit` before handoff. Its pending record survives successful send acceptance until `system:init`, and is removed when unused preparation is released. Unexpected process exit, a dead transport discovered on acquisition/sweep, or a pre-init consumer failure settles those callers synchronously before replacement. Each entry persists the failed message and emits error/completion once; subsequent stale preparation or send rejection remains suppressed. Deliberate close and idle retirement do not invent failed requests. Background task IDs also block every safe-rebuild gate through the final completion turn; the existing bounded idle-timeout policy is unchanged.

**Adding a chat entry point = writing a sink.** The consumer must never learn
about a surface; a branch on conversation kind inside this loop is the smell
that the sink boundary is being bypassed.

## 4) Subagent Model

`subagent-handler.ts` manages nested agent invocations. A parent agent can spawn one or more subagents; each subagent runs in its own SDK session with:
- Inherited MCP servers (configurable)
- Scoped system prompt composed by `system-prompt.ts`
- Results folded back into the parent's thought stream as a `subagent_result` thought

Do not bypass `subagent-handler` for nested invocations — it owns the lifecycle, resource limits, and result translation.

## 5) External Injection (Mid-Turn Delivery)

Two entries push text into a session's RUNNING turn from outside the normal
user-input path. Both ride the same engine primitive — the subprocess absorbs
the text at the turn's next tool-round boundary and still ends with a single
result; no second turn starts. They differ in who owns the record of the
message:

- `inject-message.ts` (`injectMessage`) — persists to the conversation store
  (source: 'injection'), then sends. Throws when no live session exists. Backs
  the user's "type while generating"; called from `ipc/agent.ts`.
- `live-turn.ts` (`hasLiveTurn`, `sendIntoLiveTurn`) — the turn-in-flight probe
  plus the same send with NO persistence, for a caller that owns its own record
  (an app chat's JSONL transcript). Returns false instead of throwing whenever
  nothing reached the engine, so a caller holding a fallback queue can take the
  message back. Consumed by `apps/runtime/app-chat-live-turn.ts` for the team
  runtime's mid-turn delivery.

Callers wanting the ordinary "wait for the current turn, then start a new one"
behavior do not inject — they go through the normal send path and queue.

## 6) Integration Points

- **IPC / transport**: `src/main/ipc/agent.ts` (user-facing commands) and `src/main/ipc/conversation.ts` (session ↔ conversation binding).
- **Preload / renderer**: `src/preload/index.ts` `agent:*` events; `src/renderer/api/transport.ts` methodMap; `src/renderer/stores/chat.store.ts` consumes events.
- **MCP servers**: `services/email-mcp/`, `services/web-search/`, and any user-installed MCP are routed via `mcp-manager.ts`.
- **Permissions UI**: `pulse/`, `components/chat/` surface approvals raised by `permission-handler.ts`.

## 7) Editing Guidance

| If you need to... | Start here |
|---|---|
| Change how the SDK is invoked or configured | `sdk-config.ts` / `resolved-sdk.ts` |
| Add or change a user-level AI setting every session must obey | `user-agent-settings.ts` (read it in the layer that consumes it, never thread it through entries) — see §11 |
| Add a server every user-facing session should have | `toolsets/base.ts` — see §11 |
| Change what identity the host puts on outgoing requests | `request-identity-factory.ts` (see §10) |
| Change how hard a model thinks | `reasoning-effort.ts` (never set `effort` / `maxThinkingTokens` at a call site) |
| Add an engine, or change engine selection / fallback | `capabilities.ts` (`EngineId`), `resolved-sdk.ts` (loader, `ENGINE_LABELS`, `FALLBACK_ORDER`), `engine-availability.ts`, `scripts/engine-runtimes.cjs` |
| Change what an engine claims it can do | `<engine>/capabilities.ts` — never by sniffing tool names or engine ids in consumers |
| Tell an out-of-process engine how large the active model is | `shared/constants/model-runtime-limits.ts` (`clampModelRuntimeLimits`), then name the result in that engine's options module — never an engine-local default |
| Change which prompt template an engine with its own tool guidance gets | `system-prompt.ts` (`buildEngineNeutralTemplate`) + `prompt.nativeAgentGuidance` on the engine's `capabilities.ts` |
| Change how SDK events become thoughts | `stream-processor.ts` |
| Change session lifecycle or invalidation rules | `session-manager.ts` |
| Add a new field to the system prompt | `system-prompt.ts` |
| Add a new tool-approval flow | `permission-handler.ts` |
| Let a non-user trigger push a message | `inject-message.ts` (do NOT invent a new injection path) |
| Interrupt / pause / switch mid-turn | `control.ts` |
| Change subagent behavior | `subagent-handler.ts` |
| Register a new MCP server source | `mcp-manager.ts` |
| Give a new out-of-process engine MCP or skills | `mcp/partition.ts` + `mcp/sdk-bridge.ts` (reuse as-is) and `skills.ts`; write only the engine's own config renderer |
| Change MCP connectivity checks / failure classification | `mcp-probe.ts` |
| Touch CC's credential store / MCP auth records | `mcp-auth-state.ts` (never inline elsewhere) |
| Change how an engine resolves a file tool's path argument (`~`, env vars, drive letters) or prints search results | also `foundation/path-containment.ts` `resolveToolPath` and `apps/runtime/turn-file-access.ts` `filterSearchOutput`, which mirror it for file boundaries |

## 8) Hard Rules

1. **No state duplication in renderer.** Renderer stores mirror authoritative main-process state via events only.
2. **Never re-implement injection paths.** All external triggers go through `inject-message.ts`.
3. **Never bypass `stream-processor`** when translating SDK events — subagent-handler and permission-handler compose with it, not around it.
4. **Do not weaken the config-change invalidation contract.** Partial in-place session updates are forbidden; batch destroy + recreate is the only supported path.
5. **Mirrors of CC-internal formats stay in one module and fail closed.** `mcp-auth-state.ts` reproduces CC's entry-key derivation and keychain naming; a CC upgrade that changes either must make the lookup miss, never make it match the wrong record. Revalidate when bumping `@anthropic-ai/claude-agent-sdk`.
6. **Guard every `mainWindow` access** in async callbacks with `!mainWindow.isDestroyed()`.
7. **Every engine clamps the effort ladder to its own enum.** See §9.
8. **An option a caller relies on as a restriction must be honoured or refused, never ignored.**
   `features.permissionRules` states whether an engine enforces `allowedTools` /
   `disallowedTools` / `canUseTool` at all (Codex does not: `thread/start` takes
   no tool lists and routes no call through the gate). A caller restricting a
   turn on someone else's behalf must check it and refuse — a restriction the
   engine accepts and ignores reads as protection while the request runs with
   everything. Adding an engine means answering this flag honestly.
9. **Session reuse must not outlive the options a caller depends on.**
   `computeSessionInputsFingerprint` covers `allowedTools` as well as
   `disallowedTools` / `permissionMode` / the skip-permissions flag, because the
   auto-allow rules decide which calls the engine settles by itself. Reuse
   normally DEFERS a rebuild while the session is busy and returns the existing
   session — correct for a model or knowledge change, wrong when the options are
   a restriction. `SessionGates.requireFreshInputs` makes that case throw
   (`SessionOptionsStaleError`) instead — only when the inputs fingerprint itself
   differs; a credential or model change on the same source still defers: the
   request is reported as not started rather than run with the previous caller's
   permissions. The gate also covers
   the in-flight sharing point: a concurrent creation is shared with a gated
   caller only when its inputs fingerprint matches; otherwise the caller waits
   the creation out and re-evaluates against the finished session, where the
   same stale check applies.
10. **Bash rule matching is the engine's semantics, never re-derived in Halo.**
    A `Bash(...)` whitelist rule handed over via `allowedTools` is evaluated
    entirely inside the Claude Code engine, which splits a compound command
    (`&&`, `;`, `|`, `$()`, backticks, newlines, wrappers like `bash -c`) on
    every shell separator and requires each part to match a rule on its own.
    This is an EXTERNAL assumption: the matcher lives in the bundled CLI
    (currently `@anthropic-ai/claude-agent-sdk` 0.2.89) and cannot be unit
    tested offline from this repo. Halo deliberately runs no pattern test of
    its own — a second matcher would drift from the engine's and clear what it
    refused. The dependence is fail-closed by construction: any call the
    engine's rules do not auto-allow reaches the per-call gate
    (`apps/runtime/delegation-gate.ts`), which under a whitelist refuses
    unconditionally. An engine build that stopped splitting compound commands
    would therefore degrade the whitelist to whole-string matching — narrower
    than intended, never wider, never full access. Revalidate the splitting
    behavior when bumping the SDK (same ritual as hard rule 5).

## 9) Reasoning Effort

Two inputs decide how hard a model thinks, and they are orthogonal:

- **Whether** — `thinkingEnabled`, per request. The composer always sends
  true (its slider's `'off'` is a picked level instead); IM and automation
  runs always think; only an HTTP caller can send false.
- **How hard** — `reasoningEffort` on the model's user override
  (Settings > Provider > Model Config), per model.

The composer's thinking slider adds a picked level that wins over both, `'off'`
included: a space conversation's own `reasoningEffort` (on the conversation,
like its model pin), a digital human's `userOverrides.chatReasoningEffort` (one
level for all its chat sessions, applied only to sends from the chat surfaces —
IM, team and federation dispatch and automation runs keep the configured
effort), else a level an HTTP caller put on the send. `pickReasoningEffort`
takes the first ladder level in that order, so a bad stored value falls
through; both stored fields are also validated where they are written. The
renderer's last-used level only seeds a new conversation — passed to
`createConversation`, so the warm-up that follows spawns at it — and never
rides on a send, so a conversation without its own level runs at the model
config.

`reasoning-effort.ts` is the only place they combine. Call sites pass them to
`applyReasoningEffort(sdkOptions, thinkingEnabled, capabilities, requestedEffort)`
and never set a thinking option themselves; it writes the names the downstream
consumers read:

| Option | Read by | Ladder |
|---|---|---|
| `effort` | Claude Agent SDK (`--effort`) | `low` `medium` `high` `max` |
| `maxThinkingTokens` | Claude Agent SDK (`--max-thinking-tokens`) | token budget |
| `reasoningEffort` | `codex/options.ts` → `model_reasoning_effort` | `minimal` `low` `medium` `high` `xhigh` |
| `pickedReasoningEffort` | `codex/options.ts` → router key | the picked level alone |

Neither engine carries a picked level to the wire on its own. Codex's effort
reaches the router only as "thinking on". Claude Code's V2 session drops
`--effort`, and it decides a request's thinking shape from a model list frozen
at its release, so a Claude model newer than that list gets a legacy
`budget_tokens` block and no effort at all. Every Claude Code engine request is
routed through the local router (`PROXY_ANTHROPIC`, delegated auth, and the
OpenAI-compat providers alike), so the router is where the level is applied.
The pick travels in the router key (`BackendRequestConfig.pickedReasoningEffort`)
next to the Model Config value. The Claude path encodes the key before SDK
options exist, so each call site computes the pick once and hands the same
value to both `resolveCredentialsForSdk` and `applyReasoningEffort`; Codex
encodes its key from `sdkOptions.pickedReasoningEffort`.

The router reads both wires from one table,
`shared/constants/reasoning-effort-profiles.ts`. Its default is to forward a
picked level as is — upstreams that serve Claude Code or Codex already map
that ladder — and an entry exists only for a model where forwarding is known
to fail or do nothing: levels it rejects, an off switch it lacks (off then runs
at its lowest level), or an off switch in another field (`thinking.type` for
DeepSeek and GLM, `between_tools` for Sonnet 5.5). Precedence on both wires:
the pick, then the Model Config value verbatim, then a level inferred from the
request (held to `low`..`high` where the model has no profile ladder).

- OpenAI wire — `converters/reasoning-effort.ts` (`resolveReasoning`) yields
  `reasoning_effort` / `reasoning.effort` and, for a toggle model switched off,
  `thinking: {type: 'disabled'}`. The ChatGPT Codex adapter then holds the
  effort to the levels the account's model catalog lists
  (`supported_reasoning_levels`), else to the Codex CLI enum.
- Anthropic wire — `utils/normalize-anthropic-reasoning.ts` reshapes
  passthrough requests that carry a thinking block (Claude Code's auxiliary
  calls carry none and are left alone): an adaptive Claude model gets `thinking: {type: 'adaptive',
  display: 'summarized'}` plus `output_config.effort`; a budget model keeps the
  engine-sized budget. With no pick and no Model Config value it only repairs a
  block the model would reject (a legacy budget on an adaptive model becomes
  adaptive at the level the budget encodes).

Depth is frozen when the engine spawns: `--effort` is a launch argument and
Codex reads `model_reasoning_effort` at thread start, while the SDK's only
runtime setter is `setMaxThinkingTokens`. The resolved level
(`sdkOptions.reasoningEffort`) and the pick (`sdkOptions.pickedReasoningEffort`)
are therefore part of `computeCredentialsFingerprint`: a changed level rebuilds the session like a
changed model, and the renderer re-warms right after saving a conversation's
level so the rebuild happens off the send path. `ensureSessionWarm` applies the
conversation's own level through `applySessionReasoningEffort` — it must
resolve the same level the first send will, or the warmed session is rebuilt
on that send; and a session warmed without a level can never acquire one.

Switching thinking off is enforced by the router, not the engine: with no
`thinking` option set, a model whose default is adaptive keeps reasoning, and
`setMaxThinkingTokens(null)` clears the limit rather than stopping it. A picked
`'off'` reaches the router in the key, which sends each model the off switch
its profile names. An HTTP send with `thinkingEnabled: false` and no picked
level still only lowers the budget.

The two engine ladders overlap but neither contains the other, so a level is
clamped per engine rather than forwarded. These values configure a local
process, where an out-of-enum value fails as an opaque startup error rather
than a reportable API error — nothing unrecognized is passed through. The
router is the exception and forwards levels, because there the upstream
returns an error the user can act on.

`reasoningEffort` exists only on `ModelCapabilityOverride`, never on a preset:
a value there is always something the user typed, which is what makes
forwarding an unrecognized one safe. A change to it is part of the aiSources
signature (`config.service.ts`), so it invalidates sessions like any other
credential change — the toggle does not, since it is not config.

## 10) Request Identity (halo engine only)

When the active engine is `halo`, the SDK option builders (`sdk-config.ts`) attach a
`requestIdentity` to the SDK options. The SDK is identity-agnostic — it has a
`RequestIdentity` seam and forwards whatever it is handed; every
provider-specific constant and algorithm lives host-side in
`request-identity-factory.ts` — except the reported Claude Code version, its
user-agent and its attribution line, which live in
`openai-compat-router/utils/claude-code-identity.ts` (read through the
router's index). The router applies the same
fixed version to every request it forwards on its Anthropic passthrough path,
in both the header and the system prompt.

What the factory produces, per request:

| Field | Effect |
|---|---|
| `headers` | Client identity (`user-agent`, `x-app`, `x-stainless-*`), plus `x-claude-code-session-id` when a session id is supplied |
| `headersForAttempt` | Retry counter |
| `systemPrefix` | A text block prepended to the system array, carrying a per-request fingerprint derived from the first user message |
| `metadata.user_id` | Device id, optionally account uuid and session id |
| `betaQueryParam` | Beta features advertised by query parameter |
| `contextManagement` | Thinking-retention policy for long sessions — see below |

**`contextManagement` is the one field with a behavior effect, not just a wire
effect.** It sends `edits: [{ type: 'clear_thinking_20251015', keep: 'all' }]`,
which sets how much prior thinking is retained as a session grows. This is a
deliberate choice, confirmed by the product owner alongside the identity work
as a whole; it is also why the field is listed here rather than left implicit —
it changes existing long sessions, so it does not belong in a commit that
claims to be identity-only.

**Gated on the engine.** The block only runs when `getActiveEngine() === 'halo'`;
the default engine is `anthropic`, so a user who never switches engines is
unaffected.

**Session id comes from the conversation.** `sdk-config.ts` passes
`conversationId` (a uuid) as `sessionId`, which is what populates both the
session header and `metadata.user_id.session_id`. Dropping it silently halves
the payload — as it did while the parameter went unpassed.

**A failure here is degraded, not fatal.** The factory is built inside a
`try/catch`: on failure the request still goes out, only without the identity
headers. The catch logs the drop with the conversation id, because a silently
unidentified session is indistinguishable from a correctly-identified one in
every downstream log.

**This is deliberate product behavior**, chosen so hallucination-prone gateway
paths see the same shape as a first-party client. It is not an accident of
bundling — it is why the SDK itself carries no provider identity. Do not
"clean it up" out of the host without a product decision.

## 11) User Settings Are Read at the Bottom; Entries Pass Nothing

Every place that starts an agent session — space chat (`send-message.ts`,
`session-manager.ts` warm-up), digital-human chat and automation
(`apps/runtime`), a team member's turn — used to receive the user's global AI
settings as parameters, and each forgot a different one. Digital humans ignored
the user's disabled tools; the prompt kept saying Halo could create digital
humans after the user switched them off.

Now the layers that assemble a session read the settings themselves, through
`user-agent-settings.ts` (`readUserAgentSettings`):

| Setting | Read by | Notes |
|---|---|---|
| `maxTurns`, `disabledTools` | `sdk-config.ts` | Engine-independent. Unset `disabledTools` means the built-in default list; the native team tools are always withheld. |
| `promptProfile`, `enableDigitalHumans` (prompt line) | `system-prompt.ts` `buildSystemPrompt` | An explicit value in the context wins over the setting. `promptProfile` only picks a template on engines that take Halo's prompt; the halo engine appends product context to its own default and ignores it. So every prompt built on `buildSystemPrompt` — digital humans' too — follows both. |
| `enableDigitalHumans` (tool) | `toolsets/base.ts` | Gates `halo-apps` in the base toolset. |
| `configDirMode`, `customConfigDir` | `sdk-config.ts` `buildSdkEnv` via `resolveClaudeConfigDir()` | Not per-entry: `CLAUDE_CONFIG_DIR` also holds the CLI credential slot, so internal tasks follow it too. |

**Two entries, not a flag.** `buildUserSessionSdkOptions` reads the settings.
`buildInternalTaskSdkOptions` deliberately does not (built-in defaults, `halo`
profile, no digital-human line): a background task the user never asked for by
name — memory consolidation, team member proposals — must not inherit the tool
restrictions or turn cap the user set for their own sessions. Which call site
uses which:

| Call site | Entry | Why |
|---|---|---|
| `send-message.ts`, `session-manager.ts` `ensureSessionWarm` | user session | Space chat. The warm-up must match the send, and now cannot differ: neither passes anything. |
| `apps/runtime/app-chat.ts` | user session | Digital-human chat, IM, team members: a session the user's digital human runs on their behalf. |
| `apps/runtime/execute.ts` | user session | Automation the user installed and configured. |
| `apps/team/service.ts` `proposeMembersViaSdk` | internal task | One-shot, tool-less helper. |
| `services/memory-consolidation/runner.ts` | internal task | Housekeeping; confined to its workspace, replaces the prompt. |

**A policy narrows, never re-opens.** `applyCapabilityPolicy`
(`apps/runtime/capability-policy.ts`) adds its withheld tools to the session's
`disallowedTools` instead of replacing them, so a tool the user disabled stays
out of an IM guest's or a borrowed teammate's turn even where the policy would
have granted it.

**Prompt follows the mounts.** An entry that never mounts `halo-apps`
(automation, a disposable team member) states `digitalHumansEnabled: false` in
its prompt context, so the prompt does not offer what the run cannot do; others
inherit the setting.

**Rationale check for digital humans.** The config directory and skills already
reached digital humans before this change (`buildSdkEnv` fell back to the
persisted `configDirMode` for every entry, and project/user setting sources were
always on). What actually changed for them: the user's `disabledTools`, prompt
profile and the digital-humans switch now apply. Release notes must not claim
digital humans newly gain the CC config directory's skills or CLAUDE.md.

A new call site decides the same question: is this the user's session, or work
the system does for itself? Do not add a setting parameter to either entry.

**Base toolset** (`toolsets/base.ts`, `buildBaseToolset`): web search, Halo
documentation (with the authoring gate `halo-apps` shares) and `halo-apps`
(while digital humans are enabled). The space chat broker, digital-human chat
and automation all start from it and remove what does not apply to them at
their own call site, with the reason. Not in the base: conversation
collaboration and everything granted per conversation or per permission.

**Entry x capability matrix**: `tests/unit/services/agent/entry-capability-matrix.test.ts`
runs the real entries and records which servers and which settings each one gets.
Adding a capability or an entry means updating that table; a server that shows up
in a row unlisted fails it.
