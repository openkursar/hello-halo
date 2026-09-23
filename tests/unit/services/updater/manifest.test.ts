/**
 * Unit tests for staged-update description verification.
 *
 * This is the only check standing between "the update server said so" and the
 * app unpacking an archive over itself, so the negative cases matter more than
 * the positive one.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { generateKeyPairSync, sign, type KeyObject } from 'crypto'
import { readStagedManifest } from '../../../../src/main/services/updater/staged/manifest'

const EXPECTED = {
  channel: 'experience' as const,
  productId: 'halo-example',
  platform: 'win',
  arch: 'x64',
  currentVersion: '2.1.16',
  helperVersion: 1,
}

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    channel: 'experience',
    productId: 'halo-example',
    version: '2.1.17',
    platform: 'win',
    arch: 'x64',
    package: {
      url: 'http://10.0.0.1:18080/download/app-2.1.17-win-x64.tar.zst',
      size: 275584704,
      sha512: Buffer.alloc(64, 7).toString('base64'),
      format: 'tar.zst',
      unpackedSize: 1021313024,
    },
    minHelperVersion: 1,
    ...overrides,
  }
}

let privateKey: KeyObject
let publicKeyB64: string
let otherPrivateKey: KeyObject

beforeAll(() => {
  const pair = generateKeyPairSync('ed25519')
  privateKey = pair.privateKey
  publicKeyB64 = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  otherPrivateKey = generateKeyPairSync('ed25519').privateKey
})

/** Produce the envelope exactly as the build-time signer will. */
function envelope(payload: unknown, key: KeyObject = privateKey): string {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8')
  return JSON.stringify({
    payload: bytes.toString('base64'),
    signature: sign(null, bytes, key).toString('base64'),
    keyId: 'test',
  })
}

describe('readStagedManifest', () => {
  it('accepts a correctly signed description', () => {
    const result = readStagedManifest(envelope(basePayload()), publicKeyB64, EXPECTED)
    expect(result.version).toBe('2.1.17')
    expect(result.package.format).toBe('tar.zst')
    expect(result.mandatory).toBe(false)
  })

  it('rejects a signature from the wrong key', () => {
    expect(() => readStagedManifest(envelope(basePayload(), otherPrivateKey), publicKeyB64, EXPECTED))
      .toThrow(/signature does not verify/)
  })

  it('rejects a payload altered after signing', () => {
    const signed = JSON.parse(envelope(basePayload())) as { payload: string; signature: string }
    const tampered = basePayload({ version: '9.9.9' })
    signed.payload = Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64')

    expect(() => readStagedManifest(JSON.stringify(signed), publicKeyB64, EXPECTED))
      .toThrow(/signature does not verify/)
  })

  it('refuses a description meant for the other channel', () => {
    expect(() => readStagedManifest(envelope(basePayload({ channel: 'stable' })), publicKeyB64, EXPECTED))
      .toThrow(/channel/)
  })

  it('refuses a description meant for another product', () => {
    expect(() => readStagedManifest(envelope(basePayload({ productId: 'halo-other' })), publicKeyB64, EXPECTED))
      .toThrow(/product/)
  })

  it('refuses a description for another platform or architecture', () => {
    expect(() => readStagedManifest(envelope(basePayload({ arch: 'arm64' })), publicKeyB64, EXPECTED))
      .toThrow(/win-arm64/)
  })

  it('refuses a validly signed but stale description', () => {
    // A signed older version is how a server would walk a client backwards.
    expect(() => readStagedManifest(envelope(basePayload({ version: '2.1.15' })), publicKeyB64, EXPECTED))
      .toThrow(/not newer/)
    expect(() => readStagedManifest(envelope(basePayload({ version: '2.1.16' })), publicKeyB64, EXPECTED))
      .toThrow(/not newer/)
  })

  it('refuses a package this build has no helper for', () => {
    expect(() => readStagedManifest(envelope(basePayload({ minHelperVersion: 2 })), publicKeyB64, EXPECTED))
      .toThrow(/helper protocol v2/)
  })

  it('refuses an unknown schema', () => {
    expect(() => readStagedManifest(envelope(basePayload({ schema: 2 })), publicKeyB64, EXPECTED))
      .toThrow(/schema/)
  })

  it('refuses a package url that is not http', () => {
    const bad = basePayload()
    ;(bad.package as Record<string, unknown>).url = 'file:///etc/passwd'
    expect(() => readStagedManifest(envelope(bad), publicKeyB64, EXPECTED)).toThrow(/scheme/)
  })

  it('refuses a malformed digest', () => {
    const bad = basePayload()
    ;(bad.package as Record<string, unknown>).sha512 = 'too-short'
    expect(() => readStagedManifest(envelope(bad), publicKeyB64, EXPECTED)).toThrow(/sha512/)
  })

  it('refuses an implausible package size', () => {
    for (const size of [0, -1, 1.5, 8 * 1024 * 1024 * 1024]) {
      const bad = basePayload()
      ;(bad.package as Record<string, unknown>).size = size
      expect(() => readStagedManifest(envelope(bad), publicKeyB64, EXPECTED), String(size)).toThrow(/size/)
    }
  })

  it('refuses an unpacked size that cannot be true', () => {
    for (const size of [0, -1, 2.5]) {
      const bad = basePayload()
      ;(bad.package as Record<string, unknown>).unpackedSize = size
      expect(() => readStagedManifest(envelope(bad), publicKeyB64, EXPECTED), String(size))
        .toThrow(/unpackedSize/)
    }
  })

  it('allows a package that is larger than the tree it unpacks to', () => {
    // Already-compressed content packs larger than it unpacks; rejecting that
    // would refuse legitimate releases.
    const incompressible = basePayload()
    ;(incompressible.package as Record<string, unknown>).size = 200272
    ;(incompressible.package as Record<string, unknown>).unpackedSize = 200022
    expect(() => readStagedManifest(envelope(incompressible), publicKeyB64, EXPECTED)).not.toThrow()
  })

  it('refuses an unsupported package format', () => {
    const bad = basePayload()
    ;(bad.package as Record<string, unknown>).format = 'zip'
    expect(() => readStagedManifest(envelope(bad), publicKeyB64, EXPECTED)).toThrow(/format/)
  })

  it('rejects envelopes that are not well formed', () => {
    expect(() => readStagedManifest('not json', publicKeyB64, EXPECTED)).toThrow(/not JSON/)
    expect(() => readStagedManifest('[]', publicKeyB64, EXPECTED)).toThrow(/not an object/)
    expect(() => readStagedManifest('{"payload":"aGk="}', publicKeyB64, EXPECTED)).toThrow(/signature/)
  })
})
