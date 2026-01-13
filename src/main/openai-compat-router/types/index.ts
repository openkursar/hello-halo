/**
 * OpenAI Compat Router - Type Definitions
 *
 * Complete type definitions for:
 * - Anthropic Claude Messages API
 * - OpenAI Chat Completions API
 * - OpenAI Responses API
 */

// Re-export all types
export * from './anthropic'
export * from './openai-chat'
export * from './openai-responses'

// ============================================================================
// Shared Types
// ============================================================================

/**
 * Supported OpenAI wire API types
 * Determined by URL suffix - no inference needed
 */
export type OpenAIWireApiType = 'chat_completions' | 'responses'

/**
 * Backend configuration for routing
 * URL must be complete endpoint (ending with /chat/completions or /responses)
 */
export interface BackendConfig {
  url: string
  key: string
  model?: string
}

/**
 * Router server info
 */
export interface RouterServerInfo {
  baseUrl: string
  port: number
}

/**
 * Router options
 */
export interface RouterOptions {
  debug?: boolean
  timeoutMs?: number
}

// ============================================================================
// Conversion Context Types
// ============================================================================

/**
 * Context passed during request conversion
 */
export interface RequestConversionContext {
  sourceApi: 'anthropic'
  targetApi: 'openai-chat' | 'openai-responses'
  hasImages: boolean
  hasTools: boolean
  hasThinking: boolean
}

/**
 * Context passed during response conversion
 */
export interface ResponseConversionContext {
  sourceApi: 'openai-chat' | 'openai-responses'
  targetApi: 'anthropic'
  requestModel?: string
}

// ============================================================================
// Stream State Types
// ============================================================================

/**
 * State for tracking stream conversion
 */
export interface StreamConversionState {
  started: boolean
  finished: boolean
  messageId: string
  model: string
  currentBlockIndex: number
  contentBlockIndex: number
  hasTextBlock: boolean
  hasThinkingBlock: boolean
  reasoningClosed: boolean
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
  }
  stopReason: string | null
}

/**
 * Tool call state during streaming
 */
export interface StreamToolCallState {
  id: string
  name: string
  arguments: string
  contentBlockIndex: number
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Result type for operations that can fail
 */
export type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E }

/**
 * Deep partial type
 */
export type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T

/**
 * Extract the element type from an array type
 */
export type ArrayElement<T> = T extends readonly (infer E)[] ? E : never
