/**
 * Error replies — how the router answers a request it cannot fulfil.
 *
 * When to retry is the client's decision, never the backend's. The engines
 * behind the router retry on their own rhythm but obey a backend's retry
 * hints when they see one, and a backend can ask for hours: a subscription
 * limit answers with a `retry-after` pointing at its reset, and the turn then
 * waits that long in silence. So no error reply carries a backend's retry
 * hints, and the router adds no wait of its own. It keeps the upstream's
 * status, so a 429 stays a 429, and makes one judgment itself: a spent quota
 * or an unpaid account is not retried at all.
 */

import type { Response as ExpressResponse } from 'express'

/** Anthropic error type → HTTP status. */
const ERROR_STATUS_MAP: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
  timeout_error: 504
}

/** HTTP status → Anthropic error type (official types only). */
const STATUS_ERROR_MAP: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  529: 'overloaded_error'
}

/** Response headers through which a backend steers when, or whether, its client retries. */
const BACKEND_RETRY_HINTS = ['retry-after', 'retry-after-ms', 'x-should-retry']

/**
 * Wording of a spent quota or an unpaid account — limits that retrying within
 * a request cannot lift. Matched against the upstream's error type and message
 * because providers report them under generic statuses (usually 429).
 */
const QUOTA_EXHAUSTED_PATTERN =
  /quota|usage[\s_-]?limit|billing|insufficient[\s_-]?(balance|credit|funds|quota)|credit balance|payment required|余额不足|额度|配额/i

function getErrorTypeFromStatus(status: number): string {
  return STATUS_ERROR_MAP[status] || 'api_error'
}

/**
 * Error type and message from an upstream error body.
 * Priority: upstream error.type > HTTP status mapping > 'api_error'.
 */
export function getUpstreamError(status: number, errorText: string): { type: string; message: string } {
  try {
    const json = JSON.parse(errorText)
    // OpenAI format: { error: { type, message } }
    if (json?.error?.type) {
      return { type: json.error.type, message: json.error.message || '' }
    }
    // Anthropic format: { error: { type, message } }
    if (json?.error?.message) {
      return { type: json.error.type || getErrorTypeFromStatus(status), message: json.error.message }
    }
  } catch {
    // Not JSON, ignore
  }
  return {
    type: getErrorTypeFromStatus(status),
    message: errorText || `HTTP ${status}`
  }
}

/**
 * Status to answer with. A known Anthropic error type decides — the upstream
 * named the failure precisely. A vendor-specific type keeps the upstream's own
 * status, so a 429 stays a 429 instead of collapsing into a generic 500.
 */
function resolveStatus(errorType: string, upstreamStatus: number | undefined): number {
  const mapped = ERROR_STATUS_MAP[errorType]
  if (mapped) return mapped
  if (upstreamStatus !== undefined && upstreamStatus >= 400 && upstreamStatus < 600) return upstreamStatus
  return 500
}

/** True when the failure is a spent quota or billing problem, not a passing condition. */
export function isQuotaExhausted(status: number, errorType: string, message: string): boolean {
  if (status === 402) return true
  if (status < 400 || status >= 500) return false
  return QUOTA_EXHAUSTED_PATTERN.test(errorType) || QUOTA_EXHAUSTED_PATTERN.test(message)
}

/**
 * Give an error reply the router's retry headers: none of the backend's
 * hints, and `x-should-retry: false` for a spent quota. Anything else is
 * retried on the client's own rhythm.
 */
export function applyRetryPolicy(
  res: ExpressResponse,
  status: number,
  errorType: string,
  message: string
): void {
  const relayedHints = BACKEND_RETRY_HINTS.filter((header) => res.hasHeader(header))
  for (const header of relayedHints) res.removeHeader(header)

  const refused = isQuotaExhausted(status, errorType, message)
  if (refused) res.setHeader('x-should-retry', 'false')

  if (relayedHints.length > 0 || refused) {
    console.log(`[RequestHandler] retry_policy status=${status} backend_hints_dropped=${relayedHints.join(',') || 'none'} retry=${refused ? 'refused_quota_or_billing' : 'client_rhythm'}`)
  }
}

/**
 * Send an error in Anthropic JSON format (HTTP error status + JSON body, not
 * SSE). Pass the upstream status when relaying an upstream failure, so a 429
 * stays a 429.
 */
export function sendError(
  res: ExpressResponse,
  errorType: string,
  message: string,
  upstream?: { status: number }
): void {
  const status = resolveStatus(errorType, upstream?.status)
  console.log(`[RequestHandler] Sending error: HTTP ${status} ${errorType} - ${message.slice(0, 100)}`)

  res.status(status)
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('request-id', `req_${Date.now()}`)
  applyRetryPolicy(res, status, errorType, message)
  res.json({
    type: 'error',
    error: { type: errorType, message }
  })
}
