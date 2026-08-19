/**
 * DeepSeek Harness session-event normalizer.
 *
 * Translates the runtime's notification stream into the Claude Code SDK
 * message protocol Halo's stream-processor consumes. This is the protocol
 * boundary: every divergence between the harness and CC is contained here so
 * the rest of Halo stays engine-agnostic.
 *
 * The harness streams whole session-log envelopes rather than a UI-shaped
 * item stream, and it has no notion of a "prompt result". Its own SDK defines
 * one activity interval as: the durable `agent/inbox/spliced` receipt for the
 * queued message, then everything up to the session's next whole-agent `idle`.
 * That interval — not the harness's inner `turn/start` … `turn/end` bracket —
 * is what Halo calls a turn, because Halo's session-consumer expects exactly
 * one `result` per user message. The session adapter owns interval detection
 * and drives `beginTurn()` / `endTurn()`; this class owns the frames.
 *
 * Per-turn output contract (services/agent/DESIGN.md §2):
 *
 *   1. system.init                       — once, when the interval opens
 *   2. message_start                     — once per harness step (= one model call)
 *   3. content_block_start/_delta/_stop  — from `assistant/chunk` stream chunks
 *   3b. AGGREGATE assistant envelope     — one per content block, at its
 *                                          boundary. For `tool_use` this lands
 *                                          before the matching tool_result
 *                                          because the harness records
 *                                          `assistant/message` before it
 *                                          dispatches any `tool/call`.
 *   4. user.tool_result                  — from `tool/result`
 *   5. message_delta + message_stop      — at `assistant/message`, carrying the
 *                                          step's usage
 *   6. result                            — once, at whole-agent idle
 *
 * Session event → CC mapping:
 *
 *   turn/start, step/end, session/end-seed  → (no frame; bracket only)
 *   step/start                              → message_start
 *   user/message                            → dropped (Halo owns the user bubble)
 *   assistant/chunk block-start             → content_block_start
 *   assistant/chunk text-delta              → content_block_delta(text_delta)
 *   assistant/chunk reasoning-delta         → content_block_delta(thinking_delta)
 *   assistant/chunk tool-call-delta         → content_block_delta(input_json_delta)
 *   assistant/chunk block-end               → content_block_stop + aggregate
 *   assistant/chunk usage                   → cached for message_delta / result
 *   assistant/chunk finish                  → stop_reason for message_delta
 *   assistant/message                       → aggregates for blocks the chunk
 *                                             stream never produced, then
 *                                             message_delta + message_stop and a
 *                                             usage-only assistant envelope
 *   tool/call                               → tool_use, only when the chunk
 *                                             stream did not already emit it
 *   tool/result                             → user.tool_result
 *   todo/write                              → TodoWrite tool_use + tool_result,
 *                                             only when no todo tool call is
 *                                             in flight
 *   turn/end                                → cached stop reason for `result`
 *   request/header                          → cached tool catalogue for init
 *   request/context                         → cached model name for init
 *   subagent.started                        → system.task_started
 *   subagent.finished                       → system.task_notification
 *   descendant session events               → assistant / user frames tagged
 *                                             with parent_tool_use_id
 *   session.status idle (own session)       → handled by the adapter, which
 *                                             calls endTurn()
 */

import type { DshNotification } from './types'
import type {
  DshContentBlock,
  DshMessage,
  DshSessionEvent,
  DshSessionEventNotification,
  DshSessionStatusNotification,
  DshStreamChunk,
  DshSubagentFinishedNotification,
  DshSubagentStartedNotification,
  DshTokenUsage,
  DshTurnEndReason,
} from './types/dsh-protocol'

// ============================================================================
// Normalizer
// ============================================================================

export interface DshNormalizerContext {
  /** The harness session id this normalizer speaks for. */
  sessionId: string
  /** Model name surfaced on `system.init` and every `message_start`. */
  model: string
  /**
   * Mirrors the Claude Code SDK's `includePartialMessages`. When true the
   * stream_event deltas are the sole bubble source, so text and reasoning are
   * omitted from the aggregate envelopes to avoid rendering them twice.
   * Tool_use aggregates are always emitted — they carry the id-based link a
   * tool_result needs during JSONL replay.
   */
  includePartialMessages: boolean
  /** MCP servers the runtime was told to connect. Reported on `system.init`. */
  mcpServerNames?: string[]
  /** Id factory, injectable so tests can assert on stable frame ids. */
  newId?: (prefix: string) => string
}

type CcFrame = Record<string, any>

/** What a harness stream-chunk block index maps to on the CC side. */
type BlockKind = 'text' | 'thinking' | 'tool' | 'ignored'

