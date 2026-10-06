/**
 * Message Array Converters
 *
 * Handles conversion of message arrays between different API formats
 */

import type {
  // Anthropic types
  AnthropicMessage,
  AnthropicSystemBlock,
  AnthropicContentBlock,
  // OpenAI Chat types
  OpenAIChatMessage,
  OpenAIChatSystemMessage,
  OpenAIChatAssistantMessage,
  OpenAIChatToolMessage,
  OpenAIChatContentPart,
  // OpenAI Responses types
  OpenAIResponsesInputItem,
  OpenAIResponsesInputMessage,
  OpenAIResponsesInputContentPart
} from '../types'

import {
  anthropicBlockToOpenAIChatPart,
  anthropicImageToOpenAIChatImage,
  anthropicToolUseToOpenAIChatToolCall,
  anthropicBlockToResponsesInputPart,
  anthropicImageToResponsesInputImage,
  anthropicToolUseToResponsesFunctionCall,
  anthropicToolResultToResponsesFunctionCallOutput,
  extractTextFromAnthropicBlocks,
  extractToolUseBlocks,
  extractToolResultBlocks
} from './content-blocks'

import { deepClone } from '../utils'

// ============================================================================
// Anthropic -> OpenAI Chat Completions
// ============================================================================

export interface ConvertedOpenAIChatMessages {
  messages: OpenAIChatMessage[]
  hasImages: boolean
}

/**
 * Options for {@link convertAnthropicMessagesToOpenAIChat} and
 * {@link convertAnthropicMessagesToResponsesInput}.
 */
export interface MessagesConvertOptions {
  /**
   * When true, image content blocks are dropped from user messages and from
   * `tool_result.content` arrays before serialization. Used when the target
   * model has no vision capability, where a strict non-vision provider would
   * otherwise reject the `image_url` variant.
   *
   * `hasImages` in the result still reflects whether the *original* input
   * contained images, so callers can log/notify accurately.
   *
   * Default: false (preserve images, current behavior).
   */
  stripImages?: boolean
}

/**
 * Drop image blocks from a tool_result.content array before it is serialized
 * as tool output text. Images inside tool results (e.g. MCP screenshot tools,
 * Read on image files) would otherwise reach the model as base64 text — a
 * single screenshot can exceed a provider's whole input limit. Vision targets
 * get those images as image parts of the following user message instead.
 */
function stripImagesFromToolResultContent(
  content: AnthropicContentBlock[]
): AnthropicContentBlock[] {
  return content.filter((b) => b.type !== 'image')
}

/**
 * Output of a tool result whose only content was images, now in the user
 * message that follows. Left empty it would read as the tool having returned
 * nothing.
 */
function movedImagesNote(count: number): string {
  return count === 1
    ? 'Image attached in the following user message.'
    : `${count} images attached in the following user message.`
}

/**
 * Convert Anthropic system prompt to OpenAI Chat system message
 */
export function convertAnthropicSystemToOpenAIChat(
  system: string | AnthropicSystemBlock[] | undefined
): OpenAIChatSystemMessage | null {
  if (!system) return null

  if (typeof system === 'string') {
    return { role: 'system', content: system }
  }

  if (Array.isArray(system) && system.length > 0) {
    const textBlocks = system.filter((block) => block?.type === 'text' && block.text
      && !block.text.startsWith('x-anthropic-'))
    if (textBlocks.length === 0) return null

    // If all blocks are plain text, return as content parts
    // Note: cache_control is Anthropic-specific, strip it for OpenAI format
    const contentParts = textBlocks.map((block) => ({
      type: 'text' as const,
      text: block.text
    }))

    return { role: 'system', content: contentParts }
  }

  return null
}

/**
 * Convert Anthropic messages array to OpenAI Chat messages
 */
