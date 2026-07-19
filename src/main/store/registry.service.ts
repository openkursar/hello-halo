/**
 * Registry Service
 *
 * Core service for browsing, querying, and installing apps from remote registries.
 *
 * Architecture (post-refactor):
 *   - SyncService:  Background sync for Mirror sources → SQLite
 *   - QueryService: Unified query entry (Mirror → FTS5, Proxy → adapter.query)
 *   - This file:    Config management, registry CRUD, install/update orchestration
 *
 * Design principles:
 *   - Sync & query are fully separated — user queries never block on network
 *   - SQLite is a transparent cache — can be dropped and rebuilt at any time
 *   - Type Tab routing avoids cross-source merge complexity
 */

import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import { getConfig, saveConfig as saveHaloConfig } from '../foundation/config.service'
import { getAppManager } from '../apps/manager'
import { AppAlreadyInstalledError } from '../apps/manager/errors'
import { getAppRuntime } from '../apps/runtime'
import type { AppSpec, SkillSpec } from '../apps/spec/schema'
import type {
  RegistryEntry,
  RegistrySource,
  StoreQuery,
  StoreAppDetail,
  StoreQueryParams,
  StoreQueryResponse,
  UpdateInfo,
  UpdateSeverity,
  UpgradeAvailableEvent,
  UpgradeStrategy,
} from '../../shared/store/store-types'
import type { RegistryServiceConfig } from './registry.types'
import type { DatabaseManager } from '../platform/store/types'
import { SyncService } from './sync.service'
import { QueryService } from './query.service'
import { STORE_CACHE_NAMESPACE, storeCacheMigrations } from './store-cache.schema'
import { getAdapter } from './adapters'
import { loadProductConfig } from '../foundation/product-config'

// ============================================
// Constants
// ============================================

/** Built-in registry sources (always present, user can toggle but not delete) */
const BUILTIN_REGISTRIES: RegistrySource[] = [
  {
    id: 'official',
    name: 'Digital Human Protocol',
    url: 'https://openkursar.github.io/digital-human-protocol',
    enabled: true,
    isDefault: true,
    sourceType: 'halo',
  },
  {
    id: 'mcp-official',
    name: 'MCP Official Registry',
    url: 'https://registry.modelcontextprotocol.io',
    enabled: true,
    sourceType: 'mcp-registry',
  },
  {
    id: 'smithery',
    name: 'Smithery',
    url: 'https://registry.smithery.ai',
    enabled: true,
    sourceType: 'smithery',
    adapterConfig: { apiKey: '' },
  },
  {
    id: 'claude-skills',
    name: 'Claude Skills Registry',
    url: 'https://majiayu000.github.io/claude-skill-registry-core',
    enabled: true,
    sourceType: 'claude-skills',
  },
  {
    id: 'skillhub',
    name: 'SkillHub (33k+ Skills)',
    url: 'https://api.skillhub.cn',
    enabled: true,
    sourceType: 'skillhub',
  },
]

/** The primary default registry (first in BUILTIN_REGISTRIES) */
const DEFAULT_REGISTRY = BUILTIN_REGISTRIES[0]

/** Default cache TTL: 1 hour */
const DEFAULT_CACHE_TTL_MS = 3600000

/** Per-registry timeout for getIndex: prevents one slow registry from blocking all data */
const REGISTRY_LOAD_TIMEOUT_MS = 15000

/** Config key used in HaloConfig for store settings */
const CONFIG_KEY = 'appStore'

// ============================================
// Runtime Validation Schemas (main-process only)
// ============================================

const RegistrySourceSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().trim().min(1),
  url: z.string().url(),
  enabled: z.boolean(),
  isDefault: z.boolean().optional(),
  sourceType: z.enum(['halo', 'mcp-registry', 'smithery', 'claude-skills', 'skillhub']).optional(),
  adapterConfig: z.record(z.string(), z.unknown()).optional(),
})

// ============================================
// Module State (singleton pattern)
// ============================================

let initialized = false
let config: RegistryServiceConfig = {
  registries: [DEFAULT_REGISTRY],
  cacheTtlMs: DEFAULT_CACHE_TTL_MS,
  autoCheckUpdates: true,
}

/** SyncService instance (created during init) */
let syncService: SyncService | null = null

/** QueryService instance (created during init) */
let queryService: QueryService | null = null

/** Listener for sync status changes (set by IPC layer) */
let syncStatusListener: ((event: { registryId: string; status: string; appCount: number; error?: string }) => void) | null = null

/** Listener for upgrade-available events (set by IPC layer) */
let upgradeAvailableListener: ((event: UpgradeAvailableEvent) => void) | null = null

/**
 * Register a listener for upgrade-available events.
 * Called by the IPC layer to push events to the renderer.
 */
export function onUpgradeAvailable(listener: typeof upgradeAvailableListener): void {
  upgradeAvailableListener = listener
}

/** Internal emitter used by upgrade.service.ts and applyUpgrade dispatch logic. */
export function emitUpgradeAvailable(event: UpgradeAvailableEvent): void {
  upgradeAvailableListener?.(event)
}

// ============================================
// Initialization / Shutdown
// ============================================

/**
 * Initialize the Registry Service.
 *
 * Loads config, runs SQLite migrations, creates SyncService + QueryService,
 * and triggers an initial background sync for Mirror sources.
 *
 * @param opts.db - DatabaseManager from platform/store (required for SQLite)
 * @param opts.overrides - Optional partial config for testing
 */
