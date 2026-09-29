/**
 * Model-request retries reported by the engine.
 *
 * Every engine announces a retry with a `system`/`api_retry` frame before it
 * waits and sends the request again (Claude Code and the Halo SDK share the
 * shape). This module turns that frame into the renderer-facing state and
 * keeps the one pending retry of a turn on its SessionState, so a client that
 * connects mid-wait can recover it.
 */

import type { ApiRetryErrorKind, ApiRetryState } from '../../../shared/types/api-retry'
import type { PendingApiRetry, SessionState } from './types'
import { emitAgentEvent } from './events'

const ERROR_KINDS: ReadonlySet<string> = new Set<ApiRetryErrorKind>([
  'authentication_failed',
  'billing_error',
  'rate_limit',
  'invalid_request',
  'server_error',
  'max_output_tokens',
  'unknown'
])

/** Longest server reason carried to the renderer; the full text stays in the logs. */
const MAX_ERROR_MESSAGE_CHARS = 500

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** The retry announced by an SDK frame, or null when the frame is not a well-formed `api_retry`. */
export function parseApiRetryMessage(msg: Record<string, unknown>): ApiRetryState | null {
  if (msg.type !== 'system' || msg.subtype !== 'api_retry') return null

  const attempt = finiteNonNegative(msg.attempt)
  const maxRetries = finiteNonNegative(msg.max_retries)
  const delayMs = finiteNonNegative(msg.retry_delay_ms)
  if (attempt === null || maxRetries === null || delayMs === null) return null

  const status = msg.error_status
  const errorKind = typeof msg.error === 'string' && ERROR_KINDS.has(msg.error)
    ? msg.error as ApiRetryErrorKind
    : 'unknown'
  const errorMessage = typeof msg.error_message === 'string' && msg.error_message.trim()
    ? msg.error_message.trim().slice(0, MAX_ERROR_MESSAGE_CHARS)
    : undefined

  return {
    attempt,
    maxRetries,
    delayMs: Math.round(delayMs),
    errorStatus: typeof status === 'number' && Number.isFinite(status) ? status : null,
    errorKind,
    ...(errorMessage ? { errorMessage } : {})
  }
}

/** The pending retry as seen now: the wait shrinks to what is left of it. */
export function snapshotApiRetry(pending: PendingApiRetry, now = Date.now()): ApiRetryState {
  return { ...pending.state, delayMs: Math.max(0, pending.retryAt - now) }
}

/** Record a retry announced for this turn and tell every client. */
export function beginApiRetry(sessionState: SessionState, retry: ApiRetryState): void {
  sessionState.apiRetry = { state: retry, retryAt: Date.now() + retry.delayMs }
  emitAgentEvent('agent:api-retry', sessionState.spaceId, sessionState.conversationId, { retry })
}

/** Clear the turn's pending retry — the request went through, or the turn is over. */
export function endApiRetry(sessionState: SessionState): void {
  if (!sessionState.apiRetry) return
  sessionState.apiRetry = null
  emitAgentEvent('agent:api-retry', sessionState.spaceId, sessionState.conversationId, { retry: null })
}
