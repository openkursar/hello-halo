/**
 * authenticateWebSocket tests. The WS auth path shares the HTTP login's
 * lockout counters, so it must: refuse a locked IP before ever validating
 * the token, record success on a valid token, record failure on an invalid
 * one, and fire the lockout alert exactly once when a failure newly locks.
 *
 * rate-limit, audit and alert are mocked to drive each branch deterministically.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

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

import { authenticateWebSocket } from '../../../../src/main/http/auth/middleware'
import {
  setCustomAccessToken,
  clearAccessToken,
} from '../../../../src/main/http/auth/token-store'
import { checkLock, recordFailure, recordSuccess } from '../../../../src/main/http/auth/rate-limit'
import { notifyLockout } from '../../../../src/main/http/auth/alert'

const VALID_TOKEN = 'Aa1!Aa1!'
const IP = '9.9.9.9'

function unlocked() {
  return { locked: false, retryAfterMs: 0 }
}

describe('authenticateWebSocket', () => {
  beforeEach(() => {
    vi.mocked(checkLock).mockReset()
    vi.mocked(recordFailure).mockReset()
    vi.mocked(recordSuccess).mockReset()
    vi.mocked(notifyLockout).mockReset()
    clearAccessToken()
    setCustomAccessToken(VALID_TOKEN)
  })

  it('returns false for a locked IP without validating the token or recording anything', () => {
    vi.mocked(checkLock).mockReturnValue({ locked: true, retryAfterMs: 60_000, reason: 'ip' })

    // Even the correct token must not authenticate a locked IP.
    expect(authenticateWebSocket(VALID_TOKEN, IP)).toBe(false)
    expect(recordSuccess).not.toHaveBeenCalled()
    expect(recordFailure).not.toHaveBeenCalled()
  })

  it('returns true and records success for a valid token', () => {
    vi.mocked(checkLock).mockReturnValue(unlocked())

    expect(authenticateWebSocket(VALID_TOKEN, IP)).toBe(true)
    expect(recordSuccess).toHaveBeenCalledWith(IP)
    expect(recordFailure).not.toHaveBeenCalled()
  })

  it('returns false and records failure for an invalid token', () => {
    vi.mocked(checkLock).mockReturnValue(unlocked())
    vi.mocked(recordFailure).mockReturnValue({ newlyLocked: false, retryAfterMs: 0 })

    expect(authenticateWebSocket('wrong', IP)).toBe(false)
    expect(recordFailure).toHaveBeenCalledWith(IP)
    expect(recordSuccess).not.toHaveBeenCalled()
    expect(notifyLockout).not.toHaveBeenCalled()
  })

  it('fires the lockout alert once when an invalid attempt newly locks', () => {
    vi.mocked(checkLock).mockReturnValue(unlocked())
    vi.mocked(recordFailure).mockReturnValue({
      newlyLocked: true,
      reason: 'target',
      retryAfterMs: 1_800_000,
    })

    expect(authenticateWebSocket('wrong', IP)).toBe(false)
    expect(notifyLockout).toHaveBeenCalledTimes(1)
    expect(notifyLockout).toHaveBeenCalledWith('target', IP)
  })
})
