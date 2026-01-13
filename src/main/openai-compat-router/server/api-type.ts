/**
 * API Type Resolution
 *
 * Determines which OpenAI wire API format to use based on URL suffix.
 * No inference, no override - URL is the single source of truth.
 */

import type { OpenAIWireApiType } from '../types'

/**
 * Valid endpoint suffixes
 */
const VALID_ENDPOINTS = {
  chat_completions: '/chat/completions',
  responses: '/responses'
} as const

/**
 * Get API type from URL suffix
 * Returns null if URL doesn't end with a valid endpoint
 */
export function getApiTypeFromUrl(url: string): 'chat_completions' | 'responses' | null {
  if (url.endsWith('/chat/completions')) return 'chat_completions'
  if (url.endsWith('/responses')) return 'responses'
  return null
}

/**
 * Validate that URL ends with a valid OpenAI endpoint
 */
export function isValidEndpointUrl(url: string): boolean {
  return getApiTypeFromUrl(url) !== null
}

/**
 * Get validation error message for invalid URL
 */
export function getEndpointUrlError(url: string): string {
  return `Invalid endpoint URL: ${url}

Please provide a complete endpoint URL ending with:
  - /chat/completions  (e.g., https://api.openai.com/v1/chat/completions)
  - /responses         (e.g., https://api.openai.com/v1/responses)`
}

/**
 * Check if stream should be forced on (from environment variable)
 */
export function shouldForceStream(): boolean {
  const envValue = process.env.HALO_OPENAI_FORCE_STREAM
  return envValue === '1' || envValue === 'true' || envValue === 'yes'
}