interface BlockState {
  /** CC content-block index. Assigned when the block is actually opened. */
  index: number
  kind: BlockKind
  /** False until `content_block_start` has been emitted. */
  opened: boolean
  stopped: boolean
  /** Accumulated text for text / thinking blocks. */
  text: string
  toolId: string
  /** CC-facing tool name (already mapped from the harness name). */
  toolName: string
  /** Accumulated raw argument JSON for tool blocks. */
  argsJson: string
}

export class DshEventNormalizer {
  private readonly context: DshNormalizerContext
  private readonly newId: (prefix: string) => string

  /** True between `beginTurn()` and `endTurn()`. */
  private turnOpen = false
  private terminal = false

  private messageOpen = false
  private messageId: string | null = null
  private nextBlockIndex = 0
  /** Harness stream-chunk index → CC block. Cleared at every message boundary. */
  private blocks = new Map<number, BlockState>()
  /**
   * Chunk indexes already delivered in the current message. `blocks` alone
   * cannot answer this: a block is removed from it the moment `block-end`
   * closes it, and the assembled `assistant/message` that follows repeats
   * every block — which would replay the whole message a second time.
   */
  private deliveredBlockIndexes = new Set<number>()

  /** Tool call ids already surfaced as a `tool_use` during this turn. */
  private emittedToolCallIds = new Set<string>()
  /** Tool call ids dispatched but not yet resolved, newest last. */
  private openToolCallIds: string[] = []
  /** Unresolved calls to the runtime's todo tool. */
  private readonly todoToolCallIds = new Set<string>()
  private hasToolUseInTurn = false

  /** Usage of the current model call, from the `usage` stream chunk. */
  private stepUsage: DshTokenUsage | null = null
  /** Sum of every model call in the interval; the `result` frame's payload. */
  private turnUsage: DshTokenUsage | null = null
  /** Stop reason from the last `finish` chunk of the current model call. */
  private finishKind: string | null = null
  /** Reason from the last `turn/end` seen in this interval. */
  private lastTurnEnd: DshTurnEndReason | null = null
  /** Failure text from a `turn/end` error or an errored `finish`. */
  private failureMessage: string | null = null

  /** Last assistant text of the interval; the `result` frame's payload. */
  private finalText = ''

  /** Tool schema names from the most recent `request/header`. */
  private toolCatalogue: string[] = []

  /** Descendant session id → the parent tool_use id that spawned it. */
  private readonly descendants = new Map<string, string>()

