/**
 * Password policy unit tests — complexity rules enforced at the
 * setCustomAccessToken boundary.
 */

import { describe, it, expect } from 'vitest'

import { validatePassword } from '../../../../src/main/http/auth/password-policy'

describe('password-policy', () => {
  describe('length', () => {
    it('rejects passwords shorter than 8 characters', () => {
      const result = validatePassword('Ab1!')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('at least 8')
    })

    it('accepts exactly 8 characters covering upper/lower/digit', () => {
      expect(validatePassword('Abcdef12').ok).toBe(true)
    })

    it('rejects passwords longer than 64 characters', () => {
      const longPassword = 'Aa1!' + 'x'.repeat(62)
      expect(validatePassword(longPassword).ok).toBe(false)
    })
  })

  describe('character classes', () => {
    it('rejects when uppercase letter is missing', () => {
      const result = validatePassword('abcdef1!')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('uppercase')
    })

    it('rejects when lowercase letter is missing', () => {
      const result = validatePassword('ABCDEF1!')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('lowercase')
    })

    it('rejects when digit is missing', () => {
      const result = validatePassword('Abcdefgh')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('digit')
    })

    it('lists all missing classes in the error', () => {
      const result = validatePassword('aaaaaaaa')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('uppercase')
      expect(result.error).toContain('digit')
    })

    it('allows special characters without requiring them', () => {
      // Symbols stay valid; they are simply no longer mandatory.
      expect(validatePassword('Abcdef12').ok).toBe(true) // no symbol
      expect(validatePassword('Abcdef1#').ok).toBe(true) // #
      expect(validatePassword('Abcdef1@').ok).toBe(true) // @
      expect(validatePassword('Abcdef1{').ok).toBe(true) // {
    })
  })

  describe('type guards', () => {
    it('rejects non-string inputs without throwing', () => {
      expect(validatePassword(undefined as unknown as string).ok).toBe(false)
      expect(validatePassword(null as unknown as string).ok).toBe(false)
      expect(validatePassword(12345678 as unknown as string).ok).toBe(false)
    })
  })
})
