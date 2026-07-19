/**
 * Request Converter: Anthropic -> OpenAI Responses API
 */

import type { AnthropicRequest, OpenAIResponsesRequest } from '../../types'
import { convertAnthropicMessagesToResponsesInput } from '../messages'
import {
  convertAnthropicToolsToResponses,
  convertAnthropicToolChoiceToResponses,
  convertAnthropicThinkingToResponsesReasoning
} from '../tools'
import { supportsVisionById } from '../../../../shared/constants/model-capabilities'
import { buildStreamOptionsIncludeUsage } from './stream-options'
import { resolveOutputTokenLimit } from './max-tokens'

export interface ConversionResult {
  request: OpenAIResponsesRequest
  hasImages: boolean
  hasTools: boolean
}

/**
 * Optional conversion overrides. See {@link anthropic-to-openai-chat.ts}.
 * Same rationale as #139: provider-declared ModelOption.supportsVision wins
 * over the model-id heuristic.
 */
export interface ConvertOptions {
  supportsVision?: boolean
}

/**
 * Convert Anthropic request to OpenAI Responses API request
 */
export function convertAnthropicToOpenAIResponses(
  anthropicRequest: AnthropicRequest,
  options?: ConvertOptions
): ConversionResult {
  // Mirror the Chat-Completions path: drop image content when the target
  // model has no vision capability so the Responses API does not reject
  // `input_image` parts. Symmetric handling keeps both paths consistent.
  //
  // Prefer the provider-declared override over supportsVisionById so
  // non-blacklisted non-vision models also strip images. (#139)
  const visionCapable = options?.supportsVision ?? supportsVisionById(anthropicRequest.model)
  const stripImages = !visionCapable

  // Detect images on the original input so we can log/report accurately
  // even after stripping.
  const originalHadImages = (anthropicRequest.messages ?? []).some((m) => {
    if (!m || !Array.isArray(m.content)) return false
    return m.content.some((b) => {
      if (b.type === 'image') return true
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        return b.content.some((inner) => inner.type === 'image')
      }
      return false
    })
  })

  // Convert messages to input items
  const inputItems = convertAnthropicMessagesToResponsesInput(
    anthropicRequest.messages,
    anthropicRequest.system,
    { stripImages }
  )

  // Report on the original input shape — independent of post-strip state.
  const hasImages = originalHadImages

  // Convert tools
  const tools = convertAnthropicToolsToResponses(anthropicRequest.tools)
  const hasTools = !!tools && tools.length > 0

  // Build request - only include essential parameters
  const request: OpenAIResponsesRequest = {
    model: anthropicRequest.model,
    input: inputItems,
    stream: anthropicRequest.stream
  }

  // Issue #181 (Responses-specific nuance): the native OpenAI Responses API
  // returns usage in `response.completed` unconditionally and silently ignores
  // `stream_options`. However, translation-style gateways (e.g. litellm) map
  // the Responses API to Chat Completions internally, where usage is gated by
  // `stream_options.include_usage`. Injecting it is harmless for the native
  // API and required for such gateways.
  if (request.stream) {
    request.stream_options = buildStreamOptionsIncludeUsage()
  }

  // Mirror the Chat Completions path. `max_output_tokens` is part of the
  // Responses API public spec — without forwarding, Halo's "max output tokens"
  // setting is silently dropped for Responses-routed backends.
  const outputTokens = resolveOutputTokenLimit(anthropicRequest.max_tokens)
  if (outputTokens !== undefined) {
    request.max_output_tokens = outputTokens
  }

  // Add tools if present
  if (tools && tools.length > 0) {
    request.tools = tools
    request.tool_choice = convertAnthropicToolChoiceToResponses(anthropicRequest.tool_choice)
  }

  // Convert thinking -> reasoning (only when enabled; omit entirely when disabled)
  const reasoning = convertAnthropicThinkingToResponsesReasoning(anthropicRequest.thinking)
  if (reasoning) {
    request.reasoning = reasoning
  }

  if (stripImages && hasImages) {
    console.log(
      `[openai-compat] Stripped image content for non-vision model: ${anthropicRequest.model}`
    )
  }

  return {
    request,
    hasImages,
    hasTools
  }
}

/**
 * Simplified conversion that returns just the request
 * (for backward compatibility)
 */
export function convertRequest(anthropicRequest: AnthropicRequest): OpenAIResponsesRequest {
  return convertAnthropicToOpenAIResponses(anthropicRequest).request
}
