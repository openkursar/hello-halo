/**
 * Response Converter: OpenAI Responses API -> Anthropic
 */

import type {
  AnthropicMessageResponse,
  AnthropicContentBlock,
  AnthropicStopReason,
  OpenAIResponsesResponse,
  OpenAIResponsesOutputItem,
  OpenAIResponsesStatus
} from '../../types'

import { responsesFunctionCallToAnthropicToolUse } from '../content-blocks'
import { generateMessageId, generateToolUseId } from '../../utils'
import { createAnthropicErrorResponse } from './openai-chat-to-anthropic'

// ============================================================================
// Stop Reason Mapping
// ============================================================================

const STOP_REASON_MAP: Record<string, AnthropicStopReason> = {
  stop: 'end_turn',
  completed: 'end_turn',
  complete: 'end_turn',
  length: 'max_tokens',
  max_tokens: 'max_tokens',
  tool_calls: 'tool_use',
  tool_call: 'tool_use',
  tool_use: 'tool_use'
}

/**
 * Map OpenAI Responses status/stop_reason to Anthropic stop_reason
 */
export function mapStatusToStopReason(
  status: OpenAIResponsesStatus | string | null | undefined
): AnthropicStopReason {
  if (!status) return 'end_turn'
  const normalized = String(status).toLowerCase()
  return STOP_REASON_MAP[normalized] || 'end_turn'
}

// ============================================================================
// Output Item Processing
// ============================================================================

/**
 * Process message output item
 */
function processMessageOutput(item: OpenAIResponsesOutputItem): AnthropicContentBlock[] {
  if (item.type !== 'message') return []

  const blocks: AnthropicContentBlock[] = []

  if ('content' in item && Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part.type === 'output_text' && part.text) {
        blocks.push({ type: 'text', text: part.text })
      } else if (part.type === 'refusal' && part.refusal) {
        blocks.push({ type: 'text', text: `[Refusal] ${part.refusal}` })
      }
    }
  }

  return blocks
}

/**
 * Process function call output item
 */
function processFunctionCallOutput(item: OpenAIResponsesOutputItem): AnthropicContentBlock | null {
  if (item.type !== 'function_call') return null

  const functionCall = item as {
    id?: string
    call_id?: string
    name: string
    arguments: string
  }

  return responsesFunctionCallToAnthropicToolUse({
    id: functionCall.id || functionCall.call_id || generateToolUseId(),
    name: functionCall.name,
    arguments: functionCall.arguments
  })
}

/**
 * Process reasoning output item
 */
function processReasoningOutput(item: OpenAIResponsesOutputItem): AnthropicContentBlock | null {
  if (item.type !== 'reasoning') return null

  const reasoning = item as {
    summary?: Array<{ type: string; text: string }>
    encrypted_content?: string
  }

  // Extract text from summary
  if (reasoning.summary && Array.isArray(reasoning.summary)) {
    const text = reasoning.summary
      .filter((s) => s.type === 'output_text' && s.text)
      .map((s) => s.text)
      .join('\n')

    if (text) {
      return { type: 'thinking', thinking: text }
    }
  }

  return null
}

// ============================================================================
// Main Converter
// ============================================================================

/**
 * Extract text from various output formats
 */
function extractOutputText(output: unknown): string | null {
  if (typeof output === 'string') {
    return output
  }

  if (output && typeof output === 'object' && 'output_text' in output) {
    return (output as { output_text: string }).output_text
  }

  return null
}

/**
 * Process generic output item (fallback)
 */
