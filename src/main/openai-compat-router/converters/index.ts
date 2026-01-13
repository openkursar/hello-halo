/**
 * Protocol Converters
 *
 * Handles conversion between:
 * - Anthropic Claude Messages API
 * - OpenAI Chat Completions API
 * - OpenAI Responses API
 */

// Request converters
export {
  convertAnthropicToOpenAIChat,
  convertRequestToChat
} from './request/anthropic-to-openai-chat'

export {
  convertAnthropicToOpenAIResponses,
  convertRequestToResponses
} from './request/anthropic-to-openai-responses'

// Response converters
export {
  convertOpenAIChatToAnthropic,
  convertChatResponseToAnthropic,
  createAnthropicErrorResponse,
  mapFinishReasonToStopReason
} from './response/openai-chat-to-anthropic'

export {
  convertOpenAIResponsesToAnthropic,
  convertResponsesResponseToAnthropic,
  mapStatusToStopReason
} from './response/openai-responses-to-anthropic'

// Content block converters
export * from './content-blocks'

// Message converters
export * from './messages'

// Tool converters
export * from './tools'

// ============================================================================
// Backward Compatibility Aliases
// ============================================================================

import { convertAnthropicToOpenAIChat } from './request/anthropic-to-openai-chat'
import { convertAnthropicToOpenAIResponses } from './request/anthropic-to-openai-responses'
import { convertOpenAIChatToAnthropic } from './response/openai-chat-to-anthropic'
import { convertOpenAIResponsesToAnthropic } from './response/openai-responses-to-anthropic'

import type { AnthropicRequest, OpenAIChatRequest, OpenAIResponsesRequest } from '../types'

/**
 * @deprecated Use convertAnthropicToOpenAIChat instead
 */
export function convertAnthropicToOpenAI(request: AnthropicRequest): OpenAIChatRequest {
  return convertAnthropicToOpenAIChat(request).request
}

/**
 * @deprecated Use convertOpenAIChatToAnthropic instead
 */
export function convertOpenAIToAnthropic(response: any, requestModel?: string) {
  return convertOpenAIChatToAnthropic(response, requestModel)
}

// Re-export with original names for compatibility
export { convertAnthropicToOpenAIResponses as convertToResponsesRequest }
export { convertOpenAIResponsesToAnthropic as convertFromResponsesResponse }
