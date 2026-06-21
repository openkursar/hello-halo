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
import type { AnthropicStopReason, StreamToolCallState } from '../types'
import { safeJsonParse } from '../utils'
import { estimateUsageTokens } from '../utils/usage-estimator'

// ============================================================================
// Stream State
// ============================================================================

export interface StreamState {
  started: boolean
  finished: boolean
  messageId: string
  model: string
  currentBlockIndex: number
  contentBlockIndex: number
  hasTextBlock: boolean
  hasThinkingBlock: boolean
  reasoningClosed: boolean
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
  }
  stopReason: AnthropicStopReason | null
  // Debug: accumulated content
  accumulatedText: string
  accumulatedThinking: string
}

export function createInitialState(model: string): StreamState {
  return {
    started: false,
    finished: false,
    messageId: `msg_${Date.now()}`,
    model,
    currentBlockIndex: -1,
    contentBlockIndex: 0,
    hasTextBlock: false,
    hasThinkingBlock: false,
    reasoningClosed: false,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0
    },
    stopReason: null,
    accumulatedText: '',
    accumulatedThinking: ''
  }
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

  protected updateUsage(usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }): void {
    if (usage.inputTokens !== undefined) {
      this.state.usage.inputTokens = usage.inputTokens
    }
    if (usage.outputTokens !== undefined) {
      this.state.usage.outputTokens = usage.outputTokens
    }
    if (usage.cacheReadTokens !== undefined) {
      this.state.usage.cacheReadTokens = usage.cacheReadTokens
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
        console.log(`[LLM] model=${this.state.model} stop=${this.state.stopReason} → tool_calls=[${tools.join(',')}]`)
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

    // Repair malformed tool arguments before closing blocks.
    // Some LLMs (e.g. GLM-5) produce incomplete JSON (missing closing braces)
    // for tool call arguments. Inject a corrective input_json_delta event before
    // content_block_stop so downstream consumers (CC SDK, stream-processor)
    // receive valid JSON.
    this.repairToolArguments()

    // Close any open block
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
        const idx = this.state.contentBlockIndex
        this.writer.writeTextBlockStart(idx)
        this.writer.writeTextDelta(idx, ' ')
        this.writer.writeBlockStop(idx)
        console.log(`[StreamHandler] Injected placeholder text block at index ${idx} (model=${this.state.model}, stop=${this.state.stopReason ?? 'null'}, thinking_len=${this.state.accumulatedThinking.length})`)
      }
    }

    await this.applyUsageFallback()

    // Write message_delta
    this.writer.writeMessageDelta(this.state.stopReason || 'end_turn', {
      inputTokens: this.state.usage.inputTokens,
      outputTokens: this.state.usage.outputTokens,
      cacheReadTokens: this.state.usage.cacheReadTokens
    })

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
   */
  private async applyUsageFallback(): Promise<void> {
    if (!this.state.started) return
    const usage = this.state.usage
    if (usage.inputTokens > 0 && usage.outputTokens > 0) return

    try {
      const needInput = usage.inputTokens === 0 && !!this.estimateInputTokens
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

  protected closeCurrentBlock(): void {
    if (this.state.currentBlockIndex >= 0) {
      this.writer.writeBlockStop(this.state.currentBlockIndex)
      this.state.currentBlockIndex = -1
    }
  }

  /**
   * Validate accumulated tool arguments and repair malformed JSON.
   *
   * Some LLMs generate syntactically broken JSON for tool call arguments
   * (e.g. missing closing braces for nested objects). This method runs
   * after all streaming deltas have been received but BEFORE content_block_stop
   * events are sent, so downstream consumers (CC SDK, stream-processor) see
   * a corrective input_json_delta and can parse the result successfully.
   *
   * Safety constraints:
   * - Only applies suffix-only repairs (appending missing brackets/braces).
   *   If jsonrepair rewrites content in the middle, the fix is skipped because
   *   the already-sent partial_json deltas cannot be retracted.
   * - The repaired output is verified with JSON.parse before being sent.
   * - Valid JSON is never touched (fast-path exit).
   */
  protected repairToolArguments(): void {
    for (const [toolIndex, state] of this.toolCallMap) {
      if (!state.arguments) continue

      // Fast path: valid JSON, nothing to do
      try {
        JSON.parse(state.arguments)
        continue
      } catch {
        // Fall through to repair
      }

      try {
        const repaired = jsonrepair(state.arguments)
        JSON.parse(repaired) // Verify repair produced valid JSON

        // Only apply suffix-only repairs (appended missing brackets/braces).
        // If jsonrepair modified content in the middle, the already-sent
        // partial_json deltas cannot be retracted — log and skip.
        if (!repaired.startsWith(state.arguments)) {
          console.warn(
            `[StreamHandler] Tool args for "${state.name}" need non-suffix repair, cannot fix in-stream. ` +
            `Original (${state.arguments.length} chars): ${state.arguments}`
          )
          continue
        }

        const suffix = repaired.slice(state.arguments.length)
        if (!suffix) continue

        const blockIndex = this.toolIndexToBlock.get(toolIndex)
        if (blockIndex === undefined) continue

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
  }

  protected startTextBlock(): boolean {
    if (this.isFinished) return false

    if (!this.state.hasTextBlock) {
      // Close any previous block (e.g., thinking)
      if (this.state.currentBlockIndex >= 0) {
        this.closeCurrentBlock()
      }

      this.state.hasTextBlock = true
      this.writer.writeTextBlockStart(this.state.contentBlockIndex)
      this.state.currentBlockIndex = this.state.contentBlockIndex

      return true
    }

    return true
  }

  protected startThinkingBlock(): boolean {
    if (this.isFinished) return false

    if (!this.state.hasThinkingBlock) {
      // Close any previous block
      if (this.state.currentBlockIndex >= 0) {
        this.closeCurrentBlock()
      }

      this.state.hasThinkingBlock = true
      this.writer.writeThinkingBlockStart(this.state.contentBlockIndex)
      this.state.currentBlockIndex = this.state.contentBlockIndex

      return true
    }

    return true
  }

  protected startToolUseBlock(toolIndex: number, toolId: string, toolName: string): number {
    if (this.isFinished) return -1

    // Check if we already have a block for this tool index
    if (this.toolIndexToBlock.has(toolIndex)) {
      return this.toolIndexToBlock.get(toolIndex)!
    }

    // Close any current block
    this.closeCurrentBlock()

    const blockIndex = this.state.contentBlockIndex
    this.toolIndexToBlock.set(toolIndex, blockIndex)
    this.state.contentBlockIndex++

    this.writer.writeToolUseBlockStart(blockIndex, toolId, toolName)
    this.state.currentBlockIndex = blockIndex

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

    // Accumulate text for debug logging
    this.state.accumulatedText += text

    // Close thinking block if open and start text block
    this.state.reasoningClosed = true

    if (!this.state.hasTextBlock) {
      if (this.state.currentBlockIndex >= 0 && !this.state.hasTextBlock) {
        this.closeCurrentBlock()
      }
      this.startTextBlock()
    }

    this.writer.writeTextDelta(this.state.currentBlockIndex, text)
  }

  protected writeThinkingDelta(thinking: string): void {
    if (this.isFinished || !thinking) return

    // Accumulate thinking for debug logging
    this.state.accumulatedThinking += thinking

    // Don't write thinking if we've already moved to text
    if (this.state.reasoningClosed || this.state.hasTextBlock) return

    if (!this.state.hasThinkingBlock) {
      this.startThinkingBlock()
    }

    this.writer.writeThinkingDelta(this.state.contentBlockIndex, thinking)
  }

  protected writeSignatureDelta(signature: string): void {
    if (this.isFinished || !signature) return

    if (this.state.hasThinkingBlock) {
      this.writer.writeSignatureDelta(this.state.contentBlockIndex, signature)

      // Close thinking block and move to next
      this.closeCurrentBlock()
      this.state.contentBlockIndex++
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

  protected writeWebSearchResult(
    toolUseId: string,
    results: Array<{ type: string; url?: string; title?: string }>
  ): void {
    if (this.isFinished) return

    // Close current block if needed
    if (this.state.currentBlockIndex >= 0 && this.state.hasTextBlock) {
      this.closeCurrentBlock()
      this.state.hasTextBlock = false
    }

    this.state.contentBlockIndex++
    this.writer.writeWebSearchBlockStart(this.state.contentBlockIndex, toolUseId, results)
    this.writer.writeBlockStop(this.state.contentBlockIndex)
    this.state.currentBlockIndex = -1
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
