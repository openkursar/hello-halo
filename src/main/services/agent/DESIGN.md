# services/agent — Agent Engine

> The largest single subsystem in the main process. Wraps a Claude Code-compatible SDK protocol into a session-oriented, stream-driven, MCP-aware engine that drives every conversation in Halo. Claude Code remains the canonical/default protocol; alternate engines must adapt to that protocol instead of changing the main flow.
>
> Read this file before touching anything under `src/main/services/agent/`.

## 1) Core Responsibilities

| Responsibility | Primary file(s) | Notes |
|---|---|---|
| Session lifecycle (create / reuse / destroy / batch-invalidate on config change) | `session-manager.ts` | Largest file. V2 Session model. Registers callback on `config.service.ts` to auto-clean when API config changes. |
| SDK stream → Thought[] translation | `stream-processor.ts` | Second largest. Incremental push, partial tool calls, interruption recovery. |
| SDK invocation & configuration | `sdk-config.ts`, `resolved-sdk.ts`, `codex/`, `dsh/` | Provider selection, model resolution, SDK option assembly. Alternate SDK engines are loaded only through `resolved-sdk.ts`; engine-specific translation is isolated under `codex/` and `dsh/`. |
| Engine availability probing | `engine-availability.ts` | Filesystem-only check of whether a build ships each engine's runtime. Read by `resolved-sdk.ts` (degraded boot) and by Settings via `agent:get-engine-availability`. |
| System prompt composition | `system-prompt.ts` | Space context, conversation context, tool availability injection. |
| Subagent orchestration | `subagent-handler.ts` | Nested agent invocations — Halo supports agents spawning agents. |
| Permission gating | `permission-handler.ts` | AskUserQuestion, tool approval, permission mode resolution. |
| MCP server routing | `mcp-manager.ts` | Registration, discovery, per-session MCP bindings. |
| MCP for out-of-process engines | `mcp/` | Engine-neutral. `partition.ts` splits `mcpServers` into in-process instances and external records, normalizing the latter; `sdk-bridge.ts` publishes the in-process ones on loopback so a child can dial them. Each engine keeps only a renderer from the normalized shape into its own dialect — `codex/mcp-config.ts`, `dsh/runtime/mcp-plugins.ts`. Do NOT add a second bridge. |
| Skill locations | `skills.ts` | The two roots `apps/manager/skill-sync.ts` writes to. The default engine finds them through SDK discovery; a child process has to be told where they are. |
| External message injection | `inject-message.ts` | Entry point for IM inbound / programmatic triggers to push messages into a session. |
| Session control | `control.ts` | Interrupt / pause / switch-model mid-session. |
| Outbound message composition | `send-message.ts`, `message-utils.ts` | User message assembly, attachment handling, token counting. |
| Session consumption loop | `session-consumer.ts` | Iterator over SDK events; dispatches into stream-processor. |
| Top-level orchestration | `agents.ts`, `index.ts` | Public surface; wires everything together. |
| Constants & shared types | `constants.ts`, `types.ts`, `events.ts`, `helpers.ts` | — |

## 2) Single Source of Truth Contract

- **Session state (thoughts, tool calls, token usage) is authoritative in the main process.** The renderer consumes events and must not persist agent state independently.
- **API config changes invalidate sessions in bulk.** `config.service.ts` exposes `onApiConfigChange(callback)`. `services/agent` registers that callback at module load. On change, all V2 Sessions are destroyed; the next user message creates a fresh Session with updated config. Do not attempt to mutate live sessions.
- **A session is reused only by a caller it was built for.** `getOrCreateV2Session` keys reuse on `conversationId`, but a conversation is shared — an IM group chat routes every sender through one. Anything the SDK fixes at subprocess startup must therefore join the reuse key, or a later caller silently runs on an earlier caller's process. Today that key is `credentialsGeneration`, `SessionConfig`, and `permissionSignature` (`permission-handler.ts`, covering permission mode, tool allow/deny lists and injected MCP servers). Adding a process-level SDK option means extending it. A permission mismatch is the one trigger that is never deferred: deferring hands back the very session being replaced.

