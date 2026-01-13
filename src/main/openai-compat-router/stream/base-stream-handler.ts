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
import { SSEWriter } from './sse-writer'
import type { AnthropicStopReason, StreamToolCallState } from '../types'
import { safeJsonParse } from '../utils'

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
    stopReason: null
  }
}

// ============================================================================
// Base Stream Handler
// ============================================================================

export interface StreamHandlerOptions {
  model?: string
  debug?: boolean
}

export abstract class BaseStreamHandler {
  protected writer: SSEWriter
  protected state: StreamState
  protected debug: boolean

  // Tool call tracking
  protected toolCallMap = new Map<number, StreamToolCallState>()
  protected toolIndexToBlock = new Map<number, number>()

  constructor(res: ExpressResponse, options: StreamHandlerOptions = {}) {
    this.writer = new SSEWriter(res, { debug: options.debug })
    this.state = createInitialState(options.model || 'unknown')
    this.debug = options.debug ?? false
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

  protected finishMessage(): void {
    // Only check if writer is closed, not if state is finished
    // (state.finished is set when finish_reason is received, but we still need to send final events)
    if (this.writer.isClosed) return

    // Close any open block
    this.closeCurrentBlock()

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

  // ============================================================================
  // Block Lifecycle
  // ============================================================================

  protected closeCurrentBlock(): void {
    if (this.state.currentBlockIndex >= 0) {
      this.writer.writeBlockStop(this.state.currentBlockIndex)
      this.state.currentBlockIndex = -1
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
