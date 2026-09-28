/**
 * A model request that failed with a transient error and is waiting to be
 * sent again by the agent engine. Every engine reports this the same way
 * (`system`/`api_retry`); main mirrors it to the renderer while the wait lasts
 * and never persists it. Pure data, renderer-safe.
 */

/** The engine's classification of the failure. */
export type ApiRetryErrorKind =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'max_output_tokens'
  | 'unknown'

export interface ApiRetryState {
  /** 1-based number of the attempt about to be made. */
  attempt: number
  maxRetries: number
  /**
   * Wait left before that attempt, measured when this state was sent. A
   * receiver sets its own deadline from it, so clocks never need to agree.
   */
  delayMs: number
  /** HTTP status of the failed attempt; null when no response arrived. */
  errorStatus: number | null
  errorKind: ApiRetryErrorKind
  /** Why the attempt failed, in the server's own words — engines that report it. */
  errorMessage?: string
}

/** Payload of `agent:api-retry`. `retry` is null once requests go through again. */
export interface ApiRetryEvent {
  spaceId: string
  conversationId: string
  retry: ApiRetryState | null
}
