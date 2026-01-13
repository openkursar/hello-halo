/**
 * Content Block Converters
 *
 * Handles conversion between different content block formats:
 * - Anthropic: text, image, tool_use, tool_result, thinking
 * - OpenAI Chat: text, image_url, tool_calls
 * - OpenAI Responses: input_text, input_image, output_text, function_call, function_call_output
 */

import type {
  // Anthropic types
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicThinkingBlock,
  AnthropicImageSource,
  // OpenAI Chat types
  OpenAIChatContentPart,
  OpenAIChatTextPart,
  OpenAIChatImagePart,
  OpenAIChatToolCall,
  // OpenAI Responses types
  OpenAIResponsesInputContentPart,
  OpenAIResponsesInputText,
  OpenAIResponsesInputImage,
  OpenAIResponsesOutputContentPart,
  OpenAIResponsesOutputText,
  OpenAIResponsesFunctionCall,
  OpenAIResponsesFunctionCallOutput
} from '../types'

// ============================================================================
// Anthropic -> OpenAI Chat Completions
// ============================================================================

/**
 * Convert Anthropic image source to data URL or direct URL
 */
export function anthropicImageSourceToUrl(source: AnthropicImageSource): string {
  if (source.type === 'base64') {
    const mediaType = source.media_type || 'image/png'
    return `data:${mediaType};base64,${source.data}`
  }
  return source.url
}

/**
 * Convert Anthropic text block to OpenAI Chat text part
 */
export function anthropicTextToOpenAIChatText(block: AnthropicTextBlock): OpenAIChatTextPart {
  return {
    type: 'text',
    text: block.text
  }
}

/**
 * Convert Anthropic image block to OpenAI Chat image part
 */
export function anthropicImageToOpenAIChatImage(block: AnthropicImageBlock): OpenAIChatImagePart {
  return {
    type: 'image_url',
    image_url: {
      url: anthropicImageSourceToUrl(block.source)
    }
  }
}

/**
 * Convert Anthropic tool_use block to OpenAI Chat tool call
 */
export function anthropicToolUseToOpenAIChatToolCall(block: AnthropicToolUseBlock): OpenAIChatToolCall {
  return {
    id: block.id,
    type: 'function',
    function: {
      name: block.name,
      arguments: JSON.stringify(block.input || {})
    }
  }
}

/**
 * Convert Anthropic content block to OpenAI Chat content part
 * Returns null for blocks that don't have a direct mapping (tool_use, tool_result)
 */
export function anthropicBlockToOpenAIChatPart(
  block: AnthropicContentBlock
): OpenAIChatContentPart | null {
  switch (block.type) {
    case 'text':
      return anthropicTextToOpenAIChatText(block)
    case 'image':
      return anthropicImageToOpenAIChatImage(block)
    default:
      return null
  }
}

// ============================================================================
// Anthropic -> OpenAI Responses
// ============================================================================

/**
 * Convert Anthropic text block to OpenAI Responses input_text
 */
export function anthropicTextToResponsesInputText(block: AnthropicTextBlock): OpenAIResponsesInputText {
  return {
    type: 'input_text',
    text: block.text
  }
}

/**
 * Convert Anthropic text block to OpenAI Responses output_text
 */
export function anthropicTextToResponsesOutputText(block: AnthropicTextBlock): OpenAIResponsesOutputText {
  return {
    type: 'output_text',
    text: block.text
  }
}

/**
 * Convert Anthropic image block to OpenAI Responses input_image
 */
export function anthropicImageToResponsesInputImage(block: AnthropicImageBlock): OpenAIResponsesInputImage {
  return {
    type: 'input_image',
    image_url: anthropicImageSourceToUrl(block.source)
  }
}

/**
 * Convert Anthropic tool_use block to OpenAI Responses function_call
 */
export function anthropicToolUseToResponsesFunctionCall(block: AnthropicToolUseBlock): OpenAIResponsesFunctionCall {
  return {
    type: 'function_call',
    call_id: block.id,
    name: block.name,
    arguments: JSON.stringify(block.input || {})
  }
}

/**
 * Convert Anthropic tool_result block to OpenAI Responses function_call_output
 */
export function anthropicToolResultToResponsesFunctionCallOutput(
  block: AnthropicToolResultBlock
): OpenAIResponsesFunctionCallOutput {
  const output = typeof block.content === 'string'
    ? block.content
    : JSON.stringify(block.content ?? '')
  return {
    type: 'function_call_output',
    call_id: block.tool_use_id,
    output
  }
}