function processGenericOutput(item: unknown): AnthropicContentBlock[] {
  if (!item || typeof item !== 'object') return []

  const obj = item as Record<string, unknown>
  const blocks: AnthropicContentBlock[] = []

  // Check for output_text
  if (obj.output_text) {
    const text = extractOutputText(obj.output_text)
    if (text) {
      blocks.push({ type: 'text', text })
    }
  }

  // Check for output_tool_call
  if (obj.output_tool_call && typeof obj.output_tool_call === 'object') {
    const toolCall = obj.output_tool_call as {
      id?: string
      call_id?: string
      name?: string
      function?: { name?: string }
      arguments?: string
      function_arguments?: string
    }

    const toolBlock = responsesFunctionCallToAnthropicToolUse({
      id: toolCall.id || toolCall.call_id,
      name: toolCall.name || toolCall.function?.name || 'tool',
      arguments: toolCall.arguments || toolCall.function_arguments || '{}'
    })
    blocks.push(toolBlock)
  }

  // Check for nested content array
  if (Array.isArray(obj.content)) {
    const textParts = obj.content
      .map((c: unknown) => {
        if (!c) return ''
        if (typeof c === 'string') return c
        if (typeof c === 'object' && c !== null) {
          const cObj = c as Record<string, unknown>
          if (cObj.text) return String(cObj.text)
          if (cObj.content) return String(cObj.content)
        }
        return ''
      })
      .filter(Boolean)

    if (textParts.length > 0) {
      blocks.push({ type: 'text', text: textParts.join('') })
    }
  }

  return blocks
}

/**
 * Convert OpenAI Responses API response to Anthropic format
 */
export function convertOpenAIResponsesToAnthropic(
  openaiResponse: unknown
): AnthropicMessageResponse {
  if (!openaiResponse) {
    return createAnthropicErrorResponse('Empty response from provider')
  }

  // Handle wrapped response format
  const resp = (openaiResponse as any).response || openaiResponse
  const model = resp.model || (openaiResponse as any).model || 'unknown'
  const content: AnthropicContentBlock[] = []

  // Get output array (try multiple possible field names)
  const output = resp.output ?? resp.outputs ?? resp.output_text ?? resp.output_texts

  if (typeof output === 'string') {
    // Simple string output
    if (output) {
      content.push({ type: 'text', text: output })
    }
  } else if (Array.isArray(output)) {
    // Array of output items
    for (const item of output) {
      if (!item) continue

      const type = String(item.type || '').toLowerCase()

      if (type.includes('message') || type === 'message') {
        content.push(...processMessageOutput(item as OpenAIResponsesOutputItem))
      } else if (type.includes('function_call') || type === 'function_call') {
        const block = processFunctionCallOutput(item as OpenAIResponsesOutputItem)
        if (block) content.push(block)
      } else if (type.includes('reasoning') || type === 'reasoning') {
        const block = processReasoningOutput(item as OpenAIResponsesOutputItem)
        if (block) content.push(block)
      } else if (type.includes('text')) {
        // Generic text output
        const text = item.text ?? item.content ?? ''
        if (text) {
          content.push({ type: 'text', text: String(text) })
        }
      } else if (type.includes('tool')) {
        // Generic tool output
        const block = processFunctionCallOutput(item as OpenAIResponsesOutputItem)
        if (block) content.push(block)
      } else {
        // Fallback processing
        content.push(...processGenericOutput(item))
      }
    }
  } else if (output && typeof output === 'object') {
    // Single object output
    const text = extractOutputText(output)
    if (text) {
      content.push({ type: 'text', text })
    }
  }

  // Extract reasoning content from response level
  if (resp.reasoning || resp.reasoning_content) {
    const reasoningText = typeof resp.reasoning === 'string'
      ? resp.reasoning
      : typeof resp.reasoning_content === 'string'
        ? resp.reasoning_content
        : null

    if (reasoningText) {
      content.push({ type: 'thinking', thinking: reasoningText })
    }
  }

  // Map stop reason
  const stopReasonRaw = resp.stop_reason || resp.status || 'end_turn'
  const stopReason = mapStatusToStopReason(stopReasonRaw)

  // Ensure content is not empty
  const finalContent = content.length > 0 ? content : [{ type: 'text' as const, text: '' }]

  return {
    id: resp.id || generateMessageId(),
    type: 'message',
    role: 'assistant',
    model,
    content: finalContent,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.input_tokens || resp.usage?.prompt_tokens || 0,
      output_tokens: resp.usage?.output_tokens || resp.usage?.completion_tokens || 0
    }
  }
}

/**
 * Alias for backward compatibility
 */
export const convertResponse = convertOpenAIResponsesToAnthropic