- **SDK protocol boundary.** `@anthropic-ai/claude-agent-sdk` is the default engine and defines Halo's internal stream/session protocol. `@hello-halo/agent-sdk`, `@openai/codex-sdk`, `@deepseek-ai/dsh`, and future engines must expose the same `tool` / `createSdkMcpServer` / `createSession` / `query` surface through `resolved-sdk.ts`. Native engine events must be normalized before they reach `session-consumer.ts` or `stream-processor.ts`.

  | Engine (`config.agent.sdkEngine`) | Runtime | Adapter | Missing runtime |
  |---|---|---|---|
  | `anthropic` (default) | `@anthropic-ai/claude-agent-sdk` in-process | — (canonical protocol) | Startup fails |
  | `halo` | `@hello-halo/agent-sdk` in-process | — (same protocol surface) | Startup fails |
  | `codex` | `codex app-server` child process (binary from `@openai/codex`) | `codex/` | Startup fails |
  | `dsh` | `@deepseek-ai/dsh` child process, stdio JSON-RPC | `dsh/` | Degrades to `FALLBACK_ORDER` |

  `dsh` degrades instead of failing because its runtime is an optional package most builds do not ship; selecting it must not brick startup. Its protocol has no cancel method and never sends a request back to Halo, so interrupt is a process kill and there is no approval prompt. That missing reverse channel does NOT rule out Halo's in-process MCP tools: the bridge in `mcp/sdk-bridge.ts` inverts the direction, and the runtime's own MCP client dials in. Everything the model can do is a plugin `dsh/runtime/cordis-config.ts` composes — including the MCP client and the skill provider — so that file, not the protocol, is where a dsh capability is granted or withheld. The limits that remain are declared in `dsh/capabilities.ts` and surfaced in Settings.

  **An out-of-process engine's MCP tools do not exist when its runtime first answers.** The client dials after the runtime is already accepting requests, so a session handed out at that moment accepts a prompt the model answers without them. `SdkMcpBridge.whenDialled()` is the evidence that discovery finished; adapters await it before reporting the session started. Servers an engine connects to directly are outside that signal.

  Per-turn output contract (REQUIRED of every engine adapter, not just Claude). Adapters that emit only token-level `stream_event` frames silently break consumers that key off top-level envelopes (apps/runtime `execute.ts`, app-chat `lastAssistantText`, session-store JSONL replay):

  | Frame | When | Carries |
  |---|---|---|
  | `system.init` | Once at turn start | session_id, model, tools, mcp_servers |
  | `stream_event` (message_start / content_block_* / message_delta / message_stop) | Token-level | UI streaming deltas |
  | `assistant` (aggregate) | At each block boundary | One content block in final form. **For `tool_use` blocks this MUST precede the corresponding `user.tool_result`** so id-based linking works during JSONL replay. |
  | `user` (tool_result) | When a tool item completes | `tool_use_id`, content, is_error |
  | `result` | Once at turn end | stop_reason, cumulative usage |

  Adding a new engine = implement an adapter under `services/agent/<engine>/` that produces this exact frame sequence. Do NOT add engine-specific branches in consumers; if a consumer needs engine awareness, the adapter contract is wrong.
- **BrowserWindow safety.** Always check `!mainWindow.isDestroyed()` before sending events in async callbacks. Stream processing is full of async callbacks; violations will crash on window close.

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

## 4) Subagent Model

`subagent-handler.ts` manages nested agent invocations. A parent agent can spawn one or more subagents; each subagent runs in its own SDK session with:
- Inherited MCP servers (configurable)
- Scoped system prompt composed by `system-prompt.ts`
- Results folded back into the parent's thought stream as a `subagent_result` thought

Do not bypass `subagent-handler` for nested invocations — it owns the lifecycle, resource limits, and result translation.

## 5) External Injection (IM / Scheduled / Programmatic)

`inject-message.ts` is the single entry for pushing messages into a live session from outside the normal user-input path. Callers include:
- `apps/runtime/dispatch-inbound.ts` (IM inbound messages)
- `apps/runtime/execute.ts` (scheduled / event-triggered runs)

Injection rules:
- Must specify target `sessionId` and role-equivalent metadata.
- Cannot inject mid-turn — injection waits for the current turn to settle.
- Permission context (owner vs guest for IM) is attached at injection time; the stream respects it until the turn ends.

## 6) Integration Points

- **IPC / transport**: `src/main/ipc/agent.ts` (user-facing commands) and `src/main/ipc/conversation.ts` (session ↔ conversation binding).
- **Preload / renderer**: `src/preload/index.ts` `agent:*` events; `src/renderer/api/transport.ts` methodMap; `src/renderer/stores/chat.store.ts` consumes events.
- **MCP servers**: `services/email-mcp/`, `services/web-search/`, and any user-installed MCP are routed via `mcp-manager.ts`.
- **Permissions UI**: `pulse/`, `components/chat/` surface approvals raised by `permission-handler.ts`.

## 7) Editing Guidance

| If you need to... | Start here |
|---|---|
| Change how the SDK is invoked or configured | `sdk-config.ts` / `resolved-sdk.ts` |
| Add an engine, or change engine selection / fallback | `capabilities.ts` (`EngineId`), `resolved-sdk.ts` (loader, `ENGINE_LABELS`, `FALLBACK_ORDER`), `engine-availability.ts` |
| Change what an engine claims it can do | `<engine>/capabilities.ts` — never by sniffing tool names or engine ids in consumers |
| Change how SDK events become thoughts | `stream-processor.ts` |
| Change session lifecycle or invalidation rules | `session-manager.ts` |
| Add a new field to the system prompt | `system-prompt.ts` |
| Add a new tool-approval flow | `permission-handler.ts` |
| Let a non-user trigger push a message | `inject-message.ts` (do NOT invent a new injection path) |
| Interrupt / pause / switch mid-turn | `control.ts` |
| Change subagent behavior | `subagent-handler.ts` |
| Register a new MCP server source | `mcp-manager.ts` |
| Give a new out-of-process engine MCP or skills | `mcp/partition.ts` + `mcp/sdk-bridge.ts` (reuse as-is) and `skills.ts`; write only the engine's own config renderer |

## 8) Hard Rules

1. **No state duplication in renderer.** Renderer stores mirror authoritative main-process state via events only.
2. **Never re-implement injection paths.** All external triggers go through `inject-message.ts`.
3. **Never bypass `stream-processor`** when translating SDK events — subagent-handler and permission-handler compose with it, not around it.
4. **Do not weaken the config-change invalidation contract.** Partial in-place session updates are forbidden; batch destroy + recreate is the only supported path.
5. **Guard every `mainWindow` access** in async callbacks with `!mainWindow.isDestroyed()`.
