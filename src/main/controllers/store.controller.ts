/**
 * Store Controller
 *
 * Business logic for the Store feature.
 * Used by both IPC handlers and HTTP routes.
 *
 * Each method returns { success: true, data } or { success: false, error }.
 * All methods are wrapped in try/catch to prevent unhandled exceptions
 * from propagating to transport layers.
 */

import type { StoreQuery, StoreQueryParams, StoreQueryResponse } from '../../shared/store/store-types'
import type { RegistryEntry, StoreAppDetail, UpdateInfo, RegistrySource } from '../../shared/store/store-types'
import type { AppType } from '../../shared/apps/spec-types'
import {
  listApps,
  queryStore,
  getAppDetail,
  getAppDocument,
  installFromStore,
  refreshIndex,
  checkUpdates,
  getRegistries,
  addRegistry,
  removeRegistry,
  toggleRegistry,
  updateRegistryAdapterConfig,
} from '../store'
import { getAppManager } from '../apps/manager'
import { McpCommandBlockedError } from '../apps/manager/errors'
import { MCP_COMMAND_BLOCKED_MESSAGE } from '../services/security-policy'

const ALLOWED_APP_TYPES: ReadonlySet<AppType> = new Set<AppType>(['automation', 'skill', 'mcp', 'extension'])

// ============================================================================
// Response Types
// ============================================================================

/** Controller success response */
export interface StoreControllerSuccess<T> {
  success: true
  data: T
}

/**
 * Stable error codes returned by Store controller methods. Callers
 * (HTTP / IPC) translate these into transport-specific responses
 * without parsing error message strings.
 *
 * Currently used only by installStoreApp. Other Store methods return
 * `code === undefined`.
 */
export type StoreErrorCode =
  | 'MCP_COMMAND_BLOCKED' // MCP install rejected by security.mcpCommandBlacklist (→ HTTP 403)

/** Controller error response */
export interface StoreControllerError {
  success: false
  error: string
  code?: StoreErrorCode
}

export type StoreControllerResponse<T> = StoreControllerSuccess<T> | StoreControllerError

// ============================================================================
// List / Query
// ============================================================================

/**
 * Paginated query — the new primary query entry point.
 */
export async function queryStoreApps(
  params: StoreQueryParams
): Promise<StoreControllerResponse<StoreQueryResponse>> {
  try {
    const result = await queryStore(params)
    return { success: true, data: result }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[StoreController] queryStoreApps error:', err.message)
    return { success: false, error: err.message }
  }
}

/**
 * List apps from the store with optional filtering (legacy compat).
 */
export async function listStoreApps(
  query?: StoreQuery | { search?: string; locale?: string; category?: string; type?: string; tags?: string[] }
): Promise<StoreControllerResponse<RegistryEntry[]>> {
  try {
    const apps = await listApps(normalizeStoreQuery(query))
    return { success: true, data: apps }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[StoreController] listStoreApps error:', err.message)
    return { success: false, error: err.message }
  }
}

// ============================================================================
// App Detail
// ============================================================================

/**
 * Get detailed information about a store app by slug.
 */
export async function getStoreAppDetail(
  slug: string
): Promise<StoreControllerResponse<StoreAppDetail>> {
  try {
    if (!slug) {
      return { success: false, error: 'App slug is required' }
    }
    const detail = await getAppDetail(slug)
    return { success: true, data: detail }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[StoreController] getStoreAppDetail error:', err.message)
    return { success: false, error: err.message }
  }
}

/**
 * Get the SKILL.md / README document for a store app, for the detail page.
 * Returns { content: null } when the source has no document for this entry.
 */
export async function getStoreAppDocument(
  slug: string
): Promise<StoreControllerResponse<{ content: string | null }>> {
  try {
    if (!slug) {
      return { success: false, error: 'App slug is required' }
    }
    const doc = await getAppDocument(slug)
    return { success: true, data: doc }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[StoreController] getStoreAppDocument error:', err.message)
    return { success: false, error: err.message }
  }
}

// ============================================================================
// Install
// ============================================================================

/**
 * Install an app from the store into a specific space.
 */
export async function installStoreApp(
  slug: string,
  spaceId: string | null,
  userConfig?: Record<string, unknown>,
  onProgress?: (filesComplete: number, filesTotal: number, currentFile: string) => void,
): Promise<StoreControllerResponse<{ appId: string }>> {
  try {
    if (!slug) {
      return { success: false, error: 'App slug is required' }
    }
    // spaceId may be null for global installs (MCP/Skill available across all spaces)
    const appId = await installFromStore(slug, spaceId, userConfig, onProgress)
    return { success: true, data: { appId } }
  } catch (error: unknown) {
    const err = error as Error
    if (error instanceof McpCommandBlockedError) {
      console.warn(`[StoreController] installStoreApp: blocked MCP command '${error.command}' (slug=${slug})`)
      return { success: false, error: MCP_COMMAND_BLOCKED_MESSAGE, code: 'MCP_COMMAND_BLOCKED' }
    }
    console.error('[StoreController] installStoreApp error:', err.message)
    return { success: false, error: err.message }
  }
}

