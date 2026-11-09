import { describe, expect, it } from 'vitest'
import { judgeFailure } from '../../../../src/main/openai-compat-router/balancing/failure-verdict'
import type { FailureEvidence } from '../../../../src/main/openai-compat-router/balancing/types'

const NOW = 1_000_000
const http = (status: number, body = '', headers: Record<string, string> = {}): FailureEvidence => ({ kind: 'http', status, headers, body })

describe('judging a failure', () => {
  it.each([
    ['402', http(402), 'quota', 'account', true],
    ['429 that names a quota', http(429, '{"error":{"message":"You exceeded your current quota"}}'), 'quota', 'account', true],
    ['429 that names a usage limit', http(429, '{"error":{"type":"usage_limit_reached"}}'), 'quota', 'account', true],
    ['403 that names billing', http(403, 'Billing account suspended'), 'quota', 'account', true],
    ['400 that names a credit balance', http(400, '{"error":{"message":"Your credit balance is too low"}}'), 'quota', 'account', true],
    ['an unpaid balance in Chinese', http(400, '账户余额不足'), 'quota', 'account', true],
    ['429', http(429, '{"error":{"message":"Too many requests"}}'), 'rate', 'member', true],
    ['529', http(529), 'rate', 'member', true],
    ['401', http(401), 'auth', 'account', true],
    ['403', http(403, 'forbidden'), 'auth', 'member', true],
    ['404', http(404), 'unavailable', 'member', true],
    ['500', http(500), 'transient', 'member', false],
    ['502', http(502), 'transient', 'member', false],
    ['503', http(503), 'transient', 'member', false],
    ['408', http(408), 'transient', 'member', false],
    ['an unusual status', http(418), 'transient', 'member', false],
  ])('%s', (_label, evidence, reason, scope, immediate) => {
    expect(judgeFailure(evidence, NOW)).toMatchObject({ blame: 'member', reason, scope, immediate })
  })

  it.each([
    ['network', { kind: 'network', message: 'ECONNRESET' } as const],
    ['a timeout while waiting for headers', { kind: 'timeout', phase: 'headers' } as const],
    ['a timeout waiting for content', { kind: 'timeout', phase: 'first-content' } as const],
    ['an empty reply', { kind: 'empty' } as const],
    ['an error event on an open stream', { kind: 'stream-error', message: 'boom' } as const],
  ])('treats %s as a failure that counts toward a threshold', (_label, evidence) => {
    expect(judgeFailure(evidence, NOW)).toMatchObject({ blame: 'member', reason: 'transient', scope: 'member', immediate: false })
  })

  it('treats an unusable credential as an account problem at once', () => {
    expect(judgeFailure({ kind: 'credential', message: 'signed out' }, NOW))
      .toMatchObject({ blame: 'member', reason: 'auth', scope: 'account', immediate: true })
  })

  it.each([400, 413, 422])('blames the request for a plain %s', status => {
    expect(judgeFailure(http(status, '{"error":{"message":"messages: text content blocks must be non-empty"}}'), NOW)).toEqual({ blame: 'request' })
  })

  it('carries what the provider announced', () => {
    expect(judgeFailure(http(429, '', { 'retry-after': '90' }), NOW)).toMatchObject({ announcedUntil: NOW + 90_000 })
    expect(judgeFailure(http(503, '', { 'retry-after': '90' }), NOW)).toMatchObject({ announcedUntil: NOW + 90_000, immediate: false })
    expect(judgeFailure(http(429), NOW)).toMatchObject({ announcedUntil: null })
  })
})
