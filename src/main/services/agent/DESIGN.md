# services/agent — Agent Engine

> The largest single subsystem in the main process. Wraps a Claude Code-compatible SDK protocol into a session-oriented, stream-driven, MCP-aware engine that drives every conversation in Halo. Claude Code remains the canonical/default protocol; alternate engines must adapt to that protocol instead of changing the main flow.
>
> Read this file before touching anything under `src/main/services/agent/`.

## 1) Core Responsibilities

| Responsibility | Primary file(s) | Notes |
|---|---|---|
| Session lifecycle (create / reuse / destroy / batch-invalidate on config change) | `session-manager.ts` | Largest file. V2 Session model. Registers callback on `config.service.ts` to auto-clean when API config changes. |
| SDK stream → Thought[] translation | `stream-processor.ts` | Second largest. Incremental push, partial tool calls, interruption recovery. |
| SDK invocation & configuration | `sdk-config.ts`, `resolved-sdk.ts`, `codex/` | Provider selection, model resolution, SDK option assembly. Alternate SDK engines are loaded only through `resolved-sdk.ts`; Codex-specific translation is isolated under `codex/`. |
| System prompt composition | `system-prompt.ts` | Space context, conversation context, tool availability injection. |
| Subagent orchestration | `subagent-handler.ts` | Nested agent invocations — Halo supports agents spawning agents. |
| Permission gating | `permission-handler.ts` | AskUserQuestion, tool approval, permission mode resolution. |
| MCP server routing | `mcp-manager.ts` | Registration, discovery, per-session MCP bindings. |
| External message injection | `inject-message.ts` | Entry point for IM inbound / programmatic triggers to push messages into a session. |
| Session control | `control.ts` | Interrupt / pause / switch-model mid-session. |
| Outbound message composition | `send-message.ts`, `message-utils.ts` | User message assembly, attachment handling, token counting. |
| Session consumption loop | `session-consumer.ts` | Iterator over SDK events; dispatches into stream-processor. |
| Top-level orchestration | `agents.ts`, `index.ts` | Public surface; wires everything together. |
| Constants & shared types | `constants.ts`, `types.ts`, `events.ts`, `helpers.ts` | — |

## 2) Single Source of Truth Contract

- **Session state (thoughts, tool calls, token usage) is authoritative in the main process.** The renderer consumes events and must not persist agent state independently.
- **API config changes invalidate sessions in bulk.** `config.service.ts` exposes `onApiConfigChange(callback)`. `services/agent` registers that callback at module load. On change, all V2 Sessions are destroyed; the next user message creates a fresh Session with updated config. Do not attempt to mutate live sessions.
- **Model selection is per-conversation.** A conversation pins its own `{ modelSourceId, modelId }` (Cursor-style), stamped at creation from the active global selection and resolved at send/warm time by `helpers.ts getApiCredentialsForConversation` (falls back to the global selection for legacy/unavailable pins). Because the model is baked into the encoded credentials at session creation (see `sdk-config.ts`), a pin change is detected by the per-conversation `credentialsFingerprint` on `V2SessionInfo` and rebuilds only that conversation's session; the fingerprint is what lets a conversation whose pin differs from the global selection resolve and rebuild independently. Note the desktop `ModelSelector` also writes the choice to the global selection — the "last-used" seed for new conversations and non-chat surfaces (apps use their own `userOverrides`) — and a global model change still bumps `credentialsGeneration`, invalidating all sessions (unchanged pre-pin behavior; sessions resume transparently via their `sessionId`).
- **SDK protocol boundary.** `@anthropic-ai/claude-agent-sdk` is the default engine and defines Halo's internal stream/session protocol. `@hello-halo/agent-sdk`, `@openai/codex-sdk`, and future engines must expose the same `tool` / `createSdkMcpServer` / `createSession` / `query` surface through `resolved-sdk.ts`. Native engine events must be normalized before they reach `session-consumer.ts` or `stream-processor.ts`.

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
| Change how SDK events become thoughts | `stream-processor.ts` |
| Change session lifecycle or invalidation rules | `session-manager.ts` |
| Add a new field to the system prompt | `system-prompt.ts` |
| Add a new tool-approval flow | `permission-handler.ts` |
| Let a non-user trigger push a message | `inject-message.ts` (do NOT invent a new injection path) |
| Interrupt / pause / switch mid-turn | `control.ts` |
| Change subagent behavior | `subagent-handler.ts` |
| Register a new MCP server source | `mcp-manager.ts` |

## 8) Hard Rules

1. **No state duplication in renderer.** Renderer stores mirror authoritative main-process state via events only.
2. **Never re-implement injection paths.** All external triggers go through `inject-message.ts`.
3. **Never bypass `stream-processor`** when translating SDK events — subagent-handler and permission-handler compose with it, not around it.
4. **Do not weaken the config-change invalidation contract.** Partial in-place session updates are forbidden; batch destroy + recreate is the only supported path.
5. **Guard every `mainWindow` access** in async callbacks with `!mainWindow.isDestroyed()`.