// ============================================================================
// Refresh Index
// ============================================================================

/**
 * Refresh the registry index from remote sources.
 */
export async function refreshStoreIndex(): Promise<StoreControllerResponse<void>> {
  try {
    await refreshIndex()
    return { success: true, data: undefined }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[StoreController] refreshStoreIndex error:', err.message)
    return { success: false, error: err.message }
  }
}

// ============================================================================
// Updates
// ============================================================================

/**
 * Check for available updates for all installed apps.
 *
 * Queries the App Manager for installed apps that have store metadata,
 * then checks the registry for newer versions.
 */
export async function checkStoreUpdates(): Promise<StoreControllerResponse<UpdateInfo[]>> {
  try {
    const manager = getAppManager()
    if (!manager) {
      return { success: false, error: 'App Manager is not yet initialized. Please try again shortly.' }
    }

    const installedApps = manager.listApps().filter(app => app.status !== 'uninstalled')
    const appsWithStore = installedApps.map(app => ({
      id: app.id,
      spec: {
        name: app.spec.name,
        version: app.spec.version,
        store: app.spec.store,
      },
    }))

    const updates = await checkUpdates(appsWithStore)
    return { success: true, data: updates }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[StoreController] checkStoreUpdates error:', err.message)
    return { success: false, error: err.message }
  }
}

// ============================================================================
// Registry Source Management
// ============================================================================

/**
 * Get the list of configured registry sources.
 */
export function getStoreRegistries(): StoreControllerResponse<RegistrySource[]> {
  try {
    const registries = getRegistries()
    return { success: true, data: registries }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[StoreController] getStoreRegistries error:', err.message)
    return { success: false, error: err.message }
  }
}

/**
 * Add a new registry source.
 */
export function addStoreRegistry(
  input: { name: string; url: string; sourceType?: string; adapterConfig?: Record<string, unknown> }
): StoreControllerResponse<RegistrySource> {
  try {
    if (!input.name || !input.name.trim()) {
      return { success: false, error: 'Registry name is required' }
    }
    if (!input.url || !input.url.trim()) {
      return { success: false, error: 'Registry URL is required' }
    }

    // Basic URL validation
    let parsedUrl: URL
    try {
      parsedUrl = new URL(input.url)
    } catch {
      return { success: false, error: 'Invalid registry URL format' }
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { success: false, error: 'Registry URL must use http:// or https://' }
    }

    const registry = addRegistry({
      name: input.name.trim(),
      url: input.url.trim().replace(/\/+$/, ''),
      enabled: true,
      ...(input.sourceType ? { sourceType: input.sourceType as RegistrySource['sourceType'] } : {}),
      ...(input.adapterConfig ? { adapterConfig: input.adapterConfig } : {}),
    })
    return { success: true, data: registry }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[StoreController] addStoreRegistry error:', err.message)
    return { success: false, error: err.message }
  }
}

/**
 * Remove a registry source.
 */
export function removeStoreRegistry(
  registryId: string
): StoreControllerResponse<void> {
  try {
    if (!registryId) {
      return { success: false, error: 'Registry ID is required' }
    }
    removeRegistry(registryId)
    return { success: true, data: undefined }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[StoreController] removeStoreRegistry error:', err.message)
    return { success: false, error: err.message }
  }
}

/**
 * Enable or disable a registry source.
 */
export function toggleStoreRegistry(
  registryId: string,
  enabled: boolean
): StoreControllerResponse<void> {
  try {
    if (!registryId) {
      return { success: false, error: 'Registry ID is required' }
    }
    toggleRegistry(registryId, enabled)
    return { success: true, data: undefined }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[StoreController] toggleStoreRegistry error:', err.message)
    return { success: false, error: err.message }
  }
}

/**
 * Update adapter config (e.g. API keys) for a registry source.
 */
export function updateStoreRegistryAdapterConfig(
  registryId: string,
  adapterConfig: Record<string, unknown>
): StoreControllerResponse<void> {
  try {
    if (!registryId) {
      return { success: false, error: 'Registry ID is required' }
    }
    updateRegistryAdapterConfig(registryId, adapterConfig)
    return { success: true, data: undefined }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[StoreController] updateStoreRegistryAdapterConfig error:', err.message)
    return { success: false, error: err.message }
  }
}

function normalizeStoreQuery(
  query?: StoreQuery | { search?: string; locale?: string; category?: string; type?: string; tags?: string[] }
): StoreQuery | undefined {
  if (!query) return undefined

  const normalized: StoreQuery = {}
  const search = query.search?.trim()
  const locale = query.locale?.trim()
  const category = query.category?.trim()
  if (search) normalized.search = search
  if (locale) normalized.locale = locale
  if (category) normalized.category = category

  if (query.type && ALLOWED_APP_TYPES.has(query.type as AppType)) {
    normalized.type = query.type as AppType
  }

  if (Array.isArray(query.tags)) {
    const tags = query.tags
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0)
    if (tags.length > 0) {
      normalized.tags = tags
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}
