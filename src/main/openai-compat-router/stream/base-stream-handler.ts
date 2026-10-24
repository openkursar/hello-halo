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
 * Whether tool arguments another block interrupted may be closed with
 * `suffix`: it only closes brackets, and the arguments end right after a whole
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
  protected toolCallMap = new Map<number, StreamToolCallState>()
  protected toolIndexToBlock = new Map<number, number>()
  /** Whitespace-only text chunks dropped while a tool call was open. */
  private droppedToolCallWhitespace = 0

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

    this.closeCurrentBlock()

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
    // Gate matches the effective stop reason emitted below (null defaults to
    // end_turn), so interrupted streams that finalize as end_turn get the same
    // repair.
    if ((this.state.stopReason ?? 'end_turn') === 'end_turn' && this.state.started) {
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
    this.closeCurrentBlock(true)
    const index = this.state.nextBlockIndex++
    this.state.currentBlock = { index, type, toolIndex }
    if (type !== 'thinking') {
      this.state.reasoningClosed = true
    }
    return index
  }

  /**
   * @param interrupted - another block is starting, so an open tool call may
   *   still have arguments on the way
   */
  protected closeCurrentBlock(interrupted = false): void {
    const block = this.state.currentBlock
    if (!block) return

    if (block.toolIndex !== undefined) {
      this.repairToolArguments(block.toolIndex, interrupted)
    }
    this.writer.writeBlockStop(block.index)
    this.state.currentBlock = null
  }

  /**
   * Validate a tool call's accumulated arguments and repair malformed JSON.
   *
   * Some LLMs generate syntactically broken JSON for tool call arguments
   * (e.g. missing closing braces for nested objects). This runs right before
   * the call's content_block_stop, where downstream consumers (CC SDK,
   * stream-processor) parse the input, so they see a corrective
   * input_json_delta and can parse the result successfully.
   *
   * Safety constraints:
   * - Only appends to the end. If jsonrepair rewrites content in the middle,
   *   the fix is skipped because the already-sent partial_json deltas cannot
   *   be retracted.
   * - The repaired output is verified with JSON.parse before being sent.
   * - Valid JSON is never touched (fast-path exit).
   * - A call another block interrupts may still have arguments on the way, and
   *   completing it there runs a different call (`rm -rf ~/old-build` cut to
   *   `rm -rf ~`), so it is only completed when it stops after a whole value
   *   and lacks nothing but brackets.
   */
  private repairToolArguments(toolIndex: number, interrupted: boolean): void {
    const state = this.toolCallMap.get(toolIndex)
    if (!state?.arguments) return

    // Fast path: valid JSON, nothing to do
    try {
      JSON.parse(state.arguments)
      return
    } catch {
      // Fall through to repair
    }

    try {
      const repaired = jsonrepair(state.arguments)
      JSON.parse(repaired) // Verify repair produced valid JSON

      // Only apply suffix-only repairs. If jsonrepair modified content in the
      // middle, the already-sent partial_json deltas cannot be retracted — log
      // and skip.
      if (!repaired.startsWith(state.arguments)) {
        console.warn(
          `[StreamHandler] Tool args for "${state.name}" need non-suffix repair, cannot fix in-stream. ` +
          `Original (${state.arguments.length} chars): ${state.arguments}`
        )
        return
      }

      const suffix = repaired.slice(state.arguments.length)
      if (!suffix) return

      if (interrupted && !closesAfterWholeValue(state.arguments, suffix)) {
        console.warn(
          `[StreamHandler] Tool args for "${state.name}" cut off mid-value by another block, left unrepaired ` +
          `(model=${this.state.model}, ${state.arguments.length} chars)`
        )
        return
      }

      const blockIndex = this.toolIndexToBlock.get(toolIndex)
      if (blockIndex === undefined) return

      console.warn(
        `[StreamHandler] Repaired malformed tool args for "${state.name}": ` +
        `appended "${suffix}" (${state.arguments.length} → ${repaired.length} chars)`
      )
      this.writer.writeInputJsonDelta(blockIndex, suffix)
      state.arguments = repaired
    } catch (e) {
      console.warn(
        `[StreamHandler] Cannot repair tool args for "${state.name}": ${(e as Error).message}. ` +
        `Original (${state.arguments.length} chars): ${state.arguments}`
      )
    }
  }

  /** Returns the open text block's index, opening one if needed; -1 once finished. */
  protected startTextBlock(): number {
    if (this.isFinished) return -1

    const open = this.state.currentBlock
    if (open?.type === 'text') return open.index

    const index = this.beginBlock('text')
    this.writer.writeTextBlockStart(index)
    return index
  }

  /** Returns the open thinking block's index, opening one if needed; -1 once finished. */
  protected startThinkingBlock(): number {
    if (this.isFinished) return -1

    const open = this.state.currentBlock
    if (open?.type === 'thinking') return open.index

    const index = this.beginBlock('thinking')
    this.writer.writeThinkingBlockStart(index)
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
    this.writer.writeToolUseBlockStart(blockIndex, toolId, toolName)

    // Track tool state
    this.toolCallMap.set(toolIndex, {
      id: toolId,
      name: toolName,
      arguments: '',
      contentBlockIndex: blockIndex
    })

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

    // Accumulate text for debug logging
    this.state.accumulatedText += text

    this.writer.writeTextDelta(this.startTextBlock(), text)
  }

  protected writeThinkingDelta(thinking: string): void {
    if (this.isFinished || !thinking) return

    // Accumulate thinking for debug logging
    this.state.accumulatedThinking += thinking

    // Don't write thinking if we've already moved past it (text or a tool call)
    if (this.state.reasoningClosed) return

    this.writer.writeThinkingDelta(this.startThinkingBlock(), thinking)
  }

  protected writeSignatureDelta(signature: string): void {
    if (this.isFinished || !signature) return

    const open = this.state.currentBlock
    if (open?.type === 'thinking') {
      this.writer.writeSignatureDelta(open.index, signature)

      // The signature ends its thinking block
      this.closeCurrentBlock()
    }
  }

  protected writeToolInputDelta(toolIndex: number, partialJson: string): void {
    if (this.isFinished || !partialJson) return

    const blockIndex = this.toolIndexToBlock.get(toolIndex)
    if (blockIndex === undefined) return

    // Update accumulated arguments
    const state = this.toolCallMap.get(toolIndex)
    if (state) {
      state.arguments += partialJson
    }

    // Try to write the delta, with fallback for invalid characters
    try {
      this.writer.writeInputJsonDelta(blockIndex, partialJson)
    } catch {
      try {
        // Escape problematic characters
        const escaped = String(partialJson)
          .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
        this.writer.writeInputJsonDelta(blockIndex, escaped)
      } catch (e) {
        if (this.debug) {
          console.error('[BaseStreamHandler] Failed to write tool input delta:', e)
        }
      }
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

    this.writer.writeWebSearchBlockStart(this.beginBlock('web_search_tool_result'), toolUseId, results)
    this.closeCurrentBlock()
  }

  protected writeError(message: string): void {
    this.writer.writeError(message)
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
