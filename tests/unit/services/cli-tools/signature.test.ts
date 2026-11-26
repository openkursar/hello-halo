/**
 * Delivery bundle signatures. The vector below was signed with a fixed test
 * seed and is accepted by the Registry's own `signing.VerifyBundle`; other
 * cases sign with throwaway keys.
 */
import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'crypto'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { CliToolError } from '../../../../src/main/services/cli-tools'
import {
  assertBundleSignature,
  loadTrustStore,
  parseBundleSignature,
  parseTrustStore,
  signedBundleBytes,
  type BundleSignature,
} from '../../../../src/main/services/cli-tools/signature'
import { makeTempDir, removeTree } from './helpers'

const VECTOR_TRUST = JSON.stringify({
  schema: 'halo.cli.trust/1',
  keys: [{ keyId: 'halo-bundle-vector', alg: 'ed25519', publicKey: '6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=' }],
})
const VECTOR_JSON = Buffer.from(JSON.stringify({
  schema: 'halo.cli.bundle/1', id: 'com.example.tool', version: '1.0.0', revision: 2,
  cli: { archiveSha256: '1'.repeat(64), integrity: `sha256-${Buffer.alloc(32, 2).toString('base64')}`, size: 1024 },
  skill: { sha256: '02cb6019d286cf555018c3cc0cfcddaf778ada0c506b796f7a158d296f39ffd1', files: 2, source: 'text', sourceRef: 'tool r2' },
}))
const VECTOR_SIG: BundleSignature = {
  alg: 'ed25519',
  keyId: 'halo-bundle-vector',
  value: '4X6K/XPuQ06oT6pBWW6JAZV3RIIg4UfHu+r9TYNyZhv4ZEDuLjT67nB98u0VH8CBFI7Dz89I8jmvVC3uSDQ/BQ==',
}

function keyPair(keyId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64')
  return {
    entry: { keyId, alg: 'ed25519', publicKey: raw },
    sign: (bundleJson: Uint8Array): BundleSignature => ({
      alg: 'ed25519',
      keyId,
      value: sign(null, signedBundleBytes(bundleJson), privateKey).toString('base64'),
    }),
  }
}

function codeOf(fn: () => void): string | undefined {
  try {
    fn()
  } catch (err) {
    return err instanceof CliToolError ? err.code : `NOT_TYPED: ${String(err)}`
  }
  return undefined
}

describe('cli-tools signature: bundle vector shared with the Registry', () => {
  it('signs the domain line followed by the raw bundle.json bytes', () => {
    expect(signedBundleBytes(Buffer.from('{}')).toString('utf-8')).toBe('halo.cli.bundle/1\n{}')
  })

  it('accepts the vector and rejects any changed byte', () => {
    const trust = parseTrustStore(VECTOR_TRUST)
    expect(trust.mode).toBe('on')
    expect(codeOf(() => assertBundleSignature(trust, VECTOR_JSON, VECTOR_SIG, 'vector'))).toBeUndefined()
    const changed = Buffer.from(VECTOR_JSON.toString('utf-8').replace('"revision":2', '"revision":3'))
    expect(codeOf(() => assertBundleSignature(trust, changed, VECTOR_SIG, 'vector'))).toBe('SIGNATURE_INVALID')
  })
})

describe('cli-tools signature: policy', () => {
  const json = Buffer.from('{"schema":"halo.cli.bundle/1"}')

  it('rejects a signature from an untrusted key and an unknown key id', () => {
    const trusted = keyPair('trusted')
    const other = keyPair('other')
    const trust = parseTrustStore(JSON.stringify({ schema: 'halo.cli.trust/1', keys: [trusted.entry] }))
    expect(codeOf(() => assertBundleSignature(trust, json, trusted.sign(json), 'tool'))).toBeUndefined()
    expect(codeOf(() => assertBundleSignature(trust, json, { ...other.sign(json), keyId: 'trusted' }, 'tool'))).toBe('SIGNATURE_INVALID')
    expect(codeOf(() => assertBundleSignature(trust, json, other.sign(json), 'tool'))).toBe('SIGNATURE_INVALID')
  })

  it('requires a signature when keys are configured', () => {
    const trust = parseTrustStore(VECTOR_TRUST)
    expect(codeOf(() => assertBundleSignature(trust, json, null, 'tool'))).toBe('SIGNATURE_MISSING')
  })

  it('skips verification without a trust file, and with an empty key list', async () => {
    const dir = makeTempDir()
    try {
      expect((await loadTrustStore(null)).mode).toBe('off')
      expect((await loadTrustStore(join(dir, 'missing.json'))).mode).toBe('off')
      writeFileSync(join(dir, 'empty.json'), JSON.stringify({ schema: 'halo.cli.trust/1', keys: [] }))
      const empty = await loadTrustStore(join(dir, 'empty.json'))
      expect(empty.mode).toBe('off')
      expect(codeOf(() => assertBundleSignature(empty, json, null, 'tool'))).toBeUndefined()
    } finally {
      removeTree(dir)
    }
  })

  it('fails closed on an unusable trust file', () => {
    for (const text of ['not json', '{"schema":"other","keys":[]}', JSON.stringify({ schema: 'halo.cli.trust/1', keys: [{ keyId: 'k', alg: 'ed25519', publicKey: 'AAAA' }] })]) {
      const trust = parseTrustStore(text)
      expect(trust.mode).toBe('broken')
      expect(codeOf(() => assertBundleSignature(trust, VECTOR_JSON, VECTOR_SIG, 'tool'))).toBe('SIGNATURE_INVALID')
    }
  })

  it('parses only the agreed bundle.sig shape', () => {
    expect(parseBundleSignature(VECTOR_SIG)).toEqual(VECTOR_SIG)
    expect(parseBundleSignature({ ...VECTOR_SIG, alg: 'rsa' })).toBeNull()
    expect(parseBundleSignature({ ...VECTOR_SIG, extra: true })).toBeNull()
    expect(parseBundleSignature({ keyId: 'k', signature: VECTOR_SIG.value })).toBeNull()
    expect(parseBundleSignature(null)).toBeNull()
  })
})
