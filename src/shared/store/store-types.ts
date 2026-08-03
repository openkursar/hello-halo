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

/**
 * Every source protocol the client can drive. Adding one means adding an
 * adapter — this list and `adapters/index.ts` are the only places that
 * enumerate protocols; runtime validation derives from here rather than
 * restating it, so a new type cannot be accepted by the type checker and
 * rejected by config validation.
 */
export const STORE_SOURCE_TYPES = [
  'halo',
  'dhp-v2',
  'mcp-registry',
  'smithery',
  'claude-skills',
  'skillhub',
] as const

export type StoreSourceType = (typeof STORE_SOURCE_TYPES)[number]

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
   *
   * 'halo' and 'dhp-v2' share the same directory protocol; 'dhp-v2' additionally
   * declares that the source runs the DHP v2 backend (handshake, install ledger,
   * collections, creator publications, ops-managed taxonomy/layout).
   */
  sourceType?: StoreSourceType
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
  /** Source registry id — populated on list results so a card can resolve install state by slug+registry. */
  registryId?: string
  /** Canonical name — for skills the ASCII command name, not a display string */
  name: string
  /** Display name published alongside `name`; absent on entries whose canonical
   * name is already presentable. `i18n` overrides it. */
  display_name?: string
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

/**
 * A single scene category. `id` is the stable key persisted in an app's
 * `category` field and used for exact-match filtering (WHERE category = ?).
 *
 * Display resolves in the renderer as `labelKey ? t(labelKey) : (label ?? id)`:
 * built-in categories carry `labelKey` so they stay translatable; server- or
 * config-supplied categories carry a literal `label` in their own language.
 */
export interface CategoryDef {
  id: string
  /** i18n key — set for built-in categories to keep them translatable */
  labelKey?: string
  /** Literal display label — set for server-/config-supplied categories */
  label?: string
  /** Optional emoji icon */
  icon?: string
}

/**
 * Per-App-type scene category enumeration. `default` is the fallback list used
 * for any type without its own entry (and by the community / no-server build).
 *
 * The authoritative source is per-deployment: an enterprise store server (ops
 * backend) downloads a controlled enum; when none is present the client
 * falls back to BUILTIN_CATEGORY_TAXONOMY so the community build is unchanged.
 */
export type CategoryTaxonomy = Partial<Record<AppType, CategoryDef[]>> & {
  default: CategoryDef[]
}

/** Stable id of the catch-all bucket; never removed, absorbs unmapped categories. */
export const CATEGORY_OTHER_ID = 'other'

/**
 * Built-in category taxonomy — the zero-server fallback. Its ids/labels/icons
 * are byte-for-byte the historical community set, so a build with no server
 * enum renders exactly as before.
 */
export const BUILTIN_CATEGORY_TAXONOMY: CategoryTaxonomy = {
  default: [
    { id: 'shopping', labelKey: 'Shopping', icon: '🛒' },
    { id: 'news', labelKey: 'News', icon: '📰' },
    { id: 'content', labelKey: 'Content', icon: '✍️' },
    { id: 'dev-tools', labelKey: 'Dev Tools', icon: '🛠️' },
    { id: 'productivity', labelKey: 'Productivity', icon: '⚡' },
    { id: 'data', labelKey: 'Data', icon: '📊' },
    { id: 'social', labelKey: 'Social', icon: '💬' },
    { id: CATEGORY_OTHER_ID, labelKey: 'Other', icon: '📦' },
  ],
}

// ============================================
// Discover Layout (config-driven discover page)
// ============================================

/**
 * Per-language display text served by the ops backend. Resolved by current
 * locale with a `default` fallback; the wire form may also be a bare string
 * (equivalent to `{ default: str }`), normalized to this shape on arrival.
 */
export type LocaleText = Record<string, string>

/** Node kinds the client renders; unknown kinds are skipped (forward-compat). */
export type DiscoverNodeType = 'row' | 'section' | 'catalog'

/** Section presentation primitives (leaf `section` nodes). */
export type DiscoverLayoutKind = 'card_grid' | 'featured' | 'rank_board' | 'collections'