export function initRegistryService(opts?: { db?: DatabaseManager; overrides?: Partial<RegistryServiceConfig> }): void {
  if (initialized) {
    console.log('[RegistryService] Already initialized, skipping')
    return
  }

  const start = performance.now()
  console.log('[RegistryService] Initializing...')

  // Load persisted config
  const persisted = loadConfig()
  config = {
    ...persisted,
    ...opts?.overrides,
    registries: normalizeRegistries(opts?.overrides?.registries ?? persisted.registries),
    cacheTtlMs: normalizeCacheTtl(opts?.overrides?.cacheTtlMs ?? persisted.cacheTtlMs),
  }

  const { changed: defaultChanged, purgeRegistryIds } = ensureBuiltinRegistries()
  if (defaultChanged) {
    saveConfigToFile()
  }

  // Initialize SQLite cache layer (if DatabaseManager provided)
  if (opts?.db) {
    const appDb = opts.db.getAppDatabase()
    opts.db.runMigrations(appDb, STORE_CACHE_NAMESPACE, storeCacheMigrations)

    syncService = new SyncService(opts.db)
    queryService = new QueryService(opts.db)

    // Purge stale data for registries that were hidden or had their URL changed.
    // This runs after syncService creation to avoid the timing issue where
    // ensureBuiltinRegistries() executes before syncService exists.
    for (const id of purgeRegistryIds) {
      syncService.clearRegistryData(id)
    }

    // Wire sync status listener
    syncService.onSyncStatusChanged((event) => {
      syncStatusListener?.(event)
    })

    // Trigger initial background sync (non-blocking)
    syncService.syncAll(config.registries, config.cacheTtlMs).catch(err => {
      console.error('[RegistryService] Initial sync failed:', err)
    })
  }

  initialized = true

  const duration = performance.now() - start
  console.log(`[RegistryService] Initialized in ${duration.toFixed(1)}ms (${config.registries.length} registries)`)
}

/**
 * Register a listener for sync status changes.
 * Called by the IPC layer to push events to the renderer.
 */
export function onSyncStatusChanged(listener: typeof syncStatusListener): void {
  syncStatusListener = listener
}

/**
 * Shutdown the Registry Service.
 *
 * Persists current configuration and clears references.
 */
export function shutdownRegistryService(): void {
  if (!initialized) return

  saveConfigToFile()
  syncService = null
  queryService = null
  syncStatusListener = null
  initialized = false

  console.log('[RegistryService] Shutdown complete')
}

// ============================================
// Sync & Query
// ============================================

/**
 * Refresh store data.
 *
 * Mirror sources: triggers SyncService re-sync.
 * Proxy sources: clears query cache so next query fetches fresh data.
 *
 * @param force - If true, clears all caches and re-syncs from scratch.
 */
export async function refreshIndex(force = false): Promise<void> {
  ensureInitialized()

  if (!syncService) {
    console.warn('[RegistryService] refreshIndex: no SyncService (db not provided)')
    return
  }

  const t0 = performance.now()
  console.log(`[RegistryService] refreshIndex: ${force ? 'force' : 'normal'} refresh`)

  if (force) {
    await syncService.forceSyncAll(config.registries)
  } else {
    await syncService.syncAll(config.registries, 0) // TTL=0 forces re-check
  }

  const dt = performance.now() - t0
  console.log(`[RegistryService] refreshIndex: completed in ${dt.toFixed(0)}ms`)
}

/**
 * Paginated query — the new primary query entry point.
 *
 * Routes by type tab:
 *   - type set   → Mirror (SQLite) + Proxy (adapter) merged
 *   - type unset → All tab preview (grouped by type)
 */
export async function queryStore(params: StoreQueryParams): Promise<StoreQueryResponse> {
  ensureInitialized()

  if (!queryService) {
    return { items: [], hasMore: false, sources: [] }
  }

  const result = await queryService.query(params, config.registries)

  // If any mirror source has error/never-synced state, trigger background re-sync
  if (syncService) {
    retryFailedMirrorSources()
  }

  return result
}

// ============================================
// Querying (legacy compat)
// ============================================

/**
 * List apps with optional filtering (legacy API, kept for backward compat).
 *
 * Internally delegates to queryStore with page=1, pageSize=10000.
 * New code should use queryStore() directly.
 */
export async function listApps(query?: StoreQuery): Promise<RegistryEntry[]> {
  const result = await queryStore({
    search: query?.search,
    locale: query?.locale,
    category: query?.category,
    type: query?.type,
    page: 1,
    pageSize: 10000,
  })
  return result.items
}

/**
 * Lightweight entry lookup by slug from the synced index — no spec fetch,
 * no network. Returns null when the slug is unknown (e.g. first publish)
 * or when the query layer is unavailable.
 */
export function findStoreEntry(slug: string): { entry: RegistryEntry; registryId: string } | null {
  ensureInitialized()
  if (!queryService) return null
  return queryService.findEntry(slug) ?? null
}

/**
 * Get detailed information about a store app by slug.
 *
 * Looks up the entry in SQLite (Mirror) first, then falls back to
 * Proxy query caches. Fetches the full spec with SQLite caching.
 *
 * @param slug - The app slug to look up
 * @returns Detailed app information including full spec
 * @throws Error if the slug is not found in any registry
 */