export function convertAnthropicMessagesToOpenAIChat(
  messages: AnthropicMessage[] | undefined,
  system: string | AnthropicSystemBlock[] | undefined,
  options?: MessagesConvertOptions
): ConvertedOpenAIChatMessages {
  const result: OpenAIChatMessage[] = []
  let hasImages = false
  const stripImages = options?.stripImages === true

  // Add system message if present
  const systemMessage = convertAnthropicSystemToOpenAIChat(system)
  if (systemMessage) {
    result.push(systemMessage)
  }

  if (!messages || !Array.isArray(messages)) {
    return { messages: result, hasImages }
  }

  // Deep clone to avoid mutation
  const msgsCopy = deepClone(messages)

  for (const msg of msgsCopy) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) {
      continue
    }

    // Handle string content
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content })
      continue
    }

    if (!Array.isArray(msg.content)) {
      continue
    }

    const blocks = msg.content as AnthropicContentBlock[]

    if (msg.role === 'user') {
      // Tool messages come first: every tool call must be answered before user
      // content. Images from tool results open the user message that follows,
      // together with the turn's own content — one user message, because some
      // strict providers reject two consecutive user messages.
      const openaiContent: OpenAIChatContentPart[] = []

      const toolResults = extractToolResultBlocks(blocks)
      for (const toolResult of toolResults) {
        // Detect images in tool_result.content array before any stripping
        // so `hasImages` reflects the original input regardless of stripImages.
        let toolResultContent = toolResult.content
        let movedImages = 0
        if (Array.isArray(toolResultContent)) {
          if (toolResultContent.some((b) => b.type === 'image')) {
            hasImages = true
            if (!stripImages) {
              for (const block of toolResultContent) {
                if (block.type === 'image' && block.source) {
                  openaiContent.push(anthropicImageToOpenAIChatImage(block))
                  movedImages++
                }
              }
            }
            toolResultContent = stripImagesFromToolResultContent(toolResultContent)
          }
        }

        const content = movedImages > 0 && Array.isArray(toolResultContent) && toolResultContent.length === 0
          ? movedImagesNote(movedImages)
          : typeof toolResultContent === 'string'
            ? toolResultContent
            : JSON.stringify(toolResultContent)

        const toolMessage: OpenAIChatToolMessage = {
          role: 'tool',
          content,
          tool_call_id: toolResult.tool_use_id
        }

        result.push(toolMessage)
      }

      // Convert remaining content blocks (text, image)
      const contentBlocks = blocks.filter(
        (b) => (b.type === 'text' && (b as any).text) || (b.type === 'image' && (b as any).source)
      )

      for (const block of contentBlocks) {
        if (block.type === 'image') {
          hasImages = true
          // Skip image conversion for non-vision targets; the provider's
          // schema does not recognize `image_url` and would reject the request.
          if (stripImages) continue
        }
        const converted = anthropicBlockToOpenAIChatPart(block)
        if (converted) {
          openaiContent.push(converted)
        }
      }

      if (openaiContent.length > 0) {
        result.push({ role: 'user', content: openaiContent })
      }
    } else if (msg.role === 'assistant') {
      // Extract text and tool_use blocks
      const text = extractTextFromAnthropicBlocks(blocks)
      const toolUseBlocks = extractToolUseBlocks(blocks)

      // Extract thinking blocks as reasoning_content.
      // Any provider that returns thinking content requires it to be echoed back
      // in subsequent requests (DeepSeek, Moonshot, GLM). Injecting it here at
      // the converter level eliminates the need for per-provider adapter logic.
      const thinkingText = blocks
        .filter((b) => b.type === 'thinking' && (b as any).thinking)
        .map((b) => (b as any).thinking as string)
        .join('\n')

      const assistantMessage: OpenAIChatAssistantMessage = {
        role: 'assistant',
        content: text || null // OpenAI expects null for pure tool_calls
      }

      if (thinkingText) {
        assistantMessage.reasoning_content = thinkingText
      }

      if (toolUseBlocks.length > 0) {
        assistantMessage.tool_calls = toolUseBlocks.map(anthropicToolUseToOpenAIChatToolCall)
      }

      result.push(assistantMessage)
    }
  }

  return { messages: result, hasImages }
}

// ============================================================================
// Anthropic -> OpenAI Responses
// ============================================================================

/**
 * Convert Anthropic system prompt to OpenAI Responses input item
 * Note: Responses API uses 'developer' role instead of 'system' for system-level instructions
 */
