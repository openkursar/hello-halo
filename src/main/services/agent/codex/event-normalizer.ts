/**
 * Codex app-server event normalizer.
 *
 * Translates Codex V2 JSON-RPC notifications into the Claude Code SDK
 * message protocol Halo's stream-processor consumes. This is the protocol
 * boundary: every divergence between Codex and CC is contained here so the
 * rest of Halo stays engine-agnostic.
 *
 * Per-turn output contract (in order, per turn):
 *
 *   1. system.init                        — once per session, before first turn
 *   2. assistant.message_start            — wraps all content blocks
 *   3. content_block_start/_delta/_stop   — text / thinking / tool_use blocks
 *   3b. AGGREGATE assistant message       — emitted at each block boundary,
 *                                            carrying the just-completed block's
 *                                            final form. Required so consumers
 *                                            that key off top-level
 *                                            `type: 'assistant'` (apps/runtime
 *                                            execute.ts; app-chat.ts
 *                                            lastAssistantText; session-store
 *                                            JSONL replay) see Codex turns the
 *                                            same way they see Claude turns.
 *                                            The aggregate for a tool_use is
 *                                            emitted BEFORE its tool_result so
 *                                            id-based linking during JSONL
 *                                            replay works.
 *   4. user.tool_result                   — interleaved with tool_use
 *   5. assistant.message_delta + _stop    — carries stop_reason + usage
 *   6. result                             — terminal marker
 *
 * Without (2) and (5) the CC stream-processor cannot extract per-turn usage
 * or lock final content. Without `result` the consumer never advances.
 * Without (3b) the engine produces a stream_event-only protocol that diverges
 * from Claude SDK and forces every consumer to learn engine-specific paths.
 *
 * Notification → CC mapping (canonical, see ARCH plan appendix A):
 *
 *   thread/started                          → system.init
 *   turn/started                            → message_start
 *   item/started(agent_message)             → content_block_start(text)
 *   item/agentMessage/delta                 → content_block_delta(text_delta)   ← TOKEN STREAM
 *   item/completed(agent_message)           → content_block_stop
 *   item/started(reasoning)                 → content_block_start(thinking)
 *   item/reasoning/textDelta                → content_block_delta(thinking_delta) ← TOKEN STREAM
 *   item/completed(reasoning)               → content_block_stop
 *   item/started(command_execution)         → tool_use Bash + content_block_stop (input is final-only)
 *   item/commandExecution/outputDelta       → buffered, flushed on completed
 *   item/completed(command_execution)       → user.tool_result with aggregated output
 *   item/started/completed(file_change)     → tool_use Edit + tool_result with patch
 *   item/started/completed(plan)            → synthetic TodoWrite (CC-shaped)
 *   item/started/completed(web_search)      → tool_use WebSearch + tool_result
 *   item/started/completed(mcp_tool_call)   → tool_use mcp__server__tool + tool_result
 *   thread/tokenUsage/updated               → cached, flushed in result
 *   turn/completed                          → message_delta + message_stop + result
 *   turn/failed / error                     → assistant error + message_delta + message_stop + result(error)
 */

import {
  ServerNotifications,
  type AgentMessageDeltaNotification,
  type CommandExecutionItem,
  type CommandExecutionOutputDeltaNotification,
  type ErrorNotification,
  type FileChangeItem,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type McpToolCallItem,
  type PlanItem,
  type ReasoningSummaryTextDeltaNotification,
  type ReasoningTextDeltaNotification,
  type ThreadStartedNotification,
  type ThreadItem,
  type TokenUsage,
  type TokenUsageUpdatedNotification,
  type TurnCompletedNotification,
  type TurnStartedNotification,
  type WebSearchItem,
} from './types/codex-protocol'

export interface NormalizerContext {
  sessionId: string
  model: string
  mcpServers: Record<string, any>
  /**
   * Mirrors Claude Code SDK's `includePartialMessages`. Drives the
   * stream_event ↔ aggregate split for TEXT and THINKING blocks so the
   * normalizer never feeds the same content to BOTH consumer paths at the
   * same time (which is what produced the doubled-bubble bug after eeb6f08).
   *
   *   - true  → live-UI mode: emit stream_event deltas as the sole bubble
   *             source. The aggregate `type:'assistant'` envelope is still
   *             emitted for protocol shape, but its text/thinking content
   *             is empty — consumers that key off it (app-chat
   *             lastAssistantText, execute.ts finalText) fall back to the
   *             stream_event accumulation already in lastTextContent /
   *             streamResult.finalContent.
   *   - false → aggregate-only mode: skip stream_event text/thinking
   *             deltas so the aggregate is the sole text source. This is
   *             what execute.ts (automation) expects.
   *
   * Tool_use is unaffected: it always streams via content_block_start +
   * input_json_delta + content_block_stop AND emits the aggregate (the
   * aggregate must precede user.tool_result for id-based JSONL linking).
   */
  includePartialMessages: boolean
}

