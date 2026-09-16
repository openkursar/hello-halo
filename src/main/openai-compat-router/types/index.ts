/**
 * OpenAI Compat Router - Type Definitions
 *
 * Complete type definitions for:
 * - Anthropic Claude Messages API
 * - OpenAI Chat Completions API
 * - OpenAI Responses API
 */

import type { BackendRequestConfig } from '../../../shared/types/ai-sources'

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
 * Reuses BackendRequestConfig from shared types to ensure consistency
 */
export type BackendConfig = BackendRequestConfig

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