export function convertAnthropicSystemToResponsesInput(
  system: string | AnthropicSystemBlock[] | undefined
): OpenAIResponsesInputMessage | null {
  if (!system) return null

  let sysText: string

  if (typeof system === 'string') {
    sysText = system
  } else if (Array.isArray(system) && system.length > 0) {
    const textParts = system
      .filter((b) => b?.type === 'text' && b.text && !b.text.startsWith('x-anthropic-'))
      .map((b) => b.text)
    sysText = textParts.join('\n')
  } else {
    return null
  }

  if (!sysText) return null

  // Use 'system' role for compatibility (some providers don't support 'developer')
  return {
    type: 'message',
    role: 'system',
    content: [{ type: 'input_text', text: sysText }]
  }
}

/**
 * Convert Anthropic messages array to OpenAI Responses input items
 */
export function convertAnthropicMessagesToResponsesInput(
  messages: AnthropicMessage[] | undefined,
  system: string | AnthropicSystemBlock[] | undefined,
  options?: MessagesConvertOptions
): OpenAIResponsesInputItem[] {
  const result: OpenAIResponsesInputItem[] = []
  const stripImages = options?.stripImages === true

  // Add system message if present
  const systemMessage = convertAnthropicSystemToResponsesInput(system)
  if (systemMessage) {
    result.push(systemMessage)
  }

  if (!messages || !Array.isArray(messages)) {
    return result
  }

  // Deep clone to avoid mutation
  const msgsCopy = deepClone(messages)

  for (const msg of msgsCopy) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) {
      continue
    }

    // Handle string content
    if (typeof msg.content === 'string') {
      const contentType = msg.role === 'user' ? 'input_text' : 'output_text'
      result.push({
        type: 'message',
        role: msg.role,
        content: [{ type: contentType, text: msg.content }]
      } as OpenAIResponsesInputMessage)
      continue
    }

    if (!Array.isArray(msg.content)) {
      continue
    }

    const blocks = msg.content as AnthropicContentBlock[]

    if (msg.role === 'user') {
      // Same layout as the Chat path: every function_call_output first, then
      // one user message opened by the images from tool results.
      const contentParts: OpenAIResponsesInputContentPart[] = []

      const toolResults = extractToolResultBlocks(blocks)
      for (const toolResult of toolResults) {
        let output = toolResult
        if (Array.isArray(toolResult.content) && toolResult.content.some((b) => b.type === 'image')) {
          let movedImages = 0
          if (!stripImages) {
            for (const block of toolResult.content) {
              if (block.type === 'image' && block.source) {
                contentParts.push(anthropicImageToResponsesInputImage(block))
                movedImages++
              }
            }
          }
          const rest = stripImagesFromToolResultContent(toolResult.content)
          output = { ...toolResult, content: movedImages > 0 && rest.length === 0 ? movedImagesNote(movedImages) : rest }
        }
        result.push(anthropicToolResultToResponsesFunctionCallOutput(output))
      }

      // Convert other content blocks
      for (const block of blocks) {
        if (block.type === 'tool_result') continue
        // Skip image blocks for non-vision targets, and any without a source to convert.
        if (block.type === 'image' && (stripImages || !block.source)) continue
        const converted = anthropicBlockToResponsesInputPart(block, 'user')
        if (converted) {
          contentParts.push(converted)
        }
      }

      if (contentParts.length > 0) {
        result.push({
          type: 'message',
          role: 'user',
          content: contentParts
        })
      }
    } else if (msg.role === 'assistant') {
      // Convert text and thinking content
      const contentParts: OpenAIResponsesInputContentPart[] = []
      for (const block of blocks) {
        if (block.type !== 'tool_use') {
          const converted = anthropicBlockToResponsesInputPart(block, 'assistant')
          if (converted) {
            contentParts.push(converted)
          }
        }
      }

      if (contentParts.length > 0) {
        result.push({
          type: 'message',
          role: 'assistant',
          content: contentParts
        })
      }

      // Convert tool_use blocks -> function_call items
      const toolUseBlocks = extractToolUseBlocks(blocks)
      for (const toolUse of toolUseBlocks) {
        result.push(anthropicToolUseToResponsesFunctionCall(toolUse))
      }
    }
  }

  return result
}