interface BlockState {
  index: number
  started: boolean
  stopped: boolean
  textSoFar: string
  /** Buffered tool output (commandExecution stdout, file_change patch). */
  output: string
  /** Original tool name surfaced to CC layer. */
  toolName: string
  toolId: string
  /**
   * Final tool input surfaced to CC layer. Captured at startToolBlock so the
   * aggregate `tool_use` envelope (emitted right before user.tool_result) can
   * carry the same `input` structure the stream_event delta carried.
   */
  toolInput: Record<string, unknown>
  /** Original Codex item type — for diagnostics. */
  fromKind: string
}

/** What each item id maps to (text block, thinking block, tool block). */
type BlockKind = 'text' | 'thinking' | 'thinking-summary' | 'tool'

interface TrackedItem {
  blockKind: BlockKind
  state: BlockState
}

export class CodexEventNormalizer {
  /**
   * Per-TURN flag: true once `system.init` has been emitted for the current
   * turn. Reset by `resetTurn()` so each new turn yields a fresh init frame.
   *
   * `system.init` is the per-turn boundary signal in the CC SDK contract
   * (see session-consumer.onTurnInit). Halo's session-consumer relies on
   * receiving one init per stream() call to flip `receivedAnyEvent=true`,
   * create the assistant placeholder, and ultimately emit `agent:complete`.
   * Treating it as session-scoped (the original design) silently skipped
   * init for turn 2+ and left the UI stuck in the "thinking…" state.
   */
  private turnInitEmitted = false
  private nextBlockIndex = 0
  private messageOpen = false
  private messageId: string | null = null
  /** Tracks one block per Codex item id so deltas can target the right index. */
  private items = new Map<string, TrackedItem>()
  /** Token usage from the most recent thread/tokenUsage/updated or turn/completed. */
  private lastUsage: TokenUsage | null = null
  /** True after we've emitted a `tool_use` content block in the current turn. */
  private hasToolUseInTurn = false
  /** Final assistant text, used as the `result` payload. */
  private finalText = ''
  /** Set when terminal events have been emitted; adapter checks this to break the read loop. */
  private terminal = false

  constructor(private readonly context: NormalizerContext) {
    // context is mutated by setSessionId — the readonly modifier here is
    // about the instance reference, not its fields. NormalizerContext is
    // intentionally writable for that lifecycle hook.
  }

  isTerminal(): boolean {
    return this.terminal
  }

  /**
   * Update the session id used in subsequent `system.init` envelopes.
   * Called by the session adapter after `thread/start` returns the real
   * thread id, so lazy-init fallbacks (when the server skips the
   * `thread/started` notification) tag CC envelopes with the persistable
   * id rather than our pre-handshake random UUID.
   */
  setSessionId(sessionId: string): void {
    this.context.sessionId = sessionId
  }

  /**
   * Reset per-turn state. The session adapter calls this before each
   * `turn/start` so every turn starts with a clean slate, including a fresh
   * `system.init` (see `turnInitEmitted` for the rationale).
   *
   * `finalText` is intentionally NOT reset here — it carries the last turn's
   * final assistant text into the `result` envelope when `turn/completed`
   * fires before any new content has streamed.
   */
  resetTurn(): void {
    this.terminal = false
    this.hasToolUseInTurn = false
    this.messageOpen = false
    this.messageId = null
    this.nextBlockIndex = 0
    this.items.clear()
    this.turnInitEmitted = false
  }

  /**
   * Synchronously build the synthetic `system.init` envelope for the current
   * turn. The stream-processor reads `session_id` / `model` / `tools` /
   * `mcp_servers` off this frame and uses its arrival as the per-turn
   * "assistant placeholder" trigger (session-consumer.onTurnInit).
   *
   * IDEMPOTENT WITHIN A TURN: returns `null` once already emitted for the
   * current turn. `resetTurn()` clears the flag so the next turn gets a
   * fresh frame. Multiple call sites (`handleTurnStarted` and the lazy
   * fallback in `handleItemStarted` for builds that skip `turn/started`)
   * race for the emission; only the first wins per turn.
   */
  createInit(sessionId?: string): any | null {
    if (this.turnInitEmitted) return null
    this.turnInitEmitted = true
    return {
      type: 'system',
      subtype: 'init',
      session_id: sessionId || this.context.sessionId,
      model: this.context.model,
      tools: collectToolNames(this.context.mcpServers),
      mcp_servers: Object.keys(this.context.mcpServers || {}).map((name) => ({
        name, status: 'connected',
      })),
      slash_commands: [],
      skills: [],
      agents: [],
    }
  }

  // ==========================================================================
  // Dispatch by notification method
  // ==========================================================================

