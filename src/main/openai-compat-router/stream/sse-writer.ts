/**
 * SSE (Server-Sent Events) Writer
 *
 * Provides a type-safe abstraction for writing Anthropic SSE events
 */

import type { Response as ExpressResponse } from 'express'
import type {
  AnthropicStreamEvent,
  AnthropicMessageStartEvent,
  AnthropicContentBlockStartEvent,
  AnthropicContentBlockDeltaEvent,
  AnthropicContentBlockStopEvent,
  AnthropicMessageDeltaEvent,
  AnthropicMessageStopEvent,
  AnthropicStopReason
} from '../types'

export interface SSEWriterOptions {
  debug?: boolean
}

/**
 * Type-safe SSE writer for Anthropic streaming format
 */
export class SSEWriter {
  private res: ExpressResponse
  private debug: boolean
  private closed: boolean = false

  constructor(res: ExpressResponse, options: SSEWriterOptions = {}) {
    this.res = res
    this.debug = options.debug ?? false
  }

  /**
   * Check if the writer is closed
   */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Write a raw SSE event
   */
  private writeEvent(event: string, data: unknown): boolean {
    if (this.closed) return false

    try {
      const jsonData = JSON.stringify(data)
      this.res.write(`event: ${event}\ndata: ${jsonData}\n\n`)

      if (this.debug) {
        console.log(`[SSEWriter] Send: ${event}`, jsonData.slice(0, 200))
      }

      return true
    } catch (e: unknown) {
      if (e instanceof TypeError && String((e as Error).message).includes('Controller is already closed')) {
        this.closed = true
      } else if (this.debug) {
        console.error('[SSEWriter] Error writing event:', e)
      }
      return false
    }
  }

  /**
   * Write message_start event
   */
  writeMessageStart(messageId: string, model: string): boolean {
    const event: AnthropicMessageStartEvent = {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }
    return this.writeEvent('message_start', event)
  }

  /**
   * Write content_block_start event for text block
   */
  writeTextBlockStart(index: number): boolean {
    const event: AnthropicContentBlockStartEvent = {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' }
    }
    return this.writeEvent('content_block_start', event)
  }

  /**
   * Write content_block_start event for tool_use block
   */
  writeToolUseBlockStart(index: number, id: string, name: string): boolean {
    const event: AnthropicContentBlockStartEvent = {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name, input: {} }
    }
    return this.writeEvent('content_block_start', event)
  }

  /**
   * Write content_block_start event for thinking block
   */
  writeThinkingBlockStart(index: number): boolean {
    const event: AnthropicContentBlockStartEvent = {
      type: 'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '' }
    }
    return this.writeEvent('content_block_start', event)
  }

  /**
   * Write content_block_start event for web_search_tool_result
   */
  writeWebSearchBlockStart(
    index: number,
    toolUseId: string,
    results: Array<{ type: string; url?: string; title?: string }>
  ): boolean {
    const event: AnthropicContentBlockStartEvent = {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: toolUseId,
        content: results
      }
    }
    return this.writeEvent('content_block_start', event)
  }

  /**
   * Write content_block_delta event for text
   */
  writeTextDelta(index: number, text: string): boolean {
    const event: AnthropicContentBlockDeltaEvent = {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text }
    }
    return this.writeEvent('content_block_delta', event)
  }

  /**
   * Write content_block_delta event for tool input JSON
   */
  writeInputJsonDelta(index: number, partialJson: string): boolean {
    const event: AnthropicContentBlockDeltaEvent = {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: partialJson }
    }
    return this.writeEvent('content_block_delta', event)
  }

  /**
   * Write content_block_delta event for thinking
   */
  writeThinkingDelta(index: number, thinking: string): boolean {
    const event: AnthropicContentBlockDeltaEvent = {
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking }
    }
    return this.writeEvent('content_block_delta', event)
  }

  /**
   * Write content_block_delta event for signature
   */
  writeSignatureDelta(index: number, signature: string): boolean {
    const event: AnthropicContentBlockDeltaEvent = {
      type: 'content_block_delta',
      index,
      delta: { type: 'signature_delta', signature }
    }
    return this.writeEvent('content_block_delta', event)
  }

  /**
   * Write content_block_stop event
   */
  writeBlockStop(index: number): boolean {
    const event: AnthropicContentBlockStopEvent = {
      type: 'content_block_stop',
      index
    }
    return this.writeEvent('content_block_stop', event)
  }

  /**
   * Write message_delta event
   */
  writeMessageDelta(
    stopReason: AnthropicStopReason,
    usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }
  ): boolean {
    const event: AnthropicMessageDeltaEvent = {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        output_tokens: usage.outputTokens ?? 0
      }
    }

    // Add additional usage fields if present
    const eventData = event as any
    if (usage.inputTokens !== undefined) {
      eventData.usage.input_tokens = usage.inputTokens
    }
    if (usage.cacheReadTokens !== undefined) {
      eventData.usage.cache_read_input_tokens = usage.cacheReadTokens
    }

    return this.writeEvent('message_delta', event)
  }

  /**
   * Write message_stop event
   */
  writeMessageStop(): boolean {
    const event: AnthropicMessageStopEvent = {
      type: 'message_stop'
    }
    return this.writeEvent('message_stop', event)
  }

  /**
   * Write error event
   */
  writeError(message: string): boolean {
    return this.writeEvent('error', {
      type: 'error',
      message: { type: 'api_error', message }
    })
  }

  /**
   * End the response
   */
  end(): void {
    if (!this.closed) {
      this.res.end()
      this.closed = true
    }
  }

  /**
   * Write error response and end
   */
  sendError(statusCode: number, errorType: string, message: string): void {
    if (!this.closed) {
      this.res.status(statusCode).json({
        type: 'error',
        error: { type: errorType, message }
      })
      this.closed = true
    }
  }
}