export async function getAppDetail(slug: string): Promise<StoreAppDetail> {
  ensureInitialized()

  if (!queryService) {
    throw new Error('QueryService not available (db not provided)')
  }

  // Look up entry in SQLite
  const found = queryService.findEntry(slug)
  if (!found) {
    throw new Error(`App not found in store: ${slug}`)
  }

  const { entry, registryId } = found

  // For claude-skills and skillhub sources, skip remote fetching at browse time.
  // The detail view only needs entry data (name, description, tags, etc.) which is
  // already available from the registry index — no network call needed.
  // The full spec (with skill_files) is fetched at install time by installFromStore().
  const registry = config.registries.find(r => r.id === registryId)
  if (registry?.sourceType === 'claude-skills' || registry?.sourceType === 'skillhub') {
    return { entry, spec: buildPreviewSpec(entry, registryId), registryId }
  }

  // All other sources: fetch full spec (with SQLite spec cache)
  const spec = await queryService.fetchSpec(entry, registryId, config.registries)
  const specWithStore = withInstallStoreMetadata(spec, entry.slug, registryId)

  return { entry, spec: specWithStore, registryId }
}

// ============================================
// Detail Document (SKILL.md / README)
// ============================================

/** In-memory document cache: detail pages re-entered in one session never refetch. */
const documentCache = new Map<string, string | null>()
const DOCUMENT_CACHE_MAX = 50

/** Cap stored document size — protects memory and IPC payloads from pathological files. */
const DOCUMENT_MAX_BYTES = 1_000_000

/**
 * Fetch the display document (SKILL.md) for a store entry.
 *
 * Returns null when the source has no document for this entry — callers
 * hide the docs section. Misses (null) are cached too, so entries without
 * docs don't trigger a network probe on every detail visit.
 */
export async function getAppDocument(slug: string): Promise<{ content: string | null }> {
  ensureInitialized()

  if (!queryService) {
    throw new Error('QueryService not available (db not provided)')
  }

  const found = queryService.findEntry(slug)
  if (!found) {
    throw new Error(`App not found in store: ${slug}`)
  }

  const { entry, registryId } = found
  const cacheKey = `${registryId}:${slug}@${entry.version}`

  if (documentCache.has(cacheKey)) {
    return { content: documentCache.get(cacheKey) ?? null }
  }

  const registry = config.registries.find(r => r.id === registryId)
  if (!registry) {
    throw new Error(`Registry not found: ${registryId}`)
  }

  const adapter = getAdapter(registry)
  let content: string | null = null
  if (adapter.fetchDocument) {
    const t0 = performance.now()
    content = await adapter.fetchDocument(registry, entry)
    if (content && content.length > DOCUMENT_MAX_BYTES) {
      content = content.slice(0, DOCUMENT_MAX_BYTES)
    }
    console.log(
      `[RegistryService] getAppDocument: ${slug} -> ${content ? `${content.length} chars` : 'none'} ` +
      `(${(performance.now() - t0).toFixed(0)}ms)`
    )
  }

  // FIFO eviction keeps the cache bounded; entries are tiny relative to specs
  if (documentCache.size >= DOCUMENT_CACHE_MAX) {
    const oldest = documentCache.keys().next().value
    if (oldest !== undefined) documentCache.delete(oldest)
  }
  documentCache.set(cacheKey, content)

  return { content }
}

// ============================================
// Installation
// ============================================

/**
 * Install an app from the store into a specific space.
 *
 * Uses QueryService to find the entry and fetch the spec,
 * then delegates to the App Manager for installation.
 *
 * @param slug - The app slug to install
 * @param spaceId - The target space ID
 * @param userConfig - Optional user configuration values
 * @returns The installed app ID
 */
export async function installFromStore(
  slug: string,
  spaceId: string | null,
  userConfig?: Record<string, unknown>,
  onProgress?: (filesComplete: number, filesTotal: number, currentFile: string) => void,
): Promise<string> {
  ensureInitialized()

  if (!queryService) {
    throw new Error('QueryService not available (db not provided)')
  }

  // Find the entry
  const found = queryService.findEntry(slug)
  if (!found) {
    throw new Error(`App not found in store: ${slug}`)
  }

  const { entry, registryId } = found

  if (!isBundleFormat(entry)) {
    throw new Error(
      `This app uses legacy package format "${String(entry.format)}". Bundle packages are required in this build.`
    )
  }

  // Fetch the full spec — bypass spec cache on install to ensure fresh content
  // (cached specs may be missing skill_files if the initial fetch failed)
  const registry = config.registries.find(r => r.id === registryId)
  if (!registry) {
    throw new Error(`Registry not found: ${registryId}`)
  }
  const adapter = getAdapter(registry)
  const spec = await adapter.fetchSpec(registry, entry, onProgress)
  const specWithStore = withInstallStoreMetadata(spec, entry.slug, registryId)

  // Delegate to App Manager
  const manager = getAppManager()
  if (!manager) {
    throw new Error('App Manager is not yet initialized')
  }

  const appId = await manager.install(spaceId, specWithStore, userConfig)

  // Auto-activate in runtime if available
  const runtime = getAppRuntime()
  if (runtime) {
    try {
      await runtime.activate(appId)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.warn(`[RegistryService] installFromStore: runtime activate failed (non-fatal): ${errMsg}`)
    }
  }

  // Install declared skill dependencies. Any failure rolls back the app we
  // just installed — shipping an app without its skills is a broken install
  // that previously surfaced only at runtime (skip for skill-type: no recursion).
  if (specWithStore.type !== 'skill') {
    try {
      let bundledSkillSpecs: Map<string, SkillSpec> | undefined
      if (typeof adapter.fetchBundledSkills === 'function') {
        const bundledDeps = (specWithStore.requires?.skills ?? [])
          .filter((dep): dep is { id: string; bundled: true; files?: string[] } => typeof dep !== 'string' && dep.bundled === true)
          .map(dep => ({ id: dep.id, files: dep.files }))

        if (bundledDeps.length > 0) {
          bundledSkillSpecs = await adapter.fetchBundledSkills(registry, entry, bundledDeps)
        }
      }

      await installRequiredSkills(specWithStore, spaceId, bundledSkillSpecs)
    } catch (err) {
      // deleteApp() only accepts 'uninstalled' apps, and the app may already
      // be runtime-active — deactivate and soft-delete before hard-deleting.
      try {
        if (runtime) {
          try {
            await runtime.deactivate(appId)
          } catch { /* activation above may have failed — proceed with deletion */ }
        }
        await manager.uninstall(appId)
        await manager.deleteApp(appId)
      } catch (rollbackErr) {
        console.error(
          `[RegistryService] Rollback of "${slug}" (${appId}) failed after dependency error: ${(rollbackErr as Error).message}`
        )
      }
      throw new Error(`Installation of "${entry.name}" failed: ${(err as Error).message}`)
    }
  }

  console.log(`[RegistryService] Installed "${entry.name}" (${slug}) as ${appId} in space ${spaceId}`)
  return appId
}

