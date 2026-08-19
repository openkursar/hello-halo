/**
 * handleLogin tests. Covers the rate-limit/audit/alert side effects of the
 * `POST /api/remote/login` handler: 200 + recordSuccess on a valid token,
 * 401 + recordFailure on a bad one, 429 + Retry-After when the IP/target is
 * locked, and the notifyLockout fire-once-on-newlyLocked contract.
 *
 * rate-limit, audit and alert are mocked so each branch can be driven
 * deterministically without touching the real sliding-window state.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Request, Response } from 'express'

vi.mock('../../../../src/main/http/auth/rate-limit', () => ({
  checkLock: vi.fn(),
  recordFailure: vi.fn(),
  recordSuccess: vi.fn(),
}))

vi.mock('../../../../src/main/http/auth/audit', () => ({
  logAuthEvent: vi.fn(),
}))

vi.mock('../../../../src/main/http/auth/alert', () => ({
  notifyLockout: vi.fn(),
}))

import { handleLogin } from '../../../../src/main/http/auth/middleware'
import {
  setCustomAccessToken,
  clearAccessToken,
} from '../../../../src/main/http/auth/token-store'
import { checkLock, recordFailure, recordSuccess } from '../../../../src/main/http/auth/rate-limit'
import { notifyLockout } from '../../../../src/main/http/auth/alert'

const VALID_TOKEN = 'Aa1!Aa1!'

interface MockResponse {
  statusCode: number
  headers: Record<string, string>
  body: unknown
  status(code: number): MockResponse
  set(name: string, value: string): MockResponse
  json(payload: unknown): MockResponse
}

function makeRes(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    set(name, value) {
      this.headers[name] = value
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
  }
  return res
}

function makeReq(body: unknown, headers: Record<string, string> = {}): Request {
  return {
    body,
    headers,
    socket: { remoteAddress: '5.6.7.8' },
  } as unknown as Request
}

function unlocked() {
  return { locked: false, retryAfterMs: 0 }
}

describe('handleLogin', () => {
  beforeEach(() => {
    vi.mocked(checkLock).mockReset()
    vi.mocked(recordFailure).mockReset()
    vi.mocked(recordSuccess).mockReset()
    vi.mocked(notifyLockout).mockReset()
    clearAccessToken()
    setCustomAccessToken(VALID_TOKEN)
  })

  it('returns 200 and records success for a valid token', () => {
    vi.mocked(checkLock).mockReturnValue(unlocked())
    const res = makeRes()

    handleLogin(makeReq({ token: VALID_TOKEN }), res as unknown as Response)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(recordSuccess).toHaveBeenCalledWith('5.6.7.8')
    expect(recordFailure).not.toHaveBeenCalled()
  })

  it('returns 401 and records failure for a bad token', () => {
    vi.mocked(checkLock).mockReturnValue(unlocked())
    vi.mocked(recordFailure).mockReturnValue({ newlyLocked: false, retryAfterMs: 0 })
    const res = makeRes()

    handleLogin(makeReq({ token: 'wrong' }), res as unknown as Response)

    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ success: false, error: 'Invalid token' })
    expect(recordFailure).toHaveBeenCalledWith('5.6.7.8')
    expect(recordSuccess).not.toHaveBeenCalled()
    expect(notifyLockout).not.toHaveBeenCalled()
  })

  it('returns 429 with Retry-After (seconds) when locked and never validates', () => {
    vi.mocked(checkLock).mockReturnValue({ locked: true, retryAfterMs: 90_000, reason: 'ip' })
    const res = makeRes()

    handleLogin(makeReq({ token: VALID_TOKEN }), res as unknown as Response)

    expect(res.statusCode).toBe(429)
    expect(res.headers['Retry-After']).toBe('90')
    expect(res.body).toEqual({
      success: false,
      error: 'Too many failed attempts. Try again later.',
      code: 'LOCKED',
    })
    // Locked short-circuit runs before any success/failure accounting.
    expect(recordSuccess).not.toHaveBeenCalled()
    expect(recordFailure).not.toHaveBeenCalled()
  })

  it('rounds Retry-After up to whole seconds', () => {
    vi.mocked(checkLock).mockReturnValue({ locked: true, retryAfterMs: 1500, reason: 'target' })
    const res = makeRes()

    handleLogin(makeReq({ token: 'x' }), res as unknown as Response)

    expect(res.headers['Retry-After']).toBe('2')
  })

  it('fires notifyLockout exactly once when a failure newly locks', () => {
    vi.mocked(checkLock).mockReturnValue(unlocked())
    vi.mocked(recordFailure).mockReturnValue({
      newlyLocked: true,
      reason: 'ip',
      retryAfterMs: 900_000,
    })
    const res = makeRes()

    handleLogin(makeReq({ token: 'wrong' }), res as unknown as Response)

    expect(res.statusCode).toBe(401)
    expect(notifyLockout).toHaveBeenCalledTimes(1)
    expect(notifyLockout).toHaveBeenCalledWith('ip', '5.6.7.8')
  })

  it('does not fire notifyLockout when the failure did not newly lock', () => {
    vi.mocked(checkLock).mockReturnValue(unlocked())
    vi.mocked(recordFailure).mockReturnValue({ newlyLocked: false, retryAfterMs: 0 })
    const res = makeRes()

    handleLogin(makeReq({ token: 'wrong' }), res as unknown as Response)

    expect(notifyLockout).not.toHaveBeenCalled()
  })

  it('rejects a non-string token body as a failure (does not throw)', () => {
    vi.mocked(checkLock).mockReturnValue(unlocked())
    vi.mocked(recordFailure).mockReturnValue({ newlyLocked: false, retryAfterMs: 0 })
    const res = makeRes()

    handleLogin(makeReq({ token: { nested: true } }), res as unknown as Response)

    expect(res.statusCode).toBe(401)
    expect(recordFailure).toHaveBeenCalledWith('5.6.7.8')
    expect(recordSuccess).not.toHaveBeenCalled()
  })

  it('rejects a missing body without throwing', () => {
    vi.mocked(checkLock).mockReturnValue(unlocked())
    vi.mocked(recordFailure).mockReturnValue({ newlyLocked: false, retryAfterMs: 0 })
    const res = makeRes()

    handleLogin(makeReq(undefined), res as unknown as Response)

    expect(res.statusCode).toBe(401)
    expect(recordFailure).toHaveBeenCalled()
  })
})
