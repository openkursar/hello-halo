/**
 * Request Interceptor Types
 *
 * Interceptors operate on Anthropic Messages API format (the SDK's native format).
 * This ensures interceptors work identically for all providers — both Anthropic
 * passthrough and OpenAI-compatible backends — without format-dependent branching.
 *
 * Interceptors run BEFORE any format conversion, so they always see the original
 * Anthropic request and respond in Anthropic SSE format.
 */

import type { Response as ExpressResponse } from 'express'
import type { AnthropicRequest } from '../types'

/**
 * Context passed to interceptors
 */
export interface InterceptorContext {
  /** Original Anthropic model name */
  originalModel: string
  /** Express response object for sending responses */
  res: ExpressResponse
}

/**
 * Result of an interceptor execution
 */
export type InterceptorResult =
  | { handled: false }                              // Continue to next interceptor
  | { handled: true; modified?: AnthropicRequest }  // Modified request, continue processing
  | { handled: true; responded: true }              // Response already sent, stop processing

/**
 * Request interceptor interface
 */
export interface RequestInterceptor {
  /** Unique name for logging/debugging */
  name: string

  /**
   * Check if this interceptor should handle the request
   */
  shouldIntercept(request: AnthropicRequest, context: InterceptorContext): boolean

  /**
   * Handle the request
   * - Return { handled: false } to pass to next interceptor
   * - Return { handled: true, modified: request } to modify and continue
   * - Return { handled: true, responded: true } if response was sent
   */
  intercept(request: AnthropicRequest, context: InterceptorContext): InterceptorResult | Promise<InterceptorResult>
}
