/**
 * Shared password-policy structural tests. The main-side message
 * mapping is covered separately in tests/unit/http/auth/password-policy.test.ts.
 */

import { describe, it, expect } from 'vitest'

import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  checkPasswordPolicy,
} from '../../../../src/shared/auth/password-policy'

describe('shared password-policy', () => {
  it('exposes 8/64 as the policy bounds', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8)
    expect(PASSWORD_MAX_LENGTH).toBe(64)
  })

  it('returns ok for an 8-char password covering upper/lower/digit', () => {
    expect(checkPasswordPolicy('Abcdef12')).toEqual({ ok: true })
  })

  it('accepts a special character even though it is not required', () => {
    expect(checkPasswordPolicy('Aa1!Aa1!')).toEqual({ ok: true })
  })

  it('returns TOO_SHORT alone for short input (class checks deferred until length passes)', () => {
    expect(checkPasswordPolicy('Ab1')).toEqual({ ok: false, codes: ['TOO_SHORT'] })
  })

  it('returns TOO_LONG when input exceeds the cap', () => {
    const long = 'Aa1' + 'x'.repeat(PASSWORD_MAX_LENGTH)
    const result = checkPasswordPolicy(long)
    expect(result).toEqual({ ok: false, codes: ['TOO_LONG'] })
  })

  it('aggregates every missing character class', () => {
    const result = checkPasswordPolicy('aaaaaaaa')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.codes).toEqual(['MISSING_UPPER', 'MISSING_DIGIT'])
  })

  it('reports each class independently', () => {
    expect(checkPasswordPolicy('abcdef12')).toEqual({ ok: false, codes: ['MISSING_UPPER'] })
    expect(checkPasswordPolicy('ABCDEF12')).toEqual({ ok: false, codes: ['MISSING_LOWER'] })
    expect(checkPasswordPolicy('Abcdefgh')).toEqual({ ok: false, codes: ['MISSING_DIGIT'] })
  })

  it('returns NOT_A_STRING for non-string inputs', () => {
    expect(checkPasswordPolicy(undefined)).toEqual({ ok: false, codes: ['NOT_A_STRING'] })
    expect(checkPasswordPolicy(null)).toEqual({ ok: false, codes: ['NOT_A_STRING'] })
    expect(checkPasswordPolicy(12345678)).toEqual({ ok: false, codes: ['NOT_A_STRING'] })
  })
})
