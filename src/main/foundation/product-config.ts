/**
 * Product Configuration (product.json) — foundation tier.
 *
 * Reads the build-time `product.json` that drives per-variant behavior
 * (data folder isolation, auth providers, update channel, browser policy,
 * registry overrides, IM defaults, telemetry, security flags).
 *
 * This module is foundation-grade: it depends only on Electron/Node and
 * shared types, and is safe to import from any upper tier. It deliberately
 * holds no domain logic — provider *loading* lives in
 * `services/ai-sources/auth-loader.ts`, security *predicates* in
 * `services/security-policy.ts`; both read their slice from here.
 */

import { join } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'
import { type AuthProviderConfig } from '../../shared/types'
import type { CategoryTaxonomy, RegistrySource } from '../../shared/store/store-types'

// AuthProviderConfig is defined in src/shared/types/ai-sources.ts so the main
// loader and the renderer setup UI share one source of truth. Re-exported here
// for ergonomic local imports from this module.
export { type AuthProviderConfig }

/**
 * Update configuration for auto-updater
 */
export interface UpdateConfig {
  /** Provider type: 'github' for GitHub Releases, 'generic' for custom server */
  provider: 'github' | 'generic'
  /** URL for generic provider (empty string = disabled) */
  url?: string
  /** GitHub repository owner (for github provider) */
  owner?: string
  /** GitHub repository name (for github provider) */
  repo?: string
}

/**
 * Browser network access policy (enterprise feature).
 *
 * Controls which domains the embedded browser is allowed to navigate to.
 * When not configured, the browser is unrestricted (default for open-source).
 *
 * - "allowlist": only domains matching the patterns are permitted.
 * - "blocklist": all domains except those matching the patterns are permitted.
 * - "unrestricted": no restrictions (explicit opt-out, same as omitting the field).
 */
export interface BrowserPolicy {
  /** Policy mode */
  mode: 'allowlist' | 'blocklist' | 'unrestricted'
  /** Domain patterns for allowlist mode (e.g. "*.weoa.com", "example.com") */
  allowlist?: string[]
  /** Domain patterns for blocklist mode */
  blocklist?: string[]
  /** Default homepage URL for new browser tabs (defaults to about:blank when policy is active) */
  homepage?: string
  /**
   * Allowlist mode only: when true, users may add their own allowlist
   * entries (persisted in config.json `browser.customAllowlist`) via the
   * Settings UI and the blocked-page "allow and retry" action. User entries
   * can only widen the allowlist — mode and built-in patterns stay fixed.
   * Omitted/false → the allowlist is fully locked (default).
   */
  userExtensible?: boolean
}

/**
 * Per-registry override entry in product.json.
 *
 * Allows enterprise/custom builds to override specific built-in registry
 * properties without touching source code. Only declared fields are applied;
 * omitted fields retain their built-in defaults.
 *
 * - `url`        — replace the registry endpoint (e.g. point to an internal mirror)
 * - `name`       — replace the display name shown in the Store UI
 * - `sourceType` — replace the protocol driver. A deployment that redirects a
 *                  built-in source to its own server declares the server's
 *                  protocol here; omitting it leaves the built-in default, so
 *                  the backend surface stays dark.
 * - `enabled` — force-enable or force-disable the registry on every startup;
 *               overrides the user's manual toggle in Settings. The entry
 *               is still visible in the registry list, just locked.
 * - `hidden`  — when true, the registry is removed entirely. The entry will
 *               not appear in the Store UI and any persisted copy from a
 *               previous run is dropped on the next startup. Use this
 *               (instead of `enabled: false`) when the policy forbids the
 *               registry outright — showing a permanently-off toggle for
 *               an immutable built-in is dead UI and misleading.
 *               `hidden: true` takes precedence over `enabled`.
 */
export interface RegistryOverride {
  url?: string
  name?: string
  sourceType?: RegistrySource['sourceType']
  enabled?: boolean
  hidden?: boolean
  /**
   * Publish target for the App detail page's "Publish" button.
   * The user never picks the target — it is determined by product.json.
   *
   *   - 'github-pr':     open a draft PR against an OSS DHP repo (requires `github.owner/repo`)
   *   - 'http-registry': POST a multipart .dhpkg to a private registry with a Bearer token
   *   - 'local-dhpkg':   write a .dhpkg via the system save dialog (no network)
   */
  publish?: {
    target: 'github-pr' | 'http-registry' | 'local-dhpkg'
    /** Required when target === 'github-pr' */
    github?: { owner: string; repo: string; clientId?: string }
    /** Required when target === 'http-registry'; must be replaced at deploy time. */
    token?: string
  }
}

