/**
 * Request Converter: Anthropic -> OpenAI Chat Completions
 */

import type { AnthropicRequest, OpenAIChatRequest } from '../../types'
import { convertAnthropicMessagesToOpenAIChat } from '../messages'
import {
  convertAnthropicToolsToOpenAIChat,
  convertAnthropicToolChoiceToOpenAIChat,
  convertAnthropicThinkingToChatReasoningEffort
} from '../tools'
import { supportsVisionById, isReasoningModelById } from '../../../../shared/constants/model-capabilities'
import { buildStreamOptionsIncludeUsage } from './stream-options'
import { resolveOutputTokenLimit } from './max-tokens'

export interface ConversionResult {
  request: OpenAIChatRequest
  hasImages: boolean
  hasTools: boolean
}

/**
 * Optional conversion overrides. `supportsVision` lets the caller pass the
 * provider-declared ModelOption.supportsVision straight through to the
 * router's strip decision, bypassing the model-id heuristic in
 * {@link supportsVisionById}. Undefined falls back to that heuristic.
 * See issue #139.
 */
export interface ConvertOptions {
  supportsVision?: boolean
}

/**
 * Convert Anthropic request to OpenAI Chat Completions request
 */
export function convertAnthropicToOpenAIChat(
  anthropicRequest: AnthropicRequest,
  options?: ConvertOptions
): ConversionResult {
  // Strip image blocks for non-vision models. The OpenAI Chat spec encodes
  // images as `{type:'image_url', ...}`, but strict non-vision providers
  // reject this variant entirely. Image content can leak in via tool results
  // (Read on image, screenshots, MCP image returns) or mid-conv model
  // switches — the renderer UI input gate alone is not sufficient.
  //
  // Prefer the provider-declared override (ModelOption.supportsVision carried
  // through the encoded BackendConfig) over the model-id heuristic; the
  // heuristic defaults unknown models to vision-capable and would forward
  // images to non-vision providers, triggering HTTP 400. (#139)
  const visionCapable = options?.supportsVision ?? supportsVisionById(anthropicRequest.model)
  const stripImages = !visionCapable

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
  const reasoningEffort = convertAnthropicThinkingToChatReasoningEffort(anthropicRequest.thinking)
  if (reasoningEffort) {
    openaiRequest.reasoning_effort = reasoningEffort
  }

  // Ensure every assistant message carries the reasoning_content field when
  // thinking mode is active OR thinking blocks are present in the conversation
  // history. This handles providers (DeepSeek et al.) that require the field on
  // ALL assistant messages once any thinking content exists in the conversation.
  const hasThinkingInConversation = openaiRequest.messages
    .some((m) => m.role === 'assistant' && 'reasoning_content' in m)
  if (reasoningEffort || hasThinkingInConversation) {
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
