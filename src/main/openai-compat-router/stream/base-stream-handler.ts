/**
 * Base Stream Handler
 *
 * Provides shared functionality for stream conversion:
 * - State management
 * - Block lifecycle management
 * - SSE parsing utilities
 */

import { Readable } from 'node:stream'
import type { Response as ExpressResponse } from 'express'
import { jsonrepair } from 'jsonrepair'
import { SSEWriter } from './sse-writer'
import type { AnthropicStopReason, AnthropicWebSearchResult, StreamToolCallState } from '../types'
import { safeJsonParse } from '../utils'
import { estimateUsageTokens } from '../utils/usage-estimator'
import { createEmptyUsage, type NormalizedUsage } from '../converters/response/usage'

// ============================================================================
// Stream State
// ============================================================================

export interface StreamState {
  started: boolean
  finished: boolean
  messageId: string
  model: string
  /** The block deltas go to; null between blocks. */
  currentBlock: {
    index: number
    type: 'text' | 'thinking' | 'tool_use' | 'web_search_tool_result'
    /** Upstream tool-call key of a tool_use block. */
    toolIndex?: number
  } | null
  /** Index the next block takes; an index is never reused within a message. */
  nextBlockIndex: number
  /** Set once a non-thinking block opens; thinking after that is dropped. */
  reasoningClosed: boolean
  usage: NormalizedUsage
  stopReason: AnthropicStopReason | null
  // Debug: accumulated content
  accumulatedText: string
  accumulatedThinking: string
}

type BlockType = NonNullable<StreamState['currentBlock']>['type']

interface ToolCallState extends StreamToolCallState {
  output: 'streaming' | 'queued' | 'delivered'
  emittedChars: number
  complete: boolean
}

type DeferredBlock =
  | { type: 'tool_use'; index: number; tool: ToolCallState }
  | { type: 'text' | 'thinking'; index: number; start: number; end: number; signature?: string }
  | { type: 'web_search_tool_result'; index: number; toolUseId: string; results: AnthropicWebSearchResult[] }

export function createInitialState(model: string): StreamState {
  return {
    started: false,
    finished: false,
    messageId: `msg_${Date.now()}`,
    model,
    currentBlock: null,
    nextBlockIndex: 0,
    reasoningClosed: false,
    usage: createEmptyUsage(),
    stopReason: null,
    accumulatedText: '',
    accumulatedThinking: ''
  }
}

/**
 * Whether incomplete tool arguments may be closed with `suffix`: it only
 * closes brackets, and the arguments end right after a whole
 * string, container, `true`, `false` or `null`. A number may still be growing
 * (`90` of `9000`) and an unfinished string needs a quote, so neither passes.
 */
function closesAfterWholeValue(args: string, suffix: string): boolean {
  return /^[\s\]}]+$/.test(suffix) && /["\]}el]\s*$/.test(args)
}

// ============================================================================
// Base Stream Handler
// ============================================================================

export interface StreamHandlerOptions {
  model?: string
  debug?: boolean
  /**
   * Deferred input-token estimate started at request dispatch (see
   * usage-estimator.ts). Awaited only when the upstream omitted usage —
   * settled long before stream finish, so the await never blocks.
   */
  estimateInputTokens?: () => Promise<number>
}

export abstract class BaseStreamHandler {
  protected writer: SSEWriter
  protected state: StreamState
  protected debug: boolean
  private estimateInputTokens?: () => Promise<number>

  // Tool call tracking
  protected toolCallMap = new Map<number, ToolCallState>()
  protected toolIndexToBlock = new Map<number, number>()
  /** Whitespace-only text chunks dropped while a tool call was open. */
  private droppedToolCallWhitespace = 0
  // Only an unfinished tool holds up following blocks. Its arguments can keep
  // arriving under an earlier index; that tail is checked again at stream end.
  private deferredBlocks: DeferredBlock[] | null = null
  private pendingError: string | null = null
  private streamFailure: string | null = null

  constructor(res: ExpressResponse, options: StreamHandlerOptions = {}) {
    this.writer = new SSEWriter(res, { debug: options.debug })
    this.state = createInitialState(options.model || 'unknown')
    this.debug = options.debug ?? false
    this.estimateInputTokens = options.estimateInputTokens
  }

  /**
   * Process the incoming stream and convert to Anthropic format
   */
  abstract processStream(stream: unknown): Promise<void>