/**
 * Enterprise service defaults — pre-populated configuration for internal services.
 *
 * Each key maps to a service's config type with optional fields.
 * At runtime, these defaults are merged under user config (user values take precedence).
 * Open-source builds omit this entirely; enterprise builds set values in product.json.
 */
export interface ServiceDefaults {
  /** Default email channel configuration (partial — user config wins) */
  email?: Partial<import('../../shared/types/notification-channels').EmailChannelConfig>
}

// ============================================
// IM Channels product defaults
// ============================================

/**
 * Default permission control settings for new IM channel instances.
 *
 * Injected via product.json at build time. Only affects the INITIAL state
 * when a user creates a new IM channel instance — users can override per-instance.
 *
 * Enterprise builds typically set `defaultEnabled: true` with a restrictive guest policy.
 * Open-source/personal builds omit this entirely (defaults to no restrictions).
 */
export interface ImChannelsPermissionDefaults {
  /** Whether Permission Control toggle is ON by default for new instances */
  defaultEnabled?: boolean
  /** Whether Guest Access toggle is ON by default (within permission control) */
  defaultGuestAccess?: boolean
  /** Default guest policy pre-populated for new instances */
  defaultGuestPolicy?: {
    allowedTools?: string[]
  }
  /** Placeholder hint for the Owner User IDs input (enterprise-customizable) */
  ownerIdHint?: string
  /**
   * Documentation URL appended to the no-owner guide message sent in IM
   * when permission control is on but no owner is bound yet.
   */
  ownerSetupGuideUrl?: string
}

/**
 * IM Channels section of product.json.
 */
export interface ImChannelsProductConfig {
  /** Default permission settings for new IM channel instances */
  permissionControl?: ImChannelsPermissionDefaults
}

/**
 * Store section of product.json.
 *
 * `categories` is the no-server scene-category enumeration: a deployment
 * without a store server (which would otherwise own the enum) can
 * still customize categories here without forking. It is the middle tier of
 * the resolution chain `server ?? product.json ?? built-in`; a build that
 * omits it falls back to the built-in community set.
 */
export interface StoreProductConfig {
  categories?: CategoryTaxonomy
}

// ============================================
// Product Configuration
// ============================================

/**
 * Product configuration from product.json
 */
export interface ProductConfig {
  name: string
  version: string
  /**
   * Data folder name for per-variant isolation (e.g. 'halo', 'halo-enterprise').
   * Controls both the Halo config directory (~/.{dataFolderName}/) and
   * Electron userData directory. Defaults to 'halo' when omitted.
   */
  dataFolderName?: string
  authProviders: AuthProviderConfig[]
  /** Update configuration (optional, defaults to GitHub if not specified) */
  updateConfig?: UpdateConfig
  /** Browser network access policy (optional, unrestricted when omitted) */
  browserPolicy?: BrowserPolicy
  /**
   * Announcement feed URL (optional; omitted/empty disables the feature).
   *
   * A plain JSON document matching `shared/types/announcement.ts`, served as a
   * static file — deliberately not an API, so publishing is a file upload and
   * retracting is emptying the list. Deployments usually point this at the same
   * static host that serves the update feed.
   *
   * Kept separate from `updateConfig` on purpose: release notes only reach users
   * who are behind on versions, so they cannot carry a message meant for
   * everyone.
   */
  announcementsUrl?: string
  /**
   * Enterprise service defaults (optional).
   * Pre-populates service configurations so internal users don't need manual setup.
   * Open-source builds omit this field entirely.
   */
  serviceDefaults?: ServiceDefaults
  /**
   * Built-in registry overrides (optional, enterprise/custom builds only).
   *
   * Keys are built-in registry IDs ('official', 'mcp-official', 'smithery',
   * 'claude-skills'). Each entry is merged on top of the built-in defaults
   * during `ensureBuiltinRegistries()` on every startup, making the values
   * immutable from the user's perspective (same semantics as `url`/`name`).
   *
   * Example (product.enterprise.json):
   * ```json
   * "registryOverrides": {
   *   "official":      { "url": "http://10.x.x.x:18081", "name": "Enterprise Registry" },
   *   "mcp-official":  { "hidden": true },
   *   "smithery":      { "hidden": true },
   *   "claude-skills": { "hidden": true }
   * }
   * ```
   *
   * Use `hidden: true` to remove a built-in registry entirely from the
   * Store UI. Use `enabled: false` only when the entry should remain
   * visible but locked off (rare; mostly useful for staged rollouts).
   */
  registryOverrides?: Record<string, RegistryOverride>
  /**
   * IM channel defaults (optional, enterprise/custom builds only).
   *
   * Controls default permission settings for new IM channel instances.
   * Open-source builds omit this (no restrictions by default).
   */
  imChannels?: ImChannelsProductConfig

