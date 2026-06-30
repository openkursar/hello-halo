/**
 * Static product key unit tests (credential-key.ts).
 *
 * Covers the enterprise-configured branch (product.json
 * security.credentialStaticKey) — which is the key path real enterprise builds
 * ship — plus the deterministic HKDF fallback and malformed-key handling.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock product-config so we can drive the configured-key branch and the data
// folder name without a real product.json on disk.
const productConfig: { security?: { credentialStaticKey?: unknown } } = {}
let dataFolderName = 'halo'

vi.mock('../../../src/main/foundation/product-config', () => ({
  loadProductConfig: () => productConfig,
  getDataFolderName: () => dataFolderName,
}))

// At-rest gate on, so the envelope roundtrip below actually encrypts.
vi.mock('../../../src/main/foundation/credential-safety', () => ({
  isCredentialAtRestSafe: vi.fn(() => true),
}))

import {
  getStaticProductKey,
  __resetStaticKeyCacheForTests,
} from '../../../src/main/foundation/credential-key'
import {
  encodeForStorage,
  decodeFromStorage,
  __resetKeyCacheForTests,
} from '../../../src/main/foundation/crypto-envelope'

describe('credential-key', () => {
  beforeEach(() => {
    delete productConfig.security
    dataFolderName = 'halo'
    __resetStaticKeyCacheForTests()
    __resetKeyCacheForTests()
  })

  describe('configured product key (enterprise path)', () => {
    it('uses security.credentialStaticKey verbatim when it is valid 64-hex', () => {
      const hex = 'ab'.repeat(32) // 64 hex chars = 32 bytes
      productConfig.security = { credentialStaticKey: hex }
      expect(getStaticProductKey().toString('hex')).toBe(hex)
    })

    it('encrypts and decrypts under the configured key, surviving a restart', () => {
      productConfig.security = { credentialStaticKey: 'cd'.repeat(32) }
      const encoded = encodeForStorage('enterprise-secret')
      expect(encoded.startsWith('gmcred:v2:')).toBe(true)

      // Simulate a restart: drop caches, re-read the same configured key.
      __resetStaticKeyCacheForTests()
      __resetKeyCacheForTests()
      expect(decodeFromStorage(encoded)).toBe('enterprise-secret')
    })

    it('falls back to the derived key when the configured key is malformed', () => {
      productConfig.security = { credentialStaticKey: 'not-valid-hex' }
      const key = getStaticProductKey()
      expect(key).toHaveLength(32)
      expect(key.toString('hex')).not.toBe('not-valid-hex')
    })

    it('falls back when the configured key has the wrong length', () => {
      productConfig.security = { credentialStaticKey: 'abcd' } // valid hex, too short
      expect(getStaticProductKey()).toHaveLength(32)
    })
  })

  describe('derived fallback (no configured key)', () => {
    it('is deterministic across restarts for the same data folder', () => {
      const a = getStaticProductKey().toString('hex')
      __resetStaticKeyCacheForTests()
      const b = getStaticProductKey().toString('hex')
      expect(a).toBe(b)
      expect(a).toHaveLength(64)
    })

    it('differs between data folder names (per-variant isolation)', () => {
      dataFolderName = 'halo'
      const a = getStaticProductKey().toString('hex')
      __resetStaticKeyCacheForTests()
      dataFolderName = 'halo-enterprise'
      const b = getStaticProductKey().toString('hex')
      expect(a).not.toBe(b)
    })
  })

  // Cross-version stability guard. Enterprise builds ship
  // credentialAtRestSafe=true with an EMPTY credentialStaticKey, so every
  // install derives the same fallback key from the in-source pepper and the
  // data folder name. These pinned values fix that derivation: any change to
  // FALLBACK_PEPPER, the HKDF info labels, or the SM4-CBC/HMAC-SM3 envelope
  // parameters would shift the key and silently orphan every gmcred:v2:
  // credential written by a prior release. Such a change must fail here.
  describe('golden vector (empty enterprise key, dataFolderName="halo")', () => {
    const GOLDEN_KEY_HEX = '529b8da54fc86f58be87c9a4da8c420f633993fffce043980c738df6cbe88bce'
    // A gmcred:v2: ciphertext of 'golden-vector-secret' captured under the key
    // above. Random salt/iv make every encrypt unique, so this is a fixed
    // decrypt vector — not an encrypt-output comparison.
    const GOLDEN_V2_CIPHERTEXT =
      'gmcred:v2:NNi3iuNHmB955IomVgnVYcSxOSO6MDm6sFn8aiv/7ikgywaoIYl7GL5HeXRLu/Fq9ypFp6VbOP/NrAWeVrhwMZf8geE8/7vubolkmnXQw2MOTMNcUUNU8+70Zu+f7vOR'

    it('derives the pinned fallback key for an empty static key', () => {
      productConfig.security = { credentialStaticKey: '' }
      expect(getStaticProductKey().toString('hex')).toBe(GOLDEN_KEY_HEX)
    })

    it('decodes a v2 credential written by a prior version under the same key', () => {
      productConfig.security = { credentialStaticKey: '' }
      expect(decodeFromStorage(GOLDEN_V2_CIPHERTEXT)).toBe('golden-vector-secret')
    })
  })
})
