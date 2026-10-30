import { randomUUID } from 'node:crypto'
import { mkdir, open, opendir, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { CcInstallation } from '../../../shared/types/cc-runtime'
import { getConfig } from '../../foundation/config.service'
import { CcRuntimeError } from './errors'
import { getRuntimeRoot } from './paths'
import { isRecommendedVersion, VERSION_PATTERN } from './policy'

const MAX_ENTRIES = 64
const MAX_CATALOG_BYTES = 128 * 1024

export interface CatalogIntegrity {
  platform: string
  sourceUrl?: string
  checksum?: string
  checksumPrefix?: string
}

export interface CatalogEntry {
  installation: CcInstallation
  integrity?: CatalogIntegrity
  checkedEnvironment?: string
}

interface Catalog {
  version: 1
  entries: CatalogEntry[]
  truncated: boolean
}

let loaded: { root: string; value: Promise<Catalog> } | undefined
let writeQueue: Promise<unknown> = Promise.resolve()

export function mergeInstallationSnapshot(previous: CcInstallation | undefined, current: CcInstallation): CcInstallation {
  const merged = { ...previous, ...current }
  if (previous) {
    merged.managed = previous.managed || current.managed
    merged.version = current.version ?? previous.version
    merged.kind = current.kind ?? previous.kind
    merged.resolvedPath = current.resolvedPath ?? previous.resolvedPath
  }
  if (['verified', 'compatible'].includes(current.compatibility)) delete merged.issue
  return merged
}

function boundedEntries(entries: CatalogEntry[], selectedPath?: string): CatalogEntry[] {
  const unique = [...new Map(entries.map(entry => [entry.installation.path, entry])).values()]
  const selected = unique.find(entry => entry.installation.path === selectedPath)
  const kept = unique.slice(0, MAX_ENTRIES)
  if (selected && !kept.includes(selected)) kept[kept.length - 1] = selected
  return kept
}

function validEntry(value: unknown): value is CatalogEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as CatalogEntry
  const item = entry.installation
  return Boolean(item && typeof item.path === 'string' && item.path.length <= 4096 && isAbsolute(item.path)
    && ['verified', 'compatible', 'incompatible', 'unavailable', 'unchecked'].includes(item.compatibility)
    && typeof item.managed === 'boolean' && typeof item.recommended === 'boolean'
    && (item.version === undefined || (typeof item.version === 'string' && item.version.length <= 80 && VERSION_PATTERN.test(item.version)))
    && (item.kind === undefined || ['native', 'javascript'].includes(item.kind))
    && (item.checkedAt === undefined || (typeof item.checkedAt === 'string' && item.checkedAt.length <= 80))
    && (item.resolvedPath === undefined || (typeof item.resolvedPath === 'string' && item.resolvedPath.length <= 4096))
    && (!entry.integrity || (typeof entry.integrity.platform === 'string'
      && (entry.integrity.sourceUrl === undefined || (typeof entry.integrity.sourceUrl === 'string' && entry.integrity.sourceUrl.length <= 2048))
      && (!entry.integrity.checksum || /^[a-f0-9]{64}$/i.test(entry.integrity.checksum))
      && (!entry.integrity.checksumPrefix || /^[a-f0-9]{16}$/i.test(entry.integrity.checksumPrefix)))))
}

async function persist(root: string, catalog: Catalog): Promise<void> {
  await mkdir(root, { recursive: true })
  const temporary = join(root, `.catalog-${randomUUID()}.tmp`)
  const contents = JSON.stringify(catalog)
  if (Buffer.byteLength(contents) > MAX_CATALOG_BYTES) throw new CcRuntimeError('storage-failed')
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(contents); await file.sync() } finally { await file.close() }
    await rename(temporary, join(root, 'catalog.json'))
  } catch (cause) {
    console.error('[CcRuntime] Installation catalog could not be saved', { code: (cause as NodeJS.ErrnoException).code })
    throw new CcRuntimeError('storage-failed', { cause })
  } finally {
    await rm(temporary, { force: true }).catch(error => console.warn('[CcRuntime] Catalog staging cleanup failed', { code: (error as NodeJS.ErrnoException).code }))
  }
}