/** Sort applied to a section's locally-resolved entries. */
export type DiscoverSortKind = 'installs' | 'recent' | 'name' | 'manual'

/**
 * Declarative query a section runs against the already-synced index (no network
 * fetch). All fields optional; an empty source means "all apps".
 */
export interface DiscoverSource {
  featured?: boolean
  types?: AppType[]
  categories?: string[]
  tags?: string[]
  /** Explicit slugs for a hand-curated section (order preserved with sort: 'manual'). */
  slugs?: string[]
  sort?: DiscoverSortKind
  limit?: number
}

/**
 * One node of the discover layout tree. `row` is a columns container holding
 * `section` children; `section` is a leaf with a layout + query; `catalog` is
 * the paginated full-catalog grid.
 */
export interface DiscoverNode {
  type: DiscoverNodeType
  /** For `section`: which presentation primitive to use. */
  layout?: DiscoverLayoutKind
  title?: LocaleText
  subtitle?: LocaleText
  source?: DiscoverSource
  /** For `row`: number of columns (1–3). */
  columns?: number
  /** For `row`: child section nodes. */
  children?: DiscoverNode[]
  /** Kept in the layout but omitted from render — a temporary operator hide. */
  hidden?: boolean
}

/** The discover-page layout document served at `/discover-layout.json`. */
export interface DiscoverLayout {
  version: number
  nodes: DiscoverNode[]
}

/**
 * A layout node with its data already resolved by the main process, which holds
 * the full index mirror. The renderer receives entries rather than the query
 * that produced them — a section's ranking is therefore computed over every
 * entry, not just the page the browse list happens to have loaded.
 *
 * Hidden nodes and sections that resolve to nothing are dropped before sending.
 */
export interface ResolvedDiscoverNode {
  type: DiscoverNodeType
  layout?: DiscoverLayoutKind
  title?: LocaleText
  subtitle?: LocaleText
  /** For `row`: column count and child nodes. */
  columns?: number
  children?: ResolvedDiscoverNode[]
  /** Resolved entries for a section, or the first catalog page. */
  entries?: RegistryEntry[]
  /** Only for the `collections` layout. */
  collections?: StoreCollection[]
  /** Only for `catalog`: whether further pages exist behind the browse query. */
  hasMore?: boolean
}

export interface ResolvedDiscover {
  version: number
  nodes: ResolvedDiscoverNode[]
}

/**
 * Page size for the catalog node. Shared because the main process returns page
 * 1 and the renderer requests page 2 onwards — a mismatch would repeat or skip
 * entries at the boundary.
 */
export const DISCOVER_CATALOG_PAGE_SIZE = 30

/**
 * Zero-config fallback: a single paginated catalog. Used by the community build
 * and whenever the server layout is absent/empty/malformed, so the discover
 * page always renders the full app grid. The catalog title is resolved in the
 * renderer (t('All Apps')) when a node carries none.
 */
export const BUILTIN_DISCOVER_LAYOUT: DiscoverLayout = {
  version: 1,
  nodes: [{ type: 'catalog' }],
}

// ============================================
// Scene Collections
// ============================================

/** A curated cross-type scene collection served by the ops backend. */
export interface StoreCollection {
  id: string
  /** Short tag shown on the collection card. */
  label: string
  name: string
  description: string
  /** Ordered member app slugs. */
  memberSlugs: string[]
}

// ============================================
// My Publications
// ============================================

/**
 * Error sentinel meaning "no store identity / signed out". Travels across
 * IPC as an error string; the renderer maps it to a sign-in prompt instead of a
 * raw error. Kept here so main and renderer share one literal.
 */
export const STORE_NOT_SIGNED_IN = 'NOT_SIGNED_IN'

/**
 * Whether a creator sign-in is possible for the current build+store pairing.
 * Lets the renderer tell "signed out but can sign in" apart from the
 * misconfiguration where the store requires an account yet this build ships no
 * identity provider — the latter must show an explanation, not a dead sign-in
 * button that can never succeed.
 *   - `signed-in`     — a token is held.
 *   - `available`     — an identity provider is configured but not signed in.
 *   - `unavailable`   — store requires identity but no provider is configured.
 *   - `not-required`  — the store does not bind identity.
 */