  /**
   * Dispatch a single Codex JSON-RPC notification by method name. Returns a
   * batch of CC-shaped messages to forward to the stream-processor.
   *
   * Notifications received after the normalizer has already emitted a
   * terminal `result` for the turn are dropped — Codex sometimes sends a
   * `turn/completed` after a `turn/failed` (or after we emitted a
   * synthetic error from an `error` item), and forwarding the second
   * `result` confuses the consumer with a "success" trailing an error.
   * The exception is `thread/started`, which arrives once per session
   * lifecycle and is independent of turn state.
   */
  handle(method: string, params: unknown): any[] {
    if (this.terminal && method !== ServerNotifications.ThreadStarted) {
      return []
    }
    switch (method) {
      case ServerNotifications.ThreadStarted:
        return this.handleThreadStarted(params as ThreadStartedNotification)
      case ServerNotifications.TurnStarted:
        return this.handleTurnStarted(params as TurnStartedNotification)
      case ServerNotifications.ItemStarted:
        return this.handleItemStarted(params as ItemStartedNotification)
      case ServerNotifications.ItemCompleted:
        return this.handleItemCompleted(params as ItemCompletedNotification)
      case ServerNotifications.AgentMessageDelta:
        return this.handleAgentMessageDelta(params as AgentMessageDeltaNotification)
      case ServerNotifications.ReasoningTextDelta:
        return this.handleReasoningTextDelta(params as ReasoningTextDeltaNotification, false)
      case ServerNotifications.ReasoningSummaryTextDelta:
        return this.handleReasoningTextDelta(params as ReasoningSummaryTextDeltaNotification, true)
      case ServerNotifications.CommandExecutionOutputDelta:
        return this.handleCommandExecutionOutputDelta(params as CommandExecutionOutputDeltaNotification)
      case ServerNotifications.ThreadTokenUsageUpdated:
        return this.handleTokenUsage(params as TokenUsageUpdatedNotification)
      case ServerNotifications.TurnCompleted:
        return this.handleTurnCompleted(params as TurnCompletedNotification)
      case ServerNotifications.TurnFailed:
        return this.handleTurnFailed(params as ErrorNotification)
      case ServerNotifications.Error:
        return this.handleError(params as ErrorNotification)
      case ServerNotifications.Warning:
        // Surface warnings as system messages but do not change stream state.
        return []
      case ServerNotifications.ThreadCompacted:
        return [{
          type: 'system',
          subtype: 'compact_boundary',
          session_id: this.context.sessionId,
        }]
      default:
        // FileChangeOutputDelta / McpToolCallProgress are advisory; we keep the
        // tool's running output but do not stream it (capabilities advertise
        // toolOutput=token only for command_execution).
        return []
    }
  }

  // ==========================================================================
  // Handlers
  // ==========================================================================

  private handleThreadStarted(_params: ThreadStartedNotification): any[] {
    // INTENTIONALLY SILENT.
    //
    // Codex's app-server emits `thread/started` automatically on every
    // successful `thread/start` (and on `thread/resume`) — a session-level
    // event signaling "this thread now exists". Halo's session warmup
    // calls thread/start during conversation switch BEFORE the user has
    // sent anything. If we treated thread/started as the signal to emit
    // `system:init`, the CC stream-processor would interpret that as
    // "turn started", flip chat.store.isStreaming=true, and freeze the
    // UI in the "thinking…" state until a result frame arrived — which never comes
    // because no turn was ever requested.
    //
    // Per the CC SDK contract, `system:init` is the FIRST FRAME of a
    // streaming turn, not a session-lifecycle event. We therefore emit
    // init lazily inside `handleTurnStarted` / `handleItemStarted`, which
    // only fire when the user actually sends a message and Codex begins
    // a turn. The thread id is captured from `thread/start`'s response
    // and threaded through `setSessionId`, so lazy init still tags the
    // envelope with the persistable id.
    return []
  }

  private handleTurnStarted(_params: TurnStartedNotification): any[] {
    const messages: any[] = []
    this.terminal = false
    this.hasToolUseInTurn = false
    if (!this.turnInitEmitted) messages.push(this.createInit(this.context.sessionId))
    messages.push(this.openMessage())
    return messages
  }