// ============================================
// Required Skills Auto-Install
// ============================================

/**
 * Auto-install skills declared in `spec.requires.skills`.
 *
 * Called after the parent app is persisted and activated.
 *
 * Two install paths depending on the `bundled` flag:
 *   - bundled: true  → install directly from the pre-fetched SkillSpec (no store lookup).
 *                      The spec was fetched by the adapter from the package's `skills/` dir.
 *   - bundled: false → install via `installFromStore()`, reusing the full store chain.
 *
 * Design decisions:
 *   - Sequential install: avoids DB contention and keeps logs readable.
 *   - Already-installed skills are skipped/re-synced, never an error. Any other
 *     failure is collected and thrown at the end — an app without its declared
 *     skills is broken at runtime, so partial installs must surface to the UI
 *     (callers roll back the parent app).
 *   - No recursion: `installFromStore()` guards with `type !== 'skill'`, so skills
 *     that themselves declare `requires.skills` won't trigger another round.
 */
export async function installRequiredSkills(
  spec: AppSpec,
  spaceId: string | null,
  bundledSkillSpecs?: Map<string, SkillSpec>,
): Promise<void> {
  const skills = spec.requires?.skills
  if (!skills || skills.length === 0) return

  const manager = getAppManager()
  const failures: string[] = []

  for (const dep of skills) {
    const skillId = typeof dep === 'string' ? dep : dep.id
    const isBundled = typeof dep !== 'string' && dep.bundled === true

    if (isBundled) {
      // Bundled skill: must come from the pre-fetched spec — never fall back to store
      const bundledSpec = bundledSkillSpecs?.get(skillId)
      if (!bundledSpec) {
        failures.push(`bundled skill "${skillId}" has no fetched content`)
        continue
      }
      if (!manager) {
        failures.push(`App Manager not available for bundled skill "${skillId}"`)
        continue
      }
      try {
        await manager.install(spaceId, bundledSpec, {})
        console.log(`[RegistryService] Installed bundled skill "${skillId}" for "${spec.name}"`)
      } catch (err) {
        if (err instanceof AppAlreadyInstalledError) {
          // Stale/orphaned record from a previous install — find it and re-sync
          try {
            const existing = manager.listApps({ spaceId, type: 'skill' })
              .find(a => a.specId === skillId)

            if (existing) {
              // Update spec with fresh bundled content (also re-syncs files to disk)
              manager.updateSpec(existing.id, bundledSpec as unknown as Record<string, unknown>)

              if (existing.status === 'uninstalled') {
                manager.reinstall(existing.id)
                console.log(`[RegistryService] Reinstalled stale bundled skill "${skillId}" for "${spec.name}"`)
              } else {
                console.log(`[RegistryService] Re-synced bundled skill "${skillId}" for "${spec.name}"`)
              }
            } else {
              console.warn(`[RegistryService] Bundled skill "${skillId}" reported as installed but not found in DB`)
            }
          } catch (syncErr) {
            console.warn(
              `[RegistryService] Failed to re-sync bundled skill "${skillId}": ${(syncErr as Error).message}`
            )
          }
          continue
        }
        failures.push(`bundled skill "${skillId}": ${(err as Error).message}`)
      }
      continue
    }

    // Non-bundled skill: install from store by slug
    try {
      await installFromStore(skillId, spaceId)
      console.log(`[RegistryService] Auto-installed required skill "${skillId}" for "${spec.name}"`)
    } catch (err) {
      if (err instanceof AppAlreadyInstalledError) {
        // Check if the existing record is uninstalled or needs file re-sync
        if (manager) {
          try {
            const existing = manager.listApps({ spaceId, type: 'skill' })
              .find(a => a.specId === skillId)

            if (existing) {
              if (existing.status === 'uninstalled') {
                // Reinstall the uninstalled skill
                manager.reinstall(existing.id)
                console.log(`[RegistryService] Reinstalled uninstalled skill "${skillId}" for "${spec.name}"`)
              } else {
                console.log(`[RegistryService] Required skill "${skillId}" already installed and active, skipping`)
              }
            } else {
              console.log(`[RegistryService] Required skill "${skillId}" already installed, skipping`)
            }
          } catch (syncErr) {
            console.warn(
              `[RegistryService] Failed to check/reinstall skill "${skillId}": ${(syncErr as Error).message}`
            )
          }
        } else {
          console.log(`[RegistryService] Required skill "${skillId}" already installed, skipping`)
        }
        continue
      }
      failures.push(`required skill "${skillId}": ${(err as Error).message}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to install required skills — ${failures.join('; ')}`)
  }
}

// ============================================
// Private helpers
// ============================================

/**
 * Build a lightweight AppSpec from RegistryEntry data for the browse/detail view.
 *
 * Does NOT fetch from GitHub — avoids consuming API quota on page navigation.
 * The full spec (with skill_files populated) is fetched at install time via
 * installFromStore() → adapter.fetchSpec().
 *
 * Used for claude-skills and skillhub sources where the registry index already contains
 * all data needed to render the detail page (name, description, tags, etc.).
 */
function buildPreviewSpec(entry: RegistryEntry, registryId: string): AppSpec {
  const store = { slug: entry.slug, registry_id: registryId }
  const requires = (entry.requires_mcps?.length || entry.requires_skills?.length)
    ? {
        mcps: entry.requires_mcps?.map(id => ({ id })),
        skills: entry.requires_skills,
      }
    : undefined

  // Skills are the only type sourced from claude-skills, but handle others defensively
  if (entry.type === 'skill') {
    const spec: SkillSpec = {
      spec_version: '1',
      name: entry.name,
      type: 'skill',
      version: entry.version,
      author: entry.author,
      description: entry.description,
      requires,
      i18n: entry.i18n,
      skill_files: {}, // empty — populated at install time
      store,
    }
    return spec
  }

  // Fallback for any other entry types
  return {
    spec_version: '1',
    name: entry.name,
    type: entry.type,
    version: entry.version,
    author: entry.author,
    description: entry.description,
    requires,
    i18n: entry.i18n,
    store,
  } as AppSpec
}

// ============================================
// Updates
// ============================================

/**
 * Check for available updates for installed apps.
 *
 * Compares installed app versions with entries in SQLite (Mirror sources).
 * Proxy source apps are not checked (no full index available).
 *
 * @param installedApps - List of installed apps to check
 * @returns List of available updates
 */
export async function checkUpdates(
  installedApps: Array<{
    id: string
    upgradeStrategy?: UpgradeStrategy
    spec: { name: string; version: string; store?: { slug?: string; registry_id?: string } }
  }>
): Promise<UpdateInfo[]> {
  ensureInitialized()

  if (!queryService) return []

  const updates: UpdateInfo[] = []

  for (const app of installedApps) {
    const slug = app.spec.store?.slug
    if (!slug) continue

    const found = queryService.findEntry(slug, app.spec.store?.registry_id)
    if (!found) continue

    const { entry } = found

    if (isNewerVersion(entry.version, app.spec.version)) {
      updates.push({
        appId: app.id,
        currentVersion: app.spec.version,
        latestVersion: entry.version,
        entry,
        strategy: app.upgradeStrategy ?? 'auto',
        severity: computeSeverity(app.spec.version, entry.version),
      })
    }
  }

  return updates
}

/**
 * Compare two semver versions to classify the diff as patch / minor / major.
 *
 * Falls back to 'major' if either version is unparseable — safer to surface
 * an alert than to silently auto-upgrade through an unknown change.
 */
function computeSeverity(current: string, latest: string): UpdateSeverity {
  const c = parseSemver(current)
  const l = parseSemver(latest)
  if (!c || !l) return 'major'
  if (l[0] > c[0]) return 'major'
  if (l[1] > c[1]) return 'minor'
  if (l[2] > c[2]) return 'patch'
  return 'patch'
}

/**
 * Apply an upgrade to an installed App.
 *
 * Fetches the latest spec from the registry, validates it against the
 * mode-permitted severity, then delegates to AppManager.updateSpec()
 * which preserves userConfig/userOverrides/permissions.
 *
 * Modes:
 *   - 'patch_minor': only allowed when severity is patch or minor
 *   - 'major':       allowed for any severity (used after user confirms a major)
 *   - 'force':       allowed for any severity, skips strategy checks
 */
export async function applyUpgrade(
  appId: string,
  mode: 'patch_minor' | 'major' | 'force' = 'force',
): Promise<{ appId: string; from: string; to: string; severity: UpdateSeverity }> {
  ensureInitialized()

  if (!queryService) {
    throw new Error('QueryService not available (db not provided)')
  }

  const manager = getAppManager()
  if (!manager) {
    throw new Error('App Manager is not yet initialized')
  }

  const app = manager.getApp(appId)
  if (!app) throw new Error(`Installed app not found: ${appId}`)

  const slug = app.spec.store?.slug
  if (!slug) throw new Error(`App ${appId} has no store.slug — cannot upgrade`)

  const found = queryService.findEntry(slug, app.spec.store?.registry_id)
  if (!found) throw new Error(`App ${slug} not found in any registry (cannot upgrade)`)

  const fromVersion = app.spec.version
  const toVersion = found.entry.version
  if (!isNewerVersion(toVersion, fromVersion)) {
    throw new Error(`App ${slug} is already at the latest version (${fromVersion})`)
  }

  const severity = computeSeverity(fromVersion, toVersion)
  if (mode === 'patch_minor' && severity === 'major') {
    throw new Error(`Cannot auto-apply major upgrade for ${slug} (use mode='major' after user confirm)`)
  }

  // Fetch the full latest spec from the source registry
  const registry = config.registries.find(r => r.id === found.registryId)
  if (!registry) throw new Error(`Registry not found: ${found.registryId}`)

  const adapter = getAdapter(registry)
  const newSpec = await adapter.fetchSpec(registry, found.entry)
  const newSpecWithStore = withInstallStoreMetadata(newSpec, found.entry.slug, found.registryId)

  // updateSpec preserves userConfig / userOverrides / permissions automatically
  manager.updateSpec(appId, newSpecWithStore as unknown as Record<string, unknown>)

  console.log(
    `[RegistryService] applyUpgrade: ${slug} ${fromVersion} -> ${toVersion} ` +
    `(severity=${severity}, mode=${mode})`
  )

  // Refresh runtime activation for automation apps so subscriptions reflect any spec changes
  const runtime = getAppRuntime()
  if (runtime && newSpecWithStore.type === 'automation') {
    runtime.syncAppSubscriptions(appId)
  }

  return { appId, from: fromVersion, to: toVersion, severity }
}

// ============================================
// Registry Source Management
// ============================================

/**
 * Get the list of configured registry sources.
 */
export function getRegistries(): RegistrySource[] {
  ensureInitialized()
  return [...config.registries]
}

/**
 * Add a new registry source.
 *
 * @param registry - Registry source without ID (ID is auto-generated)
 * @returns The created registry source with assigned ID
 */
export function addRegistry(registry: Omit<RegistrySource, 'id'>): RegistrySource {
  ensureInitialized()

  const normalizedUrl = normalizeRegistryUrl(registry.url)
  if (!isHttpUrl(normalizedUrl)) {
    throw new Error('Registry URL must use http:// or https://')
  }
  if (isBlockedRegistryHost(new URL(normalizedUrl).hostname)) {
    throw new Error('Registry URL must point to a public host (loopback, private, and link-local addresses are not allowed)')
  }

  const duplicate = config.registries.find(
    r => normalizeRegistryUrl(r.url) === normalizedUrl
  )
  if (duplicate) {
    throw new Error(`Registry already exists: ${duplicate.name}`)
  }

  const newRegistry: RegistrySource = {
    ...registry,
    id: uuidv4(),
    url: normalizedUrl,
    isDefault: false,
  }

  config.registries.push(newRegistry)
  saveConfigToFile()

  console.log(`[RegistryService] Added registry: "${newRegistry.name}" (${newRegistry.id})`)
  return newRegistry
}

/**
 * Remove a registry source by ID.
 *
 * @param registryId - The registry ID to remove
 * @throws Error if attempting to remove the default registry
 */
export function removeRegistry(registryId: string): void {
  ensureInitialized()

  const registry = config.registries.find(r => r.id === registryId)
  if (!registry) {
    throw new Error(`Registry not found: ${registryId}`)
  }
  if (isDefaultRegistry(registry) || isBuiltinRegistry(registry)) {
    throw new Error('Cannot remove a built-in registry')
  }

  config.registries = config.registries.filter(r => r.id !== registryId)
  if (syncService) {
    syncService.clearRegistryData(registryId)
  }
  saveConfigToFile()

  console.log(`[RegistryService] Removed registry: "${registry.name}" (${registryId})`)
}

/**
 * Enable or disable a registry source.
 *
 * @param registryId - The registry ID to toggle
 * @param enabled - Whether the registry should be enabled
 */
export function toggleRegistry(registryId: string, enabled: boolean): void {
  ensureInitialized()

  const registry = config.registries.find(r => r.id === registryId)
  if (!registry) {
    throw new Error(`Registry not found: ${registryId}`)
  }

  registry.enabled = enabled
  saveConfigToFile()

  console.log(`[RegistryService] Registry "${registry.name}" ${enabled ? 'enabled' : 'disabled'}`)
}

/**
 * Update the adapterConfig for a registry source (e.g. Smithery API key).
 *
 * @param registryId - The registry ID to update
 * @param adapterConfig - Partial config to merge into the existing adapterConfig
 */
export function updateRegistryAdapterConfig(
  registryId: string,
  adapterConfig: Record<string, unknown>
): void {
  ensureInitialized()

  const registry = config.registries.find(r => r.id === registryId)
  if (!registry) {
    throw new Error(`Registry not found: ${registryId}`)
  }

  registry.adapterConfig = { ...(registry.adapterConfig ?? {}), ...adapterConfig }
  saveConfigToFile()

  console.log(`[RegistryService] Updated adapterConfig for registry "${registry.name}"`)
}

// ============================================
// Config Persistence
// ============================================

/**
 * Load registry service configuration from the main HaloConfig.
 * Returns defaults if no configuration exists.
 */
export function loadConfig(): RegistryServiceConfig {
  try {
    const haloConfig = getConfig()
    const storeConfig = (haloConfig as Record<string, unknown>)[CONFIG_KEY] as Record<string, unknown> | undefined

    if (!storeConfig) {
      return {
        registries: [...BUILTIN_REGISTRIES],
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
        autoCheckUpdates: true,
      }
    }

    return {
      registries: normalizeRegistries(
        Array.isArray(storeConfig.registries)
          ? (storeConfig.registries as RegistrySource[])
          : [...BUILTIN_REGISTRIES]
      ),
      cacheTtlMs: normalizeCacheTtl(
        typeof storeConfig.cacheTtlMs === 'number'
          ? storeConfig.cacheTtlMs
          : DEFAULT_CACHE_TTL_MS
      ),
      autoCheckUpdates: typeof storeConfig.autoCheckUpdates === 'boolean'
        ? storeConfig.autoCheckUpdates
        : true,
    }
  } catch (error) {
    console.error('[RegistryService] Failed to load config, using defaults:', error)
    return {
      registries: [...BUILTIN_REGISTRIES],
      cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      autoCheckUpdates: true,
    }
  }
}

/**
 * Persist the current registry service configuration to the main HaloConfig.
 */
export function saveConfig(): void {
  saveConfigToFile()
}

// ============================================
// Internal Helpers
// ============================================

/** Cooldown to avoid hammering re-sync on every query */
let lastRetryAttemptMs = 0
const RETRY_COOLDOWN_MS = 30_000 // 30s between retry attempts

/**
 * Check mirror sources for error/never-synced state and trigger background re-sync.
 * Non-blocking, fire-and-forget. Debounced by RETRY_COOLDOWN_MS.
 */
function retryFailedMirrorSources(): void {
  const now = Date.now()
  if (now - lastRetryAttemptMs < RETRY_COOLDOWN_MS) return

  const mirrorRegistries = config.registries.filter(r => {
    if (!r.enabled) return false
    const adapter = getAdapter(r)
    return adapter.strategy === 'mirror'
  })

  const states = syncService!.getSyncStates()
  const stateMap = new Map(states.map(s => [s.registryId, s]))

  const needsRetry = mirrorRegistries.filter(r => {
    const state = stateMap.get(r.id)
    // Never synced, or synced with error and 0 items
    return !state || state.status === 'error' || state.appCount === 0
  })

  if (needsRetry.length === 0) return

  lastRetryAttemptMs = now
  console.log(`[RegistryService] retryFailedMirrorSources: ${needsRetry.map(r => r.id).join(', ')}`)

  for (const registry of needsRetry) {
    syncService!.syncOne(registry, 0, true).catch(err => {
      console.error(`[RegistryService] Background retry failed for ${registry.id}:`, err)
    })
  }
}

/**
 * Compare two version strings to determine if `latest` is newer than `current`.
 * Supports SemVer core numbers and falls back to numeric dot-segment comparison.
 *
 * @returns true if latest > current
 */
function isNewerVersion(latest: string, current: string): boolean {
  if (latest === current) return false

  const parsedLatest = parseSemver(latest)
  const parsedCurrent = parseSemver(current)
  if (parsedLatest && parsedCurrent) {
    for (let i = 0; i < 3; i++) {
      if (parsedLatest[i] > parsedCurrent[i]) return true
      if (parsedLatest[i] < parsedCurrent[i]) return false
    }
    return false
  }

  const l = parseNumericDotVersion(latest)
  const c = parseNumericDotVersion(current)
  const len = Math.max(l.length, c.length)

  for (let i = 0; i < len; i++) {
    const lv = l[i] ?? 0
    const cv = c[i] ?? 0
    if (lv > cv) return true
    if (lv < cv) return false
  }

  return false
}

function parseSemver(version: string): [number, number, number] | null {
  const match = version.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function parseNumericDotVersion(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((segment) => {
      const numeric = segment.match(/^(\d+)/)
      return numeric ? Number(numeric[1]) : 0
    })
}

function normalizeCacheTtl(cacheTtlMs: number): number {
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) {
    return DEFAULT_CACHE_TTL_MS
  }
  return Math.floor(cacheTtlMs)
}

function normalizeRegistries(registries: RegistrySource[]): RegistrySource[] {
  const result: RegistrySource[] = []
  const seenIds = new Set<string>()
  const seenUrls = new Set<string>()

  for (const registry of registries) {
    const parsed = RegistrySourceSchema.safeParse(registry)
    if (!parsed.success) {
      continue
    }

    const normalizedUrl = normalizeRegistryUrl(parsed.data.url)
    if (!isHttpUrl(normalizedUrl)) {
      continue
    }

    const normalized: RegistrySource = {
      ...parsed.data,
      url: normalizedUrl,
    }

    if (seenIds.has(normalized.id) || seenUrls.has(normalized.url)) {
      continue
    }

    seenIds.add(normalized.id)
    seenUrls.add(normalized.url)
    result.push(normalized)
  }

  return result
}

function normalizeRegistryUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function isBlockedV4(a: number, b: number): boolean {
  return (
    a === 0 ||                            // unspecified
    a === 127 ||                          // loopback
    a === 10 ||                           // RFC1918
    (a === 172 && b >= 16 && b <= 31) ||  // RFC1918
    (a === 192 && b === 168) ||           // RFC1918
    (a === 169 && b === 254)              // link-local / cloud metadata (169.254.169.254)
  )
}

/**
 * True when a hostname names the local machine or a private/internal network.
 * Gates the user-driven "add registry" action so an operator cannot turn the
 * store fetcher into an SSRF probe against loopback, RFC1918, or the cloud
 * metadata endpoint. Only literal IPs are inspected (no DNS resolution): a
 * hostname that resolves to a private address is out of scope here, and
 * trusted built-in / enterprise registries never pass through this gate.
 */
function isBlockedRegistryHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (v4) return isBlockedV4(Number(v4[1]), Number(v4[2]))

  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true        // loopback / unspecified
    if (host.startsWith('fe80:')) return true               // link-local
    if (host.startsWith('fc') || host.startsWith('fd')) return true // unique-local fc00::/7
    if (host.startsWith('::ffff:')) {
      const mapped = host.slice('::ffff:'.length).match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
      if (mapped) return isBlockedV4(Number(mapped[1]), Number(mapped[2]))
    }
  }
  return false
}