export type StoreSignInStatus = 'signed-in' | 'available' | 'unavailable' | 'not-required'

/** A creator's own published version and its current store status. */
export interface MyPublication {
  /** Scoped slug "author/app-id". */
  slug: string
  /** Display name from the index (absent on legacy records). */
  name?: string
  /** App type from the index vocabulary (automation | skill | mcp). */
  type?: string
  version: string
  /** Derived listing status: online / taken down / rejected. */
  status: 'listed' | 'hidden' | 'rejected'
  /** Who took the app down (present only when status is hidden). A self-takedown
   * is the creator's own action and can be relisted by republishing; an admin
   * takedown is a moderation decision the creator cannot reverse. */
  takedownBy?: 'self' | 'admin'
  /** Creator-visible rejection reason (present only when status is rejected). */
  rejectReason?: string
  /** ISO timestamp of submission. */
  submittedAt?: string
  /** Publish channel the version came through. */
  channel?: string
  /** Install count for the app (0 when unknown). */
  installs?: number
}

// ============================================
// Store Capabilities
// ============================================

/**
 * Creator-identity strength, named after the capability rather than whichever
 * provider happens to supply it — a self-hosted registry must be able to
 * advertise account-level identity without adopting another vendor's vocabulary.
 *   - 'account' : authoritative per-person identity, stable across devices
 *   - 'shared'  : one credential shared by the whole deployment; no per-person binding
 *   - 'none'    : anonymous; publish identity unavailable
 */
export type StoreIdentityMode = 'account' | 'shared' | 'none'

/**
 * Feature advertisement returned by a DHP v2 backend's `GET /capabilities`.
 * Absent (no such endpoint) means the source is catalog-only.
 */
export interface ServerFeatures {
  /**
   * Install-count data is present in the index (`meta.installs`) and may be
   * displayed. This is the read/display side only — it says nothing about
   * whether the server accepts install orders, which is a separate subsystem.
   */
  installs: boolean
  /** Editorial "featured" flag is maintained on this backend. */
  featured: boolean
  /** Curated scene collections are served. */
  collections: boolean
  /** Submit → review → listed/rejected state machine runs on this backend. */
  reviewWorkflow: boolean
  /** Creator-identity strength this backend can establish. A driver downgrades
   * any value it does not recognise, so this is already the closed vocabulary. */
  identityBinding: StoreIdentityMode
}

/** An install the client asks a source to authorise and record. */
export interface InstallOrder {
  slug: string
  version: string
  /** Stable per-installation identifier, used server-side for de-duplication. */
  installId: string
  /**
   * Identifies the install intent, and is what the server counts by. It is held
   * across every retry of one intent and re-minted for a fresh one, so an app
   * whose download keeps failing bills one install rather than one per attempt.
   */
  orderUuid: string
}

/** A granted install order: where the authorised bundle is downloaded from. */
export interface InstallGrant {
  path: string
}

/**
 * Renderer-safe store capability flags. Every gated store UI surface
 * gates its visibility on this object, so a single build serves every edition
 * (community / enterprise / self-hosted) without per-edition branches.
 *
 * Read capabilities (browse/search/detail/install) are always available and do
 * not appear here — they never degrade. Only capabilities that depend on a
 * store backend or identity provider are gated. A field is `false`/`'none'`
 * when its backing source is absent, which renders the corresponding surface
 * hidden rather than broken.
 *
 * Closed shape (plain booleans + one enum), no passthrough: nothing here may
 * leak a URL, token, or deployment topology.
 */
export interface StoreCapabilities {
  /** Browse/search/install baseline. Always true — kept for explicit intent. */
  catalog: true
  /** Store-count board + per-card install counts. Requires install-count data. */
  installs: boolean
  /** Publish entry point. True when a publish target is configured. */
  publish: boolean
  /** Submit → review → online/rejected state machine on the backend. */
  reviewWorkflow: boolean
  /** Creator identity strength for publish / my-publications. */
  identity: StoreIdentityMode
}