  private handleItemStarted(params: ItemStartedNotification): any[] {
    const messages: any[] = []
    if (!this.messageOpen) {
      if (!this.turnInitEmitted) messages.push(this.createInit(this.context.sessionId))
      messages.push(this.openMessage())
    }
    if (!params?.item) return messages

    const item = params.item
    const itemId = item.id ?? params.itemId
    if (!itemId) return messages

    // Codex's actual wire-level item.type values are camelCase (per
    // codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts).
    // Snake_case will silently bypass every case and corrupt the stream.
    switch (item.type) {
      case 'userMessage':
        // Echo of the user's own prompt — Halo already showed the user
        // their bubble. Drop it to avoid a stray "tool-call - userMessage" card.
        return messages
      case 'agentMessage':
        messages.push(...this.startTextBlock(itemId))
        break
      case 'reasoning':
        messages.push(...this.startThinkingBlock(itemId))
        break
      case 'commandExecution':
        messages.push(...this.startToolBlock(itemId, 'Bash', item, {
          command: (item as CommandExecutionItem).command || '',
        }, 'commandExecution'))
        break
      case 'fileChange':
        messages.push(...this.startToolBlock(itemId, 'Edit', item, fileChangeInput(item as FileChangeItem), 'fileChange'))
        break
      case 'webSearch':
        messages.push(...this.startToolBlock(itemId, 'WebSearch', item, {
          query: (item as WebSearchItem).query || '',
        }, 'webSearch'))
        break
      case 'mcpToolCall': {
        const m = item as McpToolCallItem
        const name = mcpToolName(m.server || 'mcp', m.tool || 'unknown')
        messages.push(...this.startToolBlock(itemId, name, item, asRecord(m.arguments), 'mcpToolCall'))
        break
      }
      case 'plan':
        messages.push(...this.startToolBlock(itemId, 'TodoWrite', item, {
          todos: planToTodos(item as PlanItem),
        }, item.type))
        break
      case 'dynamicToolCall': {
        const dyn = item as any
        messages.push(...this.startToolBlock(itemId, dyn.tool || dyn.name || 'DynamicTool', item, asRecord(dyn.arguments), 'dynamicToolCall'))
        break
      }
      case 'imageGeneration':
        // Render as an inline tool_use card; real image data comes via item.completed.
        messages.push(...this.startToolBlock(itemId, 'ImageGeneration', item, asRecord(item), 'imageGeneration'))
        break
      case 'imageView':
      case 'enteredReviewMode':
      case 'exitedReviewMode':
      case 'hookPrompt':
        // No CC-equivalent; drop silently. Future: surface as system message.
        return messages
      case 'contextCompaction':
        messages.push({ type: 'system', subtype: 'compact_boundary', session_id: this.context.sessionId })
        break
      default:
        // Unknown item kinds are dropped to keep the stream well-formed.
        // (Including any new item types added in future Codex versions.)
        break
    }
    return messages
  }

  private handleItemCompleted(params: ItemCompletedNotification): any[] {
    if (!params?.item) return []
    const item = params.item
    const itemId = item.id ?? params.itemId
    if (!itemId) return []

    // Drop userMessage echoes — see handleItemStarted for rationale.
    if (item.type === 'userMessage') return []
    // Drop UI-only items.
    if (item.type === 'imageView' || item.type === 'enteredReviewMode' ||
        item.type === 'exitedReviewMode' || item.type === 'hookPrompt') {
      return []
    }

    const messages: any[] = []
    const tracked = this.items.get(itemId)

    if (tracked?.blockKind === 'text') {
      // CRITICAL: Codex emits both incremental deltas AND the same full
      // text again in item.completed.text. The TUI reference impl
      // (`deltas_then_same_final_message_are_rendered_snapshot`) handles
      // this by trusting deltas exclusively — if any delta streamed, the
      // text in item.completed is a redundant echo, not a delta to apply.
      //
      // Halo's OpenAI-compat router can additionally double the text
      // during chat_completions→responses transcoding, making
      // item.completed.text == textSoFar + textSoFar. Naively flushing
      // "tail = item.text.slice(textSoFar.length)" then re-emits the
      // entire text, producing visible doubled bubbles.
      //
      // Rules:
      //  - If deltas streamed (textSoFar is non-empty): TRUST deltas,
      //    ignore item.text. Just emit content_block_stop.
      //  - If no deltas streamed (textSoFar empty): emit item.text as
      //    a single delta so the full message reaches the renderer.
      const itemText = (item as any).text || ''
      if (tracked.state.textSoFar.length === 0 && itemText) {
        messages.push(streamEvent({
          type: 'content_block_delta',
          index: tracked.state.index,
          delta: { type: 'text_delta', text: itemText },
        }))
        tracked.state.textSoFar = itemText
      }
      this.finalText = tracked.state.textSoFar
      messages.push(...this.stopBlock(tracked.state))
      messages.push(...this.aggregateBlock('text', tracked.state))
      this.items.delete(itemId)
      return messages
    }

    if (tracked?.blockKind === 'thinking' || tracked?.blockKind === 'thinking-summary') {
      // Same trust-deltas rule as text. Reasoning items can carry the
      // full text both via deltas and in item.completed; doubling here
      // would clutter the thinking block with repeated chains-of-thought.
      const itemText = reasoningToText(item as any) || (item as any).text || ''
      if (tracked.state.textSoFar.length === 0 && itemText) {
        messages.push(streamEvent({
          type: 'content_block_delta',
          index: tracked.state.index,
          delta: { type: 'thinking_delta', thinking: itemText },
        }))
        tracked.state.textSoFar = itemText
      }
      messages.push(...this.stopBlock(tracked.state))
      messages.push(...this.aggregateBlock(tracked.blockKind, tracked.state))
      this.items.delete(itemId)
      return messages
    }

    if (tracked?.blockKind === 'tool') {
      messages.push(...this.completeToolBlock(itemId, item, tracked.state))
      return messages
    }

    // No tracked block — the item completed without a corresponding
    // item.started (server skipped the start, or we joined mid-stream on
    // resume). This is the COMMON path when no deltas streamed and the
    // server emitted only started+completed back-to-back. Branch by
    // camelCase item kind.
    if (item.type === 'agentMessage') {
      const text = (item as any).text || ''
      messages.push(...this.startTextBlock(itemId))
      const tracked2 = this.items.get(itemId)
      if (tracked2 && text) {
        messages.push(streamEvent({
          type: 'content_block_delta',
          index: tracked2.state.index,
          delta: { type: 'text_delta', text },
        }))
        tracked2.state.textSoFar = text
        this.finalText = text
      }
      if (tracked2) {
        messages.push(...this.stopBlock(tracked2.state))
        messages.push(...this.aggregateBlock('text', tracked2.state))
      }
      this.items.delete(itemId)
      return messages
    }
    if (item.type === 'reasoning') {
      const text = reasoningToText(item as any)
      messages.push(...this.startThinkingBlock(itemId))
      const tracked2 = this.items.get(itemId)
      if (tracked2 && text) {
        messages.push(streamEvent({
          type: 'content_block_delta',
          index: tracked2.state.index,
          delta: { type: 'thinking_delta', thinking: text },
        }))
        tracked2.state.textSoFar = text
      }
      if (tracked2) {
        messages.push(...this.stopBlock(tracked2.state))
        messages.push(...this.aggregateBlock('thinking', tracked2.state))
      }
      this.items.delete(itemId)
      return messages
    }

    // Tool item: synthesize a complete tool_use + tool_result so the UI
    // doesn't see a dangling tool_result.
    messages.push(...this.synthesizeOrphanTool(item))
    return messages
  }

