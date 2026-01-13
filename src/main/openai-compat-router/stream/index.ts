/**
 * Stream Handlers
 *
 * Converts OpenAI streaming responses to Anthropic SSE format
 */

// SSE Writer
export { SSEWriter, type SSEWriterOptions } from './sse-writer'

// Base handler
export {
  BaseStreamHandler,
  createInitialState,
  OPENAI_CHAT_STOP_REASON_MAP,
  OPENAI_RESPONSES_STOP_REASON_MAP,
  type StreamState,
  type StreamHandlerOptions
} from './base-stream-handler'

// OpenAI Chat Completions stream handler
export {
  OpenAIChatStreamHandler,
  streamOpenAIChatToAnthropic
} from './openai-chat-stream'

// OpenAI Responses API stream handler
export {
  OpenAIResponsesStreamHandler,
  streamOpenAIResponsesToAnthropic
} from './openai-responses-stream'

// ============================================================================
// Backward Compatibility Aliases
// ============================================================================

import { streamOpenAIChatToAnthropic } from './openai-chat-stream'
import { streamOpenAIResponsesToAnthropic } from './openai-responses-stream'

/**
 * @deprecated Use streamOpenAIChatToAnthropic instead
 */
export const streamOpenAIToAnthropic = streamOpenAIChatToAnthropic
