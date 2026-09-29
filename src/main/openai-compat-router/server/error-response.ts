/**
 * Error replies — how the router answers a request it cannot fulfil.
 *
 * Every client of the router (Claude Code, the Halo SDK, Codex) retries on its
 * own and decides from the status and the retry headers. So an error reply
 * must keep what the upstream said: its status, its `retry-after`, and whether
 * retrying can help at all. A spent quota answered as a transient 500 turns
 * into many minutes of pointless retries before the user sees the reason.
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

/**
 * Wait suggested for failures of the server-side kind when the upstream gave
 * none: short, because such blips usually clear within seconds.
 */
const TRANSIENT_RETRY_AFTER_SECONDS = '3'

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

function isTransientStatus(status: number): boolean {
  return status === 408 || status >= 500
}

/** True when the failure is a spent quota or billing problem, not a passing condition. */
export function isQuotaExhausted(status: number, errorType: string, message: string): boolean {
  if (status === 402) return true
  if (status < 400 || status >= 500) return false
  return QUOTA_EXHAUSTED_PATTERN.test(errorType) || QUOTA_EXHAUSTED_PATTERN.test(message)
}

/**
 * Set the retry headers of an error reply: the upstream's own hints when it
 * sent any, `x-should-retry: false` for a spent quota, and a short
 * `retry-after` for server-side failures that came without one.
 */
export function applyRetryHints(
  res: ExpressResponse,
  status: number,
  errorType: string,
  message: string,
  upstreamHeaders?: Headers
): void {
  const upstreamRetryAfter = upstreamHeaders?.get('retry-after')
  const upstreamShouldRetry = upstreamHeaders?.get('x-should-retry')

  if (upstreamRetryAfter) {
    res.setHeader('retry-after', upstreamRetryAfter)
  }

  if (upstreamShouldRetry) {
    res.setHeader('x-should-retry', upstreamShouldRetry)
  } else if (!upstreamRetryAfter && isQuotaExhausted(status, errorType, message)) {
    res.setHeader('x-should-retry', 'false')
    return
  }

  if (!upstreamRetryAfter && isTransientStatus(status)) {
    res.setHeader('retry-after', TRANSIENT_RETRY_AFTER_SECONDS)
  }
}

/**
 * Send an error in Anthropic JSON format (HTTP error status + JSON body, not
 * SSE). Pass the upstream status and headers when relaying an upstream
 * failure, so its status and retry hints survive the relay.
 */
export function sendError(
  res: ExpressResponse,
  errorType: string,
  message: string,
  upstream?: { status: number; headers: Headers }
): void {
  const status = resolveStatus(errorType, upstream?.status)
  console.log(`[RequestHandler] Sending error: HTTP ${status} ${errorType} - ${message.slice(0, 100)}`)

  res.status(status)
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('request-id', `req_${Date.now()}`)
  applyRetryHints(res, status, errorType, message, upstream?.headers)
  res.json({
    type: 'error',
    error: { type: errorType, message }
  })
}