  private handleAgentMessageDelta(params: AgentMessageDeltaNotification): any[] {
    if (!params?.itemId || !params.delta) return []
    const messages: any[] = []

    // Lazy block creation: if the delta arrives before item/started (which
    // does happen on some Codex builds), we MUST emit the content_block_start
    // frame too. Previously `ensureTextBlock` quietly created the block but
    // dropped the start frame, so the renderer received content_block_delta
    // referring to an index that was never opened — visible as missing or
    // delayed text.
    if (!this.items.has(params.itemId)) {
      messages.push(...this.startTextBlock(params.itemId))
    }
    const tracked = this.items.get(params.itemId)!

    tracked.state.textSoFar += params.delta
    messages.push(streamEvent({
      type: 'content_block_delta',
      index: tracked.state.index,
      delta: { type: 'text_delta', text: params.delta },
    }))
    return messages
  }

  private handleReasoningTextDelta(
    params: ReasoningTextDeltaNotification | ReasoningSummaryTextDeltaNotification,
    _summary: boolean,
  ): any[] {
    if (!params?.itemId || !params.delta) return []
    const messages: any[] = []

    // Same lazy-emit rule as handleAgentMessageDelta — reasoning deltas
    // can also arrive before item/started; we owe the renderer a
    // content_block_start frame.
    if (!this.items.has(params.itemId)) {
      messages.push(...this.startThinkingBlock(params.itemId))
    }
    const tracked = this.items.get(params.itemId)!

    tracked.state.textSoFar += params.delta
    messages.push(streamEvent({
      type: 'content_block_delta',
      index: tracked.state.index,
      delta: { type: 'thinking_delta', thinking: params.delta },
    }))
    return messages
  }

  private handleCommandExecutionOutputDelta(params: CommandExecutionOutputDeltaNotification): any[] {
    if (!params?.itemId || !params.delta) return []
    const tracked = this.items.get(params.itemId)
    if (!tracked || tracked.blockKind !== 'tool') return []
    tracked.state.output += params.delta
    // No CC-equivalent token-stream channel for tool stdout. We buffer the
    // running output here; the renderer reads it from the user.tool_result
    // emitted at item.completed. For richer real-time UI, a Halo-internal
    // `agent:tool-output-delta` channel would be the future extension point.
    return []
  }

  private handleTokenUsage(params: TokenUsageUpdatedNotification): any[] {
    if (params?.usage) this.lastUsage = params.usage
    return []
  }

  private handleTurnCompleted(params: TurnCompletedNotification): any[] {
    if (params?.usage) this.lastUsage = params.usage
    const messages: any[] = []
    // Close any blocks the server forgot to mark completed (defensive).
    // Emit the per-block aggregate alongside the stream stop so consumers
    // that key off `type: 'assistant'` still see the leftover content.
    for (const [, tracked] of Array.from(this.items.entries())) {
      messages.push(...this.stopBlock(tracked.state))
      messages.push(...this.aggregateBlock(tracked.blockKind, tracked.state))
    }
    this.items.clear()
    messages.push(...this.closeMessage(this.hasToolUseInTurn ? 'tool_use' : 'end_turn'))
    messages.push(this.createResult(false))
    this.terminal = true
    return messages
  }

