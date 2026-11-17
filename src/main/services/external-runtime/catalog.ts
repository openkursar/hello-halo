import { randomUUID } from 'node:crypto'
import { mkdir, open, opendir, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { RuntimeConfig, RuntimeInstallation } from '../../../shared/types/external-runtime'
import { RuntimeError } from './errors'
import type { RuntimeComponent, RuntimeProvider } from './provider'

const MAX_ENTRIES = 64
const MAX_CATALOG_BYTES = 128 * 1024

export interface CatalogIntegrity {
  platform: string
  sourceUrl?: string
  checksum?: string
  checksumPrefix?: string
  artifactIntegrity?: string
  directory?: string
  components?: RuntimeComponent[]
}
export interface CatalogEntry {
  installation: RuntimeInstallation
  integrity?: CatalogIntegrity
  checkedEnvironment?: string
}
interface Catalog { version: 1; entries: CatalogEntry[]; truncated: boolean }

export function mergeInstallationSnapshot(previous: RuntimeInstallation | undefined, current: RuntimeInstallation): RuntimeInstallation {
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

export function validComponentPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !isAbsolute(path) && !/[\\:]/.test(path)
    && path.split('/').every(part => part !== '..' && part !== '.' && part !== '')
}

function validArtifactIntegrity(value: string): boolean {
  const match = /^(sha256|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match) return false
  const digest = Buffer.from(match[2], 'base64')
  return digest.length === (match[1] === 'sha512' ? 64 : 32) && digest.toString('base64') === match[2]
}

function validEntry(value: unknown): value is CatalogEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as CatalogEntry
  const item = entry.installation
  const integrity = entry.integrity
  return Boolean(item && typeof item.path === 'string' && item.path.length <= 4096 && isAbsolute(item.path)
    && ['verified', 'compatible', 'incompatible', 'unavailable', 'unchecked'].includes(item.compatibility)
    && typeof item.managed === 'boolean' && typeof item.recommended === 'boolean'
    && (item.version === undefined || (typeof item.version === 'string' && item.version.length <= 80 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item.version)))
    && (item.kind === undefined || ['native', 'javascript'].includes(item.kind))
    && (item.checkedAt === undefined || (typeof item.checkedAt === 'string' && item.checkedAt.length <= 80))
    && (item.resolvedPath === undefined || (typeof item.resolvedPath === 'string' && item.resolvedPath.length <= 4096))
    && (!integrity || (typeof integrity.platform === 'string'
      && (integrity.sourceUrl === undefined || (typeof integrity.sourceUrl === 'string' && integrity.sourceUrl.length <= 2048))
      && (integrity.checksum === undefined || /^[a-f0-9]{64}$/i.test(integrity.checksum))
      && (integrity.checksumPrefix === undefined || /^[a-f0-9]{16}$/i.test(integrity.checksumPrefix))
      && (integrity.artifactIntegrity === undefined || (typeof integrity.artifactIntegrity === 'string' && validArtifactIntegrity(integrity.artifactIntegrity)))
      && (integrity.directory === undefined || (typeof integrity.directory === 'string' && isAbsolute(integrity.directory) && integrity.directory.length <= 4096))
      && (integrity.components === undefined || (Array.isArray(integrity.components) && integrity.components.length > 0 && integrity.components.length <= 128
        && integrity.components.every(component => typeof component.path === 'string' && validComponentPath(component.path)
          && /^[a-f0-9]{64}$/i.test(component.checksum) && Number.isSafeInteger(component.size) && component.size >= 0)
        && new Set(integrity.components.map(component => component.path.toLowerCase())).size === integrity.components.length)))))
}

export function hasRequiredIntegrity(provider: RuntimeProvider, entry: CatalogEntry): boolean {
  if (!entry.installation.managed) return true
  const platform = entry.integrity?.platform
  if (!platform) return !provider.requiredComponents
  if (provider.requiredComponents && (!entry.installation.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.installation.version))) return false
  let required: string[] | undefined
  let pin: string | undefined
  try {
    required = provider.requiredComponents?.(platform)
    pin = entry.installation.version ? provider.pinnedIntegrity?.(entry.installation.version, platform) : undefined
  } catch { return false }
  if (pin && entry.integrity?.artifactIntegrity !== pin) return false
  if (!required?.length) return !provider.requiredComponents
  const integrity = entry.integrity!
  return Boolean(integrity.artifactIntegrity && integrity.directory && integrity.components
    && required.every(path => validComponentPath(path) && integrity.components!.some(component => component.path === path))
    && resolve(entry.installation.path) === resolve(integrity.directory, required[0]))
}