  /**
   * Store configuration (optional).
   *
   * Holds the no-server scene-category enumeration. Open-source/community
   * builds omit this and fall back to the built-in category set.
   */
  store?: StoreProductConfig

  /**
   * Store creator-identity provider (optional).
   *
   * Declares which AI-source provider type supplies the authoritative user
   * identity used for publish attribution and "my publications" (e.g.
   * "halo-cloud"). The store reads the signed-in token of this provider
   * and forwards it to an identity-bound store server. Omitted → no account
   * binding; the store falls back to whatever the server advertises ('shared'
   * or 'none'). The generic core references only this field, never a specific
   * provider.
   */
  identityProvider?: string

  /**
   * Identity source for telemetry (optional).
   *
   * A dot-path describing where to read the externally-meaningful user ID
   * (e.g. an enterprise SSO UID) from the current AI source. The path is
   * resolved against the active entry in `aiSources.sources[]`. Example
   * values:
   *   - "user.uid"     — enterprise OAuth UID (default for SSO providers)
   *   - "user.email"   — fall back to email when UID is unavailable
   *
   * When omitted, telemetry falls back to the anonymous per-install UUID
   * generated on first launch. Safe to set in open-source builds — it has
   * no effect unless the telemetry provider is also configured.
   */
  identitySource?: string

  /**
   * Telemetry configuration (optional, enterprise/custom builds only).
   *
   * Whitelists which property keys in the analytics module's SENSITIVE_KEYS
   * set may be forwarded to the self-hosted telemetry backend. The
   * SENSITIVE_KEYS set covers user-authored / user-identifiable fields
   * (spec.name, space name, model name, MCP/skill/im bot names, token
   * counts, error codes). Open-source builds MUST omit this entirely —
   * every SENSITIVE_KEYS property is dropped at sanitize time, in addition
   * to the empty-endpoint provider-disabled safety net. Enterprise builds
   * opt-in per field.
   */
  telemetry?: {
    /**
     * Telemetry backend base URL (client sends POST {endpoint}/v1/events)
     * and its Bearer token. Both ship inside the package and are readable
     * by any user — they are per-variant configuration, not secrets, and
     * live committed in the variant repo. Empty/omitted disables the
     * provider. Real abuse protection belongs server-side.
     */
    endpoint?: string
    apiKey?: string
    allowedSensitiveFields?: string[]
  }

  /**
   * Public analytics providers (optional, brand builds only).
   *
   * Identifiers ship inside the package (user-readable) — configuration,
   * not secrets. Open-source builds omit this block entirely, which
   * disables every provider.
   */
  analytics?: {
    ga?: {
      measurementId?: string
      apiSecret?: string
    }
    baidu?: {
      siteId?: string
    }
  }

  /**
   * Tunnel issuer endpoint override (optional).
   *
   * Base URL of the named-tunnel issuer service that grants each device a
   * permanent remote-access hostname. When omitted, the built-in default in
   * `services/tunnel-issuer.client.ts` applies. Enterprise builds may point
   * this at a self-hosted issuer.
   */
  tunnelIssuerUrl?: string

  /**
   * Security policy (optional, enterprise/custom builds only).
   *
   * Each flag is "safe mode ON" — set to true to enable restrictions.
   * Open-source builds omit this entirely and keep permissive defaults.
   * The flag definitions and consumers live in
   * `src/main/services/security-policy.ts` — the only place a new flag
   * needs to be defined.
   *
   * Typed as `unknown` here to keep this foundation module free of any
   * dependency on the security-policy domain module (which itself reads
   * loadProductConfig()). The security-policy module re-narrows the value
   * to its own SecurityPolicy type at access time.
   */
  security?: Record<string, unknown>
}

// ============================================================================
// Product Configuration Loading
// ============================================================================

let productConfig: ProductConfig | null = null
let productConfigPath: string | null = null

/**
 * Get the path to product.json.
 *
 * In development, product.json is in project root; in production it lives
 * inside app.asar. `app.getAppPath()` resolves to the right base in both
 * cases, so a single join handles both.
 *
 * A `product.local.json` next to it takes precedence in unpackaged builds so a
 * developer can point at local services without editing the packaged
 * product.json (which electron-builder generates). It never applies once packaged.
 */