  private handleTurnFailed(params: ErrorNotification): any[] {
    const message = errorMessageFrom(params)
    return this.emitTerminalError(message || 'Codex turn failed')
  }

  private handleError(params: ErrorNotification): any[] {
    const message = errorMessageFrom(params)
    return this.emitTerminalError(message || 'Codex stream error')
  }

  private emitTerminalError(message: string): any[] {
    const messages: any[] = []
    if (!this.messageOpen) messages.push(this.openMessage())
    messages.push(...assistantWithBlocks([{ type: 'text', text: message }]))
    messages.push(...this.closeMessage('end_turn'))
    messages.push(this.createResult(true, message))
    this.terminal = true
    return messages
  }

  // ==========================================================================
  // Block helpers
  // ==========================================================================

  private openMessage(): any {
    this.messageOpen = true
    this.messageId = `codex-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.nextBlockIndex = 0
    this.items.clear()
    return streamEvent({
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.context.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: emptyUsage(),
      },
    })
  }

  private closeMessage(stopReason: 'end_turn' | 'tool_use'): any[] {
    if (!this.messageOpen) return []
    this.messageOpen = false
    return [
      streamEvent({
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: this.lastUsage ? toClaudeUsage(this.lastUsage) : emptyUsage(),
      }),
      streamEvent({ type: 'message_stop' }),
    ]
  }

  createResult(isError: boolean, error?: string): any {
    const usage = this.lastUsage ? toClaudeUsage(this.lastUsage) : undefined
    return {
      type: 'result',
      subtype: isError ? 'error_during_execution' : 'success',
      session_id: this.context.sessionId,
      result: isError ? (error || '') : this.finalText,
      is_error: isError,
      usage,
      cumulative_usage: usage,
      stop_reason: isError ? 'error' : 'end_turn',
    }
  }

  private startTextBlock(itemId: string): any[] {
    if (this.items.has(itemId)) return []
    const state: BlockState = {
      index: this.nextBlockIndex++,
      started: true,
      stopped: false,
      textSoFar: '',
      output: '',
      toolName: '',
      toolId: itemId,
      toolInput: {},
      fromKind: 'agent_message',
    }
    this.items.set(itemId, { blockKind: 'text', state })
    return [streamEvent({
      type: 'content_block_start',
      index: state.index,
      content_block: { type: 'text', text: '' },
    })]
  }

  private startThinkingBlock(itemId: string): any[] {
    if (this.items.has(itemId)) return []
    const state: BlockState = {
      index: this.nextBlockIndex++,
      started: true,
      stopped: false,
      textSoFar: '',
      output: '',
      toolName: '',
      toolId: itemId,
      toolInput: {},
      fromKind: 'reasoning',
    }
    this.items.set(itemId, { blockKind: 'thinking', state })
    return [streamEvent({
      type: 'content_block_start',
      index: state.index,
      content_block: { type: 'thinking', thinking: '' },
    })]
  }

  private startToolBlock(
    itemId: string,
    toolName: string,
    item: ThreadItem,
    input: Record<string, unknown>,
    fromKind: string,
  ): any[] {
    if (this.items.has(itemId)) return []
    const state: BlockState = {
      index: this.nextBlockIndex++,
      started: true,
      stopped: false,
      textSoFar: '',
      output: '',
      toolName,
      toolId: itemId,
      toolInput: input,
      fromKind,
    }
    this.items.set(itemId, { blockKind: 'tool', state })
    this.hasToolUseInTurn = true
    return [
      streamEvent({
        type: 'content_block_start',
        index: state.index,
        content_block: { type: 'tool_use', id: itemId, name: toolName, input: {} },
      }),
      streamEvent({
        type: 'content_block_delta',
        index: state.index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      }),
      streamEvent({ type: 'content_block_stop', index: state.index }),
    ]
  }

  /**
   * Build the aggregate `type: 'assistant'` envelope for a single completed
   * block. Returns an empty array for empty text/thinking blocks (no payload
   * worth surfacing).
   *
   * Why per-block aggregate (vs one aggregate at message close):
   *   - tool_use must arrive BEFORE its tool_result for id-based linking in
   *     `apps/runtime/session-transcript.convertEventsToMessages` (toolUseMap is
   *     populated lazily as assistant messages arrive). Codex emits
   *     `userWithToolResult` immediately on item.completed; emitting the
   *     aggregate at message close would put tool_use AFTER tool_result and
   *     drop the linkage on JSONL replay.
   *   - Per-block matches Claude SDK's per-response granularity for mixed
   *     text/tool turns.
   *
   * Why the aggregate at all (vs trusting stream_events):
   *   - execute.ts (automation runtime) consumes only top-level
   *     `type: 'assistant'` for finalText / report_to_user detection.
   *   - app-chat.ts captures lastAssistantText off raw `type: 'assistant'`
   *     to bypass stream-processor's known lastTextContent corruption TODO.
   *   - session-store JSONL replay reconstructs message bubbles from
   *     `type: 'assistant'` (the stream_event branch is legacy/optional).
   *
   * Without this layer the Codex normalizer satisfies stream-processor's UI
   * needs but silently breaks every consumer that follows the Claude SDK
   * top-level message contract.
   */
  private aggregateBlock(blockKind: BlockKind, state: BlockState): any[] {
    if (blockKind === 'text') {
      if (!state.textSoFar) return []
      // Mode split mirrors Claude Code SDK: when stream_event is the live
      // bubble source (includePartialMessages=true), DO NOT also send the
      // text inside the aggregate envelope. Otherwise stream-processor.ts
      // would append the same text twice — once at content_block_stop, then
      // again from the aggregate text thought (the doubled bubble bug).
      //
      // Known trade-off: app-chat.ts persists aggregate `assistant` events
      // to JSONL (stream_event is filtered out per app-chat.ts:581). With
      // text suppressed here, session-transcript.convertEventsToMessages can no
      // longer reconstruct the bubble text for Codex digital-human chat
      // history replay. Mitigation paths if that bites:
      //   a) Stop filtering stream_event from JSONL for Codex sessions
      //      (engine-aware persistence — explicitly called out as a smell
      //      by app-chat.ts:579 but the practical choice).
      //   b) Have session-store fall back to reading `result.result` (the
      //      final text Codex normalizer already puts in the terminal
      //      `result` envelope) when aggregate text is missing.
      // The interactive bubble is the priority — replay can be addressed
      // separately without re-introducing the doubling.
      if (this.context.includePartialMessages) return []
      return assistantWithBlocks([{ type: 'text', text: state.textSoFar }])
    }
    if (blockKind === 'thinking' || blockKind === 'thinking-summary') {
      if (!state.textSoFar) return []
      // Same rationale as text: suppress aggregate thinking when stream_event
      // is the live source so the timeline doesn't duplicate the chain-of-
      // thought (parseSDKMessage skips thinking thoughts, but session-store
      // and other top-level `type:'assistant'` consumers would still see
      // double thinking blocks on replay).
      if (this.context.includePartialMessages) return []
      return assistantWithBlocks([{ type: 'thinking', thinking: state.textSoFar }])
    }
    if (blockKind === 'tool') {
      return assistantWithBlocks([{
        type: 'tool_use',
        id: state.toolId,
        name: state.toolName,
        input: state.toolInput,
      }])
    }
    return []
  }

  private completeToolBlock(itemId: string, item: ThreadItem, state: BlockState): any[] {
    const messages: any[] = []
    const isError = isItemErrored(item)
    const output = extractToolOutput(item, state)
    // The aggregate `tool_use` envelope MUST precede the user.tool_result so
    // session-store JSONL replay can link the result to its tool by id (see
    // `aggregateBlock` for the full rationale).
    messages.push(...this.aggregateBlock('tool', state))
    messages.push(userWithToolResult(itemId, output, isError))
    this.items.delete(itemId)
    return messages
  }

  private synthesizeOrphanTool(item: ThreadItem): any[] {
    const messages: any[] = []
    const itemId = item.id || `codex-orphan-${this.nextBlockIndex}`
    const toolName = guessToolName(item)
    const input = guessToolInput(item)
    messages.push(...this.startToolBlock(itemId, toolName, item, input, item.type))
    const state = this.items.get(itemId)?.state
    if (state) {
      messages.push(...this.completeToolBlock(itemId, item, state))
    }
    return messages
  }

  private stopBlock(state: BlockState): any[] {
    if (state.stopped) return []
    state.stopped = true
    return [streamEvent({ type: 'content_block_stop', index: state.index })]
  }
}

// ============================================================================
// Pure helpers
// ============================================================================

function streamEvent(event: any): any {
  return { type: 'stream_event', event }
}

function assistantWithBlocks(content: any[]): any[] {
  return [{
    type: 'assistant',
    message: {
      id: `codex-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role: 'assistant',
      content,
    },
  }]
}

