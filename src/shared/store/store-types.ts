/**
 * Shared Store Types
 *
 * Pure TypeScript type definitions for the Store / Registry system.
 * These types are used by both the main process and the renderer process.
 *
 * IMPORTANT: This file must NOT import any Node.js or Electron APIs.
 * It is included in the renderer (web) tsconfig.
 */

import type { AppType } from '../apps/spec-types'

// ============================================
// Registry Source Configuration
// ============================================

/** A configured registry source */
export interface RegistrySource {
  /** Unique identifier */
  id: string
  /** Display name */
  name: string
  /** Base URL for fetching index.json and packages */
  url: string
  /** Whether this registry is enabled */
  enabled: boolean
  /** Whether this is the built-in official registry (cannot be deleted) */
  isDefault?: boolean
  /**
   * Source type — determines which adapter is used to fetch and parse the index.
   * Defaults to 'halo' when absent (backward-compatible).
   */
  sourceType?: 'halo' | 'mcp-registry' | 'smithery' | 'claude-skills' | 'skillhub'
  /**
   * Adapter-specific configuration (e.g. API keys).
   * Interpreted exclusively by the adapter for this sourceType.
   */
  adapterConfig?: Record<string, unknown>
}

// ============================================
// Registry Index (fetched from registry)
// ============================================

/** Top-level structure of index.json */
export interface RegistryIndex {
  /** Index format version */
  version: number
  /** ISO timestamp when the index was generated */
  generated_at: string
  /** Registry source identifier URL */
  source: string
  /** List of available apps */
  apps: RegistryEntry[]
}

/** A single app entry in the registry index */
export interface RegistryEntry {
  // Identity
  /** URL-safe unique identifier */
  slug: string
  /** Display name */
  name: string
  /** Current version (semver) */
  version: string
  /** Author name */
  author: string
  /** Short description */
  description: string
  /** App type */
  type: AppType

  // Distribution
  /** Package format (bundle-only; minimum bundle is a folder with spec.yaml) */
  format: 'bundle'
  /** Relative bundle directory path within the registry */
  path: string
  /** Absolute download URL (for non-Git sources) */
  download_url?: string
  /** Package size in bytes */
  size_bytes?: number
  /** Integrity checksum (sha256:...) */
  checksum?: string

  // Discovery
  /** Primary category */
  category: string
  /** Free-form tags */
  tags: string[]
  /** Icon (emoji or URL) */
  icon?: string
  /** Primary locale (BCP 47) */
  locale?: string

  // Compatibility
  /** Minimum client version required */
  min_app_version?: string

  // Dependency summary (for display without fetching full spec)
  /** Required MCP IDs */
  requires_mcps?: string[]
  /** Required Skill IDs */
  requires_skills?: string[]

  // Timestamps
  /** ISO timestamp when first published */
  created_at?: string
  /** ISO timestamp of last update */
  updated_at?: string

  /**
   * Locale-specific name and description overrides.
   * Extracted from the spec's i18n block at registry build time.
   * Allows the store UI to display translated listings without fetching the full spec.
   *
   * Keys are BCP 47 locale tags (e.g. "zh-CN", "ja").
   * Resolution: exact locale match → language-prefix match → canonical name/description.
   *
   * Full config_schema overrides (labels, placeholders, option labels) are only
   * available after fetching the complete spec.
   */
  i18n?: Record<string, { name?: string; description?: string }>

  /**
   * Implementation-defined extension data.
   *
   * The protocol defines this field as an open key-value container.
   * Contents are entirely determined by the registry publisher or client
   * implementation — the protocol places no constraints on the shape.
   *
   * Registry publishers and client implementations may use this field
   * freely for custom metadata without affecting protocol compatibility.
   */
  meta?: Record<string, unknown>
}

// ============================================
// Store Query & Filtering
// ============================================

/** Query parameters for listing store apps (legacy, kept for backward compat) */
export interface StoreQuery {
  /** Free-text search (matches name, description, tags, and locale overrides when locale is provided) */
  search?: string
  /** Preferred UI locale (BCP 47), used for localized search matching */
  locale?: string
  /** Filter by category */
  category?: string
  /** Filter by app type */
  type?: AppType
  /** Filter by tags */
  tags?: string[]
}

