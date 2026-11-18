/**
 * Protocol Converters
 *
 * Handles conversion between:
 * - Anthropic Claude Messages API
 * - OpenAI Chat Completions API
 * - OpenAI Responses API
 */

export { resolveReasoning as resolveOpenAIReasoning } from './reasoning-effort'

// Request converters
export {
  convertAnthropicToOpenAIChat,
  convertRequest as convertRequestToChat
} from './request/anthropic-to-openai-chat'

export {
  convertAnthropicToOpenAIResponses,
  convertRequest as convertRequestToResponses
} from './request/anthropic-to-openai-responses'

// Response converters.
//
// The `convertChatResponseToAnthropic` / `convertResponsesResponseToAnthropic`
// aliases live in `./response/index.ts` — re-exporting them here from the
// leaf modules used to compile under esbuild's permissive tree-shaker but
// crashes any strict ESM consumer (Node.js native loader, tsx, ts-node ESM)
// with `SyntaxError: ... does not provide an export named ...`. Sourcing
// every alias from the response barrel keeps every consumer working.
export {
  convertOpenAIChatToAnthropic,
  convertChatResponseToAnthropic,
  createAnthropicErrorResponse,
  mapFinishReasonToStopReason
} from './response'

export {
  convertOpenAIResponsesToAnthropic,
  convertResponsesResponseToAnthropic,
  mapStatusToStopReason
} from './response'

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
