/**
 * Catalog signatures (A07). The real sample below is the public test key and
 * a catalog entry signed by the backend's tooling (key id halo-test-2026-11);
 * no private key is involved here. Other cases sign with throwaway keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CliToolError } from '../../../../src/main/services/cli-tools'
import {
  assertCatalogSignature,
  guideSignatureAccepted,
  loadTrustStore,
  parseCatalogSignature,
  parseTrustStore,
  signedBytes,
  signedGuideBytes,
  signedSkillBytes,
  skillSignatureAccepted,
  type CatalogSignature,
  type SignedFields,
} from '../../../../src/main/services/cli-tools/signature'
import { buildManifest, makeTempDir, removeTree, writePackage } from './helpers'

const REAL_TRUST = JSON.stringify({
  schema: 'halo.cli.trust/1',
  keys: [{ keyId: 'halo-test-2026-11', alg: 'ed25519', publicKey: 'xnH7U6Gf80/6CrGqe/utIZqRyE3bzrM6kCHFj3m7UaQ=' }],
})
const REAL_FIELDS: SignedFields = {
  id: 'npm.js-yaml',
  version: '5.5.0',
  archiveSha256: 'db08b7b055c3c3267edb14c19b2f2087809dbfd3383778e3bbfa1cd83cedf71d',
  integrity: 'sha256-yAZ77/dPl2BWqcrwTi/3WOj1INH4+xcbe9iybglM6Cc=',
}
const REAL_SIG: CatalogSignature = {
  alg: 'ed25519',
  keyId: 'halo-test-2026-11',
  value: 'y+QqnoHEOg3Ev989yA0OmLgT4c6+2dxojvj5MaKaiAnTdBYtxVE4lnhAPAm/JH7Z/kPiMUMLfnFXVvmHbHncBQ==',
}

function keyPair(keyId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64')
  return {
    entry: { keyId, alg: 'ed25519', publicKey: raw },
    sign: (fields: SignedFields): CatalogSignature => ({
      alg: 'ed25519',
      keyId,
      value: sign(null, signedBytes(fields), privateKey).toString('base64'),
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

describe('cli-tools signature: real sample from the backend', () => {
  it('verifies the signed catalog entry with the published test key', () => {
    const trust = parseTrustStore(REAL_TRUST)
    expect(trust.mode).toBe('on')
    expect(codeOf(() => assertCatalogSignature(trust, REAL_FIELDS, REAL_SIG))).toBeUndefined()
    // Uppercase hex is the same digest.
    expect(codeOf(() => assertCatalogSignature(trust, { ...REAL_FIELDS, archiveSha256: REAL_FIELDS.archiveSha256.toUpperCase() }, REAL_SIG))).toBeUndefined()
  })

  it.each([
    ['id', { id: 'npm.js-yaml2' }],
    ['version', { version: '4.1.0' }],
    ['archiveSha256', { archiveSha256: 'f9078f7a45efa7ebaaba1ae71a980c34ce10e6dff445d9c24a1bb53c0abe5aa7' }],
    ['integrity', { integrity: 'sha256-To7kNeU/feHqZFqmuUNmfhy2hKAy8xy/SHGuKtA0TCU=' }],
  ])('rejects the sample when %s is tampered', (_field, change) => {
    const trust = parseTrustStore(REAL_TRUST)
    expect(codeOf(() => assertCatalogSignature(trust, { ...REAL_FIELDS, ...change }, REAL_SIG))).toBe('SIGNATURE_INVALID')
  })

  it('builds the signed bytes exactly as agreed', () => {
    expect(signedBytes({ id: 'a', version: '1.0.0', archiveSha256: 'AB', integrity: 'sha256-x' }).toString('utf-8'))
      .toBe('halo.cli.sig/1\na\n1.0.0\nab\nsha256-x\n')
  })
})

describe('cli-tools signature: policy', () => {
  const fields: SignedFields = { id: 'com.example.tool', version: '1.0.0', archiveSha256: 'a'.repeat(64), integrity: 'sha256-abc' }

  it('rejects a signature from an untrusted key and an unknown key id', () => {
    const trusted = keyPair('k1')
    const rogue = keyPair('k1')
    const trust = parseTrustStore(JSON.stringify({ schema: 'halo.cli.trust/1', keys: [trusted.entry] }))
    expect(codeOf(() => assertCatalogSignature(trust, fields, trusted.sign(fields)))).toBeUndefined()
    expect(codeOf(() => assertCatalogSignature(trust, fields, rogue.sign(fields)))).toBe('SIGNATURE_INVALID')
    expect(codeOf(() => assertCatalogSignature(trust, fields, keyPair('k2').sign(fields)))).toBe('SIGNATURE_INVALID')
  })

  it('requires a signature when keys are configured', () => {
    const trust = parseTrustStore(REAL_TRUST)
    expect(codeOf(() => assertCatalogSignature(trust, fields, null))).toBe('SIGNATURE_MISSING')
    expect(codeOf(() => assertCatalogSignature(trust, fields, undefined))).toBe('SIGNATURE_MISSING')
  })

  it('skips verification without a trust file, and with an empty key list', async () => {
    const off = await loadTrustStore(null)
    expect(off.mode).toBe('off')
    expect(codeOf(() => assertCatalogSignature(off, fields, null))).toBeUndefined()
    const dir = makeTempDir()
    try {
      expect((await loadTrustStore(join(dir, 'absent.json'))).mode).toBe('off')
      writeFileSync(join(dir, 'empty.json'), JSON.stringify({ schema: 'halo.cli.trust/1', keys: [] }))
      expect((await loadTrustStore(join(dir, 'empty.json'))).mode).toBe('off')
    } finally {
      removeTree(dir)
    }
  })

  it('fails closed on an unusable trust file', () => {
    for (const text of ['{not json', JSON.stringify({ schema: 'other', keys: [] }), JSON.stringify({ schema: 'halo.cli.trust/1', keys: [{ keyId: 'k', alg: 'ed25519', publicKey: 'short' }] })]) {
      const trust = parseTrustStore(text)
      expect(trust.mode).toBe('broken')
      expect(codeOf(() => assertCatalogSignature(trust, REAL_FIELDS, REAL_SIG))).toBe('SIGNATURE_INVALID')
    }
  })

  it('parses only the agreed signature shape', () => {
    expect(parseCatalogSignature(null)).toBeNull()
    expect(parseCatalogSignature({ alg: 'rsa', keyId: 'k', value: 'x' })).toBeNull()
    expect(parseCatalogSignature(REAL_SIG)).toEqual(REAL_SIG)
  })
})

describe('cli-tools signature: catalog install through the host', () => {
  let dir: string
  let presetDir: string
  let pkgs: string

  beforeEach(() => {
    dir = makeTempDir()
    presetDir = join(dir, 'preset')
    pkgs = join(dir, 'pkgs')
    mkdirSync(presetDir)
    mkdirSync(pkgs)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    removeTree(dir)
  })

  async function startHost() {
    vi.resetModules()
    const host = await import('../../../../src/main/services/cli-tools/host')
    host.initCliTools({ root: join(dir, 'cli'), runtimePath: process.execPath, presetDir })
    return host
  }

  function expectation(file: string) {
    return {
      id: 'com.example.tool',
      version: '1.0.0',
      archiveSha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      integrity: buildManifest({ version: '1.0.0' }).integrity as string,
    }
  }

  it('installs only a validly signed package when the build ships keys', async () => {
    const key = keyPair('k1')
    writeFileSync(join(presetDir, 'trusted-keys.json'), JSON.stringify({ schema: 'halo.cli.trust/1', keys: [key.entry] }))
    const host = await startHost()
    expect(await host.catalogSignatureMode()).toBe('on')
    const file = writePackage(pkgs)
    const exp = expectation(file)

    await expect(host.installCatalogPackage(file, { ...exp, signature: null })).rejects.toMatchObject({ code: 'SIGNATURE_MISSING' })
    await expect(host.installCatalogPackage(file, { ...exp, signature: keyPair('k1').sign(exp) })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' })
    await expect(host.installCatalogPackage(file, { ...exp, signature: key.sign({ ...exp, version: '9.9.9' }) })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' })
    expect((await host.readCliToolState())!.tools['com.example.tool']).toBeUndefined()

    expect(await host.installCatalogPackage(file, { ...exp, signature: key.sign(exp) })).toMatchObject({ installed: true })
  })

  it('installs unsigned packages when no trust file is shipped', async () => {
    const host = await startHost()
    expect(await host.catalogSignatureMode()).toBe('off')
    const file = writePackage(pkgs)
    expect(await host.installCatalogPackage(file, { ...expectation(file), signature: null })).toMatchObject({ installed: true })
  })
})

describe('guide override signatures', () => {
  // Shared with the registry's Go test (TestGuideMessageAndVector): RFC 8032 test 1 key.
  const VECTOR_TRUST = parseTrustStore(JSON.stringify({
    schema: 'halo.cli.trust/1',
    keys: [{ keyId: 'rfc8032', alg: 'ed25519', publicKey: '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=' }],
  }))
  const VECTOR_FIELDS = {
    id: 'io.prettier.cli',
    version: '3.10.1',
    revision: 2,
    sha256: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
  }
  const VECTOR_SIG: CatalogSignature = {
    alg: 'ed25519',
    keyId: 'rfc8032',
    value: 'pHlB6VLR0E/M+3c7uOuYaahVp3nLIPWV5RgNal4mYd/+iF5LKA6hyAtpBY7u1hmMI3/sKpkqVfo9/QyR8MDsDw==',
  }

  it('signs the documented bytes', () => {
    expect(signedGuideBytes({ ...VECTOR_FIELDS, sha256: VECTOR_FIELDS.sha256.toUpperCase() }).toString('utf-8')).toBe(
      `halo.cli.guide/1\nio.prettier.cli\n3.10.1\n2\n${VECTOR_FIELDS.sha256}\n`,
    )
  })

  it('accepts the cross-language vector and rejects any changed field', () => {
    expect(VECTOR_TRUST.mode).toBe('on')
    expect(guideSignatureAccepted(VECTOR_TRUST, VECTOR_FIELDS, VECTOR_SIG)).toBe(true)
    expect(guideSignatureAccepted(VECTOR_TRUST, { ...VECTOR_FIELDS, revision: 3 }, VECTOR_SIG)).toBe(false)
    expect(guideSignatureAccepted(VECTOR_TRUST, { ...VECTOR_FIELDS, version: '3.10.2' }, VECTOR_SIG)).toBe(false)
    expect(guideSignatureAccepted(VECTOR_TRUST, { ...VECTOR_FIELDS, sha256: '0'.repeat(64) }, VECTOR_SIG)).toBe(false)
    expect(guideSignatureAccepted(VECTOR_TRUST, VECTOR_FIELDS, { ...VECTOR_SIG, keyId: 'other' })).toBe(false)
    expect(guideSignatureAccepted(VECTOR_TRUST, VECTOR_FIELDS, { ...VECTOR_SIG, value: 'AAAA' })).toBe(false)
    expect(guideSignatureAccepted(VECTOR_TRUST, VECTOR_FIELDS, null)).toBe(false)
  })

  it('never accepts a package signature as a guide signature', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const trust = parseTrustStore(JSON.stringify({
      schema: 'halo.cli.trust/1',
      keys: [{ keyId: 'k1', alg: 'ed25519', publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64') }],
    }))
    const fields = { id: 'a.b', version: '1.0.0', revision: 1, sha256: 'a'.repeat(64) }
    const packageSig = sign(null, signedBytes({ id: 'a.b', version: '1.0.0', archiveSha256: 'a'.repeat(64), integrity: '1' }), privateKey)
    expect(guideSignatureAccepted(trust, fields, { alg: 'ed25519', keyId: 'k1', value: packageSig.toString('base64') })).toBe(false)
    const guideSig = sign(null, signedGuideBytes(fields), privateKey)
    expect(guideSignatureAccepted(trust, fields, { alg: 'ed25519', keyId: 'k1', value: guideSig.toString('base64') })).toBe(true)
  })

  it('follows the trust mode: off accepts anything, broken accepts nothing', () => {
    expect(guideSignatureAccepted({ mode: 'off', keys: new Map() }, VECTOR_FIELDS, null)).toBe(true)
    expect(guideSignatureAccepted({ mode: 'broken', keys: new Map() }, VECTOR_FIELDS, VECTOR_SIG)).toBe(false)
  })
})

describe('tool skill signatures', () => {
  // Shared with the registry's Go test (TestSkillMessageAndVector): RFC 8032 test 1 key.
  const VECTOR_TRUST = parseTrustStore(JSON.stringify({
    schema: 'halo.cli.trust/1',
    keys: [{ keyId: 'rfc8032', alg: 'ed25519', publicKey: '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=' }],
  }))
  const VECTOR_FIELDS = {
    id: 'io.prettier.cli',
    revision: 2,
    sha256: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
  }
  const VECTOR_SIG: CatalogSignature = {
    alg: 'ed25519',
    keyId: 'rfc8032',
    value: 'qwDP+2ghLgBOPNJJZLpqSVInLP8W+yRYDPu0dKj6yhLYkNLXzZbVSMTJrkkhHSiv9hZ1vUiC+bM4URwzBoXDBQ==',
  }

  it('signs the documented bytes', () => {
    expect(signedSkillBytes({ ...VECTOR_FIELDS, sha256: VECTOR_FIELDS.sha256.toUpperCase() }).toString('utf-8')).toBe(
      `halo.cli.skill/1\nio.prettier.cli\n2\n${VECTOR_FIELDS.sha256}\n`,
    )
  })

  it('accepts the cross-language vector and rejects any changed field', () => {
    expect(skillSignatureAccepted(VECTOR_TRUST, VECTOR_FIELDS, VECTOR_SIG)).toBe(true)
    expect(skillSignatureAccepted(VECTOR_TRUST, { ...VECTOR_FIELDS, revision: 3 }, VECTOR_SIG)).toBe(false)
    expect(skillSignatureAccepted(VECTOR_TRUST, { ...VECTOR_FIELDS, id: 'io.prettier.other' }, VECTOR_SIG)).toBe(false)
    expect(skillSignatureAccepted(VECTOR_TRUST, { ...VECTOR_FIELDS, sha256: '0'.repeat(64) }, VECTOR_SIG)).toBe(false)
    expect(skillSignatureAccepted(VECTOR_TRUST, VECTOR_FIELDS, null)).toBe(false)
  })

  it('is not interchangeable with a guide signature', () => {
    const guideSig: CatalogSignature = {
      alg: 'ed25519',
      keyId: 'rfc8032',
      value: 'pHlB6VLR0E/M+3c7uOuYaahVp3nLIPWV5RgNal4mYd/+iF5LKA6hyAtpBY7u1hmMI3/sKpkqVfo9/QyR8MDsDw==',
    }
    expect(skillSignatureAccepted(VECTOR_TRUST, VECTOR_FIELDS, guideSig)).toBe(false)
    expect(guideSignatureAccepted(VECTOR_TRUST, { ...VECTOR_FIELDS, version: '3.10.1' }, VECTOR_SIG)).toBe(false)
  })

  it('follows the trust mode: off accepts anything, broken accepts nothing', () => {
    expect(skillSignatureAccepted({ mode: 'off', keys: new Map() }, VECTOR_FIELDS, null)).toBe(true)
    expect(skillSignatureAccepted({ mode: 'broken', keys: new Map() }, VECTOR_FIELDS, VECTOR_SIG)).toBe(false)
  })
})
