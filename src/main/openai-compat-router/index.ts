/**
 * OpenAI Compat Router
 *
 * A protocol translation layer between Anthropic Claude Messages API and OpenAI APIs.
 * Supports both OpenAI Chat Completions API and OpenAI Responses API.
 *
 * Features:
 * - Request conversion: Anthropic -> OpenAI (Chat/Responses)
 * - Response conversion: OpenAI -> Anthropic
 * - Streaming support with SSE translation
 * - Tool/function calling support
 * - Image handling (base64/URL)
 * - Thinking/reasoning support
 *
 * Usage:
 * ```typescript
 * import { ensureOpenAICompatRouter, encodeBackendConfig } from './openai-compat-router'
 *
 * // Start the router
 * const { baseUrl, port } = await ensureOpenAICompatRouter({ debug: true })
 *
 * // Encode backend config as API key
 * // URL must be complete endpoint (ending with /chat/completions or /responses)
 * const apiKey = encodeBackendConfig({
 *   url: 'https://api.openai.com/v1/chat/completions',
 *   key: 'sk-...'
 * })
 *
 * // Make requests to: baseUrl + '/v1/messages' with x-api-key: apiKey
 * ```
 */

// ============================================================================
// Server (Main Entry Point)
// ============================================================================

export {
  ensureOpenAICompatRouter,
  stopOpenAICompatRouter,
  getRouterInfo,
  isRouterRunning,
  createApp
} from './server'

// ============================================================================
// Converters
// ============================================================================

export {
  // Request converters
  convertAnthropicToOpenAIChat,
  convertAnthropicToOpenAIResponses,
  // Response converters
  convertOpenAIChatToAnthropic,
  convertOpenAIResponsesToAnthropic,
  createAnthropicErrorResponse,
  // Backward compatibility
  convertAnthropicToOpenAI,
  convertOpenAIToAnthropic
} from './converters'

// ============================================================================
// Stream Handlers
// ============================================================================

export {
  streamOpenAIChatToAnthropic,
  streamOpenAIResponsesToAnthropic,
  // Backward compatibility
  streamOpenAIToAnthropic,
  // Classes for advanced usage
  SSEWriter,
  BaseStreamHandler,
  OpenAIChatStreamHandler,
  OpenAIResponsesStreamHandler
} from './stream'

// ============================================================================
// Utilities
// ============================================================================

export {
  // Config encoding
  encodeBackendConfig,
  decodeBackendConfig,
  // URL helpers
  extractBaseUrl,
  // ID generation
  generateId,
  generateMessageId,
  generateToolUseId,
  generateToolCallId,
  // JSON helpers
  safeJsonParse,
  deepClone
} from './utils'

// ============================================================================
// URL Validation (from server/api-type)
// ============================================================================

export {
  isValidEndpointUrl,
  getApiTypeFromUrl,
  getEndpointUrlError
} from './server/api-type'

// ============================================================================
// Types
// ============================================================================

export type {
  // Shared types
  OpenAIWireApiType,
  BackendConfig,
  RouterServerInfo,
  RouterOptions,
  // Anthropic types
  AnthropicRequest,
  AnthropicMessage,
  AnthropicMessageResponse,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicThinkingBlock,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicStopReason,
  AnthropicUsage,
  AnthropicStreamEvent,
  AnthropicErrorResponse,
  // OpenAI Chat types
  OpenAIChatRequest,
  OpenAIChatMessage,
  OpenAIChatResponse,
  OpenAIChatChunk,
  OpenAIChatTool,
  OpenAIChatToolCall,
  OpenAIChatToolChoice,
  OpenAIChatFinishReason,
  // OpenAI Responses types
  OpenAIResponsesRequest,
  OpenAIResponsesResponse,
  OpenAIResponsesInputItem,
  OpenAIResponsesOutputItem,
  OpenAIResponsesTool,
  OpenAIResponsesStreamEvent
} from './types'