function userWithToolResult(toolUseId: string, content: string, isError: boolean): any {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        is_error: isError,
      }],
    },
  }
}

function collectToolNames(mcpServers: Record<string, any>): string[] {
  const names: string[] = []
  for (const [serverName, server] of Object.entries(mcpServers || {})) {
    const tools = server?.instance?.listTools?.()
    if (!Array.isArray(tools)) continue
    for (const tool of tools) {
      if (tool?.name) names.push(mcpToolName(serverName, tool.name))
    }
  }
  return names
}

function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function fileChangeInput(item: FileChangeItem): Record<string, unknown> {
  // Halo's CC `Edit` tool input is `{ file_path, old_string, new_string }`.
  // Codex emits `{ changes: [{ path, kind, diff }] }` where `diff` is a
  // unified diff string (per FileUpdateChange schema). We CANNOT
  // reconstruct old_string/new_string from a unified diff without parsing
  // it — for now we surface the diff verbatim and let the renderer fall
  // back to the unified-patch view (see capabilities.tools.synthetic[lossy=true]).
  if (item.changes && item.changes.length === 1) {
    const change = item.changes[0]
    return {
      file_path: change.path,
      kind: change.kind ?? '',
      diff: change.diff ?? '',
    }
  }
  return {
    changes: item.changes || [],
  }
}

