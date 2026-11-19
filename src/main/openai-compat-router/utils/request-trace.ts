/**
 * Per-request tracing identifiers.
 *
 * A backend config is resolved once per account and model and reused for a
 * minute, so the identifiers its headers carry would repeat across requests.
 * A client that names each request gives every one its own.
 */

import { randomBytes } from 'node:crypto'

/**
 * Give the identifiers already present in `headers` a fresh value for this
 * request, in place. Names are lowercase; a header that is absent stays absent.
 * `conversationId` replaces the conversation header when the caller knows which
 * conversation the request belongs to.
 */
export function stampRequestTrace(headers: Record<string, string>, conversationId?: string): void {
  const hex = randomBytes(64).toString('hex')
  const traceId = hex.slice(0, 32)
  const spanId = hex.slice(32, 48)
  const parentSpanId = hex.slice(48, 64)
  const requestId = hex.slice(64, 96)
  const rootRequestId = hex.slice(96, 128)

  const stamps: Record<string, string> = {
    'x-request-id': requestId,
    'x-conversation-message-id': requestId,
    'x-conversation-request-id': rootRequestId,
    'x-root-request-id': rootRequestId,
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    'x-b3-traceid': traceId,
    'x-b3-spanid': spanId,
    'x-b3-parentspanid': parentSpanId,
    'x-trace-id': traceId,
  }
  if (conversationId) stamps['x-conversation-id'] = conversationId

  for (const name in stamps) {
    if (name in headers) headers[name] = stamps[name]
  }
}
