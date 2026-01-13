/**
 * Response Converter: OpenAI Chat Completions -> Anthropic
 */

import type {
  AnthropicMessageResponse,
  AnthropicContentBlock,
  AnthropicStopReason,
  OpenAIChatResponse,
  OpenAIChatResponseMessage,
  OpenAIChatFinishReason
} from '../../types'

import {
  openAIChatToolCallToAnthropicToolUse,
  openAIChatTextToAnthropicText
} from '../content-blocks'

import { generateMessageId, generateServerToolUseId } from '../../utils'

// ============================================================================
// Stop Reason Mapping
// ============================================================================

const STOP_REASON_MAP: Record<string, AnthropicStopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'stop_sequence' // Approximate mapping
}

/**
 * Map OpenAI finish_reason to Anthropic stop_reason
 */
export function mapFinishReasonToStopReason(
  finishReason: OpenAIChatFinishReason | string | null | undefined
): AnthropicStopReason {
  if (!finishReason) return 'end_turn'
  return STOP_REASON_MAP[finishReason] || 'end_turn'
}

// ============================================================================
// Content Extraction
// ============================================================================

/**
 * Extract text content from various OpenAI content formats
 */
function extractTextContent(content: unknown): string | null {
  if (content === null || content === undefined || content === '') {
    return null
  }

  if (typeof content === 'string') {
    return content
  }

  // Handle array of content parts
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        if (!p) return ''
        if (typeof p === 'string') return p
        if (p.type === 'text' && typeof p.text === 'string') return p.text
        return ''
      })
      .filter(Boolean)
    return parts.length > 0 ? parts.join('') : null
  }

  return String(content)
}

/**
 * Extract web search annotations and convert to Anthropic format
 */
function extractWebSearchAnnotations(
  annotations: Array<{ type: string; url_citation?: { url?: string; title?: string } }> | undefined
): AnthropicContentBlock[] {
  if (!annotations || !Array.isArray(annotations)) {
    return []
  }

  const blocks: AnthropicContentBlock[] = []
  const toolUseId = generateServerToolUseId()

  // Add server_tool_use block
  blocks.push({
    type: 'server_tool_use',
    id: toolUseId,
    name: 'web_search',
    input: { query: '' }
  } as AnthropicContentBlock)

  // Add web_search_tool_result block
  blocks.push({
    type: 'web_search_tool_result',
    tool_use_id: toolUseId,
    content: annotations.map((ann) => ({
      type: 'web_search_result',
      url: ann.url_citation?.url,
      title: ann.url_citation?.title
    }))
  } as AnthropicContentBlock)

  return blocks
}

/**
 * Extract thinking/reasoning content
 */
function extractThinkingContent(
  message: OpenAIChatResponseMessage & { thinking?: { content?: string; signature?: string }; reasoning?: string; reasoning_content?: string }
): AnthropicContentBlock | null {
  // Check for thinking field (structured format)
  if (message.thinking?.content) {
    return {
      type: 'thinking',
      thinking: message.thinking.content,
      signature: message.thinking.signature
    }
  }

  // Check for reasoning field (string format)
  const reasoningText = typeof message.reasoning === 'string'
    ? message.reasoning
    : typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : null

  if (reasoningText) {
    return {
      type: 'thinking',
      thinking: reasoningText
    }
  }

  return null
}

// ============================================================================
// Main Converter
// ============================================================================

/**
 * Create an error response in Anthropic format
 */
export function createAnthropicErrorResponse(message: string): AnthropicMessageResponse {
  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    model: 'unknown',
    content: [{ type: 'text', text: `Error: ${message}` }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 }
  }
}

/**
 * Convert OpenAI Chat Completions response to Anthropic format
 */
export function convertOpenAIChatToAnthropic(
  openaiResponse: OpenAIChatResponse,
  requestModel?: string
): AnthropicMessageResponse {
  if (!openaiResponse) {
    return createAnthropicErrorResponse('Empty response from provider')
  }

  const choice = openaiResponse.choices?.[0]
  if (!choice) {
    return createAnthropicErrorResponse('No choices in response')
  }

  const message = choice.message
  if (!message) {
    return createAnthropicErrorResponse('No message in response choice')
  }

  const content: AnthropicContentBlock[] = []

  // Extract web search annotations (if present)
  const annotations = (message as any).annotations
  if (annotations) {
    content.push(...extractWebSearchAnnotations(annotations))
  }

  // Extract text content
  const text = extractTextContent(message.content)
  if (text) {
    content.push(openAIChatTextToAnthropicText(text))
  }

  // Convert tool calls
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const toolCall of message.tool_calls) {
      if (!toolCall?.function) continue
      content.push(openAIChatToolCallToAnthropicToolUse(toolCall))
    }
  }

  // Extract thinking/reasoning content
  const thinkingBlock = extractThinkingContent(message as any)
  if (thinkingBlock) {
    content.push(thinkingBlock)
  }

  // Map stop reason
  const stopReason = mapFinishReasonToStopReason(choice.finish_reason)

  return {
    id: openaiResponse.id,
    type: 'message',
    role: 'assistant',
    model: openaiResponse.model || requestModel || 'unknown',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
      cache_read_input_tokens: openaiResponse.usage?.cache_read_input_tokens
    }
  }
}

/**
 * Alias for backward compatibility
 */
export const convertResponse = convertOpenAIChatToAnthropic
