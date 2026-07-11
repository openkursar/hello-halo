/**
 * Unit tests for the portable identity seam (http/identity).
 *
 * Crypto is real (Ed25519); filesystem writes are isolated by the global test
 * setup, which points os.homedir() (and therefore getHaloDir()) at a fresh
 * per-test temp dir that is cleaned up afterwards.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { generateKeyPairSync, sign } from 'crypto'
import path from 'path'

// Global setup mocks electron but omits safeStorage, which local identity needs
// to encrypt its private key at rest. Own the mock here; isEncryptionAvailable
// = false exercises the plaintext fallback path (no OS keychain in the runner).
function testHome(): string {
  return globalThis.__HALO_TEST_DIR__ || '/tmp/halo-test-fallback'
}

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => {
      const dir = testHome()
      if (name === 'userData') return path.join(dir, '.halo')
      return dir
    },
    getAppPath: () => path.join(testHome(), 'app'),
    getName: () => 'Halo',
    getVersion: () => '1.0.0-test',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

import { DeviceKeyResolver } from '../../../../src/main/http/identity/device-key-resolver'
import {
  deriveIdentityId,
  ensureLocalIdentity,
  getLocalIdentity,
  getLocalPublicKeyPem,
  signWithLocalKey,
  _resetLocalIdentityCache,
} from '../../../../src/main/http/identity/device-key'
import { initIdentity, resolveIdentity } from '../../../../src/main/http/identity/index'
import type { AuthProof } from '../../../../src/main/http/identity/types'

// In-memory keypair + a valid device-key proof for it.
function makeKeypairProof(challengeText = 'challenge-bytes') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  const identityId = deriveIdentityId(publicKeyPem)
  const challenge = Buffer.from(challengeText)
  const signature = sign(null, challenge, privateKey)

  const proof: AuthProof = {
    method: 'device-key',
    identityId,
    publicKey: publicKeyPem,
    challenge: challenge.toString('base64'),
    signature: signature.toString('base64'),
  }
  return { publicKeyPem, identityId, proof }
}

beforeEach(() => {
  _resetLocalIdentityCache()
})

describe('deriveIdentityId', () => {
  it('is deterministic for a given public key', () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string
    expect(deriveIdentityId(pem)).toBe(deriveIdentityId(pem))
  })

  it('produces the id_ prefix and is stable across PEM/DER inputs', () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string
    const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
    const id = deriveIdentityId(pem)
    expect(id.startsWith('id_')).toBe(true)
    expect(deriveIdentityId(der)).toBe(id)
  })

  it('differs for different keys', () => {
    const a = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string
    const b = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string
    expect(deriveIdentityId(a)).not.toBe(deriveIdentityId(b))
  })
})

describe('DeviceKeyResolver', () => {
  const resolver = new DeviceKeyResolver()

  it('resolves a valid proof to the claimed identity', () => {
    const { identityId, proof } = makeKeypairProof()
    const identity = resolver.resolve(proof)
    expect(identity).not.toBeNull()
    expect(identity?.id).toBe(identityId)
    // displayName falls back to the id when the proof omits it.
    expect(identity?.displayName).toBe(identityId)
  })

  it('carries displayName when the proof supplies one', () => {
    const { proof } = makeKeypairProof()
    const identity = resolver.resolve({ ...proof, displayName: 'Alice' })
    expect(identity?.displayName).toBe('Alice')
  })

  it('returns null when the signature is tampered', () => {
    const { proof } = makeKeypairProof()
    const tampered = Buffer.from(proof.signature as string, 'base64')
    tampered[0] ^= 0xff
    expect(resolver.resolve({ ...proof, signature: tampered.toString('base64') })).toBeNull()
  })

  it('returns null when the challenge does not match the signature', () => {
    const { proof } = makeKeypairProof()
    const otherChallenge = Buffer.from('different-challenge').toString('base64')
    expect(resolver.resolve({ ...proof, challenge: otherChallenge })).toBeNull()
  })

  it('returns null when identityId does not match the public key', () => {
    const { proof } = makeKeypairProof()
    expect(resolver.resolve({ ...proof, identityId: 'id_not_the_real_one' })).toBeNull()
  })

  it('returns null when a different key signed the challenge', () => {
    const { proof } = makeKeypairProof()
    // Swap in a foreign public key: derivation no longer matches identityId.
    const foreign = generateKeyPairSync('ed25519').publicKey.export({
      type: 'spki',
      format: 'pem',
    }) as string
    expect(resolver.resolve({ ...proof, publicKey: foreign })).toBeNull()
  })

  it('returns null for a wrong method', () => {
    const { proof } = makeKeypairProof()
    expect(resolver.resolve({ ...proof, method: 'sso' })).toBeNull()
  })
})

describe('resolveIdentity dispatch', () => {
  beforeEach(() => {
    initIdentity()
  })

  it('dispatches a valid device-key proof', () => {
    const { identityId, proof } = makeKeypairProof()
    expect(resolveIdentity(proof)?.id).toBe(identityId)
  })

  it('returns null for an unknown method without throwing', () => {
    const proof: AuthProof = { method: 'does-not-exist' }
    expect(resolveIdentity(proof)).toBeNull()
  })
})

describe('local node identity', () => {
  it('initializes and exposes a stable, portable identity', () => {
    ensureLocalIdentity()
    const identity = getLocalIdentity()
    expect(identity.id.startsWith('id_')).toBe(true)
    expect(identity.displayName).toBeTruthy()
    expect(deriveIdentityId(getLocalPublicKeyPem())).toBe(identity.id)
  })

  it('keeps the same id across a reload (init twice)', () => {
    ensureLocalIdentity()
    const first = getLocalIdentity().id

    // Drop the in-memory cache so the second init reloads from disk.
    _resetLocalIdentityCache()
    ensureLocalIdentity()
    const second = getLocalIdentity().id

    expect(second).toBe(first)
  })

  it('signs with the local key and the signature verifies via its own proof', () => {
    ensureLocalIdentity()
    const challenge = Buffer.from('local-challenge')
    const signature = signWithLocalKey(challenge)

    const proof: AuthProof = {
      method: 'device-key',
      identityId: getLocalIdentity().id,
      publicKey: getLocalPublicKeyPem(),
      challenge: challenge.toString('base64'),
      signature: signature.toString('base64'),
    }
    expect(new DeviceKeyResolver().resolve(proof)?.id).toBe(getLocalIdentity().id)
  })
})
