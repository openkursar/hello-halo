/**
 * Warmup Request Interceptor
 *
 * CC CLI sends "Warmup" requests to pre-initialize agent subprocesses.
 * These serve no real purpose for LLM APIs, so we intercept and return a mock response.
 */

import type { AnthropicRequest } from '../types'
import type { RequestInterceptor, InterceptorContext, InterceptorResult } from './types'

/**
 * Extract user message text from Anthropic message content formats
 */
function getUserMessageText(content: AnthropicRequest['messages'][number]['content']): string | null {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    const textBlock = content.find((b) => typeof b === 'object' && b.type === 'text')
    return textBlock && 'text' in textBlock ? (textBlock.text as string) : null
  }

  return null
}

/**
 * Check if the last user message is exactly "Warmup"
 */
function isWarmupRequest(request: AnthropicRequest): boolean {
  if (!request.messages?.length) return false

  const lastUserMsg = [...request.messages].reverse().find((m) => m.role === 'user')
  if (!lastUserMsg) return false

  const text = getUserMessageText(lastUserMsg.content)
  return text?.trim() === 'Warmup'
}

/**
 * Send mock Warmup response in Anthropic SSE format
 */
function sendMockResponse(context: InterceptorContext): void {
  const { res, originalModel } = context
  const msgId = `msg_warmup_${Date.now()}`
  const responseText = 'Ready.'

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  // message_start
  res.write(`event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: originalModel,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 }
    }
  })}\n\n`)

  // content_block_start
  res.write(`event: content_block_start\ndata: ${JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' }
  })}\n\n`)

  // content_block_delta
  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: responseText }
  })}\n\n`)

  // content_block_stop
  res.write(`event: content_block_stop\ndata: ${JSON.stringify({
    type: 'content_block_stop',
    index: 0
  })}\n\n`)

  // message_delta
  res.write(`event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 2 }
  })}\n\n`)

  // message_stop
  res.write(`event: message_stop\ndata: ${JSON.stringify({
    type: 'message_stop'
  })}\n\n`)

  res.end()
}

/**
 * Warmup interceptor - returns mock response for CC CLI warmup requests
 */
export const warmupInterceptor: RequestInterceptor = {
  name: 'warmup',

  shouldIntercept(request: AnthropicRequest): boolean {
    return isWarmupRequest(request)
  },

  intercept(_request: AnthropicRequest, context: InterceptorContext): InterceptorResult {
    console.log('[Interceptor:warmup] Intercepting Warmup request, returning mock response...')
    sendMockResponse(context)
    return { handled: true, responded: true }
  }
}