  constructor(context: DshNormalizerContext) {
    this.context = context
    this.newId = context.newId ?? ((prefix) =>
      `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
  }

  /** Session ids this normalizer accepts events for: own plus descendants. */
  isKnownSession(sessionId: string): boolean {
    return sessionId === this.context.sessionId || this.descendants.has(sessionId)
  }

  /** True once the interval's terminal `result` frame has been produced. */
  isTerminal(): boolean {
    return this.terminal
  }

  /**
   * Adopt the runtime-assigned session id. Halo persists `system.init`'s
   * `session_id`, so the value has to be the one the runtime knows before the
   * first init frame is built.
   */
  setSessionId(sessionId: string): void {
    this.context.sessionId = sessionId
  }

  /**
   * Open a turn interval. Called by the adapter when the prompt's durable
   * inbox receipt appears. Emits `system.init`, the frame Halo's
   * session-consumer reads as "a turn started" — never emit it on warmup, or
   * the UI enters the thinking state with no `result` to leave it.
   */
  beginTurn(): CcFrame[] {
    this.resetTurn()
    this.turnOpen = true
    return [this.createInit()]
  }

  /**
   * Close the turn interval: flush anything the runtime left open, then emit
   * the terminal `result`. Called by the adapter on the session's whole-agent
   * `idle`, or on runtime loss with an explicit failure.
   */
  endTurn(failure?: string): CcFrame[] {
    if (this.terminal) return []
    const frames: CcFrame[] = []
    if (!this.turnOpen) return []
    if (failure) this.failureMessage = failure

    for (const state of Array.from(this.blocks.values())) {
      frames.push(...this.stopBlock(state))
      frames.push(...this.aggregateBlock(state))
    }
    this.blocks.clear()
    frames.push(...this.closeMessage())
    frames.push(this.createResult(failure !== undefined))

    this.turnOpen = false
    this.terminal = true
    return frames
  }

  /**
   * Dispatch one runtime notification. Returns the CC frames it produces, in
   * emission order. Notifications for sessions this normalizer does not track,
   * and everything arriving after the terminal `result`, are dropped.
   */
  handle(notification: DshNotification): CcFrame[] {
    if (this.terminal) return []
    switch (notification.method) {
      case 'session.event':
        return this.handleSessionEvent(notification.payload as DshSessionEventNotification)
      case 'subagent.started':
        return this.handleSubagentStarted(notification.payload as DshSubagentStartedNotification)
      case 'subagent.finished':
        return this.handleSubagentFinished(notification.payload as DshSubagentFinishedNotification)
      case 'session.status':
        // Whole-agent transitions bound the turn interval, which the adapter
        // owns — it calls endTurn() so it can also stop pumping the stream.
        return []
      default:
        return []
    }
  }

  /** Whether this status notification closes our own turn interval. */
  isOwnIdle(notification: DshNotification): boolean {
    if (notification.method !== 'session.status') return false
    const payload = notification.payload as DshSessionStatusNotification
    return payload?.sessionId === this.context.sessionId && payload?.status === 'idle'
  }

  // ==========================================================================
  // Session events
  // ==========================================================================

  private handleSessionEvent(payload: DshSessionEventNotification): CcFrame[] {
    const sessionId = payload?.sessionId
    const event = payload?.event
    if (!sessionId || !event?.type) return []
    if (sessionId !== this.context.sessionId) {
      return this.descendants.has(sessionId) ? this.handleDescendantEvent(sessionId, event) : []
    }
    if (!this.turnOpen) return []

    const data = event.data ?? {}
    switch (event.type) {
      case 'step/start':
        return this.openMessage()
      case 'assistant/chunk':
        return this.handleChunk(data.chunk as DshStreamChunk | undefined)
      case 'assistant/message':
        return this.handleAssistantMessage(
          data.message as DshMessage | undefined,
          data.usage as DshTokenUsage | undefined,
        )
      case 'tool/call':
        return this.handleToolCall(data)
      case 'tool/result':
        return this.handleToolResult(data)
      case 'todo/write':
        return this.handleTodoWrite(data.todos)
      case 'turn/end':
        this.lastTurnEnd = data.reason as DshTurnEndReason
        if (this.lastTurnEnd?.kind === 'error') {
          this.failureMessage = this.lastTurnEnd.error?.message || 'dsh turn failed'
        }
        return []
      case 'request/header':
        this.toolCatalogue = extractToolNames(data.header)
        return []
      case 'request/context':
        if (typeof data.model === 'string' && data.model) this.context.model = data.model
        return []
      default:
        // turn/start, step/end, user/message, session/end-seed and any
        // plugin-merged event carry no CC-visible payload. `user/message`
        // in particular is dropped on purpose: Halo already rendered the
        // user's own bubble, and runtime-injected context has no CC frame
        // that would not read as a stray user turn.
        return []
    }
  }

  private handleChunk(chunk: DshStreamChunk | undefined): CcFrame[] {
    if (!chunk?.type) return []
    switch (chunk.type) {
      case 'block-start':
        return this.startBlock(chunk.index ?? 0, chunk.blockType ?? 'text')
      case 'text-delta':
        return this.appendText(chunk.index ?? 0, chunk.text ?? '')
      case 'reasoning-delta':
        return this.appendReasoning(chunk.index ?? 0, chunk.text ?? '')
      case 'tool-call-delta':
        return this.appendToolArguments(chunk)
      case 'block-end':
        return this.endBlock(chunk.index ?? 0, chunk.block)
      case 'usage':
        if (chunk.usage) {
          this.stepUsage = chunk.usage
          this.turnUsage = addUsage(this.turnUsage, chunk.usage)
        }
        return []
      case 'finish':
        return this.handleFinish(chunk.reason)
      default:
        return []
    }
  }

  private handleFinish(reason: DshStreamChunk['reason']): CcFrame[] {
    const kind = reason?.kind ?? 'stop'
    this.finishKind = kind
    if (kind !== 'error' && kind !== 'aborted') return []

    // A failed model call still left its partial blocks open. Close them
    // without aggregating: half a sentence is not content worth committing to
    // the timeline, and a retry will stream the block again from index 0.
    this.failureMessage = reason?.failure?.message || this.failureMessage
    const frames: CcFrame[] = []
    for (const state of Array.from(this.blocks.values())) frames.push(...this.stopBlock(state))
    this.blocks.clear()
    return frames
  }

  private handleAssistantMessage(message: DshMessage | undefined, usage: DshTokenUsage | undefined): CcFrame[] {
    const frames: CcFrame[] = []
    if (usage && !this.stepUsage) {
      this.stepUsage = usage
      this.turnUsage = addUsage(this.turnUsage, usage)
    }

    // Adapters that do not replay `block-end` (or a resumed log whose chunks
    // were pruned) leave the assembled message as the only source for some
    // blocks. Emit those now, still ahead of any `tool/call`.
    const content = Array.isArray(message?.content) ? message!.content! : []
    for (let i = 0; i < content.length; i++) {
      if (this.deliveredBlockIndexes.has(i)) continue
      frames.push(...this.synthesizeBlock(i, content[i]))
    }
    for (const state of Array.from(this.blocks.values())) {
      frames.push(...this.stopBlock(state))
      frames.push(...this.aggregateBlock(state))
    }
    this.blocks.clear()

    frames.push(...this.closeMessage())

    // Per-call token accounting rides its own envelope: the harness reports
    // usage only once the whole message is assembled, after every block
    // aggregate has already been emitted. An empty-content assistant frame is
    // invisible to `parseSDKMessage` but is exactly what `context-usage`
    // reads to size the context indicator.
    if (this.stepUsage) {
      frames.push({
        type: 'assistant',
        message: {
          id: this.messageId ?? this.newId('dsh-msg'),
          role: 'assistant',
          model: this.context.model,
          content: [],
          usage: toClaudeUsage(this.stepUsage),
        },
      })
    }
    this.stepUsage = null
    this.finishKind = null
    return frames
  }

  private handleToolCall(data: Record<string, any>): CcFrame[] {
    const callId = typeof data.callId === 'string' ? data.callId : ''
    if (!callId) return []
    const harnessName = typeof data.name === 'string' ? data.name : ''
    if (isTodoTool(harnessName)) this.todoToolCallIds.add(callId)
    this.openToolCallIds.push(callId)

    // The chunk stream normally already produced this tool_use. `tool/call` is
    // the authoritative record, so it doubles as the fallback for a runtime
    // that recorded no chunks — without it a `tool/result` would arrive with
    // nothing to link to.
    if (this.emittedToolCallIds.has(callId)) return []
    const frames: CcFrame[] = []
    if (!this.messageOpen) frames.push(...this.openMessage())
    const state = this.createBlockState('tool', callId, mapToolName(harnessName))
    state.argsJson = typeof data.arguments === 'string' ? data.arguments : ''
    frames.push(...this.openToolBlock(state))
    frames.push(...this.stopBlock(state))
    frames.push(...this.aggregateBlock(state))
    return frames
  }

  private handleToolResult(data: Record<string, any>): CcFrame[] {
    const message = data.message as DshMessage | undefined
    const block = message?.content?.[0]
    const toolUseId = block?.toolCallId || ''
    if (!toolUseId) return []
    const isError = Boolean(block?.isError) || Boolean(data.error)
    this.openToolCallIds = this.openToolCallIds.filter((id) => id !== toolUseId)
    this.todoToolCallIds.delete(toolUseId)
    return [userWithToolResult(toolUseId, flattenBlocks(block?.content), isError)]
  }

  private handleTodoWrite(todos: unknown): CcFrame[] {
    // The list is a log-only snapshot the `todo_write` tool appends as a side
    // effect of its own call, so it is already on screen as that tool's card.
    // It is only worth a synthetic card when a deployment wrote it directly.
    if (this.todoToolCallIds.size > 0 || !Array.isArray(todos)) return []
    const frames: CcFrame[] = []
    if (!this.messageOpen) frames.push(...this.openMessage())
    const state = this.createBlockState('tool', this.newId('dsh-todo'), 'TodoWrite')
    state.argsJson = JSON.stringify({ todos })
    frames.push(...this.openToolBlock(state))
    frames.push(...this.stopBlock(state))
    frames.push(...this.aggregateBlock(state))
    frames.push(userWithToolResult(state.toolId, 'Todos updated', false))
    return frames
  }

  // ==========================================================================
  // Subagents
  // ==========================================================================

  /**
   * Children run inside the runtime, so Halo watches rather than drives them.
   * `subagent.started` names the parent and child sessions but not the tool
   * call that spawned the child; the delegating `tool/call` is the one still
   * awaiting its result when the child appears, which is what links the two.
   */
  private handleSubagentStarted(payload: DshSubagentStartedNotification): CcFrame[] {
    const childSessionId = payload?.childSessionId
    const parentSessionId = payload?.parentSessionId
    if (!childSessionId || !parentSessionId) return []
    if (!this.isKnownSession(parentSessionId)) return []

    const parentToolUseId = this.openToolCallIds[this.openToolCallIds.length - 1]
    this.descendants.set(childSessionId, parentToolUseId ?? childSessionId)
    if (!parentToolUseId) return []
    return [{
      type: 'system',
      subtype: 'task_started',
      session_id: this.context.sessionId,
      task_id: childSessionId,
      tool_use_id: parentToolUseId,
    }]
  }

  private handleSubagentFinished(payload: DshSubagentFinishedNotification): CcFrame[] {
    const childSessionId = payload?.childSessionId
    if (!childSessionId || !this.descendants.has(childSessionId)) return []
    return [{
      type: 'system',
      subtype: 'task_notification',
      session_id: this.context.sessionId,
      task_id: childSessionId,
      status: taskStatusFrom(payload?.status, payload?.stopReason),
    }]
  }

  /**
   * Descendant sessions reach the timeline as the CC subagent protocol does:
   * complete assistant / user frames tagged with `parent_tool_use_id`, which
   * `stream-processor` routes to `subagent-handler` without knowing the
   * engine. Their token-level chunks stay inside the child.
   */
  private handleDescendantEvent(sessionId: string, event: DshSessionEvent): CcFrame[] {
    const parentToolUseId = this.descendants.get(sessionId)
    if (!parentToolUseId) return []
    const data = event.data ?? {}

    if (event.type === 'assistant/message') {
      const content = (data.message as DshMessage | undefined)?.content
      const blocks = toCcContent(Array.isArray(content) ? content : [])
      if (blocks.length === 0) return []
      return [{
        type: 'assistant',
        parent_tool_use_id: parentToolUseId,
        message: { id: this.newId('dsh-sub'), role: 'assistant', content: blocks },
      }]
    }
    if (event.type === 'tool/result') {
      const block = (data.message as DshMessage | undefined)?.content?.[0]
      const toolUseId = block?.toolCallId
      if (!toolUseId) return []
      const isError = Boolean(block?.isError) || Boolean(data.error)
      return [{
        ...userWithToolResult(toolUseId, flattenBlocks(block?.content), isError),
        parent_tool_use_id: parentToolUseId,
      }]
    }
    return []
  }

  // ==========================================================================
  // Frame builders
  // ==========================================================================

  /**
   * Build the per-turn `system.init` envelope. `tools` is populated from the
   * last `request/header`, so the first turn of a session advertises an empty
   * catalogue — the runtime does not disclose its tools before it uses them.
   */
  createInit(): CcFrame {
    return {
      type: 'system',
      subtype: 'init',
      session_id: this.context.sessionId,
      model: this.context.model,
      tools: [...this.toolCatalogue],
      mcp_servers: this.mcpServerStatuses(),
      slash_commands: [],
      skills: [],
      agents: [],
    }
  }

  /**
   * Per-server status for `system.init`, which is what drives Halo's MCP panel.
   *
   * The runtime reports no connection state, so the evidence is indirect: a
   * connected server's tools appear in the catalogue under its
   * `mcp__<server>__` prefix. A server whose tools have not been seen is
   * `pending` rather than `connected` — the composition lets a server fail
   * without taking the session down, so a configured server is not a reachable
   * one. Turn one advertises an empty catalogue, so everything starts pending.
   */
  private mcpServerStatuses(): { name: string; status: string }[] {
    return (this.context.mcpServerNames ?? []).map((name) => ({
      name,
      status: this.toolCatalogue.some((tool) => tool.startsWith(`mcp__${name}__`))
        ? 'connected'
        : 'pending',
    }))
  }

  createResult(isError: boolean): CcFrame {
    const usage = this.turnUsage ? toClaudeUsage(this.turnUsage) : undefined
    const outcome = resultOutcome(this.lastTurnEnd?.kind, isError)
    return {
      type: 'result',
      subtype: outcome.subtype,
      session_id: this.context.sessionId,
      result: outcome.isError ? (this.failureMessage || 'dsh run failed') : this.finalText,
      is_error: outcome.isError,
      usage,
      cumulative_usage: usage,
      stop_reason: outcome.stopReason,
    }
  }

  private openMessage(): CcFrame[] {
    const frames: CcFrame[] = []
    if (this.messageOpen) {
      // A `step/start` with the previous step still open means the runtime
      // never closed it (a rejected pre-step, or a log we joined mid-stream).
      for (const state of Array.from(this.blocks.values())) {
        frames.push(...this.stopBlock(state))
        frames.push(...this.aggregateBlock(state))
      }
      this.blocks.clear()
      frames.push(...this.closeMessage())
    }
    this.messageOpen = true
    this.messageId = this.newId('dsh-msg')
    this.nextBlockIndex = 0
    this.blocks.clear()
    this.deliveredBlockIndexes.clear()
    frames.push(streamEvent({
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
    }))
    return frames
  }

  private closeMessage(): CcFrame[] {
    if (!this.messageOpen) return []
    this.messageOpen = false
    return [
      streamEvent({
        type: 'message_delta',
        delta: { stop_reason: stopReasonFrom(this.finishKind, this.hasToolUseInTurn), stop_sequence: null },
        usage: this.stepUsage ? toClaudeUsage(this.stepUsage) : emptyUsage(),
      }),
      streamEvent({ type: 'message_stop' }),
    ]
  }

  private createBlockState(kind: BlockKind, toolId: string, toolName: string): BlockState {
    return {
      index: this.nextBlockIndex++,
      kind,
      opened: false,
      stopped: false,
      text: '',
      toolId,
      toolName,
      argsJson: '',
    }
  }

  private startBlock(chunkIndex: number, blockType: string): CcFrame[] {
    if (this.blocks.has(chunkIndex)) return []
    const frames: CcFrame[] = []
    if (!this.messageOpen) frames.push(...this.openMessage())
    this.deliveredBlockIndexes.add(chunkIndex)

    if (blockType === 'tool-call') {
      // The id and name only arrive with the first `tool-call-delta`, and CC's
      // `content_block_start` needs both. Reserve the slot and open it there.
      const state = this.createBlockState('tool', '', '')
      this.blocks.set(chunkIndex, state)
      return frames
    }
    const kind: BlockKind = blockType === 'text' ? 'text' : blockType === 'reasoning' ? 'thinking' : 'ignored'
    const state = this.createBlockState(kind, '', '')
    this.blocks.set(chunkIndex, state)
    if (kind === 'ignored') {
      // Nothing in the CC vocabulary renders an assistant-side image block.
      // Reserving the slot keeps its deltas from opening a phantom text block.
      this.nextBlockIndex--
      return frames
    }
    state.opened = true
    frames.push(streamEvent({
      type: 'content_block_start',
      index: state.index,
      content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
    }))
    return frames
  }

  private appendText(chunkIndex: number, text: string): CcFrame[] {
    if (!text) return []
    const frames: CcFrame[] = []
    let state = this.blocks.get(chunkIndex)
    if (!state) {
      frames.push(...this.startBlock(chunkIndex, 'text'))
      state = this.blocks.get(chunkIndex)
    }
    if (!state || state.kind !== 'text') return frames
    state.text += text
    frames.push(streamEvent({
      type: 'content_block_delta',
      index: state.index,
      delta: { type: 'text_delta', text },
    }))
    return frames
  }

  private appendReasoning(chunkIndex: number, text: string): CcFrame[] {
    if (!text) return []
    const frames: CcFrame[] = []
    let state = this.blocks.get(chunkIndex)
    if (!state) {
      frames.push(...this.startBlock(chunkIndex, 'reasoning'))
      state = this.blocks.get(chunkIndex)
    }
    if (!state || state.kind !== 'thinking') return frames
    state.text += text
    frames.push(streamEvent({
      type: 'content_block_delta',
      index: state.index,
      delta: { type: 'thinking_delta', thinking: text },
    }))
    return frames
  }

  private appendToolArguments(chunk: DshStreamChunk): CcFrame[] {
    const chunkIndex = chunk.index ?? 0
    const frames: CcFrame[] = []
    let state = this.blocks.get(chunkIndex)
    if (!state) {
      frames.push(...this.startBlock(chunkIndex, 'tool-call'))
      state = this.blocks.get(chunkIndex)
    }
    if (!state || state.kind !== 'tool') return frames

    if (!state.opened) {
      state.toolId = chunk.id || state.toolId || this.newId('dsh-call')
      state.toolName = mapToolName(chunk.name || state.toolName)
      frames.push(...this.openToolBlock(state))
    }
    const delta = chunk.argumentsDelta ?? ''
    if (delta) {
      state.argsJson += delta
      frames.push(streamEvent({
        type: 'content_block_delta',
        index: state.index,
        delta: { type: 'input_json_delta', partial_json: delta },
      }))
    }
    return frames
  }

  private openToolBlock(state: BlockState): CcFrame[] {
    state.opened = true
    this.hasToolUseInTurn = true
    if (state.toolId) this.emittedToolCallIds.add(state.toolId)
    if (isTodoTool(state.toolName) && state.toolId) this.todoToolCallIds.add(state.toolId)
    return [streamEvent({
      type: 'content_block_start',
      index: state.index,
      content_block: { type: 'tool_use', id: state.toolId, name: state.toolName, input: {} },
    })]
  }

  private endBlock(chunkIndex: number, block: DshContentBlock | undefined): CcFrame[] {
    const state = this.blocks.get(chunkIndex)
    if (!state) return []
    const frames: CcFrame[] = []

    // The assembled block is the authority: an adapter may deliver a block
    // whole, with no deltas at all.
    if (state.kind === 'text' && !state.text && block?.text) {
      frames.push(...this.appendText(chunkIndex, block.text))
    } else if (state.kind === 'thinking' && !state.text && block?.text) {
      frames.push(...this.appendReasoning(chunkIndex, block.text))
    } else if (state.kind === 'tool' && !state.opened) {
      state.toolId = block?.id || this.newId('dsh-call')
      state.toolName = mapToolName(block?.name || '')
      state.argsJson = block?.arguments ?? ''
      frames.push(...this.openToolBlock(state))
      if (state.argsJson) {
        frames.push(streamEvent({
          type: 'content_block_delta',
          index: state.index,
          delta: { type: 'input_json_delta', partial_json: state.argsJson },
        }))
      }
    }

    frames.push(...this.stopBlock(state))
    frames.push(...this.aggregateBlock(state))
    this.blocks.delete(chunkIndex)
    return frames
  }

  /** Emit a block that only ever existed in the assembled assistant message. */
  private synthesizeBlock(chunkIndex: number, block: DshContentBlock | undefined): CcFrame[] {
    if (!block?.type) return []
    const frames: CcFrame[] = []
    if (block.type === 'text' || block.type === 'reasoning') {
      const isText = block.type === 'text'
      frames.push(...this.startBlock(chunkIndex, isText ? 'text' : 'reasoning'))
      frames.push(...(isText
        ? this.appendText(chunkIndex, block.text ?? '')
        : this.appendReasoning(chunkIndex, block.text ?? '')))
      return frames
    }
    if (block.type === 'tool-call') {
      frames.push(...this.startBlock(chunkIndex, 'tool-call'))
      const state = this.blocks.get(chunkIndex)
      if (!state) return frames
      state.toolId = block.id || this.newId('dsh-call')
      state.toolName = mapToolName(block.name || '')
      state.argsJson = block.arguments ?? ''
      frames.push(...this.openToolBlock(state))
      if (state.argsJson) {
        frames.push(streamEvent({
          type: 'content_block_delta',
          index: state.index,
          delta: { type: 'input_json_delta', partial_json: state.argsJson },
        }))
      }
    }
    return frames
  }

  private stopBlock(state: BlockState): CcFrame[] {
    if (!state.opened || state.stopped) return []
    state.stopped = true
    return [streamEvent({ type: 'content_block_stop', index: state.index })]
  }

  /**
   * The aggregate `type: 'assistant'` envelope for one completed block.
   *
   * Consumers that follow the Claude SDK's top-level message contract read
   * only this frame: `apps/runtime/execute.ts` for final text, `app-chat.ts`
   * for `lastAssistantText`, and session-store's JSONL replay for message
   * reconstruction. An engine that emits stream_events alone is invisible to
   * all three.
   *
   * Text and thinking are suppressed while stream_events are the live bubble
   * source, because both paths feed the same renderer state and would render
   * the content twice. Tool_use is never suppressed: it carries the id a
   * tool_result links against on replay, and it must precede that result.
   */
  private aggregateBlock(state: BlockState): CcFrame[] {
    if (!state.opened) return []
    if (state.kind === 'text') {
      if (!state.text) return []
      this.finalText = state.text
      if (this.context.includePartialMessages) return []
      return [assistantWithBlocks(this.newId('dsh-msg'), [{ type: 'text', text: state.text }])]
    }
    if (state.kind === 'thinking') {
      if (!state.text || this.context.includePartialMessages) return []
      return [assistantWithBlocks(this.newId('dsh-msg'), [{ type: 'thinking', thinking: state.text }])]
    }
    if (state.kind === 'tool') {
      return [assistantWithBlocks(this.newId('dsh-msg'), [{
        type: 'tool_use',
        id: state.toolId,
        name: state.toolName,
        input: parseJsonObject(state.argsJson),
      }])]
    }
    return []
  }

  private resetTurn(): void {
    this.terminal = false
    this.messageOpen = false
    this.messageId = null
    this.nextBlockIndex = 0
    this.blocks.clear()
    this.deliveredBlockIndexes.clear()
    this.emittedToolCallIds.clear()
    this.openToolCallIds = []
    this.todoToolCallIds.clear()
    this.hasToolUseInTurn = false
    this.stepUsage = null
    this.turnUsage = null
    this.finishKind = null
    this.lastTurnEnd = null
    this.failureMessage = null
    this.finalText = ''
    this.descendants.clear()
  }
}

// ============================================================================
// Pure helpers
// ============================================================================

function streamEvent(event: Record<string, unknown>): CcFrame {
  return { type: 'stream_event', event }
}

function assistantWithBlocks(id: string, content: unknown[]): CcFrame {
  return { type: 'assistant', message: { id, role: 'assistant', content } }
}

function userWithToolResult(toolUseId: string, content: string, isError: boolean): CcFrame {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
  }
}

/**
 * Harness tool names are the runtime's own snake_case registrations. Mapping
 * them onto CC tool kinds is what lets Halo's renderer pick a real card
 * instead of the generic fallback; unknown names pass through untouched.
 * Keep in step with `capabilities.tools.synthetic`.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  pwsh: 'Bash',
  read: 'Read',
  read_image: 'Read',
  write: 'Write',
  edit: 'Edit',
  str_replace_editor: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  todo_write: 'TodoWrite',
  ask_user_question: 'AskUserQuestion',
  skill: 'Skill',
  subagent: 'Task',
}

function mapToolName(name: string): string {
  if (!name) return 'Unknown'
  return TOOL_NAME_MAP[name] ?? name
}

function isTodoTool(name: string): boolean {
  return name === 'todo_write' || name === 'TodoWrite'
}

/** Flatten harness result content into the plain string a CC tool_result carries. */
function flattenBlocks(blocks: DshContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  return blocks.map((block) => {
    if (block?.type === 'text') return block.text ?? ''
    if (block?.type === 'image') return '[image]'
    return JSON.stringify(block)
  }).join('\n')
}

/** Project harness content blocks onto the CC block shapes subagent-handler reads. */
function toCcContent(blocks: DshContentBlock[]): unknown[] {
  const out: unknown[] = []
  for (const block of blocks) {
    if (block?.type === 'text' && block.text) out.push({ type: 'text', text: block.text })
    else if (block?.type === 'tool-call') {
      out.push({
        type: 'tool_use',
        id: block.id ?? '',
        name: mapToolName(block.name ?? ''),
        input: parseJsonObject(block.arguments ?? ''),
      })
    }
  }
  return out
}

function extractToolNames(header: unknown): string[] {
  const tools = (header as { tools?: Array<{ name?: string }> } | undefined)?.tools
  if (!Array.isArray(tools)) return []
  return tools.map((tool) => mapToolName(tool?.name ?? '')).filter(Boolean)
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed }
  } catch {
    return {}
  }
}

function stopReasonFrom(finishKind: string | null, hasToolUse: boolean): string {
  switch (finishKind) {
    case 'tool-calls': return 'tool_use'
    case 'max-tokens': return 'max_tokens'
    case 'stop': return 'end_turn'
    default: return hasToolUse ? 'tool_use' : 'end_turn'
  }
}

/**
 * Map the harness turn-end vocabulary onto the three `result` shapes Halo's
 * stream-processor distinguishes: success, a graceful token-ceiling stop, and
 * an interrupted run. Only a genuine failure sets `is_error` — an aborted or
 * blocked turn is an interruption, and flagging it as an error would surface a
 * provider-error banner the user never hit.
 */
function resultOutcome(
  turnEndKind: string | undefined,
  forcedError: boolean,
): { subtype: string; isError: boolean; stopReason: string } {
  if (forcedError || turnEndKind === 'error') {
    return { subtype: 'error_during_execution', isError: true, stopReason: 'error' }
  }
  if (turnEndKind === 'max-tokens') {
    return { subtype: 'error_max_turns', isError: false, stopReason: 'max_tokens' }
  }
  if (turnEndKind === 'aborted' || turnEndKind === 'blocked' || turnEndKind === 'interrupted') {
    return { subtype: 'error_during_execution', isError: false, stopReason: 'interrupted' }
  }
  return { subtype: 'success', isError: false, stopReason: 'end_turn' }
}

function taskStatusFrom(status: string | undefined, stopReason: string | undefined): string {
  if (status === 'ok' && (stopReason === undefined || stopReason === 'completed')) return 'completed'
  if (stopReason === 'aborted') return 'stopped'
  return status === 'ok' ? 'completed' : 'failed'
}

function addUsage(base: DshTokenUsage | null, next: DshTokenUsage): DshTokenUsage {
  if (!base) return { ...next }
  return {
    inputTokens: (base.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (base.outputTokens ?? 0) + (next.outputTokens ?? 0),
    cacheReadTokens: (base.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheWriteTokens: (base.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
    reasoningTokens: (base.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
  }
}

/**
 * Harness counts are disjoint (uncached input, cache reads, and cache writes
 * are reported separately), which is the same convention CC's usage fields
 * follow, so the mapping is field-for-field.
 */
function toClaudeUsage(usage: DshTokenUsage): Record<string, number> {
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cache_read_input_tokens: usage.cacheReadTokens ?? 0,
    cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
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