  // ============================================================================
  // State Management
  // ============================================================================

  protected get isFinished(): boolean {
    return this.state.finished || this.writer.isClosed
  }

  protected markFinished(): void {
    this.state.finished = true
  }

  protected markStreamCompleted(): void {
    if (this.state.stopReason === null && !this.pendingError) {
      this.state.stopReason = this.toolCallMap.size > 0 ? 'tool_use' : 'end_turn'
    }
  }

  protected handleStreamError(error: unknown): void {
    if (this.writer.isClosed || this.pendingError) return
    const detail = error as { name?: unknown; code?: unknown; cause?: { code?: unknown }; message?: unknown } | null
    const identifier = (value: unknown) => typeof value === 'string' && /^[\w.-]{1,80}$/.test(value) ? value : 'unknown'
    // Transport errors may embed a URL or quote a payload; neither belongs in main.log.
    const message = typeof detail?.message === 'string'
      ? detail.message.replace(/https?:\/\/\S+/gi, '<url>')
        .replace(/(["'`])[\s\S]*?\1/g, '<redacted>')
        .replace(/[\[{][\s\S]*/, '<redacted>')
        .replace(/\?[^\s]*/g, '?<redacted>')
        .replace(/[\r\n][\s\S]*/, '').slice(0, 200)
      : 'unknown'
    this.streamFailure = `name=${identifier(detail?.name)}, code=${identifier(detail?.code ?? detail?.cause?.code)}, message=${message}`
    if (this.state.stopReason === null) {
      this.writeError('The model response stream failed before completion. Please retry.', 'stream_failure')
    }
  }

  protected updateModel(model: string): void {
    if (model) {
      this.state.model = model
    }
  }

  protected updateUsage(usage: Partial<NormalizedUsage>): void {
    if (usage.inputTokens !== undefined) {
      this.state.usage.inputTokens = usage.inputTokens
    }
    if (usage.outputTokens !== undefined) {
      this.state.usage.outputTokens = usage.outputTokens
    }
    if (usage.cacheReadTokens !== undefined) {
      this.state.usage.cacheReadTokens = usage.cacheReadTokens
    }
    if (usage.cacheCreationTokens !== undefined) {
      this.state.usage.cacheCreationTokens = usage.cacheCreationTokens
    }
  }

  // ============================================================================
  // Message Lifecycle
  // ============================================================================

  protected ensureMessageStarted(): boolean {
    if (this.isFinished) return false

    if (!this.state.started) {
      this.state.started = true
      return this.writer.writeMessageStart(this.state.messageId, this.state.model)
    }

    return true
  }

  protected async finishMessage(): Promise<void> {
    // Only check if writer is closed, not if state is finished
    // (state.finished is set when finish_reason is received, but we still need to send final events)
    if (this.writer.isClosed) return

    if (!this.pendingError && this.state.stopReason === null) {
      if (this.toolCallMap.size === 0) this.state.stopReason = 'end_turn'
      else this.writeError('The model response ended before completion. Please retry.', 'missing_completion')
    }

    if (!this.pendingError) {
      for (const tool of this.toolCallMap.values()) {
        if (tool.output !== 'delivered' && !this.prepareToolArguments(tool)) break
      }
    }
    if (this.pendingError) {
      this.closeCurrentBlock()
      await this.applyUsageFallback()
      if (this.state.started) this.writer.writeMessageDelta(null, this.state.usage)
      this.writer.writeError(this.pendingError)
      this.writer.end()
      return
    }
    if (this.streamFailure) {
      console.warn(`[StreamHandler] Stream failed after completion (model=${this.state.model}, stop=${this.state.stopReason}, ${this.streamFailure})`)
    }
    this.closeCurrentBlock()
    this.flushDeferredBlocks()

    if (this.debug) {
      if (this.state.accumulatedThinking) {
        console.log(`[StreamHandler] Accumulated thinking:\n${this.state.accumulatedThinking}`)
      }
      if (this.state.accumulatedText) {
        console.log(`[StreamHandler] Accumulated text:\n${this.state.accumulatedText}`)
      }
    }

    // LLM response sample — one line per turn, always-on
    {
      const tools = [...this.toolCallMap.values()].map(t => t.name)
      const textPreview = this.state.accumulatedText
        ? this.state.accumulatedText.slice(0, 80).replace(/\n/g, '↵')
        : ''
      if (tools.length > 0) {
        const dropped = this.droppedToolCallWhitespace
          ? ` (dropped ${this.droppedToolCallWhitespace} whitespace text chunks inside tool calls)`
          : ''
        console.log(`[LLM] model=${this.state.model} stop=${this.state.stopReason} → tool_calls=[${tools.join(',')}]${dropped}`)
        if (this.debug) {
          for (const [idx, tc] of this.toolCallMap) {
            console.log(`[LLM] tool[${idx}] ${tc.name} args (${tc.arguments.length} chars): ${tc.arguments}`)
          }
        }
      } else if (textPreview) {
        console.log(`[LLM] model=${this.state.model} stop=${this.state.stopReason} → text="${textPreview}"`)
      } else {
        console.log(`[LLM] model=${this.state.model} stop=${this.state.stopReason} → (empty, thinking_len=${this.state.accumulatedThinking.length})`)
      }
    }

    // Repair turns that produced no actual text and no tool calls, regardless
    // of which blocks the provider happened to open (truly empty, thinking-only,
    // empty text block — all observed in the wild from GLM-4.7/5.1 et al.):
    //
    //   1. SDK contract: isResultSuccessful requires a terminal 'text' /
    //      'thinking' / 'redacted_thinking' block, else the turn is treated as
    //      an execution error and the agent loop aborts.
    //   2. History round-trip: the placeholder must be NON-empty. An empty
    //      assistant text persists into the session transcript and converts to
    //      `{role:'assistant', content: null}` without tool_calls on the next
    //      request (messages.ts `text || null`) — an invalid history message
    //      that makes providers like GLM return empty responses for every
    //      subsequent turn in the session.
    //
    if (this.state.stopReason === 'end_turn' && this.state.started) {
      const hasActualText = this.state.accumulatedText.length > 0
      const hasToolCalls = this.toolCallMap.size > 0

      if (!hasActualText && !hasToolCalls) {
        const idx = this.state.nextBlockIndex++
        this.writer.writeTextBlockStart(idx)
        this.writer.writeTextDelta(idx, ' ')
        this.writer.writeBlockStop(idx)
        console.log(`[StreamHandler] Injected placeholder text block at index ${idx} (model=${this.state.model}, stop=${this.state.stopReason ?? 'null'}, thinking_len=${this.state.accumulatedThinking.length})`)
      }
    }

    await this.applyUsageFallback()

    // Write message_delta
    this.writer.writeMessageDelta(this.state.stopReason || 'end_turn', this.state.usage)

    // Write message_stop
    this.writer.writeMessageStop()

    // End response
    this.writer.end()

    this.state.finished = true
  }

  /**
   * Bias-high usage fallback for upstreams that omit usage entirely.
   *
   * The final message_delta is the single source of token accounting for
   * every downstream consumer (SDK context display, llm.invocation telemetry,
   * automation run records); leaving it at 0 silently zeroes all of them.
   * Estimation contract: may over-count, must never under-count (see
   * usage-estimator.ts).
   *
   * Input side awaits the deferred estimate started at dispatch time — by
   * stream finish it has settled, so the await is a resolved-promise
   * microtask. Output side runs a single char pass over text already
   * accumulated in state (KB-scale).
   *
   * Gated on `state.started`: a stream that never produced a message (e.g.
   * upstream error before any chunk) was likely never charged, so no tokens
   * are attributed to it.
   *
   * The input side keys off the whole prompt accounting, not `inputTokens`
   * alone: a fully cache-hit prompt legitimately reports zero new input, and
   * estimating over it would replace a truthful zero with a full-context guess.
   */
  private async applyUsageFallback(): Promise<void> {
    if (!this.state.started) return
    const usage = this.state.usage
    const hasPromptAccounting =
      usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens > 0
    if (hasPromptAccounting && usage.outputTokens > 0) return

    try {
      const needInput = !hasPromptAccounting && !!this.estimateInputTokens
      const needOutput = usage.outputTokens === 0

      if (needInput) {
        usage.inputTokens = await this.estimateInputTokens!()
      }
      if (needOutput) {
        let raw = estimateUsageTokens(this.state.accumulatedText)
        raw += estimateUsageTokens(this.state.accumulatedThinking)
        for (const tc of this.toolCallMap.values()) {
          raw += estimateUsageTokens(tc.arguments)
        }
        if (raw > 0) usage.outputTokens = raw
      }
      if (needInput || needOutput) {
        console.log(
          `[StreamHandler] usage fallback applied: input=${usage.inputTokens} output=${usage.outputTokens} (bias-high estimate, model=${this.state.model})`
        )
      }
    } catch (err) {
      // Fallback must never break stream finalization.
      console.warn('[StreamHandler] usage fallback failed:', err)
    }
  }

  // ============================================================================
  // Block Lifecycle
  // ============================================================================
  // One block is open at a time, and each block takes the next index: a client
  // that checks the Messages stream rejects a start at an index already used,
  // even one whose block has stopped.

  /** Close the open block and give a new block the next index. */
  private beginBlock(type: BlockType, toolIndex?: number): number {
    this.closeCurrentBlock()
    const index = this.state.nextBlockIndex++
    this.state.currentBlock = { index, type, toolIndex }
    if (type !== 'thinking') {
      this.state.reasoningClosed = true
    }
    return index
  }

  protected closeCurrentBlock(): void {
    const block = this.state.currentBlock
    if (!block) return

    if (!this.deferredBlocks) {
      const tool = block.toolIndex === undefined ? undefined : this.toolCallMap.get(block.toolIndex)
      if (tool) {
        if (!this.pendingError) {
          if (tool.complete || this.hasCompleteToolInput(tool)) this.deliverTool(tool)
          else this.deferredBlocks = [{ type: 'tool_use', index: block.index, tool }]
        }
      } else {
        this.writer.writeBlockStop(block.index)
      }
    }
    this.state.currentBlock = null
  }

  protected endToolBlock(toolIndex: number): void {
    if (this.state.currentBlock?.toolIndex === toolIndex) this.closeCurrentBlock()
  }

  private hasCompleteToolInput(tool: ToolCallState): boolean {
    if (!tool.arguments) return false
    try {
      const input = JSON.parse(tool.arguments)
      tool.complete = typeof input === 'object' && input !== null && !Array.isArray(input)
      return tool.complete
    } catch {
      return false
    }
  }

  /** Normal stops may omit closing brackets, but never part of a value. */
  private prepareToolArguments(tool: ToolCallState): boolean {
    if (tool.complete || this.hasCompleteToolInput(tool)) return true

    if (this.state.stopReason !== 'end_turn' && this.state.stopReason !== 'tool_use') {
      this.writeError(`The model response stopped with incomplete tool arguments (${this.state.stopReason}). Please retry.`, 'truncated_tool', tool)
      return false
    }

    // Providers may omit deltas for a tool with no parameters.
    if (!tool.arguments) {
      tool.complete = true
      return true
    }

    try {
      const repaired = jsonrepair(tool.arguments)
      const input = JSON.parse(repaired)
      if (typeof input !== 'object' || input === null || Array.isArray(input) || !repaired.startsWith(tool.arguments)) {
        this.writeError('The model response contains invalid tool arguments. Please retry.', 'invalid_tool', tool)
        return false
      }

      const suffix = repaired.slice(tool.arguments.length)
      if (!closesAfterWholeValue(tool.arguments, suffix)) {
        this.writeError('The model response contains incomplete tool arguments. Please retry.', 'truncated_tool', tool)
        return false
      }
      console.warn(
        `[StreamHandler] Repaired malformed tool args for "${tool.name}": ` +
        `appended ${suffix.length} closing characters (${tool.arguments.length} → ${repaired.length} chars)`
      )
      tool.arguments = repaired
      tool.complete = true
      return true
    } catch {
      this.writeError('The model response contains invalid tool arguments. Please retry.', 'invalid_tool', tool)
      return false
    }
  }

  private deliverTool(tool: ToolCallState): void {
    const index = tool.contentBlockIndex
    if (tool.output === 'queued') this.writer.writeToolUseBlockStart(index, tool.id, tool.name)
    if (tool.arguments.length > tool.emittedChars) {
      this.writer.writeInputJsonDelta(index, tool.arguments.slice(tool.emittedChars))
      tool.emittedChars = tool.arguments.length
    }
    this.writer.writeBlockStop(index)
    tool.output = 'delivered'
  }

  private flushDeferredBlocks(): void {
    if (!this.deferredBlocks) return
    for (const block of this.deferredBlocks) {
      if (this.writer.isClosed) break
      switch (block.type) {
        case 'tool_use':
          this.deliverTool(block.tool)
          continue
        case 'text':
          this.writer.writeTextBlockStart(block.index)
          if (block.end > block.start) this.writer.writeTextDelta(block.index, this.state.accumulatedText.slice(block.start, block.end))
          break
        case 'thinking':
          this.writer.writeThinkingBlockStart(block.index)
          if (block.end > block.start) this.writer.writeThinkingDelta(block.index, this.state.accumulatedThinking.slice(block.start, block.end))
          if (block.signature) this.writer.writeSignatureDelta(block.index, block.signature)
          break
        case 'web_search_tool_result':
          this.writer.writeWebSearchBlockStart(block.index, block.toolUseId, block.results)
          break
      }
      this.writer.writeBlockStop(block.index)
    }
    this.deferredBlocks = null
  }

  /** Returns the open text block's index, opening one if needed; -1 once finished. */
  protected startTextBlock(): number {
    if (this.isFinished) return -1

    const open = this.state.currentBlock
    if (open?.type === 'text') return open.index

    const index = this.beginBlock('text')
    if (this.deferredBlocks) {
      const start = this.state.accumulatedText.length
      this.deferredBlocks.push({ type: 'text', index, start, end: start })
    } else {
      this.writer.writeTextBlockStart(index)
    }
    return index
  }

  /** Returns the open thinking block's index, opening one if needed; -1 once finished. */
  protected startThinkingBlock(): number {
    if (this.isFinished) return -1

    const open = this.state.currentBlock
    if (open?.type === 'thinking') return open.index

    const index = this.beginBlock('thinking')
    if (this.deferredBlocks) {
      const start = this.state.accumulatedThinking.length
      this.deferredBlocks.push({ type: 'thinking', index, start, end: start })
    } else {
      this.writer.writeThinkingBlockStart(index)
    }
    return index
  }

  protected startToolUseBlock(toolIndex: number, toolId: string, toolName: string): number {
    if (this.isFinished) return -1

    // Check if we already have a block for this tool index
    if (this.toolIndexToBlock.has(toolIndex)) {
      return this.toolIndexToBlock.get(toolIndex)!
    }

    const blockIndex = this.beginBlock('tool_use', toolIndex)
    this.toolIndexToBlock.set(toolIndex, blockIndex)

    const tool: ToolCallState = {
      id: toolId,
      name: toolName,
      arguments: '',
      contentBlockIndex: blockIndex,
      output: this.deferredBlocks ? 'queued' : 'streaming',
      emittedChars: 0,
      complete: false
    }
    this.toolCallMap.set(toolIndex, tool)
    if (this.deferredBlocks) this.deferredBlocks.push({ type: 'tool_use', index: blockIndex, tool })
    else this.writer.writeToolUseBlockStart(blockIndex, toolId, toolName)

    return blockIndex
  }

  // ============================================================================
  // Content Writing
  // ============================================================================

  protected writeTextDelta(text: string): void {
    if (this.isFinished || !text) return

    // Some servers stream whitespace as text between a tool call's argument
    // chunks; it must not cut the call off.
    if (this.state.currentBlock?.type === 'tool_use' && !text.trim()) {
      this.droppedToolCallWhitespace++
      return
    }

    const index = this.startTextBlock()
    this.state.accumulatedText += text
    const deferred = this.deferredBlocks?.at(-1)
    if (deferred?.type === 'text') deferred.end = this.state.accumulatedText.length
    else this.writer.writeTextDelta(index, text)
  }

  protected writeThinkingDelta(thinking: string): void {
    if (this.isFinished || !thinking) return

    // Don't write thinking if we've already moved past it (text or a tool call)
    if (this.state.reasoningClosed) {
      this.state.accumulatedThinking += thinking
      return
    }

    const index = this.startThinkingBlock()
    this.state.accumulatedThinking += thinking
    const deferred = this.deferredBlocks?.at(-1)
    if (deferred?.type === 'thinking') deferred.end = this.state.accumulatedThinking.length
    else this.writer.writeThinkingDelta(index, thinking)
  }

  protected writeSignatureDelta(signature: string): void {
    if (this.isFinished || !signature) return

    const open = this.state.currentBlock
    if (open?.type === 'thinking') {
      const deferred = this.deferredBlocks?.at(-1)
      if (deferred?.type === 'thinking') deferred.signature = signature
      else this.writer.writeSignatureDelta(open.index, signature)

      // The signature ends its thinking block
      this.closeCurrentBlock()
    }
  }

  protected writeToolInputDelta(toolIndex: number, partialJson: string): void {
    if (this.isFinished || !partialJson) return

    const state = this.toolCallMap.get(toolIndex)
    if (!state) return
    if (state.output === 'delivered') {
      if (partialJson.trim()) this.writeError('The model changed tool arguments after completing the call. Please retry.', 'late_tool_arguments', state)
      return
    }
    state.arguments += partialJson
    if (!this.deferredBlocks) {
      this.writer.writeInputJsonDelta(state.contentBlockIndex, partialJson)
      state.emittedChars = state.arguments.length
    }
  }

  /**
   * Emit a tool call's full argument JSON when no `…arguments.delta` ever
   * arrived for it.
   *
   * Some Responses backends deliver function-call arguments only on the
   * completed item and never as deltas — the official Codex backend does exactly
   * this, and the Codex CLI's own client reads the finished item while
   * discarding `response.function_call_arguments.delta`. The Anthropic wire has
   * no "here is the whole input" event, so without this the block closes with
   * empty input and the SDK receives a tool call with no arguments.
   */
  protected writeToolInputIfMissing(toolIndex: number, completeJson: string): void {
    const state = this.toolCallMap.get(toolIndex)
    if (!state || state.arguments) return
    this.writeToolInputDelta(toolIndex, completeJson)
  }

  protected writeWebSearchResult(
    toolUseId: string,
    results: AnthropicWebSearchResult[]
  ): void {
    if (this.isFinished) return

    const index = this.beginBlock('web_search_tool_result')
    if (this.deferredBlocks) this.deferredBlocks.push({ type: 'web_search_tool_result', index, toolUseId, results })
    else this.writer.writeWebSearchBlockStart(index, toolUseId, results)
    this.closeCurrentBlock()
  }

  protected writeError(message: string, reason = 'upstream_error', rejectedTool?: StreamToolCallState): void {
    if (this.writer.isClosed || this.pendingError) return
    const tool = this.state.currentBlock?.toolIndex
    const firstDeferred = this.deferredBlocks?.[0]
    const input = rejectedTool ?? (firstDeferred?.type === 'tool_use' ? firstDeferred.tool : undefined) ?? (tool === undefined ? undefined : this.toolCallMap.get(tool))
    console.warn(`[StreamHandler] Rejected model response (model=${this.state.model}, stop=${this.state.stopReason ?? 'missing'}, reason=${reason}, tool=${input?.name ?? 'none'}, chars=${input?.arguments.length ?? 0}${this.streamFailure ? `, ${this.streamFailure}` : ''})`)
    this.pendingError = message
    this.state.finished = true
  }

  // ============================================================================
  // Stop Reason Mapping
  // ============================================================================

  protected setStopReason(reason: AnthropicStopReason): void {
    this.state.stopReason = reason
  }

  // ============================================================================
  // SSE Parsing Utilities
  // ============================================================================

  /**
   * Parse SSE lines from buffer
   */
  protected parseSSELines(buffer: string): { lines: string[]; remaining: string } {
    const lines = buffer.split('\n')
    const remaining = lines.pop() || ''
    return { lines, remaining }
  }

  /**
   * Parse SSE data line
   */
  protected parseSSEData(line: string): { data: string | null; isDone: boolean } {
    if (!line.startsWith('data:')) {
      return { data: null, isDone: false }
    }

    const dataStr = line.slice(5).trim()

    if (dataStr === '[DONE]') {
      return { data: null, isDone: true }
    }

    return { data: dataStr, isDone: false }
  }

  /**
   * Convert WebStream to Node Readable
   */
  protected streamToNodeReadable(stream: unknown): Readable {
    return Readable.fromWeb(stream as any)
  }
}

// ============================================================================
// Stop Reason Mapping Tables
// ============================================================================

export const OPENAI_CHAT_STOP_REASON_MAP: Record<string, AnthropicStopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'stop_sequence'
}

export const OPENAI_RESPONSES_STOP_REASON_MAP: Record<string, AnthropicStopReason> = {
  stop: 'end_turn',
  completed: 'end_turn',
  complete: 'end_turn',
  length: 'max_tokens',
  max_tokens: 'max_tokens',
  tool_calls: 'tool_use',
  tool_call: 'tool_use',
  tool_use: 'tool_use'
}