/**
 * Convert Anthropic content block to OpenAI Responses input content part
 * Returns null for blocks that should be handled separately (tool_use, tool_result)
 */
export function anthropicBlockToResponsesInputPart(
  block: AnthropicContentBlock,
  role: 'user' | 'assistant'
): OpenAIResponsesInputContentPart | null {
  switch (block.type) {
    case 'text':
      return role === 'user'
        ? anthropicTextToResponsesInputText(block)
        : anthropicTextToResponsesOutputText(block) as unknown as OpenAIResponsesInputContentPart
    case 'image':
      return anthropicImageToResponsesInputImage(block)
    case 'thinking':
      // Convert thinking to output_text for assistant role
      if (role === 'assistant' && block.thinking) {
        return { type: 'output_text', text: block.thinking } as unknown as OpenAIResponsesInputContentPart
      }
      return null
    default:
      return null
  }
}

// ============================================================================
// OpenAI Chat Completions -> Anthropic
// ============================================================================

/**
 * Convert OpenAI Chat tool call to Anthropic tool_use block
 */
export function openAIChatToolCallToAnthropicToolUse(toolCall: OpenAIChatToolCall): AnthropicToolUseBlock {
  let input: Record<string, unknown> = {}
  try {
    const args = toolCall.function.arguments || '{}'
    input = typeof args === 'object' ? args : JSON.parse(args)
  } catch {
    // If JSON parsing fails, wrap in text field
    input = { text: toolCall.function.arguments || '' }
  }

  return {
    type: 'tool_use',
    id: toolCall.id,
    name: toolCall.function.name,
    input
  }
}

/**
 * Convert OpenAI Chat text content to Anthropic text block
 */
export function openAIChatTextToAnthropicText(text: string): AnthropicTextBlock {
  return {
    type: 'text',
    text
  }
}

// ============================================================================
// OpenAI Responses -> Anthropic
// ============================================================================

/**
 * Convert OpenAI Responses output_text to Anthropic text block
 */
export function responsesOutputTextToAnthropicText(part: OpenAIResponsesOutputText): AnthropicTextBlock {
  return {
    type: 'text',
    text: part.text
  }
}

/**
 * Convert OpenAI Responses function_call to Anthropic tool_use block
 */
export function responsesFunctionCallToAnthropicToolUse(
  functionCall: { id?: string; call_id?: string; name: string; arguments: string }
): AnthropicToolUseBlock {
  let input: Record<string, unknown> = {}
  try {
    const args = functionCall.arguments || '{}'
    input = typeof args === 'object' ? args : JSON.parse(args)
  } catch {
    input = { text: functionCall.arguments || '' }
  }

  return {
    type: 'tool_use',
    id: functionCall.id || functionCall.call_id || `call_${Date.now()}`,
    name: functionCall.name,
    input
  }
}

// ============================================================================
// Content Array Helpers
// ============================================================================

/**
 * Normalize content to array of blocks
 */
export function normalizeAnthropicContent(
  content: string | AnthropicContentBlock[]
): AnthropicContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return content
}

/**
 * Extract text content from Anthropic content blocks
 */
export function extractTextFromAnthropicBlocks(blocks: AnthropicContentBlock[]): string | null {
  const textBlocks = blocks.filter((b): b is AnthropicTextBlock => b.type === 'text' && !!b.text)
  if (textBlocks.length === 0) return null
  return textBlocks.map((b) => b.text).join('\n')
}

/**
 * Extract tool_use blocks from Anthropic content
 */
export function extractToolUseBlocks(blocks: AnthropicContentBlock[]): AnthropicToolUseBlock[] {
  return blocks.filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use' && !!b.id)
}

/**
 * Extract tool_result blocks from Anthropic content
 */
export function extractToolResultBlocks(blocks: AnthropicContentBlock[]): AnthropicToolResultBlock[] {
  return blocks.filter((b): b is AnthropicToolResultBlock => b.type === 'tool_result' && !!b.tool_use_id)
}

/**
 * Check if content contains images
 */
export function contentHasImages(blocks: AnthropicContentBlock[]): boolean {
  return blocks.some((b) => b.type === 'image')
}

/**
 * Check if content contains tool usage
 */
export function contentHasToolUse(blocks: AnthropicContentBlock[]): boolean {
  return blocks.some((b) => b.type === 'tool_use' || b.type === 'tool_result')
}
