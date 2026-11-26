/**
 * Unit tests for the CLI tool catalog backend (`halo.cli.catalog/2`).
 *
 * The source driver and the account token are stubbed; the cli-tools host is
 * real, on a temporary root, so the install path runs the same bundle checks
 * and publish steps a device does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, sign } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { STORE_NOT_SIGNED_IN } from '../../../src/shared/store/store-types'
import type { RegistrySource } from '../../../src/shared/store/store-types'
import { buildBundle, makeTempDir, removeTree, writePackage, type BundleSpec, type Files } from '../services/cli-tools/helpers'

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
  const sync = await import('../../../src/main/store/backend/cli-catalog-sync')
  return { catalog, sync, host, identity: vi.mocked(identity.getStoreIdentityToken) }
}

type Shipped = ReturnType<typeof buildBundle>

/** A bundle of a fresh package of `version`, or of `spec.hcli` when given. */
function bundleOf(version: string, spec: Partial<BundleSpec> = {}): Shipped {
  return buildBundle({ hcli: spec.hcli ?? writePackage(pkgs, { version }), ...spec })
}

const FAKE: Pick<Shipped, 'ref'> = { ref: { id: ID, version: '0.0.0', revision: 1, sha256: 'a'.repeat(64), size: 1 } }

function versionEntry(version: string, shipped: Pick<Shipped, 'ref'> = FAKE, overrides: Record<string, unknown> = {}) {
  const { revision, sha256, size } = shipped.ref
  return {
    version,
    platforms: ['any'],
    minNode: '22.14',
    sideEffects: 'read-only',
    auth: { method: 'none' },
    commands: ['tool'],
    publishedAt: '2026-11-19T08:00:00Z',
    bundle: { revision, sha256, size, url: `/clis/${ID}/${version}/bundles/${revision}.zip` },
    ...overrides,
  }
}

function catalogBody(tools: unknown[]) {
  return { schema: 'halo.cli.catalog/2', generatedAt: '2026-11-19T08:00:00Z', tools }
}

/** What the source driver answers for a catalog it serves. */
function served(tools: unknown[]) {
  return { status: 'ok', document: catalogBody(tools) }
}

function tool(versions: unknown[], overrides: Record<string, unknown> = {}) {
  return { id: ID, displayName: 'Example tool', source: 'partner', revoked: false, latest: '1.0.0', versions, ...overrides }
}

/** A driver download that serves each listed bundle by its URL. */
function downloads(...bundles: Shipped[]) {
  return vi.fn(async (_source: unknown, url: string) => {
    const found = bundles.find(b => url === `/clis/${b.ref.id}/${b.ref.version}/bundles/${b.ref.revision}.zip`)
    if (!found) throw new Error('This CLI version is no longer available from the store')
    return found.bytes
  })
}

