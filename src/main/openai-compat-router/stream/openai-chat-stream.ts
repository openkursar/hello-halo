/**
 * OpenAI Chat Completions Stream Handler
 *
 * Converts OpenAI Chat Completions SSE stream to Anthropic format
 */

import type { Response as ExpressResponse } from 'express'
import {
  BaseStreamHandler,
  OPENAI_CHAT_STOP_REASON_MAP,
  type StreamHandlerOptions
} from './base-stream-handler'
import { safeJsonParse } from '../utils'
import type { OpenAIChatChunk, AnthropicStopReason } from '../types'

export class OpenAIChatStreamHandler extends BaseStreamHandler {
  // Track <think> tag state for providers that use XML-style thinking
  private inThinkTag = false
  private thinkBuffer = ''

  constructor(res: ExpressResponse, options: StreamHandlerOptions = {}) {
    super(res, options)
  }

  /**
   * Process OpenAI Chat Completions stream
   */
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
          if (isDone) continue
          if (!data) continue

          if (this.debug) {
            console.log('[OpenAIChatStream] Received:', data.slice(0, 200))
          }

          const chunkJson = safeJsonParse<OpenAIChatChunk>(data)
          if (!chunkJson) continue

          this.processChunk(chunkJson)
        }
      }
    } catch (error: any) {
      if (!this.isFinished && this.debug) {
        console.error('[OpenAIChatStream] Error:', error)
      }
    } finally {
      this.finishMessage()
    }
  }

  /**
   * Process a single chunk from the stream
   */
  private processChunk(chunk: OpenAIChatChunk): void {
    // Handle provider error
    if ((chunk as any).error) {
      this.writeError(JSON.stringify((chunk as any).error))
      return
    }

    // Update model if provided
    if (chunk.model) {
      this.updateModel(chunk.model)
    }

    // Ensure message has started
    this.ensureMessageStarted()

    // Update usage if provided
    if (chunk.usage) {
      this.updateUsage({
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
        cacheReadTokens: chunk.usage.cache_read_input_tokens
      })
    }

    // Process choice
    const choice = chunk.choices?.[0]
    if (!choice) return

    const delta = choice.delta

    // Process reasoning/thinking (some providers use delta.reasoning)
    if (typeof (delta as any)?.reasoning === 'string' && (delta as any).reasoning !== '') {
      this.writeThinkingDelta((delta as any).reasoning)
    }

    // Process structured thinking (delta.thinking with content/signature)
    if ((delta as any)?.thinking) {
      const thinking = (delta as any).thinking
      if (thinking.signature) {
        this.writeSignatureDelta(thinking.signature)
      } else if (thinking.content) {
        this.writeThinkingDelta(thinking.content)
      }
    }

    // Process text content (with <think> tag detection)
    if (delta?.content !== undefined && delta?.content !== null && delta?.content !== '') {
      this.processTextWithThinkTags(delta.content)
    }

    // Process annotations (web search results)
    if ((delta as any)?.annotations?.length) {
      this.processAnnotations((delta as any).annotations)
    }

    // Process tool calls
    if (delta?.tool_calls) {
      this.processToolCalls(delta.tool_calls)
    }

    // Process finish reason
    if (choice.finish_reason) {
      const stopReason = OPENAI_CHAT_STOP_REASON_MAP[choice.finish_reason] || 'end_turn'
      this.setStopReason(stopReason)
      this.markFinished()
    }
  }

  /**
   * Process text content with <think> tag detection
   * Some providers wrap thinking content in <think>...</think> tags
   */
  private processTextWithThinkTags(text: string): void {
    let remaining = text

    while (remaining.length > 0) {
      if (this.inThinkTag) {
        // Looking for </think> closing tag
        const closeIndex = remaining.indexOf('</think>')
        if (closeIndex !== -1) {
          // Found closing tag - write thinking content before it
          const thinkContent = remaining.slice(0, closeIndex)
          if (thinkContent) {
            this.writeThinkingDelta(thinkContent)
          }
          this.inThinkTag = false
          remaining = remaining.slice(closeIndex + 8) // Skip </think>

          // Skip leading whitespace after </think>
          const trimmed = remaining.replace(/^[\n\r]+/, '')
          remaining = trimmed
        } else {
          // No closing tag yet - buffer all as thinking
          this.writeThinkingDelta(remaining)
          remaining = ''
        }
      } else {
        // Looking for <think> opening tag
        const openIndex = remaining.indexOf('<think>')
        if (openIndex !== -1) {
          // Found opening tag - write text before it as regular text
          const textBefore = remaining.slice(0, openIndex)
          if (textBefore) {
            this.writeTextDelta(textBefore)
          }
          this.inThinkTag = true
          remaining = remaining.slice(openIndex + 7) // Skip <think>
        } else {
          // No opening tag - write all as regular text
          this.writeTextDelta(remaining)
          remaining = ''
        }
      }
    }
  }

  /**
   * Process annotations (web search results)
   */
  private processAnnotations(
    annotations: Array<{ url_citation?: { url?: string; title?: string } }>
  ): void {
    const toolUseId = `srvtoolu_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`

    const results = annotations.map((ann) => ({
      type: 'web_search_result',
      title: ann.url_citation?.title,
      url: ann.url_citation?.url
    }))

    this.writeWebSearchResult(toolUseId, results)
  }

  /**
   * Process tool calls
   */
  private processToolCalls(
    toolCalls: Array<{
      index?: number
      id?: string
      type?: string
      function?: { name?: string; arguments?: string }
    }>
  ): void {
    const processedIndices = new Set<number>()

    for (const toolCall of toolCalls) {
      if (this.isFinished) break

      const toolIndex = toolCall.index ?? 0
      if (processedIndices.has(toolIndex)) continue
      processedIndices.add(toolIndex)

      // Check if this is a new tool call or update to existing
      if (!this.toolIndexToBlock.has(toolIndex)) {
        // New tool call
        const toolId = toolCall.id || `call_${Date.now()}_${toolIndex}`
        const toolName = toolCall.function?.name || `tool_${toolIndex}`

        this.startToolUseBlock(toolIndex, toolId, toolName)
      } else if (toolCall.id && toolCall.function?.name) {
        // Update tool info if we have real values
        const state = this.toolCallMap.get(toolIndex)
        if (state && state.id.startsWith('call_') && state.name.startsWith('tool_')) {
          state.id = toolCall.id
          state.name = toolCall.function.name
        }
      }

      // Write arguments delta
      if (toolCall.function?.arguments) {
        this.writeToolInputDelta(toolIndex, toolCall.function.arguments)
      }
    }
  }
}

// ============================================================================
// Convenience Function
// ============================================================================

/**
 * Stream OpenAI Chat Completions response to Anthropic format
 */
export async function streamOpenAIChatToAnthropic(
  stream: unknown,
  res: ExpressResponse,
  model?: string,
  debug = false
): Promise<void> {
  const handler = new OpenAIChatStreamHandler(res, { model, debug })
  await handler.processStream(stream)
}
