/**
 * Unit tests for the CLI tool catalog backend.
 *
 * The source driver and the account token are stubbed; the cli-tools host is
 * real, on a temporary root, so the install path runs the same archive checks
 * and publish steps a device does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STORE_NOT_SIGNED_IN } from '../../../src/shared/store/store-types'
import type { RegistrySource } from '../../../src/shared/store/store-types'
import { buildManifest, makeTempDir, removeTree, writePackage } from '../services/cli-tools/helpers'

vi.mock('../../../src/main/store/registry.service', () => ({ getPrimaryRegistry: vi.fn(() => null) }))
vi.mock('../../../src/main/store/adapters', () => ({ getAdapter: vi.fn(() => ({})) }))
vi.mock('../../../src/main/store/backend/identity', () => ({ getStoreIdentityToken: vi.fn(async () => 'tok') }))

const ID = 'com.example.tool'
const PRIMARY: RegistrySource = { id: 'official', name: 'Primary', url: 'http://reg.test', enabled: true, sourceType: 'dhp-v2' }

let dir: string
let pkgs: string

/** The source driver methods under test; any other method is absent. */
type Driver = Record<string, (...args: never[]) => unknown>

async function load(driver: Driver | null, presetDir: string | null = null) {
  vi.resetModules()
  const registry = await import('../../../src/main/store/registry.service')
  const adapters = await import('../../../src/main/store/adapters')
  const identity = await import('../../../src/main/store/backend/identity')
  vi.mocked(registry.getPrimaryRegistry).mockReturnValue(driver ? PRIMARY : null)
  vi.mocked(adapters.getAdapter).mockReturnValue((driver ?? {}) as never)
  vi.mocked(identity.getStoreIdentityToken).mockResolvedValue('tok')
  const host = await import('../../../src/main/services/cli-tools/host')
  host.initCliTools({ root: join(dir, 'cli'), runtimePath: process.execPath, presetDir })
  const catalog = await import('../../../src/main/store/backend/cli-catalog')
  return { catalog, host, identity: vi.mocked(identity.getStoreIdentityToken) }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function versionEntry(version: string, bytes: Uint8Array, overrides: Record<string, unknown> = {}) {
  return {
    version,
    manifestSchema: 'halo.cli/1',
    integrity: buildManifest({ version }).integrity,
    archiveSha256: sha256(bytes),
    size: bytes.length,
    platforms: ['any'],
    minNode: '22.14',
    sideEffects: 'read-only',
    auth: { method: 'none' },
    commands: ['tool'],
    downloadUrl: `/clis/${ID}/${version}/package.hcli`,
    publishedAt: '2026-11-19T08:00:00Z',
    signature: null,
    ...overrides,
  }
}

function catalogBody(tools: unknown[]) {
  return { schema: 'halo.cli.catalog/1', generatedAt: '2026-11-19T08:00:00Z', tools }
}

function tool(versions: unknown[], overrides: Record<string, unknown> = {}) {
  return { id: ID, displayName: 'Example tool', source: 'npm', revoked: false, latest: '1.0.0', versions, ...overrides }
}

function packageBytes(version: string): Uint8Array {
  return new Uint8Array(readFileSync(writePackage(pkgs, { version })))
}

function downloadDirs(): string[] {
  return readdirSync(tmpdir()).filter(name => name.startsWith('halo-cli-download-'))
}

beforeEach(() => {
  dir = makeTempDir()
  pkgs = join(dir, 'pkgs')
  mkdirSync(pkgs)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  removeTree(dir)
})

describe('cli catalog: parsing', () => {
  it('drops malformed tools and versions instead of guessing', async () => {
    const { catalog } = await load(null)
    const good = versionEntry('1.0.0', new Uint8Array([1]))
    const tools = catalog.parseCliCatalog(catalogBody([
      tool([good]),
      tool([good], { id: 'Bad ID' }),
      tool([{ ...good, archiveSha256: 'xyz' }], { id: 'com.example.badsha' }),
      tool([{ ...good, integrity: 'md5-abc' }], { id: 'com.example.badint' }),
      tool([{ ...good, version: '1.0' }], { id: 'com.example.badver' }),
      tool([{ ...good, downloadUrl: '' }], { id: 'com.example.nourl' }),
      tool([good], { displayName: 'Duplicate' }),
    ]))
    // A tool keeps its entry (its revocation still applies) but malformed versions are dropped.
    expect(tools.map(t => t.id)).toEqual([ID, 'com.example.badsha', 'com.example.badint', 'com.example.badver', 'com.example.nourl'])
    expect(tools.slice(1).every(t => t.versions.length === 0)).toBe(true)
    expect(tools[0].displayName).toBe('Example tool')
  })

  it('refuses a body with an unknown schema', async () => {
    const { catalog } = await load(null)
    expect(() => catalog.parseCliCatalog({ schema: 'other/1', tools: [] })).toThrow('unsupported CLI catalog')
    expect(() => catalog.parseCliCatalog(null)).toThrow('invalid CLI catalog')
  })

  it('falls back to the newest listed version when latest is not listed', async () => {
    const { catalog } = await load(null)
    const bytes = new Uint8Array([1])
    const [parsed] = catalog.parseCliCatalog(catalogBody([
      tool([versionEntry('2.0.0', bytes), versionEntry('1.0.0', bytes)], { latest: '9.9.9' }),
    ]))
    expect(parsed.latest).toBe('2.0.0')
  })
})

describe('cli catalog: listing', () => {
  it('is empty without a catalog-capable source, with no request made', async () => {
    const { catalog, identity } = await load(null)
    expect(await catalog.fetchCliCatalog()).toEqual({ tools: [] })
    expect(identity).not.toHaveBeenCalled()
  })

  it('is empty when the source serves no catalog', async () => {
    const fetchCliCatalog = vi.fn(async () => null)
    const { catalog } = await load({ fetchCliCatalog })
    expect(await catalog.fetchCliCatalog()).toEqual({ tools: [] })
    expect(fetchCliCatalog).toHaveBeenCalledWith(PRIMARY, { token: 'tok' })
  })

  it('reports a missing sign-in rather than an empty catalog', async () => {
    const fetchCliCatalog = vi.fn()
    const { catalog, identity } = await load({ fetchCliCatalog })
    identity.mockResolvedValue(null)
    await expect(catalog.fetchCliCatalog()).rejects.toThrow(STORE_NOT_SIGNED_IN)
    expect(fetchCliCatalog).not.toHaveBeenCalled()
  })

  it('maps versions for the renderer without download paths or digests', async () => {
    const bytes = new Uint8Array([1])
    const fetchCliCatalog = vi.fn(async () => catalogBody([
      tool([
        versionEntry('1.0.0', bytes),
        versionEntry('0.9.0', bytes, { platforms: ['plan9-mips'], sideEffects: 'sometimes', auth: { method: 'magic' } }),
      ]),
    ]))
    const { catalog } = await load({ fetchCliCatalog })
    const { tools } = await catalog.fetchCliCatalog()
    expect(tools).toHaveLength(1)
    expect(tools[0].installed).toBeNull()
    expect(tools[0].versions[0]).toEqual({
      version: '1.0.0',
      size: 1,
      platforms: ['any'],
      supported: true,
      minNode: '22.14',
      sideEffects: 'read-only',
      auth: 'none',
      commands: ['tool'],
      publishedAt: '2026-11-19T08:00:00Z',
    })
    expect(tools[0].versions[1].supported).toBe(false)
    expect(tools[0].versions[1].sideEffects).toBeUndefined()
    expect(tools[0].versions[1].auth).toBeUndefined()
    expect(JSON.stringify(tools)).not.toMatch(/downloadUrl|archiveSha256|integrity|package\.hcli/)
  })
})

describe('cli catalog: install and revocation', () => {
  it('installs only the version the user asked for, verified, and cleans its download', async () => {
    const bytes = packageBytes('1.0.0')
    const fetchCliCatalog = vi.fn(async () => catalogBody([tool([versionEntry('1.0.0', bytes)])]))
    const downloadCliPackage = vi.fn(async () => bytes)
    const { catalog, host } = await load({ fetchCliCatalog, downloadCliPackage })
    const before = downloadDirs()

    await catalog.fetchCliCatalog()
    expect(downloadCliPackage).not.toHaveBeenCalled()

    const view = await catalog.installCliTool({ id: ID, version: '1.0.0' })
    expect(downloadCliPackage).toHaveBeenCalledWith(PRIMARY, `/clis/${ID}/1.0.0/package.hcli`, { token: 'tok' }, expect.any(Number))
    expect(view.installed).toEqual({ current: '1.0.0', versions: ['1.0.0'], revoked: false })
    const state = await host.readCliToolState()
    expect(state!.tools[ID].versions['1.0.0'].source).toBe('catalog')
    expect(downloadDirs()).toEqual(before)
  })

  it('refuses a download whose digest differs from the catalog and installs nothing', async () => {
    const bytes = packageBytes('1.0.0')
    const fetchCliCatalog = vi.fn(async () => catalogBody([tool([versionEntry('1.0.0', bytes)])]))
    const downloadCliPackage = vi.fn(async () => packageBytes('1.0.0').map((b, i) => (i === 0 ? b ^ 1 : b)))
    const { catalog, host } = await load({ fetchCliCatalog, downloadCliPackage })

    await expect(catalog.installCliTool({ id: ID, version: '1.0.0' })).rejects.toThrow('does not match the store catalog')
    expect((await host.readCliToolState())!.tools[ID]).toBeUndefined()
  })

  it('refuses a package whose payload differs from the catalog integrity', async () => {
    const bytes = packageBytes('1.0.0')
    const entry = versionEntry('1.0.0', bytes, { integrity: `sha256-${'A'.repeat(43)}=` })
    const fetchCliCatalog = vi.fn(async () => catalogBody([tool([entry])]))
    const { catalog, host } = await load({ fetchCliCatalog, downloadCliPackage: vi.fn(async () => bytes) })

    await expect(catalog.installCliTool({ id: ID, version: '1.0.0' })).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    expect((await host.readCliToolState())!.tools[ID]).toBeUndefined()
  })

  it('refuses revoked, unlisted and unsupported versions before downloading', async () => {
    const bytes = new Uint8Array([1])
    const body = catalogBody([
      tool([versionEntry('1.0.0', bytes)], { revoked: true }),
      tool([versionEntry('1.0.0', bytes, { platforms: ['plan9-mips'] })], { id: 'com.example.other' }),
    ])
    const downloadCliPackage = vi.fn()
    const { catalog } = await load({ fetchCliCatalog: vi.fn(async () => body), downloadCliPackage })

    await expect(catalog.installCliTool({ id: ID, version: '1.0.0' })).rejects.toThrow('revoked')
    await expect(catalog.installCliTool({ id: 'com.example.absent', version: '1.0.0' })).rejects.toThrow('not in the store catalog')
    await expect(catalog.installCliTool({ id: 'com.example.other', version: '2.0.0' })).rejects.toThrow('no longer available')
    await expect(catalog.installCliTool({ id: 'com.example.other', version: '1.0.0' })).rejects.toThrow('does not support this device')
    expect(downloadCliPackage).not.toHaveBeenCalled()
  })

  it('applies a revocation to the installed tool on the next read and keeps it out of new executions', async () => {
    const bytes = packageBytes('1.0.0')
    let revoked = false
    const fetchCliCatalog = vi.fn(async () => catalogBody([tool([versionEntry('1.0.0', bytes)], { revoked })]))
    const { catalog, host } = await load({ fetchCliCatalog, downloadCliPackage: vi.fn(async () => bytes) })
    await catalog.installCliTool({ id: ID, version: '1.0.0' })

    revoked = true
    await catalog.syncCliCatalogRevocations()
    expect((await host.readCliToolState())!.tools[ID].revoked).toBe(true)
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
    expect(await host.applyCliToolsEnv(env, { entry: 'other', engine: 'claude' })).toBeNull()

    revoked = false
    const { tools } = await catalog.fetchCliCatalog()
    expect(tools[0].installed?.revoked).toBe(false)
  })

  it('keeps the revocation sync silent when there is nothing to ask or the request fails', async () => {
    const quiet = await load(null)
    await expect(quiet.catalog.syncCliCatalogRevocations()).resolves.toBeUndefined()

    const fetchCliCatalog = vi.fn()
    const signedOut = await load({ fetchCliCatalog })
    signedOut.identity.mockResolvedValue(null)
    await signedOut.catalog.syncCliCatalogRevocations()
    expect(fetchCliCatalog).not.toHaveBeenCalled()

    const failing = await load({ fetchCliCatalog: vi.fn(async () => { throw new Error('cli-catalog failed: 503') }) })
    await expect(failing.catalog.syncCliCatalogRevocations()).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith('[CliCatalog] Revocation sync skipped:', 'cli-catalog failed: 503')
  })
})

describe('cli catalog: status and signatures', () => {
  it('marks an installed catalog tool delisted, flags withdrawn versions and updates without downloading', async () => {
    const bytes1 = packageBytes('1.0.0')
    let body = catalogBody([tool([versionEntry('1.0.0', bytes1)])])
    const downloadCliPackage = vi.fn(async () => bytes1)
    const { catalog, host } = await load({ fetchCliCatalog: vi.fn(async () => body), downloadCliPackage })
    await catalog.installCliTool({ id: ID, version: '1.0.0' })
    expect(downloadCliPackage).toHaveBeenCalledTimes(1)

    body = catalogBody([tool([versionEntry('2.0.0', new Uint8Array([2]))], { latest: '2.0.0' })])
    await catalog.fetchCliCatalog()
    let record = (await host.readCliToolState())!.tools[ID]
    expect(record.versions['1.0.0'].withdrawn).toBe(true)
    expect(record.catalogUpdate).toBe('2.0.0')
    expect(record.delisted).toBeUndefined()
    expect(downloadCliPackage).toHaveBeenCalledTimes(1)

    body = catalogBody([])
    const { tools } = await catalog.fetchCliCatalog()
    expect(tools).toEqual([])
    record = (await host.readCliToolState())!.tools[ID]
    expect(record.delisted).toBe(true)
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
    expect(await host.applyCliToolsEnv(env, { entry: 'other', engine: 'claude' })).toBeNull()
  })

  it('does not delist anything when the catalog cannot be read', async () => {
    const bytes = packageBytes('1.0.0')
    let fail = false
    const fetchCliCatalog = vi.fn(async () => { if (fail) throw new Error('503'); return catalogBody([tool([versionEntry('1.0.0', bytes)])]) })
    const { catalog, host } = await load({ fetchCliCatalog, downloadCliPackage: vi.fn(async () => bytes) })
    await catalog.installCliTool({ id: ID, version: '1.0.0' })
    fail = true
    await catalog.syncCliCatalogRevocations()
    expect((await host.readCliToolState())!.tools[ID].delisted).toBeUndefined()
  })

  it('refuses a missing or invalid signature before downloading when the build ships keys', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const presetDir = join(dir, 'preset')
    mkdirSync(presetDir)
    writeFileSync(join(presetDir, 'trusted-keys.json'), JSON.stringify({
      schema: 'halo.cli.trust/1',
      keys: [{ keyId: 'k1', alg: 'ed25519', publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64') }],
    }))
    const bytes = packageBytes('1.0.0')
    const fields = { version: '1.0.0', integrity: buildManifest({ version: '1.0.0' }).integrity as string, archiveSha256: sha256(bytes) }
    const value = (version: string) => sign(null, Buffer.from(`halo.cli.sig/1\n${ID}\n${version}\n${fields.archiveSha256}\n${fields.integrity}\n`), privateKey).toString('base64')
    let signature: unknown = null
    const downloadCliPackage = vi.fn(async () => bytes)
    const { catalog, host } = await load({
      fetchCliCatalog: vi.fn(async () => catalogBody([tool([versionEntry('1.0.0', bytes, { signature })])])),
      downloadCliPackage,
    }, presetDir)

    await expect(catalog.installCliTool({ id: ID, version: '1.0.0' })).rejects.toMatchObject({ code: 'SIGNATURE_MISSING' })
    signature = { alg: 'ed25519', keyId: 'k1', value: value('9.9.9') }
    await expect(catalog.installCliTool({ id: ID, version: '1.0.0' })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' })
    expect(downloadCliPackage).not.toHaveBeenCalled()
    expect((await host.readCliToolState())!.tools[ID]).toBeUndefined()

    signature = { alg: 'ed25519', keyId: 'k1', value: value('1.0.0') }
    await catalog.installCliTool({ id: ID, version: '1.0.0' })
    expect((await host.readCliToolState())!.tools[ID].current).toBe('1.0.0')
  })
})

describe('cli catalog: administrator guide overrides', () => {
  const TEXT = '# Bank notes\nAlways run `tool --check` first.\n'

  function guideOf(content: string, revision = 1, extra: Record<string, unknown> = {}) {
    return { revision, sha256: createHash('sha256').update(content).digest('hex'), content, signature: null, ...extra }
  }

  /** The guide path TOOLS.md of a new session names for the tool. */
  async function sessionGuide(host: Awaited<ReturnType<typeof load>>['host']): Promise<{ path: string; text: string }> {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
    const binDir = await host.applyCliToolsEnv(env, { entry: 'chat', engine: 'claude' })
    expect(binDir).not.toBeNull()
    const index = readFileSync(join(binDir!, '..', 'TOOLS.md'), 'utf-8')
    const row = index.split('\n').find(line => line.includes(`| ${ID} |`))
    const path = row?.match(/`([^`]+)` \|$/)?.[1] ?? ''
    return { path, text: path ? readFileSync(path, 'utf-8') : '' }
  }

  it('parses a valid override and drops a malformed one without touching the version', async () => {
    const { catalog } = await load(null)
    const bytes = new Uint8Array([1])
    const parsed = catalog.parseCliCatalog(catalogBody([
      tool([
        versionEntry('3.0.0', bytes, { guide: guideOf(TEXT, 2) }),
        versionEntry('2.0.0', bytes, { guide: { ...guideOf(TEXT), sha256: '0'.repeat(64) } }),
        versionEntry('1.0.0', bytes),
      ]),
    ]))
    expect(parsed[0].versions.map(v => v.guide)).toEqual([
      { revision: 2, sha256: guideOf(TEXT).sha256, content: TEXT, signature: null },
      'invalid',
      null,
    ])
    const [status] = catalog.catalogStatusOf(parsed)
    expect(Object.keys(status.guides!)).toEqual(['3.0.0', '1.0.0'])
    expect(status.guides!['1.0.0'].override).toBeNull()
    // The renderer never sees guide text.
    const view = await catalog.fetchCliCatalog()
    expect(JSON.stringify(view)).not.toContain('Bank notes')
  })

  it('applies an override on install, pins it per session, and reverts when the administrator resets it', async () => {
    const bytes = packageBytes('1.0.0')
    let guide: unknown = guideOf(TEXT)
    const fetchCliCatalog = vi.fn(async () => catalogBody([tool([versionEntry('1.0.0', bytes, { guide })])]))
    const { catalog, host } = await load({ fetchCliCatalog, downloadCliPackage: vi.fn(async () => bytes) })

    await catalog.installCliTool({ id: ID, version: '1.0.0' })
    const record = (await host.readCliToolState())!.tools[ID].versions['1.0.0']
    expect(record.guideOverride).toEqual({ revision: 1, sha256: guideOf(TEXT).sha256 })
    expect(JSON.stringify(record)).not.toContain('Bank notes')
    const first = await sessionGuide(host)
    expect(first.text).toBe(TEXT)
    expect(first.path).toContain(join('guides', `${ID}.md`))

    // A new revision reaches new sessions; the earlier session's copy is unchanged.
    const edited = `${TEXT}Second revision.\n`
    guide = guideOf(edited, 2)
    await catalog.fetchCliCatalog()
    const second = await sessionGuide(host)
    expect(second.text).toBe(edited)
    expect(second.path).not.toBe(first.path)
    expect(readFileSync(first.path, 'utf-8')).toBe(TEXT)

    // Reset: the package guide applies again and unreferenced texts are pruned.
    guide = undefined
    await catalog.fetchCliCatalog()
    expect((await host.readCliToolState())!.tools[ID].versions['1.0.0'].guideOverride).toBeUndefined()
    const third = await sessionGuide(host)
    expect(third.path).not.toContain(join('guides', `${ID}.md`))
    expect(third.path.endsWith('README.md') || third.path === '').toBe(true)
  })

  it('leaves the guide as it is when the override is malformed or for another payload', async () => {
    const bytes = packageBytes('1.0.0')
    let entry: Record<string, unknown> = { guide: guideOf(TEXT) }
    const fetchCliCatalog = vi.fn(async () => catalogBody([tool([versionEntry('1.0.0', bytes, entry)])]))
    const { catalog, host } = await load({ fetchCliCatalog, downloadCliPackage: vi.fn(async () => bytes) })
    await catalog.installCliTool({ id: ID, version: '1.0.0' })

    entry = { guide: { ...guideOf('other'), content: 'tampered' } }
    await catalog.fetchCliCatalog()
    expect((await host.readCliToolState())!.tools[ID].versions['1.0.0'].guideOverride?.revision).toBe(1)

    entry = { guide: guideOf('for a different build', 5), integrity: `sha256-${'B'.repeat(43)}=` }
    await catalog.fetchCliCatalog()
    expect((await host.readCliToolState())!.tools[ID].versions['1.0.0'].guideOverride?.revision).toBe(1)
    expect((await sessionGuide(host)).text).toBe(TEXT)
  })

  it('requires a guide signature when the build ships keys', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const presetDir = join(dir, 'preset')
    mkdirSync(presetDir)
    writeFileSync(join(presetDir, 'trusted-keys.json'), JSON.stringify({
      schema: 'halo.cli.trust/1',
      keys: [{ keyId: 'k1', alg: 'ed25519', publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64') }],
    }))
    const bytes = packageBytes('1.0.0')
    const fields = { version: '1.0.0', integrity: buildManifest({ version: '1.0.0' }).integrity as string, archiveSha256: sha256(bytes) }
    const packageSig = {
      alg: 'ed25519', keyId: 'k1',
      value: sign(null, Buffer.from(`halo.cli.sig/1\n${ID}\n1.0.0\n${fields.archiveSha256}\n${fields.integrity}\n`), privateKey).toString('base64'),
    }
    const plain = guideOf(TEXT)
    const guideSig = (revision: number) => ({
      alg: 'ed25519', keyId: 'k1',
      value: sign(null, Buffer.from(`halo.cli.guide/1\n${ID}\n1.0.0\n${revision}\n${plain.sha256}\n`), privateKey).toString('base64'),
    })
    let guide: unknown = plain
    const fetchCliCatalog = vi.fn(async () => catalogBody([tool([versionEntry('1.0.0', bytes, { signature: packageSig, guide })])]))
    const { catalog, host } = await load({ fetchCliCatalog, downloadCliPackage: vi.fn(async () => bytes) }, presetDir)

    await catalog.installCliTool({ id: ID, version: '1.0.0' })
    expect((await host.readCliToolState())!.tools[ID].versions['1.0.0'].guideOverride).toBeUndefined()

    guide = { ...plain, revision: 2, signature: guideSig(1) }
    await catalog.fetchCliCatalog()
    expect((await host.readCliToolState())!.tools[ID].versions['1.0.0'].guideOverride).toBeUndefined()

    guide = { ...plain, revision: 2, signature: guideSig(2) }
    await catalog.fetchCliCatalog()
    expect((await host.readCliToolState())!.tools[ID].versions['1.0.0'].guideOverride?.revision).toBe(2)
    expect((await sessionGuide(host)).text).toBe(TEXT)
  })
})