async function indexExisting(root: string): Promise<Catalog> {
  const catalog: Catalog = { version: 1, entries: [], truncated: false }
  const selectedPath = getConfig().agent?.ccRuntime?.selectedPath
  if (selectedPath && isAbsolute(selectedPath)) catalog.entries.push({ installation: {
    path: selectedPath, compatibility: 'unchecked', managed: false, recommended: false
  } })
  let rootExists = false
  try {
    const directory = await opendir(root)
    rootExists = true
    let inspected = 0
    for await (const entry of directory) {
      if (++inspected > 512 || catalog.entries.length >= MAX_ENTRIES) { catalog.truncated = true; break }
      if (!entry.isDirectory()) continue
      const match = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(darwin|linux|win32)-(arm64|x64)(-musl)?-([a-f0-9]{16})(?:-[a-f0-9-]+)?$/i.exec(entry.name)
      if (!match) continue
      const [, version, os, arch, musl = '', checksumPrefix] = match
      const path = join(root, entry.name, os === 'win32' ? 'claude.exe' : 'claude')
      try {
        if (!(await stat(path)).isFile()) continue
        catalog.entries = catalog.entries.filter(item => item.installation.path !== path)
        catalog.entries.push({ installation: {
          path, version, kind: 'native', managed: true, compatibility: 'unchecked', recommended: isRecommendedVersion(version)
        }, integrity: { platform: `${os}-${arch}${musl}`, checksumPrefix: checksumPrefix.toLowerCase() } })
      } catch (error) {
        console.warn('[CcRuntime] Existing managed entry could not be indexed', { version, code: (error as NodeJS.ErrnoException).code })
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[CcRuntime] Existing runtime directory could not be indexed', { code: (error as NodeJS.ErrnoException).code })
      catalog.truncated = true
    }
  }
  if (rootExists || catalog.entries.length) {
    await persist(root, catalog)
    console.log('[CcRuntime] Installation catalog initialized', { entries: catalog.entries.length, truncated: catalog.truncated })
  }
  return catalog
}

async function readCatalog(root: string): Promise<Catalog> {
  try {
    const path = join(root, 'catalog.json')
    const file = await open(path, 'r')
    let text: string
    try {
      const buffer = Buffer.alloc(MAX_CATALOG_BYTES + 1)
      let bytes = 0
      while (bytes < buffer.length) {
        const next = await file.read(buffer, bytes, buffer.length - bytes, bytes)
        if (!next.bytesRead) break
        bytes += next.bytesRead
      }
      if (bytes > MAX_CATALOG_BYTES) throw new Error('catalog-size-limit')
      text = buffer.subarray(0, bytes).toString('utf8')
    } finally { await file.close() }
    const parsed = JSON.parse(text) as Catalog
    if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_ENTRIES || !parsed.entries.every(validEntry)) throw new Error('invalid-catalog')
    for (const entry of parsed.entries) {
      if (entry.checkedEnvironment !== `${process.platform}-${process.arch}` && ['verified', 'compatible'].includes(entry.installation.compatibility)) {
        entry.installation = { ...entry.installation, compatibility: 'unchecked' }
      }
    }
    return { version: 1, entries: parsed.entries, truncated: Boolean(parsed.truncated) }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return indexExisting(root)
    console.error('[CcRuntime] Installation catalog could not be read', { code: (cause as NodeJS.ErrnoException).code || 'invalid-catalog' })
    throw new CcRuntimeError('storage-failed', { cause })
  }
}

function catalogForRoot(): Promise<Catalog> {
  const root = getRuntimeRoot()
  if (!loaded || loaded.root !== root) {
    const value = readCatalog(root).catch(error => {
      if (loaded?.value === value) loaded = undefined
      throw error
    })
    loaded = { root, value }
  }
  return loaded.value
}

export async function getCatalogSnapshot(): Promise<{ installations: CcInstallation[]; truncated: boolean }> {
  const catalog = await catalogForRoot()
  return { installations: catalog.entries.map(entry => ({ ...entry.installation })), truncated: catalog.truncated }
}

export async function getManagedCatalogEntries(version: string, platform: string): Promise<CatalogEntry[]> {
  const catalog = await catalogForRoot()
  return catalog.entries.filter(entry => entry.installation.managed && entry.installation.version === version && entry.integrity?.platform === platform)
    .map(entry => ({ installation: { ...entry.installation }, integrity: { ...entry.integrity! } }))
}

export async function getCatalogEntry(path: string): Promise<CatalogEntry | undefined> {
  const entry = (await catalogForRoot()).entries.find(item => item.installation.path === path)
  return entry ? { installation: { ...entry.installation }, ...(entry.integrity ? { integrity: { ...entry.integrity } } : {}) } : undefined
}

export async function rememberInstallation(installation: CcInstallation, integrity?: CatalogIntegrity): Promise<void> {
  const root = getRuntimeRoot()
  const operation = writeQueue.catch(() => {}).then(async () => {
    const catalog = await catalogForRoot()
    const previous = catalog.entries.find(entry => entry.installation.path === installation.path)
    const entry: CatalogEntry = {
      installation: mergeInstallationSnapshot(previous?.installation, installation),
      integrity: integrity ?? previous?.integrity,
      ...(installation.checkedAt ? { checkedEnvironment: `${process.platform}-${process.arch}` } : {})
    }
    if (catalog.entries[0] === previous && JSON.stringify(previous) === JSON.stringify(entry)) return
    const entries = [entry, ...catalog.entries.filter(item => item.installation.path !== installation.path)]
    const selectedPath = getConfig().agent?.ccRuntime?.selectedPath
    const next: Catalog = { version: 1, entries: boundedEntries(entries, selectedPath), truncated: catalog.truncated || entries.length > MAX_ENTRIES }
    while (Buffer.byteLength(JSON.stringify(next)) > MAX_CATALOG_BYTES) {
      let removable = next.entries.length - 1
      while (removable > 0 && next.entries[removable].installation.path === selectedPath) removable--
      if (removable <= 0) throw new CcRuntimeError('storage-failed')
      next.entries.splice(removable, 1)
      next.truncated = true
    }
    await persist(root, next)
    catalog.entries = next.entries
    catalog.truncated = next.truncated
  })
  writeQueue = operation
  return operation
}
