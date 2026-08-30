/**
 * Shared password-policy structural tests. The main-side message
 * mapping is covered separately in tests/unit/http/auth/password-policy.test.ts.
 */

import { describe, it, expect } from 'vitest'

import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  checkPasswordPolicy,
  ACCESS_CODE_MIN_SUBMIT_LENGTH,
  normalizeAccessCodeInput,
  isAccessCodeSubmittable,
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

describe('access-code submit gating (shared across all entry surfaces)', () => {
  // The same token samples every surface must agree on: an auto-generated
  // 12-char PIN (guaranteed to include a printable-ASCII special), a
  // minimal valid custom password, and inputs below the submit floor.
  const AUTO_PIN_WITH_SPECIAL = 'Xk7!pQ2#mR4*'
  const CUSTOM_8 = 'Abcdef12'
  const SHORT_7 = 'Abcde12'

  it('sets the submit floor to the shared password minimum', () => {
    expect(ACCESS_CODE_MIN_SUBMIT_LENGTH).toBe(PASSWORD_MIN_LENGTH)
    expect(ACCESS_CODE_MIN_SUBMIT_LENGTH).toBe(8)
  })

  it.each([
    ['auto PIN with specials', AUTO_PIN_WITH_SPECIAL],
    ['8-char custom password', CUSTOM_8],
  ])('judges %s submittable', (_label, token) => {
    expect(isAccessCodeSubmittable(token)).toBe(true)
  })

  it.each([
    ['7-char input', SHORT_7],
    ['empty input', ''],
  ])('judges %s not submittable', (_label, token) => {
    expect(isAccessCodeSubmittable(token)).toBe(false)
  })

  it('normalization never strips characters — specials survive for auto PINs', () => {
    expect(normalizeAccessCodeInput(AUTO_PIN_WITH_SPECIAL)).toBe(AUTO_PIN_WITH_SPECIAL)
  })

  it('normalization strips whitespace-only artifacts (paste padding)', () => {
    expect(normalizeAccessCodeInput('  Abcdef12 \n')).toBe('Abcdef12')
    expect(normalizeAccessCodeInput('A b c d e f 1 2')).toBe('Abcdef12')
  })

  it('normalization caps input at PASSWORD_MAX_LENGTH', () => {
    const over = 'Aa1' + 'x'.repeat(PASSWORD_MAX_LENGTH)
    expect(normalizeAccessCodeInput(over)).toHaveLength(PASSWORD_MAX_LENGTH)
  })
})
