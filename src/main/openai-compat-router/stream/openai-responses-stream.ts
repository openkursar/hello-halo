/**
 * OpenAI Responses API Stream Handler
 *
 * Converts OpenAI Responses API SSE stream to Anthropic format
 */

import type { Response as ExpressResponse } from 'express'
import {
  BaseStreamHandler,
  OPENAI_RESPONSES_STOP_REASON_MAP,
  type StreamHandlerOptions
} from './base-stream-handler'
import { safeJsonParse } from '../utils'
import type { AnthropicStopReason } from '../types'

// Event types from OpenAI Responses API
type ResponsesEventType =
  | 'response.created'
  | 'response.in_progress'
  | 'response.completed'
  | 'response.incomplete'
  | 'response.failed'
  | 'response.output_item.added'
  | 'response.output_item.done'
  | 'response.output_text.delta'
  | 'response.output_text.done'
  | 'response.function_call_arguments.delta'
  | 'response.function_call_arguments.done'
  | 'response.reasoning_summary_text.delta'
  | 'response.reasoning_summary_text.done'
  | 'response.reasoning_summary_part.added'
  | 'response.reasoning_summary_part.done'
  | 'error'

export class OpenAIResponsesStreamHandler extends BaseStreamHandler {
  constructor(res: ExpressResponse, options: StreamHandlerOptions = {}) {
    super(res, options)
  }

  /**
   * Process OpenAI Responses API stream
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
          if (isDone) {
            this.markFinished()
            break
          }
          if (!data) continue

          if (this.debug) {
            console.log('[OpenAIResponsesStream] Received:', data.slice(0, 200))
          }

          const chunkJson = safeJsonParse<any>(data)
          if (!chunkJson) continue

          this.processEvent(chunkJson)
        }
      }
    } catch (error: any) {
      if (this.debug) {
        console.error('[OpenAIResponsesStream] Error:', error)
      }
    } finally {
      this.finishMessage()
    }
  }

  /**
   * Process a single event from the stream
   */
  private processEvent(event: any): void {
    const eventType: ResponsesEventType = event.type || event.event || ''
    const responseObj = event.response || event

    // Update model from response
    if (responseObj.model) {
      this.updateModel(responseObj.model)
    }

    // Update usage from response
    if (responseObj.usage) {
      this.updateUsage({
        inputTokens: responseObj.usage.input_tokens || responseObj.usage.prompt_tokens,
        outputTokens: responseObj.usage.output_tokens || responseObj.usage.completion_tokens,
        cacheReadTokens: responseObj.usage.cache_read_input_tokens
      })
    }

    // Ensure message has started
    this.ensureMessageStarted()

    // Handle error events
    if (eventType === 'error' || eventType === 'response.error' || responseObj.error) {
      this.writeError(JSON.stringify(responseObj.error || event.error || {}))
      this.markFinished()
      return
    }

    // Route to specific handler based on event type
    switch (eventType) {
      case 'response.output_text.delta':
        this.handleTextDelta(event)
        break

      case 'response.output_text.done':
        this.handleTextDone()
        break

      case 'response.output_item.added':
        this.handleOutputItemAdded(event)
        break

      case 'response.output_item.done':
        this.handleOutputItemDone(event)
        break

      case 'response.function_call_arguments.delta':
        this.handleFunctionCallArgumentsDelta(event)
        break

      case 'response.function_call_arguments.done':
        // Arguments complete, block will be closed by output_item.done
        break

      case 'response.reasoning_summary_text.delta':
        this.handleReasoningSummaryTextDelta(event)
        break

      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_summary_part.added':
      case 'response.reasoning_summary_part.done':
        // Lifecycle events for reasoning, content handled by delta
        break

      case 'response.completed':
      case 'response.done':
      case 'done':
        this.handleCompletion(responseObj)
        break

      case 'response.incomplete':
        this.handleIncomplete(responseObj)
        break

      case 'response.failed':
        this.handleFailed(responseObj)
        break

      case 'response.created':
      case 'response.in_progress':
        // Lifecycle events, no action needed
        break

      default:
        // Check for completion status in response object
        if (responseObj.status === 'completed') {
          this.handleCompletion(responseObj)
        }
    }
  }

