/**
 * At-rest envelope unit tests. Covers both profiles:
 *   - standard: identity transform, legacy values pass through.
 *   - gm:       SM4-CBC + HMAC-SM3 roundtrip + integrity rejection.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../../src/main/foundation/credential-safety', () => ({
  isCredentialAtRestSafe: vi.fn(() => false),
}))

import { isCredentialAtRestSafe } from '../../../../src/main/foundation/credential-safety'
import {
  encodeForStorage,
  decodeFromStorage,
} from '../../../../src/main/foundation/crypto-envelope'

type MockFn = ReturnType<typeof vi.fn>

function setProfile(gm: boolean): void {
  ;(isCredentialAtRestSafe as unknown as MockFn).mockReturnValue(gm)
}

describe('envelope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('standard profile (credentialAtRestSafe = false)', () => {
    beforeEach(() => setProfile(false))

    it('encodeForStorage is identity', () => {
      expect(encodeForStorage('123456')).toBe('123456')
      expect(encodeForStorage('Aa1!Aa1!')).toBe('Aa1!Aa1!')
    })

    it('decodeFromStorage is identity for plain values', () => {
      expect(decodeFromStorage('123456')).toBe('123456')
    })

    it('still decodes a previously-encoded value (mixed-mode upgrade path)', () => {
      // Encode in gm, then read back in standard — should still recover.
      setProfile(true)
      const encoded = encodeForStorage('123456')
      setProfile(false)
      expect(decodeFromStorage(encoded)).toBe('123456')
    })
  })

  describe('gm profile (credentialAtRestSafe = true)', () => {
    beforeEach(() => setProfile(true))

    it('encodeForStorage emits the gmcred:v1: marker', () => {
      const encoded = encodeForStorage('123456')
      expect(encoded.startsWith('gmcred:v1:')).toBe(true)
    })

    it('roundtrips short and long plaintexts intact', () => {
      for (const sample of ['1', '123456', 'Aa1!Aa1!', 'x'.repeat(63)]) {
        const encoded = encodeForStorage(sample)
        expect(decodeFromStorage(encoded)).toBe(sample)
      }
    })

    it('produces a different ciphertext per call (fresh salt + iv)', () => {
      const a = encodeForStorage('123456')
      const b = encodeForStorage('123456')
      expect(a).not.toBe(b)
    })

    it('returns empty string when integrity check fails (tampered tag)', () => {
      const encoded = encodeForStorage('123456')
      // Flip a bit in the base64 body. Base64 alphabet swap to keep it valid.
      const body = encoded.slice('gmcred:v1:'.length)
      const tampered =
        'gmcred:v1:' + (body.startsWith('A') ? 'B' : 'A') + body.slice(1)
      expect(decodeFromStorage(tampered)).toBe('')
    })

    it('returns empty string for a structurally short payload', () => {
      expect(decodeFromStorage('gmcred:v1:AAAA')).toBe('')
    })

    it('decodes a legacy plain value (silent migration on next save)', () => {
      expect(decodeFromStorage('123456')).toBe('123456')
    })
  })

  describe('edge cases', () => {
    it('returns empty string for empty stored value in either profile', () => {
      setProfile(false)
      expect(decodeFromStorage('')).toBe('')
      setProfile(true)
      expect(decodeFromStorage('')).toBe('')
    })

    it('encodeForStorage returns empty string for empty plaintext', () => {
      setProfile(true)
      expect(encodeForStorage('')).toBe('')
    })
  })
})
