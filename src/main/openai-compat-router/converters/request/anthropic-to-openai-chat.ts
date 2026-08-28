/**
 * Request Converter: Anthropic -> OpenAI Chat Completions
 */

import type { AnthropicRequest, OpenAIChatRequest } from '../../types'
import { convertAnthropicMessagesToOpenAIChat } from '../messages'
import {
  convertAnthropicToolsToOpenAIChat,
  convertAnthropicToolChoiceToOpenAIChat
} from '../tools'
import { resolveReasoningEffortValue, isThinkingEffort } from '../reasoning-effort'
import { supportsVisionById, isReasoningModelById } from '../../../../shared/constants/model-capabilities'
import { buildStreamOptionsIncludeUsage } from './stream-options'
import { resolveOutputTokenLimit } from './max-tokens'
import type { ConvertRequestOptions } from './types'

export type { ConvertRequestOptions } from './types'

export interface ConversionResult {
  request: OpenAIChatRequest
  hasImages: boolean
  hasTools: boolean
}

/**
 * Convert Anthropic request to OpenAI Chat Completions request
 */
export function convertAnthropicToOpenAIChat(
  anthropicRequest: AnthropicRequest,
  options?: ConvertRequestOptions
): ConversionResult {
  // Strip image blocks for non-vision models. The OpenAI Chat spec encodes
  // images as `{type:'image_url', ...}`, but strict non-vision providers
  // reject this variant entirely. Image content can leak in via tool results
  // (Read on image, screenshots, MCP image returns) or mid-conv model
  // switches — the renderer UI input gate alone is not sufficient.
  // An explicit user vision override wins over the name heuristic so models
  // the blacklist misjudges (e.g. minimax-*) can still receive images.
  const stripImages = !(options?.visionOverride ?? supportsVisionById(anthropicRequest.model))

  // Convert messages
  const { messages, hasImages } = convertAnthropicMessagesToOpenAIChat(
    anthropicRequest.messages,
    anthropicRequest.system,
    { stripImages }
  )

  // Convert tools - just filter invalid ones, don't reject all
  const tools = convertAnthropicToolsToOpenAIChat(anthropicRequest.tools)

  // Build OpenAI request - only include essential parameters
  const openaiRequest: OpenAIChatRequest = {
    model: anthropicRequest.model,
    messages,
    stream: anthropicRequest.stream
  }

  // Issue #181: opt into chunk.usage so TokenUsageIndicator is not zero.
  // See `stream-options.ts` for the gateway-compat rationale.
  if (openaiRequest.stream) {
    openaiRequest.stream_options = buildStreamOptionsIncludeUsage()
  }

  // OpenAI reasoning models (o1/o3/o4-mini, gpt-5 thinking variants) reject
  // `max_tokens` with HTTP 400 and only accept `max_completion_tokens`. Route
  // the value to the correct field based on the model family.
  const outputTokens = resolveOutputTokenLimit(anthropicRequest.max_tokens)
  if (outputTokens !== undefined) {
    if (isReasoningModelById(anthropicRequest.model)) {
      openaiRequest.max_completion_tokens = outputTokens
    } else {
      openaiRequest.max_tokens = outputTokens
    }
  }

  // Add tools if present
  if (tools && tools.length > 0) {
    openaiRequest.tools = tools
    openaiRequest.tool_choice = convertAnthropicToolChoiceToOpenAIChat(anthropicRequest.tool_choice)
  }

  // Convert thinking -> reasoning_effort (top-level string per Chat Completions spec)
  const reasoningEffort = resolveReasoningEffortValue(
    anthropicRequest.thinking,
    options?.reasoningEffort,
    anthropicRequest.model
  )
  if (reasoningEffort) {
    openaiRequest.reasoning_effort = reasoningEffort
  }

  // Ensure every assistant message carries the reasoning_content field when
  // thinking mode is active OR thinking blocks are present in the conversation
  // history. This handles providers (DeepSeek et al.) that require the field on
  // ALL assistant messages once any thinking content exists in the conversation.
  const hasThinkingInConversation = openaiRequest.messages
    .some((m) => m.role === 'assistant' && 'reasoning_content' in m)
  if (isThinkingEffort(reasoningEffort) || hasThinkingInConversation) {
    for (const msg of openaiRequest.messages) {
      if (msg.role === 'assistant' && !('reasoning_content' in msg)) {
        ;(msg as unknown as Record<string, unknown>).reasoning_content = ''
      }
    }
  }

  if (stripImages && hasImages) {
    console.log(
      `[openai-compat] Stripped image content for non-vision model: ${anthropicRequest.model}`
    )
  }

  return {
    request: openaiRequest,
    hasImages,
    hasTools: !!tools && tools.length > 0
  }
}

/**
 * Simplified conversion that returns just the request
 * (for backward compatibility)
 */
export function convertRequest(anthropicRequest: AnthropicRequest): OpenAIChatRequest {
  return convertAnthropicToOpenAIChat(anthropicRequest).request
}
