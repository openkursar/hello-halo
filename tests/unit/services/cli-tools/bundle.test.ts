/**
 * Delivery bundles (`halo.cli.bundle/1`): every check `readBundle` runs before
 * a bundle's CLI package or skill reaches the store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'crypto'
import { readFileSync } from 'fs'
import { CliToolError } from '../../../../src/main/services/cli-tools'
import { readBundle, skillPackageSha256 } from '../../../../src/main/services/cli-tools/bundle'
import { parseTrustStore, signedBundleBytes, type TrustStore } from '../../../../src/main/services/cli-tools/signature'
import { buildBundle, makeTempDir, removeTree, writePackage } from './helpers'

const OFF: TrustStore = { mode: 'off', keys: new Map() }

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work
  } catch (err) {
    return err instanceof CliToolError ? err.code : `NOT_TYPED: ${String(err)}`
  }
  return undefined
}

let dir: string
beforeEach(() => { dir = makeTempDir() })
afterEach(() => removeTree(dir))

describe('cli-tools bundle: skill digest', () => {
  it('matches the Registry vector: domain line, then path and sha256 per file in byte order', () => {
    const files = new Map([['a.md', Buffer.from('a')], ['SKILL.md', Buffer.from('s')]])
    expect(skillPackageSha256(files)).toBe('02cb6019d286cf555018c3cc0cfcddaf778ada0c506b796f7a158d296f39ffd1')
  })
})

describe('cli-tools bundle: reading', () => {
  it('returns the CLI package as approved and the skill files', async () => {
    const hcli = writePackage(dir)
    const { bytes, ref } = buildBundle({ hcli, skill: { 'SKILL.md': '---\ndescription: d\n---\nbody\n', 'refs/a.md': 'a' } })
    const bundle = await readBundle(bytes, ref, OFF)
    expect(bundle).toMatchObject({ id: 'com.example.tool', version: '1.0.0', revision: 1, sha256: ref.sha256 })
    expect(Buffer.from(bundle.hcli).equals(readFileSync(hcli))).toBe(true)
    expect([...bundle.skill!.files.keys()].sort()).toEqual(['SKILL.md', 'refs/a.md'])
    expect(bundle.skill!.source).toBe('text')
  })

  it('accepts a bundle without a skill', async () => {
    const { bytes, ref } = buildBundle({ hcli: writePackage(dir), skill: null })
    expect((await readBundle(bytes, ref, OFF)).skill).toBeNull()
  })

  it('refuses a bundle that differs from the catalog reference', async () => {
    const { bytes, ref } = buildBundle({ hcli: writePackage(dir) })
    expect(await codeOf(readBundle(bytes, { ...ref, sha256: '0'.repeat(64) }, OFF))).toBe('DIGEST_MISMATCH')
    expect(await codeOf(readBundle(bytes, { ...ref, size: ref.size + 1 }, OFF))).toBe('DIGEST_MISMATCH')
  })

  it('refuses entries outside the layout and unsafe paths', async () => {
    const hcli = writePackage(dir)
    const extra = buildBundle({ hcli, extra: { 'notes.txt': 'x' } })
    expect(await codeOf(readBundle(extra.bytes, extra.ref, OFF))).toBe('PACKAGE_INVALID')
    const unsafe = buildBundle({ hcli, extra: { 'skill/../x': 'x' } })
    expect(await codeOf(readBundle(unsafe.bytes, unsafe.ref, OFF))).toBe('PATH_UNSAFE')
  })

  it('parses bundle.json strictly and against the reference', async () => {
    const hcli = writePackage(dir)
    const unknown = buildBundle({ hcli, editJson: json => { json.extra = 1 } })
    expect(await codeOf(readBundle(unknown.bytes, unknown.ref, OFF))).toBe('PACKAGE_INVALID')
    const other = buildBundle({ hcli, editJson: json => { json.revision = 2 } })
    expect(await codeOf(readBundle(other.bytes, other.ref, OFF))).toBe('PACKAGE_INVALID')
  })

  it('checks the CLI package and the skill against bundle.json', async () => {
    const hcli = writePackage(dir)
    const cli = buildBundle({ hcli, editJson: json => { (json.cli as Record<string, unknown>).archiveSha256 = 'f'.repeat(64) } })
    expect(await codeOf(readBundle(cli.bytes, cli.ref, OFF))).toBe('DIGEST_MISMATCH')
    const skill = buildBundle({ hcli, editJson: json => { (json.skill as Record<string, unknown>).files = 2 } })
    expect(await codeOf(readBundle(skill.bytes, skill.ref, OFF))).toBe('DIGEST_MISMATCH')
    const stray = buildBundle({ hcli, skill: null, extra: { 'skill/SKILL.md': 'x' } })
    expect(await codeOf(readBundle(stray.bytes, stray.ref, OFF))).toBe('PACKAGE_INVALID')
    const noMain = buildBundle({ hcli, skill: { 'other.md': 'x' } })
    expect(await codeOf(readBundle(noMain.bytes, noMain.ref, OFF))).toBe('PACKAGE_INVALID')
  })

  it('requires a valid signature only when the build trusts keys', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64')
    const trust = parseTrustStore(JSON.stringify({ schema: 'halo.cli.trust/1', keys: [{ keyId: 'k', alg: 'ed25519', publicKey: raw }] }))
    const hcli = writePackage(dir)
    const signed = buildBundle({
      hcli, sign: json => ({ alg: 'ed25519', keyId: 'k', value: sign(null, signedBundleBytes(json), privateKey).toString('base64') }),
    })
    expect(await codeOf(readBundle(signed.bytes, signed.ref, trust))).toBeUndefined()
    const unsigned = buildBundle({ hcli })
    expect(await codeOf(readBundle(unsigned.bytes, unsigned.ref, trust))).toBe('SIGNATURE_MISSING')
    const garbled = buildBundle({ hcli, sign: () => ({ keyId: 'k', signature: 'x' }) })
    expect(await codeOf(readBundle(garbled.bytes, garbled.ref, trust))).toBe('SIGNATURE_INVALID')
    expect(await codeOf(readBundle(garbled.bytes, garbled.ref, OFF))).toBeUndefined()
  })
})
