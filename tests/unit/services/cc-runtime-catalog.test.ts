import { describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CcInstallation } from '../../../src/shared/types/cc-runtime'

vi.mock('../../../src/main/foundation/config.service', () => ({
  getHaloDir: () => join(globalThis.__HALO_TEST_DIR__, '.halo'), getConfig: () => ({ agent: {} })
}))

function record(path: string, version: string, managed = false): CcInstallation {
  return { path, version, kind: 'native', compatibility: 'compatible', managed, recommended: true, checkedAt: new Date().toISOString() }
}

describe('CC installation catalog', () => {
  it('persists multiple local and managed versions across module restart', async () => {
    const { rememberInstallation, getCatalogSnapshot } = await import('../../../src/main/services/cc-runtime/catalog')
    const local = join(globalThis.__HALO_TEST_DIR__, 'local-claude')
    const managed = join(globalThis.__HALO_TEST_DIR__, '.halo', 'runtimes', 'claude-code', 'managed', 'claude')
    await rememberInstallation(record(local, '2.1.89'))
    await rememberInstallation(record(managed, '2.1.310', true), { platform: 'darwin-arm64', checksum: 'a'.repeat(64) })
    expect((await getCatalogSnapshot()).installations).toHaveLength(2)
    vi.resetModules()
    const restarted = await import('../../../src/main/services/cc-runtime/catalog')
    expect((await restarted.getCatalogSnapshot()).installations.map(item => item.version)).toEqual(['2.1.310', '2.1.89'])
    expect(await readFile(join(globalThis.__HALO_TEST_DIR__, '.halo', 'runtimes', 'claude-code', 'catalog.json'), 'utf8')).toContain('"version":1')
  })

  it('indexes existing private version directories once without touching binary contents', async () => {
    const root = join(globalThis.__HALO_TEST_DIR__, '.halo', 'runtimes', 'claude-code')
    const directory = join(root, '2.1.310-darwin-arm64-aaaaaaaaaaaaaaaa')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'claude'), 'not an executable; indexing must not probe it')
    const { getCatalogSnapshot } = await import('../../../src/main/services/cc-runtime/catalog')
    expect((await getCatalogSnapshot()).installations).toEqual([expect.objectContaining({ version: '2.1.310', managed: true, compatibility: 'unchecked' })])
    await mkdir(join(root, '2.1.89-darwin-arm64-bbbbbbbbbbbbbbbb'))
    await writeFile(join(root, '2.1.89-darwin-arm64-bbbbbbbbbbbbbbbb', 'claude'), 'added after indexing')
    expect((await getCatalogSnapshot()).installations).toHaveLength(1)
    expect(await readFile(join(directory, 'claude'), 'utf8')).toBe('not an executable; indexing must not probe it')
    expect(await readdir(root)).toContain('catalog.json')
  })

  it('bounds inventory without removing any user installation', async () => {
    const { rememberInstallation, getCatalogSnapshot } = await import('../../../src/main/services/cc-runtime/catalog')
    const file = join(globalThis.__HALO_TEST_DIR__, 'local-claude-0')
    await writeFile(file, 'owned by the user')
    for (let index = 0; index < 66; index++) await rememberInstallation(record(join(globalThis.__HALO_TEST_DIR__, `local-claude-${index}`), '2.1.310'))
    const result = await getCatalogSnapshot()
    expect(result.installations).toHaveLength(64)
    expect(result.truncated).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('owned by the user')
  })

  it('also bounds persisted bytes for unusually long installation paths', async () => {
    const { rememberInstallation, getCatalogSnapshot } = await import('../../../src/main/services/cc-runtime/catalog')
    const nested = 'nested/'.repeat(450)
    for (let index = 0; index < 50; index++) await rememberInstallation(record(join(globalThis.__HALO_TEST_DIR__, nested, `claude-${index}`), '2.1.310'))
    const result = await getCatalogSnapshot()
    expect(result.installations.length).toBeLessThan(50)
    expect(result.truncated).toBe(true)
    const text = await readFile(join(globalThis.__HALO_TEST_DIR__, '.halo', 'runtimes', 'claude-code', 'catalog.json'), 'utf8')
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(128 * 1024)
  })

  it('does not carry a different machine environment’s compatibility claim into this process', async () => {
    const root = join(globalThis.__HALO_TEST_DIR__, '.halo', 'runtimes', 'claude-code')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'catalog.json'), JSON.stringify({ version: 1, truncated: false, entries: [{
      installation: { ...record(join(root, 'claude'), '2.1.310', true), compatibility: 'verified' }, checkedEnvironment: 'another-platform'
    }] }))
    const { getCatalogSnapshot } = await import('../../../src/main/services/cc-runtime/catalog')
    expect((await getCatalogSnapshot()).installations[0].compatibility).toBe('unchecked')
  })

  it('keeps managed identity and checksum through failed checks, then clears the recovered issue', async () => {
    const { rememberInstallation, getCatalogEntry, mergeInstallationSnapshot } = await import('../../../src/main/services/cc-runtime/catalog')
    const path = join(globalThis.__HALO_TEST_DIR__, 'managed-claude')
    const original = { ...record(path, '2.1.310', true), sourceId: 'official', installedAt: '2026-10-25T00:00:00.000Z' }
    const integrity = { platform: 'darwin-arm64', checksum: 'a'.repeat(64) }
    await rememberInstallation(original, integrity)
    const failed: CcInstallation = { path, managed: false, compatibility: 'unavailable', recommended: false, issue: 'not-executable', checkedAt: new Date().toISOString() }
    await rememberInstallation(failed)
    const unavailable = await getCatalogEntry(path)
    expect(unavailable).toMatchObject({ installation: { managed: true, version: '2.1.310', kind: 'native', sourceId: 'official', installedAt: original.installedAt, issue: 'not-executable' }, integrity })
    const recovered = record(path, '2.1.310', true)
    expect(mergeInstallationSnapshot(unavailable!.installation, recovered).issue).toBeUndefined()
    await rememberInstallation(recovered)
    const healthy = await getCatalogEntry(path)
    expect(healthy?.installation.issue).toBeUndefined()
    expect(healthy?.integrity).toEqual(integrity)
    expect(healthy?.installation.managed).toBe(true)
  })
})
