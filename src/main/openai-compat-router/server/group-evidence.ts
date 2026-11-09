/**
 * Puts what an attempt left behind (a status, a stream error event, an error type
 * with no status) into the one form the balancing policy reads, and words the
 * final error when no member could answer.
 */

import type { FailureEvidence } from '../balancing'
import { getUpstreamError, statusForErrorType } from './error-response'
import type { HeldFailure, HeldReply } from './held-response'

const EVIDENCE_BODY_CAP = 8 * 1024

function errorTypeOf(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown } }
    return typeof parsed?.error?.type === 'string' ? parsed.error.type : undefined
  } catch {
    return undefined
  }
}

export function toFailureEvidence(failure: HeldFailure, reply: HeldReply): FailureEvidence {
  switch (failure.cause) {
    case 'http':
      if (errorTypeOf(reply.body) === 'timeout_error') return { kind: 'timeout', phase: 'headers' }
      return { kind: 'http', status: failure.status, headers: reply.headers, body: reply.body.slice(0, EVIDENCE_BODY_CAP) }
    case 'stream-error': {
      // A stream error event names the same trouble a status would.
      const status = statusForErrorType(failure.errorType)
      if (status === undefined) return { kind: 'stream-error', errorType: failure.errorType, message: failure.message }
      return {
        kind: 'http',
        status,
        headers: reply.headers,
        body: JSON.stringify({ error: { type: failure.errorType, message: failure.message } }),
      }
    }
    case 'empty':
      return { kind: 'empty' }
    case 'timeout':
      return { kind: 'timeout', phase: failure.phase }
    case 'error':
      return { kind: 'network', message: failure.message }
  }
}

/** How a member's failure reads in the one-line summary of a final error. */
export function failureReason(evidence: FailureEvidence): string {
  switch (evidence.kind) {
    case 'http':
      if (evidence.status === 401 || evidence.status === 403) return 'rejected the credentials'
      if (evidence.status === 402) return 'is out of credit'
      if (evidence.status === 429 || evidence.status === 529) return 'is limiting requests'
      if (evidence.status === 404) return 'does not offer this model'
      if (evidence.status >= 500) return 'returned a server error'
      return 'rejected the request'
    case 'timeout':
      return 'did not answer in time'
    case 'empty':
      return 'returned an empty reply'
    case 'stream-error':
      return 'reported an error'
    case 'network':
      return 'could not be reached'
    case 'credential':
      return 'is not signed in'
  }
}

export interface FinalError {
  type: string
  message: string
  /** The status the failing upstream used, when it used one. */
  status?: number
}

/** The error to answer with: the last real failure, so its status and wording stay true. */
export function lastFailureAsError(
  failure: HeldFailure | { cause: 'credential'; message: string },
  reply?: HeldReply
): FinalError {
  switch (failure.cause) {
    case 'http': {
      const parsed = getUpstreamError(failure.status, reply?.body ?? '')
      return { type: parsed.type, message: parsed.message, status: failure.status }
    }
    case 'stream-error':
      return { type: failure.errorType || 'api_error', message: failure.message }
    case 'empty':
      return { type: 'api_error', message: 'The model returned an empty reply' }
    case 'timeout':
      return { type: 'timeout_error', message: 'The model did not answer in time' }
    case 'error':
      return { type: 'api_error', message: failure.message }
    case 'credential':
      return { type: 'authentication_error', message: failure.message }
  }
}