function cloneEntry(entry: CatalogEntry): CatalogEntry {
  return { ...entry, installation: { ...entry.installation }, ...(entry.integrity ? { integrity: {
    ...entry.integrity, ...(entry.integrity.components ? { components: entry.integrity.components.map(component => ({ ...component })) } : {})
  } } : {}) }
}

export function createRuntimeCatalog(provider: RuntimeProvider, readConfig: () => RuntimeConfig, root: () => string) {
  let loaded: { root: string; value: Promise<Catalog> } | undefined
  let writeQueue: Promise<unknown> = Promise.resolve()

  function normalizeEntry(entry: CatalogEntry): CatalogEntry {
    return hasRequiredIntegrity(provider, entry) ? entry : {
      ...entry, installation: { ...entry.installation, compatibility: 'unavailable', issue: 'checksum-mismatch' }
    }
  }

  async function persist(directory: string, catalog: Catalog): Promise<void> {
    await mkdir(directory, { recursive: true })
    const temporary = join(directory, `.catalog-${randomUUID()}.tmp`)
    const contents = JSON.stringify(catalog)
    if (Buffer.byteLength(contents) > MAX_CATALOG_BYTES) throw new RuntimeError('storage-failed')
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(contents); await file.sync() } finally { await file.close() }
      const destination = join(directory, 'catalog.json')
      await rename(temporary, destination)
      const saved = await open(destination, 'r')
      try {
        const buffer = Buffer.alloc(MAX_CATALOG_BYTES + 1)
        let bytes = 0
        while (bytes < buffer.length) {
          const next = await saved.read(buffer, bytes, buffer.length - bytes, bytes)
          if (!next.bytesRead) break
          bytes += next.bytesRead
        }
        if (bytes > MAX_CATALOG_BYTES) throw new Error('catalog-readback-size-limit')
        const parsed = JSON.parse(buffer.subarray(0, bytes).toString('utf8')) as Catalog
        if (JSON.stringify(parsed) !== contents) throw new Error('catalog-readback-mismatch')
      } finally { await saved.close() }
    } catch (cause) {
      console.error('[ExternalRuntime] Installation catalog could not be saved', { runtime: provider.id, code: (cause as NodeJS.ErrnoException).code })
      throw new RuntimeError('storage-failed', { cause })
    } finally {
      await rm(temporary, { force: true }).catch(error => console.warn('[ExternalRuntime] Catalog staging cleanup failed', { runtime: provider.id, code: (error as NodeJS.ErrnoException).code }))
    }
  }

  async function indexExisting(directory: string): Promise<Catalog> {
    const catalog: Catalog = { version: 1, entries: [], truncated: false }
    const selectedPath = readConfig().selectedPath
    if (selectedPath && isAbsolute(selectedPath)) catalog.entries.push({ installation: {
      path: selectedPath, compatibility: 'unchecked', managed: false, recommended: false
    } })
    let rootExists = false
    try {
      const handle = await opendir(directory)
      rootExists = true
      let inspected = 0
      for await (const entry of handle) {
        if (++inspected > 512 || catalog.entries.length >= MAX_ENTRIES) { catalog.truncated = true; break }
        if (!entry.isDirectory() || !provider.indexManagedDirectory) continue
        try {
          const indexed = await provider.indexManagedDirectory(entry.name, directory)
          if (!indexed) continue
          if (!validEntry(indexed)) throw new Error('invalid-managed-entry')
          catalog.entries = catalog.entries.filter(item => item.installation.path !== indexed.installation.path)
          catalog.entries.push(indexed)
        } catch (error) {
          console.warn('[ExternalRuntime] Existing managed entry could not be indexed', { runtime: provider.id, code: (error as NodeJS.ErrnoException).code })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[ExternalRuntime] Existing runtime directory could not be indexed', { runtime: provider.id, code: (error as NodeJS.ErrnoException).code })
        catalog.truncated = true
      }
    }
    if (rootExists || catalog.entries.length) {
      await persist(directory, catalog)
      console.log('[ExternalRuntime] Installation catalog initialized', { runtime: provider.id, entries: catalog.entries.length, truncated: catalog.truncated })
    }
    return catalog
  }

  async function readCatalog(directory: string): Promise<Catalog> {
    try {
      const file = await open(join(directory, 'catalog.json'), 'r')
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
        if (!hasRequiredIntegrity(provider, entry)) {
          entry.installation = normalizeEntry(entry).installation
          console.warn('[ExternalRuntime] Managed catalog integrity is incomplete or conflicts with the release pin', { runtime: provider.id, version: entry.installation.version })
        }
        if (entry.checkedEnvironment !== `${process.platform}-${process.arch}` && ['verified', 'compatible'].includes(entry.installation.compatibility)) {
          entry.installation = { ...entry.installation, compatibility: 'unchecked' }
        }
      }
      return { version: 1, entries: parsed.entries, truncated: Boolean(parsed.truncated) }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return indexExisting(directory)
      console.error('[ExternalRuntime] Installation catalog could not be read', { runtime: provider.id, code: (cause as NodeJS.ErrnoException).code || 'invalid-catalog' })
      throw new RuntimeError('storage-failed', { cause })
    }
  }

  function catalogForRoot(directory = root()): Promise<Catalog> {
    if (!loaded || loaded.root !== directory) {
      const value = readCatalog(directory).catch(error => {
        if (loaded?.value === value) loaded = undefined
        throw error
      })
      loaded = { root: directory, value }
    }
    return loaded.value
  }

  async function getCatalogSnapshot(): Promise<{ installations: RuntimeInstallation[]; truncated: boolean }> {
    const catalog = await catalogForRoot()
    return { installations: catalog.entries.map(entry => ({ ...normalizeEntry(entry).installation })), truncated: catalog.truncated }
  }
  async function getManagedCatalogEntries(version: string, platform: string): Promise<CatalogEntry[]> {
    return (await catalogForRoot()).entries.filter(entry => entry.installation.managed && entry.installation.version === version && entry.integrity?.platform === platform).map(cloneEntry)
  }
  async function getCatalogEntry(path: string): Promise<CatalogEntry | undefined> {
    const entry = (await catalogForRoot()).entries.find(item => item.installation.path === path)
    return entry ? cloneEntry(normalizeEntry(entry)) : undefined
  }
  async function rememberInstallation(installation: RuntimeInstallation, integrity?: CatalogIntegrity): Promise<void> {
    const directory = root()
    const operation = writeQueue.catch(() => {}).then(async () => {
      const catalog = await catalogForRoot(directory)
      const previous = catalog.entries.find(entry => entry.installation.path === installation.path)
      const entry = normalizeEntry({
        installation: mergeInstallationSnapshot(previous?.installation, installation),
        integrity: integrity ?? previous?.integrity,
        ...(installation.checkedAt ? { checkedEnvironment: `${process.platform}-${process.arch}` } : previous?.checkedEnvironment ? { checkedEnvironment: previous.checkedEnvironment } : {})
      })
      if (!validEntry(entry)) throw new RuntimeError('storage-failed')
      if (catalog.entries[0] === previous && JSON.stringify(previous) === JSON.stringify(entry)) return
      const entries = [entry, ...catalog.entries.filter(item => item.installation.path !== installation.path)]
      const selectedPath = readConfig().selectedPath
      const kept = entries.slice(0, MAX_ENTRIES)
      const selected = entries.find(item => item.installation.path === selectedPath)
      if (selected && !kept.includes(selected)) kept[kept.length - 1] = selected
      const next: Catalog = { version: 1, entries: kept, truncated: catalog.truncated || entries.length > MAX_ENTRIES }
      while (Buffer.byteLength(JSON.stringify(next)) > MAX_CATALOG_BYTES) {
        let removable = next.entries.length - 1
        while (removable > 0 && next.entries[removable].installation.path === selectedPath) removable--
        if (removable <= 0) throw new RuntimeError('storage-failed')
        next.entries.splice(removable, 1)
        next.truncated = true
      }
      await persist(directory, next)
      catalog.entries = next.entries
      catalog.truncated = next.truncated
    })
    writeQueue = operation
    return operation
  }
  return { getCatalogSnapshot, getManagedCatalogEntries, getCatalogEntry, rememberInstallation }
}
export type RuntimeCatalog = ReturnType<typeof createRuntimeCatalog>