export function getProductConfigPath(): string {
  if (productConfigPath) return productConfigPath
  const base = app.getAppPath()
  const localPath = join(base, 'product.local.json')
  productConfigPath = !app.isPackaged && existsSync(localPath)
    ? localPath
    : join(base, 'product.json')
  return productConfigPath
}

/**
 * Load product.json configuration
 */
export function loadProductConfig(): ProductConfig {
  if (productConfig) return productConfig

  const configPath = getProductConfigPath()

  try {
    if (existsSync(configPath)) {
      // Use require for synchronous loading (config is needed at startup)
      delete require.cache[require.resolve(configPath)]
      productConfig = require(configPath) as ProductConfig
      console.log('[ProductConfig] Loaded product.json from:', configPath)
      console.log('[ProductConfig] Auth providers configured:', productConfig.authProviders.map(p => p.type).join(', '))
    } else {
      console.log('[ProductConfig] product.json not found, using defaults')
      productConfig = getDefaultProductConfig()
    }
  } catch (error) {
    console.error('[ProductConfig] Failed to load product.json:', error)
    productConfig = getDefaultProductConfig()
  }

  return productConfig
}

/** Default data folder name when product.json omits dataFolderName */
export const DEFAULT_DATA_FOLDER_NAME = 'halo'

/**
 * Get the data folder name from product.json configuration.
 * Returns the configured dataFolderName or 'halo' as default.
 * Safe to call at any point after Electron app module is available.
 */
export function getDataFolderName(): string {
  return loadProductConfig().dataFolderName || DEFAULT_DATA_FOLDER_NAME
}

/**
 * Get enterprise service defaults from product.json.
 * Returns undefined when no defaults are configured (open-source builds).
 */
export function getServiceDefaults(): ServiceDefaults | undefined {
  return loadProductConfig().serviceDefaults
}

/**
 * Get the announcement feed URL from product.json.
 * Returns undefined when the feature is not configured for this build.
 */
export function getAnnouncementsUrl(): string | undefined {
  return loadProductConfig().announcementsUrl?.trim() || undefined
}

/**
 * Get IM channel permission defaults from product.json.
 * Returns undefined when no defaults are configured (open-source/personal builds).
 */
export function getImChannelsPermissionDefaults(): ImChannelsPermissionDefaults | undefined {
  return loadProductConfig().imChannels?.permissionControl
}

/**
 * Get the identity source dot-path from product.json.
 * Returns undefined when not configured — telemetry should fall back to
 * the anonymous per-install UUID.
 */
export function getIdentitySource(): string | undefined {
  return loadProductConfig().identitySource
}

/**
 * Get the store scene-category enumeration from product.json.
 * Returns undefined when not configured — the taxonomy resolver then falls
 * back to the built-in community set. Shape validation lives with the
 * resolver (store tier), not here.
 */
export function getStoreCategoriesConfig(): CategoryTaxonomy | undefined {
  return loadProductConfig().store?.categories
}

/**
 * Get the declared store identity provider type from product.json.
 * Returns undefined when no identity binding is configured (anonymous builds).
 */
export function getStoreIdentityProvider(): string | undefined {
  return loadProductConfig().identityProvider
}

/**
 * Get the telemetry config block from product.json.
 *
 * Returns undefined when not configured (open-source builds). When
 * present, `allowedSensitiveFields` whitelists which SENSITIVE_KEYS may
 * be forwarded to the telemetry backend — see telemetry provider's
 * sanitize pass for the enforcement.
 */
export function getTelemetryConfig(): ProductConfig['telemetry'] | undefined {
  return loadProductConfig().telemetry
}

/**
 * Get the analytics config block from product.json.
 *
 * Returns undefined when not configured (open-source builds) — the
 * analytics service treats missing/empty identifiers as provider-disabled.
 */
export function getAnalyticsConfig(): ProductConfig['analytics'] | undefined {
  return loadProductConfig().analytics
}

/**
 * Get default product configuration (open-source version)
 */
function getDefaultProductConfig(): ProductConfig {
  return {
    name: 'Halo',
    version: '1.0.0',
    authProviders: [
      {
        type: 'custom',
        displayName: { en: 'Custom API', 'zh-CN': '自定义 API' },
        description: { en: 'Claude / OpenAI compatible', 'zh-CN': '兼容 Claude / OpenAI' },
        icon: 'key',
        iconBgColor: '#da7756',
        recommended: true,
        builtin: true,
        enabled: true
      }
    ]
  }
}
