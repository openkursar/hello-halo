/**
 * Anthropic SSE Stream Handler
 *
 * Re-serializes an upstream Anthropic SSE stream through BaseStreamHandler,
 * enabling all repair logic (empty text block fix, tool JSON repair, etc.)
 * that would otherwise be bypassed by zero-parsing passthrough.
 *
 * Used for anthropic_passthrough backends (third-party Anthropic-compatible
 * providers) where the upstream response may have quirks that need correction
 * before reaching the Claude Code SDK.
 */

import { Readable } from 'node:stream'
import type { Response as ExpressResponse } from 'express'
import { BaseStreamHandler, type StreamHandlerOptions } from './base-stream-handler'
import { safeJsonParse } from '../utils'
import type {
  AnthropicStreamEvent,
  AnthropicStopReason
} from '../types'

export class AnthropicStreamHandler extends BaseStreamHandler {
  constructor(res: ExpressResponse, options: StreamHandlerOptions = {}) {
    super(res, options)
  }

  async processStream(stream: unknown): Promise<void> {
    if (!stream) {
      this.writer.sendError(502, 'api_error', 'Empty stream from provider')
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''

    try {
      const nodeStream = this.streamToNodeReadable(stream)

      for await (const chunk of nodeStream) {
        if (this.isFinished) break

        buffer += decoder.decode(chunk as any, { stream: true })
        const { lines, remaining } = this.parseSSELines(buffer)
        buffer = remaining

        for (const line of lines) {
          if (this.isFinished) break

          const { data, isDone } = this.parseSSEData(line)
          if (isDone || !data) continue

          const event = safeJsonParse<AnthropicStreamEvent>(data)
          if (!event) continue

          this.processEvent(event)
        }
      }
    } catch (error: any) {
      if (!this.isFinished && this.debug) {
        console.error('[AnthropicStream] Error:', error)
      }
    } finally {
      await this.finishMessage()
    }
  }

  private processEvent(event: AnthropicStreamEvent): void {
    switch (event.type) {
      case 'message_start':
        if (event.message?.model) {
          this.updateModel(event.message.model)
        }
        if (event.message?.usage) {
          this.updateUsage({
            inputTokens: event.message.usage.input_tokens,
            outputTokens: event.message.usage.output_tokens,
            cacheReadTokens: (event.message.usage as any).cache_read_input_tokens
          })
        }
        this.ensureMessageStarted()
        break

      case 'content_block_start':
        this.handleBlockStart(event)
        break

      case 'content_block_delta':
        this.handleDelta(event)
        break

      case 'content_block_stop':
        // Block lifecycle is managed by BaseStreamHandler — no explicit action
        // needed here. The block will be closed by finishMessage or when the
        // next block starts.
        break

      case 'message_delta':
        if (event.delta?.stop_reason) {
          this.setStopReason(event.delta.stop_reason as AnthropicStopReason)
        }
        if (event.usage) {
          this.updateUsage({ outputTokens: event.usage.output_tokens })
        }
        break

      case 'message_stop':
        // Handled by finishMessage in the finally block
        break

      case 'ping':
        // No action needed
        break

      case 'error':
        if ('error' in event && event.error?.message) {
          this.writeError(event.error.message)
        }
        break
    }
  }

  private handleBlockStart(event: AnthropicStreamEvent & { type: 'content_block_start' }): void {
    const block = event.content_block

    switch (block.type) {
      case 'thinking':
        this.startThinkingBlock()
        break

      case 'text':
        this.startTextBlock()
        break

      case 'tool_use': {
        const toolBlock = block as { type: 'tool_use'; id: string; name: string }
        this.startToolUseBlock(event.index, toolBlock.id, toolBlock.name)
        break
      }

      // web_search_tool_result and other block types are passed through
      // by the upstream and don't need re-serialization via BaseStreamHandler
    }
  }

  private handleDelta(event: AnthropicStreamEvent & { type: 'content_block_delta' }): void {
    const delta = event.delta as any

    switch (delta.type) {
      case 'thinking_delta':
        if (delta.thinking) {
          this.writeThinkingDelta(delta.thinking)
        }
        break

      case 'text_delta':
        if (delta.text) {
          this.writeTextDelta(delta.text)
        }
        break

      case 'input_json_delta':
        if (delta.partial_json !== undefined) {
          this.writeToolInputDelta(event.index, delta.partial_json)
        }
        break

      case 'signature_delta':
        if (delta.signature) {
          this.writeSignatureDelta(delta.signature)
        }
        break
    }
  }
}

// ============================================================================
// Convenience Function
// ============================================================================

/**
 * Stream an upstream Anthropic SSE response through the repair pipeline
 */
export async function streamAnthropicPassthrough(
  stream: unknown,
  res: ExpressResponse,
  model?: string,
  debug = false,
  estimateInputTokens?: () => Promise<number>
): Promise<void> {
  const handler = new AnthropicStreamHandler(res, { model, debug, estimateInputTokens })
  await handler.processStream(stream)
}

/**
 * Forward an upstream Anthropic SSE stream to the client byte-for-byte.
 *
 * Unlike streamAnthropicPassthrough (which re-parses and re-serializes through
 * BaseStreamHandler to repair non-standard third-party responses), this does
 * zero parsing. It is used for genuine first-party Anthropic upstreams whose
 * SSE is already well-formed: re-serializing those through the OpenAI-oriented
 * state machine drops interleaved `thinking` text (it keeps only the
 * signature), so they must be piped raw. The caller selects this path via
 * isNativeAnthropicHost (see utils/url.ts).
 *
 * The caller forwards response headers/status before invoking this.
 */
export async function pipeAnthropicPassthrough(
  stream: unknown,
  res: ExpressResponse
): Promise<void> {
  if (!stream) {
    res.write('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Empty stream from provider"}}\n\n')
    res.end()
    return
  }

  try {
    const nodeStream = Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0])
    for await (const chunk of nodeStream) {
      res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    if (!res.writableEnded) res.end()
  } catch {
    // Upstream aborted mid-stream (network drop, client disconnect). Partial
    // SSE has already been written; just close the connection cleanly.
    if (!res.writableEnded) res.end()
  }
}