  /**
   * Handle text delta event
   */
  private handleTextDelta(event: { delta?: string }): void {
    const textDelta = event.delta
    if (typeof textDelta === 'string' && textDelta !== '') {
      this.writeTextDelta(textDelta)
    }
  }

  /**
   * Handle text done event
   */
  private handleTextDone(): void {
    if (this.state.hasTextBlock) {
      this.closeCurrentBlock()
      this.state.hasTextBlock = false
      this.state.contentBlockIndex++
    }
  }

  /**
   * Handle output item added event
   */
  private handleOutputItemAdded(event: { item?: any; output_index?: number }): void {
    const item = event.item
    if (!item) return

    if (item.type === 'function_call') {
      const toolId = item.call_id || item.id || `call_${Date.now()}`
      const toolName = item.name || 'unknown_function'
      const outputIndex = event.output_index ?? 0

      this.startToolUseBlock(outputIndex, toolId, toolName)
    } else if (item.type === 'reasoning') {
      // Reasoning item added - thinking block will be started on first delta
      // No immediate action needed, writeThinkingDelta handles block creation
    }
  }

  /**
   * Handle output item done event
   */
  private handleOutputItemDone(event: { item?: any; output_index?: number }): void {
    const item = event.item
    if (!item) return

    if (item.type === 'function_call') {
      const outputIndex = event.output_index ?? 0
      const blockIndex = this.toolIndexToBlock.get(outputIndex)

      if (blockIndex !== undefined) {
        this.writer.writeBlockStop(blockIndex)
        this.state.currentBlockIndex = -1
      }
    } else if (item.type === 'reasoning') {
      // Reasoning item complete
      // Extract summary text if present in the done event
      if (item.summary && Array.isArray(item.summary)) {
        for (const part of item.summary) {
          if (part.type === 'summary_text' && part.text) {
            this.writeThinkingDelta(part.text)
          }
        }
      }
      // Close thinking block if open (will be handled by closeCurrentBlock in finishMessage)
    }
  }

  /**
   * Handle function call arguments delta event
   */
  private handleFunctionCallArgumentsDelta(event: { delta?: string; output_index?: number }): void {
    const argsDelta = event.delta
    const outputIndex = event.output_index ?? 0

    if (typeof argsDelta === 'string') {
      this.writeToolInputDelta(outputIndex, argsDelta)
    }
  }

  /**
   * Handle reasoning summary text delta event
   */
  private handleReasoningSummaryTextDelta(event: { delta?: string }): void {
    const delta = event.delta
    if (typeof delta === 'string' && delta !== '') {
      this.writeThinkingDelta(delta)
    }
  }

  /**
   * Handle completion event
   */
  private handleCompletion(response: any): void {
    const stopReason = this.mapStopReason(response.stop_reason || response.status)
    this.setStopReason(stopReason)

    // Update final usage
    if (response.usage) {
      this.updateUsage({
        inputTokens: response.usage.input_tokens || response.usage.prompt_tokens,
        outputTokens: response.usage.output_tokens || response.usage.completion_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens
      })
    }

    this.markFinished()
  }

  /**
   * Handle incomplete event
   */
  private handleIncomplete(response: any): void {
    const reason = response.incomplete_details?.reason
    const stopReason: AnthropicStopReason =
      reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn'
    this.setStopReason(stopReason)
    this.markFinished()
  }

  /**
   * Handle failed event
   */
  private handleFailed(response: any): void {
    if (response.error) {
      this.writeError(JSON.stringify(response.error))
    }
    this.setStopReason('end_turn')
    this.markFinished()
  }

  /**
   * Map stop reason to Anthropic format
   */
  private mapStopReason(reason: string | null | undefined): AnthropicStopReason {
    if (!reason) return 'end_turn'
    const normalized = String(reason).toLowerCase()
    return OPENAI_RESPONSES_STOP_REASON_MAP[normalized] || 'end_turn'
  }
}

// ============================================================================
// Convenience Function
// ============================================================================

/**
 * Stream OpenAI Responses API response to Anthropic format
 */
export async function streamOpenAIResponsesToAnthropic(
  stream: unknown,
  res: ExpressResponse,
  model?: string,
  debug = false
): Promise<void> {
  const handler = new OpenAIResponsesStreamHandler(res, { model, debug })
  await handler.processStream(stream)
}
