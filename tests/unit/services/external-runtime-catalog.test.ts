import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRuntimeCatalog } from '../../../src/main/services/external-runtime/catalog'
import { createRuntimeReuse } from '../../../src/main/services/external-runtime/reuse'
import type { RuntimeProvider } from '../../../src/main/services/external-runtime/provider'

const provider = { id: 'codex' } as RuntimeProvider
function setup(name: string) {
  const root = join(globalThis.__HALO_TEST_DIR__, name)
  return { root, catalog: createRuntimeCatalog(provider, () => ({}), () => root) }
}
function installation(path: string) {
  return { path, version: '0.128.0', kind: 'native' as const, compatibility: 'compatible' as const, managed: true, recommended: true }
}
function checksum(text: string) { return createHash('sha256').update(text).digest('hex') }

describe('shared external runtime catalog and reuse', () => {
  it('isolates queues and bounded snapshots across instances', async () => {
    const first = setup('first')
    const second = setup('second')
    await Promise.all([
      first.catalog.rememberInstallation(installation(join(first.root, 'codex'))),
      second.catalog.rememberInstallation(installation(join(second.root, 'codex')))
    ])
    expect((await first.catalog.getCatalogSnapshot()).installations[0].path).toContain('/first/')
    expect((await second.catalog.getCatalogSnapshot()).installations[0].path).toContain('/second/')
    expect(JSON.parse(await readFile(join(first.root, 'catalog.json'), 'utf8')).version).toBe(1)
  })

  it('checks every installed component without network access and preserves artifact provenance', async () => {
    const { root, catalog } = setup('complete')
    const directory = join(root, 'published')
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'codex')
    await writeFile(path, 'main')
    await writeFile(join(directory, 'rg'), 'helper')
    const integrity = {
      platform: 'darwin-arm64', sourceUrl: 'https://registry.example', directory,
      artifactIntegrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      components: [{ path: 'codex', checksum: checksum('main'), size: 4 }, { path: 'rg', checksum: checksum('helper'), size: 6 }]
    }
    await catalog.rememberInstallation(installation(path), integrity)
    const checkInstallation = vi.fn(async () => installation(path))
    const reuse = createRuntimeReuse(provider, catalog, { checkInstallation })
    expect(await reuse.reuseManagedInstallation('0.128.0', integrity.platform, new AbortController().signal, { sourceUrl: integrity.sourceUrl, requireSourceMatch: true })).toMatchObject({ path })
    expect(checkInstallation).toHaveBeenCalledTimes(1)
    expect((await catalog.getCatalogEntry(path))?.integrity).toMatchObject(integrity)
    await writeFile(join(directory, 'rg'), 'broken')
    expect(await reuse.reuseManagedInstallation('0.128.0', integrity.platform, new AbortController().signal)).toBeNull()
    expect(checkInstallation).toHaveBeenCalledTimes(1)
    expect((await catalog.getCatalogEntry(path))?.installation.issue).toBe('checksum-mismatch')
  })

  it('rejects a different source or artifact anchor before protocol checking', async () => {
    const { root, catalog } = setup('source')
    const path = join(root, 'codex')
    await catalog.rememberInstallation(installation(path), { platform: 'darwin-arm64', sourceUrl: 'https://one.example', checksum: 'a'.repeat(64) })
    const checkInstallation = vi.fn(async () => installation(path))
    const reuse = createRuntimeReuse(provider, catalog, { checkInstallation })
    expect(await reuse.reuseManagedInstallation('0.128.0', 'darwin-arm64', new AbortController().signal, { sourceUrl: 'https://two.example', requireSourceMatch: true })).toBeNull()
    expect(checkInstallation).not.toHaveBeenCalled()
  })

  it('upgrades a legacy checksum prefix only after hashing and probing', async () => {
    const { root, catalog } = setup('legacy')
    await mkdir(root, { recursive: true })
    const path = join(root, 'codex')
    await writeFile(path, 'legacy')
    await catalog.rememberInstallation(installation(path), { platform: 'darwin-arm64', checksumPrefix: checksum('legacy').slice(0, 16) })
    const reuse = createRuntimeReuse(provider, catalog, { checkInstallation: async () => installation(path) })
    expect(await reuse.reuseManagedInstallation('0.128.0', 'darwin-arm64', new AbortController().signal, { checksum: checksum('legacy'), sourceUrl: 'https://registry.example' })).not.toBeNull()
    expect((await catalog.getCatalogEntry(path))?.integrity).toMatchObject({ checksum: checksum('legacy'), sourceUrl: 'https://registry.example' })
  })

  it('retains the selected entry at the inventory limit and never removes its files', async () => {
    const root = join(globalThis.__HALO_TEST_DIR__, 'bounded')
    const selectedPath = join(root, 'selected')
    const catalog = createRuntimeCatalog(provider, () => ({ selectedPath }), () => root)
    await mkdir(root, { recursive: true })
    await writeFile(selectedPath, 'retained')
    await catalog.rememberInstallation(installation(selectedPath))
    for (let index = 0; index < 65; index++) await catalog.rememberInstallation(installation(join(root, `entry-${index}`)))
    const snapshot = await catalog.getCatalogSnapshot()
    expect(snapshot.installations).toHaveLength(64)
    expect(snapshot.installations.some(item => item.path === selectedPath)).toBe(true)
    expect(snapshot.truncated).toBe(true)
    expect(await readFile(selectedPath, 'utf8')).toBe('retained')
    expect(Buffer.byteLength(await readFile(join(root, 'catalog.json'), 'utf8'))).toBeLessThanOrEqual(128 * 1024)
  })

  it('does not treat a malformed strong artifact digest as an integrity anchor', async () => {
    const { root, catalog } = setup('digest')
    await expect(catalog.rememberInstallation(installation(join(root, 'codex')), {
      platform: 'darwin-arm64', artifactIntegrity: 'sha512-YQ=='
    })).rejects.toMatchObject({ code: 'storage-failed' })
  })

  it.each(['missing-helper', 'wrong-pin'])('blocks %s records before probing and marks them unavailable on restart', async problem => {
    const root = join(globalThis.__HALO_TEST_DIR__, problem)
    const path = join(root, 'codex')
    const pin = `sha512-${Buffer.alloc(64, 1).toString('base64')}`
    const adapter = { ...provider, requiredComponents: () => ['codex', 'rg'], pinnedIntegrity: () => pin }
    const catalog = createRuntimeCatalog(adapter, () => ({}), () => root)
    await mkdir(root, { recursive: true })
    await writeFile(path, 'main')
    await writeFile(join(root, 'rg'), 'tampered helper')
    await catalog.rememberInstallation(installation(path), {
      platform: 'darwin-arm64', directory: root,
      artifactIntegrity: problem === 'wrong-pin' ? `sha512-${Buffer.alloc(64, 2).toString('base64')}` : pin,
      components: [{ path: 'codex', checksum: checksum('main'), size: 4 },
        ...(problem === 'wrong-pin' ? [{ path: 'rg', checksum: checksum('tampered helper'), size: 15 }] : [])]
    })
    const checkInstallation = vi.fn(async () => installation(path))
    const reuse = createRuntimeReuse(adapter, catalog, { checkInstallation })
    expect(await reuse.reuseManagedInstallation('0.128.0', 'darwin-arm64', new AbortController().signal)).toBeNull()
    expect(checkInstallation).not.toHaveBeenCalled()
    const restarted = createRuntimeCatalog(adapter, () => ({}), () => root)
    expect((await restarted.getCatalogEntry(path))?.installation).toMatchObject({ compatibility: 'unavailable', issue: 'checksum-mismatch' })
  })

  it.each(['empty', 'throws'])('rejects an unsupported platform nonfatally when its provider %s', async behavior => {
    const root = join(globalThis.__HALO_TEST_DIR__, `unsupported-${behavior}`)
    const path = join(root, 'codex')
    const adapter = { ...provider, requiredComponents: () => { if (behavior === 'throws') throw new Error('unsupported-platform'); return [] } }
    const catalog = createRuntimeCatalog(adapter, () => ({}), () => root)
    await catalog.rememberInstallation(installation(path), { platform: 'unsupported', checksum: 'a'.repeat(64) })
    const restarted = createRuntimeCatalog(adapter, () => ({}), () => root)
    expect((await restarted.getCatalogEntry(path))?.installation).toMatchObject({ compatibility: 'unavailable', issue: 'checksum-mismatch' })
    const checkInstallation = vi.fn(async () => installation(path))
    expect(await createRuntimeReuse(adapter, restarted, { checkInstallation }).reuseManagedInstallation('0.128.0', 'unsupported', new AbortController().signal)).toBeNull()
    expect(checkInstallation).not.toHaveBeenCalled()
  })

  it.each(['missing-integrity', 'missing-version', 'missing-helper', 'wrong-pin'])('normalizes managed %s on remember, snapshot and restart without cache laundering', async problem => {
    const root = join(globalThis.__HALO_TEST_DIR__, `normalize-${problem}`)
    const path = join(root, 'codex')
    const pin = `sha512-${Buffer.alloc(64, 1).toString('base64')}`
    const adapter = { ...provider, requiredComponents: () => ['codex', 'rg'], pinnedIntegrity: () => pin }
    const catalog = createRuntimeCatalog(adapter, () => ({}), () => root)
    const complete = { platform: 'darwin-arm64', directory: root, artifactIntegrity: pin,
      components: [{ path: 'codex', checksum: 'a'.repeat(64), size: 1 }, { path: 'rg', checksum: 'b'.repeat(64), size: 1 }] }
    const integrity = problem === 'missing-integrity' ? undefined : { ...complete,
      artifactIntegrity: problem === 'wrong-pin' ? `sha512-${Buffer.alloc(64, 2).toString('base64')}` : pin,
      components: problem === 'missing-helper' ? complete.components.slice(0, 1) : complete.components }
    const item = { ...installation(path), version: problem === 'missing-version' ? undefined : '0.128.0', sourceId: 'official' }
    await catalog.rememberInstallation(item, integrity)
    await catalog.rememberInstallation(item)
    expect((await catalog.getCatalogSnapshot()).installations[0]).toMatchObject({ managed: true, compatibility: 'unavailable', issue: 'checksum-mismatch', sourceId: 'official' })
    const restarted = createRuntimeCatalog(adapter, () => ({}), () => root)
    expect((await restarted.getCatalogEntry(path))?.installation).toMatchObject({ managed: true, compatibility: 'unavailable', issue: 'checksum-mismatch' })
    await restarted.rememberInstallation(installation(path), complete)
    expect((await restarted.getCatalogEntry(path))?.installation).toMatchObject({ managed: true, compatibility: 'compatible' })
    expect((await restarted.getCatalogEntry(path))?.installation.issue).toBeUndefined()
  })

  it('rejects component traversal and snapshots do not share component objects', async () => {
    const { root, catalog } = setup('invalid')
    const path = join(root, 'codex')
    const integrity = { platform: 'darwin-arm64', directory: root, components: [{ path: '../escape', checksum: 'a'.repeat(64), size: 1 }] }
    await expect(catalog.rememberInstallation(installation(path), integrity)).rejects.toMatchObject({ code: 'storage-failed' })
    integrity.components[0].path = 'codex'
    await catalog.rememberInstallation(installation(path), integrity)
    const entry = await catalog.getCatalogEntry(path)
    entry!.integrity!.components![0].checksum = 'b'.repeat(64)
    expect((await catalog.getCatalogEntry(path))!.integrity!.components![0].checksum).toBe('a'.repeat(64))
  })
})