function planToTodos(item: PlanItem): Array<{ content: string; activeForm: string; status: string }> {
  // Codex's plan item is a single Markdown text blob — not a structured
  // array. Split on lines starting with [ ]/[x] checkbox markers; each
  // becomes a CC-shaped TodoWrite entry. Falls back to a single entry if
  // no checkboxes are present.
  const text = item.text || ''
  if (!text.trim()) return []
  const lines = text.split('\n')
  const entries: Array<{ content: string; activeForm: string; status: string }> = []
  for (const raw of lines) {
    const line = raw.trim()
    const checkbox = line.match(/^[-*]?\s*\[([ xX])\]\s+(.*)$/)
    if (checkbox) {
      const completed = checkbox[1].toLowerCase() === 'x'
      const content = checkbox[2].trim()
      if (content) entries.push({ content, activeForm: content, status: completed ? 'completed' : 'pending' })
    }
  }
  if (entries.length > 0) return entries
  // No structured checkboxes — surface as a single pending entry so the UI
  // still shows something rather than an empty card.
  return [{ content: text.trim().slice(0, 200), activeForm: text.trim().slice(0, 200), status: 'pending' }]
}

function reasoningToText(item: { summary?: string[]; content?: string[] }): string {
  const parts: string[] = []
  if (Array.isArray(item.content)) parts.push(...item.content.filter(Boolean))
  else if (Array.isArray(item.summary)) parts.push(...item.summary.filter(Boolean))
  return parts.join('\n\n')
}

function isItemErrored(item: ThreadItem): boolean {
  const status = (item as any).status
  if (typeof status === 'string' && status.toLowerCase() === 'failed') return true
  return Boolean((item as any).error)
}

function extractToolOutput(item: ThreadItem, state: BlockState): string {
  if (item.type === 'commandExecution') {
    const ex = item as CommandExecutionItem
    return ex.aggregatedOutput ?? state.output
  }
  if (item.type === 'mcpToolCall') {
    const m = item as McpToolCallItem
    if (m.error) {
      return typeof m.error === 'string' ? m.error : (m.error.message || '')
    }
    const content = m.result?.content
    if (Array.isArray(content)) {
      return content.map((b) => {
        if ((b as any).type === 'text') return String((b as any).text || '')
        return JSON.stringify(b)
      }).join('\n')
    }
    if (m.result?.structured_content !== undefined) {
      return JSON.stringify(m.result.structured_content)
    }
    return ''
  }
  if (item.type === 'fileChange') {
    const f = item as FileChangeItem
    if (f.changes && f.changes.length > 0) {
      return f.changes.map((c) => `--- ${c.path}\n${c.diff || ''}`).join('\n\n')
    }
    return ''
  }
  if (item.type === 'webSearch') {
    return ''
  }
  if (item.type === 'plan') {
    return (item as PlanItem).text || ''
  }
  return state.output || ''
}

function guessToolName(item: ThreadItem): string {
  switch (item.type) {
    case 'commandExecution': return 'Bash'
    case 'webSearch': return 'WebSearch'
    case 'fileChange': return 'Edit'
    case 'plan': return 'TodoWrite'
    case 'mcpToolCall': {
      const m = item as McpToolCallItem
      return mcpToolName(m.server || 'mcp', m.tool || 'unknown')
    }
    case 'dynamicToolCall': return (item as any).tool || (item as any).name || 'DynamicTool'
    case 'imageGeneration': return 'ImageGeneration'
    default: return item.type || 'Unknown'
  }
}

function guessToolInput(item: ThreadItem): Record<string, unknown> {
  switch (item.type) {
    case 'commandExecution': return { command: (item as CommandExecutionItem).command || '' }
    case 'webSearch': return { query: (item as WebSearchItem).query || '' }
    case 'fileChange': return fileChangeInput(item as FileChangeItem)
    case 'plan': return { todos: planToTodos(item as PlanItem) }
    case 'mcpToolCall': return asRecord((item as McpToolCallItem).arguments)
    case 'dynamicToolCall': return asRecord((item as any).arguments)
    default: return {}
  }
}

function errorMessageFrom(params: ErrorNotification | undefined): string {
  if (!params) return ''
  if (typeof params.error === 'string') return params.error
  if (params.error && typeof params.error === 'object') return params.error.message || ''
  return params.message || ''
}

function toClaudeUsage(usage: TokenUsage): Record<string, number> {
  const inputTokens = usage.input_tokens ?? usage.inputTokens ?? 0
  const outputTokens = usage.output_tokens ?? usage.outputTokens ?? 0
  const cachedInput = usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cachedInput,
    cache_creation_input_tokens: 0,
  }
}

function emptyUsage(): Record<string, number> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
}