/** Paginated query parameters for the new store:query IPC channel */
export interface StoreQueryParams {
  search?: string
  locale?: string
  category?: string
  type?: AppType
  page: number
  pageSize: number
}

/** Response from store:query */
export interface StoreQueryResponse {
  items: RegistryEntry[]
  total?: number
  hasMore: boolean
  /** All tab preview mode: per-type group info */
  groups?: Array<{
    type: AppType
    count: number
    hasMore: boolean
  }>
  /** Per-source status */
  sources: Array<{
    registryId: string
    status: 'ok' | 'error'
    error?: string
  }>
}

/** Sync status for a single registry (pushed from main to renderer) */
export interface StoreSyncStatus {
  registryId: string
  status: 'idle' | 'syncing' | 'error'
  appCount: number
  error?: string
}

// ============================================
// Store App Detail (full spec + entry)
// ============================================

/** Full detail for a single store app (entry + resolved spec) */
export interface StoreAppDetail {
  /** Registry entry metadata */
  entry: RegistryEntry
  /** Full AppSpec (fetched on demand) */
  spec: import('../apps/spec-types').AppSpec
  /** Which registry source this came from */
  registryId: string
}

// ============================================
// Install Progress
// ============================================

/** Progress event pushed from main process to renderer during skill installation */
export interface StoreInstallProgress {
  /** Unique ID for this install operation (matches the progressChannel) */
  installId: string
  /** Current phase of installation */
  phase: 'fetching-tree' | 'downloading' | 'installing' | 'done' | 'error'
  /** Number of files downloaded so far */
  filesComplete: number
  /** Total number of files to download (0 until tree is fetched) */
  filesTotal: number
  /** Name of the file currently being downloaded */
  currentFile: string
  /** 0–100 percentage */
  percent: number
  /** Human-readable status message */
  message: string
}

// ============================================
// Update Information
// ============================================

/** Severity of a version diff for upgrade dispatching */
export type UpdateSeverity = 'patch' | 'minor' | 'major'

/** User-controlled upgrade strategy mirrored from apps/manager */
export type UpgradeStrategy = 'auto' | 'notify' | 'manual'

/** Information about an available update for an installed app */
export interface UpdateInfo {
  /** Installed app ID */
  appId: string
  /** Currently installed version */
  currentVersion: string
  /** Latest available version */
  latestVersion: string
  /** Registry entry for the latest version */
  entry: RegistryEntry
  /** User-selected upgrade strategy for this app */
  strategy: UpgradeStrategy
  /** Semver diff severity between currentVersion and latestVersion */
  severity: UpdateSeverity
}

/** Payload pushed to the renderer when an update is available but not auto-applied. */
export interface UpgradeAvailableEvent {
  appId: string
  currentVersion: string
  latestVersion: string
  strategy: UpgradeStrategy
  severity: UpdateSeverity
}

// ============================================
// Store Categories
// ============================================

/** Predefined store categories */
export const STORE_CATEGORIES = [
  'shopping',
  'news',
  'content',
  'dev-tools',
  'productivity',
  'data',
  'social',
  'other',
] as const

export type StoreCategory = typeof STORE_CATEGORIES[number]

/** Category display metadata */
export interface StoreCategoryMeta {
  id: StoreCategory
  /** i18n key for the display label */
  labelKey: string
  /** Emoji icon for the category */
  icon: string
}

/** Category metadata for UI rendering */
export const STORE_CATEGORY_META: StoreCategoryMeta[] = [
  { id: 'shopping', labelKey: 'Shopping', icon: '🛒' },
  { id: 'news', labelKey: 'News', icon: '📰' },
  { id: 'content', labelKey: 'Content', icon: '✍️' },
  { id: 'dev-tools', labelKey: 'Dev Tools', icon: '🛠️' },
  { id: 'productivity', labelKey: 'Productivity', icon: '⚡' },
  { id: 'data', labelKey: 'Data', icon: '📊' },
  { id: 'social', labelKey: 'Social', icon: '💬' },
  { id: 'other', labelKey: 'Other', icon: '📦' },
]