async function skillBody(host: Awaited<ReturnType<typeof load>>['host'], id = ID): Promise<string> {
  const snapshot = await host.readCurrentToolSkills()
  return (await snapshot!.skills.find(skill => skill.toolId === id)!.describe()).body
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
    const good = versionEntry('1.0.0')
    const bundle = good.bundle
    const tools = catalog.parseCliCatalog(catalogBody([
      tool([good]),
      tool([good], { id: 'Bad ID' }),
      tool([{ ...good, bundle: { ...bundle, sha256: 'xyz' } }], { id: 'com.example.badsha' }),
      tool([{ ...good, bundle: { ...bundle, revision: 0 } }], { id: 'com.example.badrev' }),
      tool([{ ...good, version: '1.0' }], { id: 'com.example.badver' }),
      tool([{ ...good, bundle: { ...bundle, url: '' } }], { id: 'com.example.nourl' }),
      tool([{ ...good, bundle: undefined, downloadUrl: '/x' }], { id: 'com.example.oldshape' }),
      tool([good], { displayName: 'Duplicate' }),
    ]))
    // A tool keeps its entry (its revocation still applies) but malformed versions are dropped.
    expect(tools.map(t => t.id)).toEqual([ID, 'com.example.badsha', 'com.example.badrev', 'com.example.badver', 'com.example.nourl', 'com.example.oldshape'])
    expect(tools.slice(1).every(t => t.versions.length === 0)).toBe(true)
    expect(tools[0].displayName).toBe('Example tool')
  })

  it('refuses a body with an unknown schema, including the retired catalog/1', async () => {
    const { catalog } = await load(null)
    expect(() => catalog.parseCliCatalog({ schema: 'halo.cli.catalog/1', tools: [] })).toThrow('unsupported CLI catalog')
    expect(() => catalog.parseCliCatalog({ schema: 'other/1', tools: [] })).toThrow('unsupported CLI catalog')
    expect(() => catalog.parseCliCatalog(null)).toThrow('invalid CLI catalog')
  })

  it('falls back to the newest listed version when latest is not listed', async () => {
    const { catalog } = await load(null)
    const [parsed] = catalog.parseCliCatalog(catalogBody([
      tool([versionEntry('2.0.0'), versionEntry('1.0.0')], { latest: '9.9.9' }),
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
    const fetchCliCatalog = vi.fn(async () => ({ status: 'absent' }))
    const { catalog } = await load({ fetchCliCatalog })
    expect(await catalog.fetchCliCatalog()).toEqual({ tools: [] })
    expect(fetchCliCatalog).toHaveBeenCalledWith(PRIMARY, { token: 'tok' }, undefined)
  })

  it('reports a missing sign-in rather than an empty catalog', async () => {
    const fetchCliCatalog = vi.fn()
    const { catalog, identity } = await load({ fetchCliCatalog })
    identity.mockResolvedValue(null)
    await expect(catalog.fetchCliCatalog()).rejects.toThrow(STORE_NOT_SIGNED_IN)
    expect(fetchCliCatalog).not.toHaveBeenCalled()
  })

  it('maps versions for the renderer without download paths or digests', async () => {
    const fetchCliCatalog = vi.fn(async () => served([
      tool([
        versionEntry('1.0.0'),
        versionEntry('0.9.0', FAKE, { platforms: ['plan9-mips'], sideEffects: 'sometimes', auth: { method: 'magic' } }),
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
    expect(JSON.stringify(tools)).not.toMatch(/bundles|sha256|revision/)
  })
})

describe('cli catalog: install and revocation', () => {
  it('installs only the bundle the user asked for, with its skill, and keeps no download', async () => {
    const shipped = bundleOf('1.0.0', { skill: { 'SKILL.md': '---\ndescription: Example.\n---\nRun `tool --check`.\n', 'refs/a.md': 'a' } })
    const fetchCliCatalog = vi.fn(async () => served([tool([versionEntry('1.0.0', shipped)])]))
    const downloadCliPackage = downloads(shipped)
    const { catalog, host } = await load({ fetchCliCatalog, downloadCliPackage })

    await catalog.fetchCliCatalog()
    expect(downloadCliPackage).not.toHaveBeenCalled()

    const view = await catalog.installCliTool({ id: ID, version: '1.0.0' })
    expect(downloadCliPackage).toHaveBeenCalledWith(PRIMARY, `/clis/${ID}/1.0.0/bundles/1.zip`, { token: 'tok' }, shipped.ref.size)
    expect(view.installed).toEqual({ current: '1.0.0', versions: ['1.0.0'], revoked: false })
    const record = (await host.readCliToolState())!.tools[ID].versions['1.0.0']
    expect(record).toMatchObject({ source: 'catalog', bundle: { revision: 1, sha256: shipped.ref.sha256 }, skill: { files: 2 } })
    expect(await skillBody(host)).toContain('Run `tool --check`.')
    expect(readdirSync(join(dir, 'cli', 'downloads'))).toEqual([])
  })

  it('refuses a download that differs from the catalog and installs nothing', async () => {
    const shipped = bundleOf('1.0.0')
    const fetchCliCatalog = vi.fn(async () => served([tool([versionEntry('1.0.0', shipped)])]))
    const downloadCliPackage = vi.fn(async () => shipped.bytes.map((b, i) => (i === 0 ? b ^ 1 : b)))
    const { catalog, host } = await load({ fetchCliCatalog, downloadCliPackage })

    await expect(catalog.installCliTool({ id: ID, version: '1.0.0' })).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    expect((await host.readCliToolState())!.tools[ID]).toBeUndefined()
  })

  it('refuses a bundle whose CLI payload differs from its bundle.json', async () => {
    const shipped = bundleOf('1.0.0', { editJson: json => { (json.cli as Record<string, unknown>).integrity = `sha256-${'A'.repeat(43)}=` } })
    const fetchCliCatalog = vi.fn(async () => served([tool([versionEntry('1.0.0', shipped)])]))
    const { catalog, host } = await load({ fetchCliCatalog, downloadCliPackage: downloads(shipped) })

    await expect(catalog.installCliTool({ id: ID, version: '1.0.0' })).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    expect((await host.readCliToolState())!.tools[ID]).toBeUndefined()
  })

  it('refuses revoked, unlisted and unsupported versions before downloading', async () => {
    const body = catalogBody([
      tool([versionEntry('1.0.0')], { revoked: true }),
      tool([versionEntry('1.0.0', FAKE, { platforms: ['plan9-mips'] })], { id: 'com.example.other' }),
    ])
    const downloadCliPackage = vi.fn()
    const { catalog } = await load({ fetchCliCatalog: vi.fn(async () => ({ status: 'ok', document: body })), downloadCliPackage })

    await expect(catalog.installCliTool({ id: ID, version: '1.0.0' })).rejects.toThrow('revoked')
    await expect(catalog.installCliTool({ id: 'com.example.absent', version: '1.0.0' })).rejects.toThrow('not in the store catalog')
    await expect(catalog.installCliTool({ id: 'com.example.other', version: '2.0.0' })).rejects.toThrow('no longer available')
    await expect(catalog.installCliTool({ id: 'com.example.other', version: '1.0.0' })).rejects.toThrow('does not support this device')
    expect(downloadCliPackage).not.toHaveBeenCalled()
  })

  it('applies a revocation to the installed tool on the next read and keeps it out of new executions', async () => {
    const shipped = bundleOf('1.0.0')
    let revoked = false
    const fetchCliCatalog = vi.fn(async () => served([tool([versionEntry('1.0.0', shipped)], { revoked })]))
    const { catalog, sync, host } = await load({ fetchCliCatalog, downloadCliPackage: downloads(shipped) })
    await catalog.installCliTool({ id: ID, version: '1.0.0' })

    revoked = true
    await sync.requestCliCatalogSync('startup')
    expect((await host.readCliToolState())!.tools[ID].revoked).toBe(true)
    expect(existsSync(join(dir, 'cli', 'tools', ID))).toBe(false)

    revoked = false
    const { tools } = await catalog.fetchCliCatalog()
    expect(tools[0].installed?.revoked).toBe(false)
  })

  it('keeps the background sync silent when there is nothing to ask or the request fails', async () => {
    const quiet = await load(null)
    await expect(quiet.sync.requestCliCatalogSync('startup')).resolves.toBeNull()

    const fetchCliCatalog = vi.fn()
    const signedOut = await load({ fetchCliCatalog })
    signedOut.identity.mockResolvedValue(null)
    await expect(signedOut.sync.requestCliCatalogSync('startup')).resolves.toBeNull()
    expect(fetchCliCatalog).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()

    const failing = await load({ fetchCliCatalog: vi.fn(async () => { throw new Error('cli-catalog failed: 503') }) })
    await expect(failing.sync.requestCliCatalogSync('startup')).resolves.toBeNull()
    expect(console.warn).toHaveBeenCalledWith('[CliCatalog] Sync failed; installed tools unchanged', { trigger: 'startup', reason: 'cli-catalog failed: 503' })
    await expect(failing.sync.syncCliCatalogNow()).rejects.toThrow('503')
  })
})

describe('cli catalog: status and signatures', () => {
  it('marks an installed catalog tool delisted, flags withdrawn versions and updates without downloading', async () => {
    const shipped = bundleOf('1.0.0')
    let body = catalogBody([tool([versionEntry('1.0.0', shipped)])])
    const downloadCliPackage = downloads(shipped)
    const { catalog, host } = await load({ fetchCliCatalog: vi.fn(async () => ({ status: 'ok', document: body })), downloadCliPackage })
    await catalog.installCliTool({ id: ID, version: '1.0.0' })
    expect(downloadCliPackage).toHaveBeenCalledTimes(1)

    body = catalogBody([tool([versionEntry('2.0.0')], { latest: '2.0.0' })])
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
    expect(existsSync(join(dir, 'cli', 'tools', ID))).toBe(false)
  })

  it('does not delist anything when the catalog cannot be read', async () => {
    const shipped = bundleOf('1.0.0')
    let fail = false
    const fetchCliCatalog = vi.fn(async () => { if (fail) throw new Error('503'); return served([tool([versionEntry('1.0.0', shipped)])]) })
    const { catalog, sync, host } = await load({ fetchCliCatalog, downloadCliPackage: downloads(shipped) })
    await catalog.installCliTool({ id: ID, version: '1.0.0' })
    fail = true
    await sync.requestCliCatalogSync('startup')
    expect((await host.readCliToolState())!.tools[ID].delisted).toBeUndefined()
  })

  it('requires a valid bundle signature when the build ships keys', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const presetDir = join(dir, 'preset')
    mkdirSync(presetDir)
    writeFileSync(join(presetDir, 'trusted-keys.json'), JSON.stringify({
      schema: 'halo.cli.trust/1',
      keys: [{ keyId: 'k1', alg: 'ed25519', publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64') }],
    }))
    const hcli = writePackage(pkgs, { version: '1.0.0' })
    const signer = (json: Uint8Array) => ({
      alg: 'ed25519', keyId: 'k1',
      value: sign(null, Buffer.concat([Buffer.from('halo.cli.bundle/1\n'), json]), privateKey).toString('base64'),
    })
    const unsigned = bundleOf('1.0.0', { hcli })
    const signed = bundleOf('1.0.0', { hcli, revision: 2, sign: signer })
    let listed = unsigned
    const { catalog, host } = await load({
      fetchCliCatalog: vi.fn(async () => served([tool([versionEntry('1.0.0', listed)])])),
      downloadCliPackage: downloads(unsigned, signed),
    }, presetDir)

    await expect(catalog.installCliTool({ id: ID, version: '1.0.0' })).rejects.toMatchObject({ code: 'SIGNATURE_MISSING' })
    expect((await host.readCliToolState())!.tools[ID]).toBeUndefined()

    listed = signed
    await catalog.installCliTool({ id: ID, version: '1.0.0' })
    expect((await host.readCliToolState())!.tools[ID].current).toBe('1.0.0')
  })
})

describe('cli catalog: skills arrive with bundles', () => {
  const skillText = (line: string): Files => ({ 'SKILL.md': `---\ndescription: ${line}\n---\n${line}\n` })

  it('takes a new revision of an installed version: the skill changes, the CLI is not reinstalled', async () => {
    const hcli = writePackage(pkgs, { version: '1.0.0' })
    const r1 = bundleOf('1.0.0', { hcli, skill: skillText('First text.') })
    const r2 = bundleOf('1.0.0', { hcli, revision: 2, skill: skillText('Second text.') })
    let listed = r1
    const downloadCliPackage = downloads(r1, r2)
    const { catalog, sync, host } = await load({ fetchCliCatalog: vi.fn(async () => served([tool([versionEntry('1.0.0', listed)])])), downloadCliPackage })
    await catalog.installCliTool({ id: ID, version: '1.0.0' })
    const before = (await host.readCliToolState())!.tools[ID].versions['1.0.0']
    expect(await skillBody(host)).toContain('First text.')

    // Nothing new: no download.
    expect((await sync.syncCliCatalogNow()).changed).toBe(0)
    expect(downloadCliPackage).toHaveBeenCalledTimes(1)

    listed = r2
    const result = await sync.syncCliCatalogNow()
    expect(result.installed).toEqual([])
    expect(result.changed).toBeGreaterThan(0)
    const after = (await host.readCliToolState())!.tools[ID].versions['1.0.0']
    expect(after).toMatchObject({ dir: before.dir, importedAt: before.importedAt, bundle: { revision: 2 } })
    expect(await skillBody(host)).toContain('Second text.')
  })

  it('gives a copy shipped before bundles its skill without reinstalling it', async () => {
    const presetDir = join(dir, 'preset')
    mkdirSync(presetDir)
    const hcli = writePackage(pkgs, { version: '1.0.0' })
    writeFileSync(join(presetDir, 'tool-1.0.0.hcli'), readFileSync(hcli))
    const shipped = bundleOf('1.0.0', { hcli, revision: 3, skill: skillText('From the Registry.') })
    const { sync, host } = await load({
      fetchCliCatalog: vi.fn(async () => served([tool([versionEntry('1.0.0', shipped)], { source: 'builtin', autoInstall: true })])),
      downloadCliPackage: downloads(shipped),
    }, presetDir)
    await host.prepareCliTools()
    const before = (await host.readCliToolState())!.tools[ID].versions['1.0.0']
    expect(before.bundle).toBeUndefined()

    const result = await sync.syncCliCatalogNow()
    expect(result.installed).toEqual([])
    const after = (await host.readCliToolState())!.tools[ID].versions['1.0.0']
    expect(after).toMatchObject({ source: 'preset', dir: before.dir, bundle: { revision: 3 }, skill: { files: 1 } })
    expect(await skillBody(host)).toContain('From the Registry.')
  })
})

describe('cli catalog: revalidation', () => {
  it('sends the previous ETag and reuses the parsed catalog when it is unchanged', async () => {
    const fetchCliCatalog = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', document: catalogBody([tool([versionEntry('1.0.0')])]), validator: '"v1"' })
      .mockResolvedValue({ status: 'unchanged' })
    const { catalog } = await load({ fetchCliCatalog })

    expect((await catalog.fetchCliCatalog()).tools.map(t => t.id)).toEqual([ID])
    expect((await catalog.fetchCliCatalog()).tools.map(t => t.id)).toEqual([ID])
    expect(fetchCliCatalog.mock.calls.map(call => call[2])).toEqual([undefined, '"v1"'])
  })
})

describe('cli catalog: administrator delivery', () => {
  const delivered = (versions: unknown[], overrides: Record<string, unknown> = {}) =>
    tool(versions, { source: 'builtin', latest: '', autoInstall: versions.length > 0, ...overrides })

  function presetOf(version: string): string {
    const presetDir = join(dir, 'preset')
    mkdirSync(presetDir)
    writePackage(presetDir, { version })
    return presetDir
  }


  it('installs a delivered tool on sync and keeps it from being deleted', async () => {
    const shipped = bundleOf('1.0.0')
    const downloadCliPackage = downloads(shipped)
    const { sync, host } = await load({ fetchCliCatalog: vi.fn(async () => served([delivered([versionEntry('1.0.0', shipped)])])), downloadCliPackage })

    const changed = vi.fn()
    const subscription = host.onDidChangeCurrentTools(changed)
    const result = await sync.syncCliCatalogNow()
    subscription.dispose()
    expect(result.installed).toEqual([{ id: ID, version: '1.0.0' }])
    expect(result.failed).toEqual([])
    expect(changed.mock.calls).toEqual([[host.getPreparedCurrentToolsRevision()]])
    const record = (await host.readCliToolState())!.tools[ID]
    expect(record.current).toBe('1.0.0')
    expect(record.autoInstall).toBe(true)
    const view = (await host.getCliToolsOverview()).tools.find(t => t.id === ID)!
    expect(view.adminManaged).toBe(true)
    expect(view.versions[0].removable).toBe(false)
    await expect(host.removeCliTool(ID)).rejects.toMatchObject({ code: 'ADMIN_MANAGED' })
    await expect(host.removeCliToolVersion(ID, '1.0.0')).rejects.toMatchObject({ code: 'ADMIN_MANAGED' })

    expect((await sync.syncCliCatalogNow()).installed).toEqual([])
    expect(downloadCliPackage).toHaveBeenCalledTimes(1)
  })

  it('leaves partner tools to the user and counts their updates', async () => {
    const shipped = bundleOf('1.0.0')
    let body = catalogBody([tool([versionEntry('1.0.0', shipped)])])
    const downloadCliPackage = downloads(shipped)
    const { catalog, sync } = await load({ fetchCliCatalog: vi.fn(async () => ({ status: 'ok', document: body })), downloadCliPackage })

    expect((await sync.syncCliCatalogNow()).installed).toEqual([])
    await catalog.installCliTool({ id: ID, version: '1.0.0' })
    body = catalogBody([tool([versionEntry('2.0.0'), versionEntry('1.0.0', shipped)], { latest: '2.0.0' })])
    const result = await sync.syncCliCatalogNow()
    expect(result.installed).toEqual([])
    expect(result.updates).toBe(1)
    expect(downloadCliPackage).toHaveBeenCalledTimes(1)
  })

  it('moves past the shipped copy, falls back to it when the delivery is withdrawn, and never downgrades', async () => {
    const shipped = bundleOf('2.0.0')
    let body = catalogBody([delivered([versionEntry('2.0.0', shipped)])])
    const downloadCliPackage = downloads(shipped)
    const { sync, host } = await load({ fetchCliCatalog: vi.fn(async () => ({ status: 'ok', document: body })), downloadCliPackage }, presetOf('1.0.0'))

    expect((await sync.syncCliCatalogNow()).installed).toEqual([{ id: ID, version: '2.0.0' }])
    expect((await host.readCliToolState())!.tools[ID].current).toBe('2.0.0')

    // Every approved version withdrawn: the catalog no longer marks the tool, the device still does.
    body = catalogBody([delivered([])])
    const result = await sync.syncCliCatalogNow()
    expect(result.installed).toEqual([])
    let record = (await host.readCliToolState())!.tools[ID]
    expect(record.current).toBe('1.0.0')
    expect(record.versions['2.0.0'].withdrawn).toBe(true)
    expect(record.autoInstall).toBe(true)

    body = catalogBody([delivered([versionEntry('0.9.0', bundleOf('0.9.0'))])])
    await sync.syncCliCatalogNow()
    record = (await host.readCliToolState())!.tools[ID]
    expect(record.current).toBe('1.0.0')
    expect(record.versions['0.9.0']).toBeUndefined()
    expect(downloadCliPackage).toHaveBeenCalledTimes(1)
  })

  it('remembers a refused bundle for background reads until the catalog changes it, retries it on Sync, and retries a network fault', async () => {
    const hcli = writePackage(pkgs, { version: '1.0.0' })
    const broken = bundleOf('1.0.0', { hcli, editJson: json => { (json.cli as Record<string, unknown>).integrity = `sha256-${'A'.repeat(43)}=` } })
    const fixed = bundleOf('1.0.0', { hcli, revision: 2 })
    let body = catalogBody([delivered([versionEntry('1.0.0', broken)])])
    const downloadCliPackage = downloads(broken, fixed)
    const { sync, host } = await load({ fetchCliCatalog: vi.fn(async () => ({ status: 'ok', document: body })), downloadCliPackage })

    expect((await sync.requestCliCatalogSync('sign-in'))!.failed).toEqual([{ id: ID, version: '1.0.0' }])
    expect((await host.getCliToolsOverview()).deliveryFailures).toEqual([{ id: ID, version: '1.0.0', code: 'DIGEST_MISMATCH' }])
    expect((await sync.requestCliCatalogSync('sign-in'))!.failed).toEqual([])
    expect(downloadCliPackage).toHaveBeenCalledTimes(1)
    // The user's Sync tries the remembered version once more.
    expect((await sync.syncCliCatalogNow()).failed).toEqual([{ id: ID, version: '1.0.0' }])
    expect(downloadCliPackage).toHaveBeenCalledTimes(2)

    body = catalogBody([delivered([versionEntry('1.0.0', fixed)])])
    downloadCliPackage.mockRejectedValueOnce(new Error('socket hang up'))
    expect((await sync.requestCliCatalogSync('sign-in'))!.failed).toEqual([{ id: ID, version: '1.0.0' }])
    expect((await host.getCliToolsOverview()).deliveryFailures).toEqual([])
    expect((await sync.requestCliCatalogSync('sign-in'))!.installed).toEqual([{ id: ID, version: '1.0.0' }])
    expect(downloadCliPackage).toHaveBeenCalledTimes(4)
  })

  it('installs a remembered refusal on Sync once the bundle arrives intact, and clears the record', async () => {
    const shipped = bundleOf('1.0.0')
    const downloadCliPackage = downloads(shipped)
    downloadCliPackage.mockResolvedValueOnce(Buffer.from('corrupted on the way'))
    const body = catalogBody([delivered([versionEntry('1.0.0', shipped)])])
    const { sync, host } = await load({ fetchCliCatalog: vi.fn(async () => ({ status: 'ok', document: body })), downloadCliPackage })

    expect((await sync.requestCliCatalogSync('startup'))!.failed).toEqual([{ id: ID, version: '1.0.0' }])
    expect((await host.getCliToolsOverview()).deliveryFailures).toHaveLength(1)
    expect((await sync.syncCliCatalogNow()).installed).toEqual([{ id: ID, version: '1.0.0' }])
    expect((await host.getCliToolsOverview()).deliveryFailures).toEqual([])
  })

  it('reads on events only when due, except at sign-in', async () => {
    const fetchCliCatalog = vi.fn(async () => served([]))
    const { sync } = await load({ fetchCliCatalog })

    expect(await sync.requestCliCatalogSync('startup')).not.toBeNull()
    expect(await sync.requestCliCatalogSync('focus')).toBeNull()
    expect(await sync.requestCliCatalogSync('sign-in')).not.toBeNull()
    await sync.syncCliCatalogNow()
    expect(fetchCliCatalog).toHaveBeenCalledTimes(3)
  })

  it('stays fresh after a read and backs off after failures', async () => {
    const { sync } = await load(null)
    let now = 0
    const schedule = new sync.CliCatalogSchedule(() => now)
    expect(schedule.isDue()).toBe(true)

    schedule.succeeded()
    now = sync.CLI_CATALOG_FRESH_MS - 1
    expect(schedule.isDue()).toBe(false)
    now += 1
    expect(schedule.isDue()).toBe(true)

    const waits: number[] = []
    for (let i = 0; i < 7; i++) {
      const start = now
      schedule.failed()
      while (!schedule.isDue()) now += 1000
      waits.push(now - start)
    }
    expect(waits.slice(0, 3)).toEqual([sync.CLI_CATALOG_RETRY_MS, sync.CLI_CATALOG_RETRY_MS * 2, sync.CLI_CATALOG_RETRY_MS * 4])
    expect(waits[6]).toBe(sync.CLI_CATALOG_MAX_RETRY_MS)

    schedule.signedOut()
    expect(schedule.isDue()).toBe(false)
    now += sync.CLI_CATALOG_RETRY_MS
    expect(schedule.isDue()).toBe(true)
  })
})