function isDefaultRegistry(registry: RegistrySource): boolean {
  return registry.id === DEFAULT_REGISTRY.id || registry.isDefault === true
}

function isBuiltinRegistry(registry: RegistrySource): boolean {
  return BUILTIN_REGISTRIES.some(b => b.id === registry.id)
}

/**
 * Ensure all built-in registries are present in the config.
 *
 * For each built-in registry:
 *  - If product.json declares `hidden: true` for it: the entry is removed
 *    from `config.registries` (and never inserted). Any persisted copy
 *    from a previous run — including one created before the policy was
 *    flipped on — is dropped. This is the policy-forbids-it case.
 *  - If already present: update immutable fields (name, url, sourceType) but
 *    preserve the user's `enabled` toggle and `adapterConfig` (e.g. API keys).
 *  - If absent: insert it at the correct position.
 *
 * The official registry is always first.
 *
 * @returns Object with `changed` (triggers config save) and `purgeRegistryIds`
 *          (registry IDs whose cached data must be cleared after SyncService creation).
 */
function ensureBuiltinRegistries(): { changed: boolean; purgeRegistryIds: string[] } {
  let changed = false
  const purgeRegistryIds: string[] = []

  // Read product.json overrides once (loadProductConfig is singleton-cached).
  // Enterprise builds use this to redirect the official registry
  // to an internal mirror, hide forbidden public sources, and/or
  // force-disable specific entries.
  const productOverrides = loadProductConfig().registryOverrides ?? {}

  for (const builtin of BUILTIN_REGISTRIES) {
    const override = productOverrides[builtin.id] ?? {}

    // `hidden: true` is the strongest signal: the registry must not
    // appear in the Store UI at all. Strip any persisted entry and
    // skip the rest of the merge so it never reaches the user.
    if (override.hidden === true) {
      const before = config.registries.length
      config.registries = config.registries.filter(r => r.id !== builtin.id)
      if (config.registries.length !== before) {
        purgeRegistryIds.push(builtin.id)
        console.log(`[RegistryService] Removed hidden built-in registry "${builtin.id}" per product.json`)
        changed = true
      }
      continue
    }

    // Merge: builtin defaults ← product.json override (only declared fields win)
    const effective = {
      ...builtin,
      ...(override.url     !== undefined ? { url:     override.url     } : {}),
      ...(override.name    !== undefined ? { name:    override.name    } : {}),
      ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
    }

    const existing = config.registries.find(r => r.id === builtin.id)

    if (existing) {
      // Immutable fields (name, url, sourceType, isDefault, enabled when
      // product.json declares an override) are enforced on every startup.
      // User-controlled fields (adapterConfig) are always preserved.
      const urlChanged = existing.url !== effective.url
      if (
        existing.name       !== effective.name       ||
        urlChanged                                   ||
        existing.sourceType !== effective.sourceType ||
        existing.isDefault  !== effective.isDefault  ||
        // Only enforce `enabled` when product.json explicitly declares it;
        // otherwise preserve the user's manual toggle from Settings.
        (override.enabled !== undefined && existing.enabled !== effective.enabled)
      ) {
        existing.name       = effective.name
        existing.url        = effective.url
        existing.sourceType = effective.sourceType
        existing.isDefault  = effective.isDefault
        if (override.enabled !== undefined) {
          existing.enabled = effective.enabled
        }
        if (urlChanged) {
          purgeRegistryIds.push(builtin.id)
        }
        changed = true
      }
      // Preserve existing.adapterConfig (e.g. Smithery API key)
    } else {
      // Insert missing builtin with effective (merged) values
      config.registries.push({ ...effective })
      changed = true
    }
  }

  // Ensure official registry is first
  const officialIndex = config.registries.findIndex(r => r.id === DEFAULT_REGISTRY.id)
  if (officialIndex > 0) {
    const [official] = config.registries.splice(officialIndex, 1)
    config.registries.unshift(official)
    changed = true
  }

  // Ensure only the official registry has isDefault=true
  for (const registry of config.registries) {
    const shouldBeDefault = registry.id === DEFAULT_REGISTRY.id
    if (registry.isDefault !== shouldBeDefault) {
      registry.isDefault = shouldBeDefault
      changed = true
    }
  }

  return { changed, purgeRegistryIds }
}

function withInstallStoreMetadata(spec: AppSpec, slug: string, registryId: string): AppSpec {
  return {
    ...spec,
    store: {
      ...(spec.store ?? {}),
      slug: spec.store?.slug ?? slug,
      registry_id: registryId,
    },
  }
}

/**
 * Ensure the service has been initialized before use.
 * @throws Error if not initialized
 */
function ensureInitialized(): void {
  if (!initialized) {
    initRegistryService()
  }
}

/**
 * Persist current config to the HaloConfig file.
 */
function saveConfigToFile(): void {
  try {
    saveHaloConfig({
      [CONFIG_KEY]: {
        registries: config.registries,
        cacheTtlMs: config.cacheTtlMs,
        autoCheckUpdates: config.autoCheckUpdates,
      },
    })
  } catch (error) {
    console.error('[RegistryService] Failed to save config:', error)
  }
}

function isBundleFormat(entry: { format?: string }): entry is { format: 'bundle' } {
  return entry.format === 'bundle'
}
