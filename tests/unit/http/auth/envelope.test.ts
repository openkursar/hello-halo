/**
 * At-rest envelope unit tests. Covers both profiles:
 *   - standard: identity transform, legacy values pass through.
 *   - gm:       SM4-CBC + HMAC-SM3 roundtrip + integrity rejection.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

vi.mock('../../../../src/main/foundation/credential-safety', () => ({
  isCredentialAtRestSafe: vi.fn(() => false),
}))

import { isCredentialAtRestSafe } from '../../../../src/main/foundation/credential-safety'
import {
  encodeForStorage,
  decodeFromStorage,
  needsKeyMigration,
  __resetKeyCacheForTests,
} from '../../../../src/main/foundation/crypto-envelope'

// Mirrors the electron mock in tests/unit/setup.ts: userData = <testDir>/.halo
function credKeyPath(): string {
  return join(globalThis.__HALO_TEST_DIR__, '.halo', 'cred.key')
}

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

  describe('persisted master key (credentialAtRestSafe = true)', () => {
    beforeEach(() => {
      setProfile(true)
      __resetKeyCacheForTests()
    })

    it('keeps the master key stable across a simulated restart', () => {
      const encoded = encodeForStorage('stable-secret')
      // Simulate a process restart: drop the in-memory cache so the next
      // call re-reads the persisted cred.key from disk.
      __resetKeyCacheForTests()
      expect(decodeFromStorage(encoded)).toBe('stable-secret')
    })

    it('cannot decrypt after the master key changes (why regeneration is forbidden)', () => {
      const encoded = encodeForStorage('secret')
      // Replace the persisted key — the exact failure the old machine-seed
      // scheme produced on every network change. The fix is to NEVER do this.
      writeFileSync(credKeyPath(), randomBytes(32).toString('hex'))
      __resetKeyCacheForTests()
      expect(decodeFromStorage(encoded)).toBe('')
    })

    it('falls back to the legacy seed for values written before the master key', () => {
      // Simulate an old install: a malformed key file makes the master key
      // unavailable, so encode uses the legacy machine seed.
      writeFileSync(credKeyPath(), 'not-a-valid-key')
      __resetKeyCacheForTests()
      const legacyEncoded = encodeForStorage('legacy-secret')
      expect(legacyEncoded.startsWith('gmcred:v1:')).toBe(true)

      // New build, first proper run: establish a real master key.
      rmSync(credKeyPath())
      __resetKeyCacheForTests()

      // Decode still recovers via the legacy fallback...
      expect(decodeFromStorage(legacyEncoded)).toBe('legacy-secret')
      // ...and the value is flagged so the startup migration re-encrypts it.
      expect(needsKeyMigration(legacyEncoded)).toBe(true)
    })
  })

  describe('needsKeyMigration (credentialAtRestSafe = true)', () => {
    beforeEach(() => {
      setProfile(true)
      __resetKeyCacheForTests()
    })

    it('is false for a value already stored under the master key', () => {
      expect(needsKeyMigration(encodeForStorage('secret'))).toBe(false)
    })

    it('is true for plaintext (needs encrypting at rest)', () => {
      expect(needsKeyMigration('plain-secret')).toBe(true)
    })

    it('is false for an empty value', () => {
      expect(needsKeyMigration('')).toBe(false)
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
