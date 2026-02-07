/**
 * Config Service - Manages application configuration
 */

import { app } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { v4 as uuidv4 } from 'uuid'

// Import analytics config type
import type { AnalyticsConfig } from './analytics/types'
import type {
  AISourcesConfig,
  AISource,
  LegacyAISourcesConfig,
  OAuthSourceConfig,
  CustomSourceConfig,
  ModelOption
} from '../../shared/types'
import { BUILTIN_PROVIDERS, getBuiltinProvider } from '../../shared/constants'
import { decryptString } from './secure-storage.service'

// ============================================================================
// ENCRYPTED DATA MIGRATION
// ============================================================================
// v1.2.10 and earlier used Electron's safeStorage to encrypt API keys/tokens.
// v1.2.12 removed encryption (causes macOS Keychain prompts) but kept decryption
// for backward compatibility. However, if decryption fails (Keychain unavailable,
// cross-machine migration, data corruption), decryptString() returns empty string,
// causing the app to think no API key is configured.
//
// This migration runs once at startup (before any service reads config) to:
// 1. Detect encrypted values (enc: prefix)
// 2. Attempt decryption
// 3. Save plaintext on success, clear invalid data on failure
// 4. Ensure subsequent reads get valid data
// ============================================================================

const ENCRYPTED_PREFIX = 'enc:'

interface MigrationResult {
  migrated: boolean
  fields: string[]
  failures: string[]
}

/**
 * Check if a value is encrypted (has enc: prefix)
 */
function isEncryptedValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX)
}

/**
 * Attempt to decrypt a value and return the result
 * @returns { success: true, value: decrypted } or { success: false }
 */
function tryDecrypt(value: string): { success: true; value: string } | { success: false } {
  const decrypted = decryptString(value)

  // decryptString returns empty string on failure, or the original value if not encrypted
  // For encrypted values, success means we got a non-empty, non-enc: prefixed result
  if (decrypted && !decrypted.startsWith(ENCRYPTED_PREFIX)) {
    return { success: true, value: decrypted }
  }

  return { success: false }
}

/**
 * Migrate encrypted credentials to plaintext
 *
 * This function reads the config file directly (bypassing getConfig() to avoid
 * triggering decryption in ai-sources/manager.ts) and migrates any encrypted
 * values to plaintext.
 *
 * Called once at app startup, before any IPC handlers are registered.
 */
function migrateEncryptedCredentials(): void {
  const configPath = getConfigPath()

  if (!existsSync(configPath)) {
    return // No config file, nothing to migrate
  }

  let parsed: Record<string, any>
  try {
    const content = readFileSync(configPath, 'utf-8')
    parsed = JSON.parse(content)
  } catch (error) {
    console.error('[Config Migration] Failed to read config file:', error)
    return // Don't block startup on migration failure
  }

  const result: MigrationResult = {
    migrated: false,
    fields: [],
    failures: []
  }

  // 1. Migrate legacy api.apiKey (if exists and encrypted)
  if (parsed.api && isEncryptedValue(parsed.api.apiKey)) {
    const decryptResult = tryDecrypt(parsed.api.apiKey)
    if (decryptResult.success) {
      parsed.api.apiKey = decryptResult.value
      result.migrated = true
      result.fields.push('api.apiKey')
    } else {
      parsed.api.apiKey = ''
      result.migrated = true
      result.failures.push('api.apiKey')
    }
  }

  // 2. Migrate aiSources.custom.apiKey
  if (parsed.aiSources?.custom && isEncryptedValue(parsed.aiSources.custom.apiKey)) {
    const decryptResult = tryDecrypt(parsed.aiSources.custom.apiKey)
    if (decryptResult.success) {
      parsed.aiSources.custom.apiKey = decryptResult.value
      result.migrated = true
      result.fields.push('aiSources.custom.apiKey')
    } else {
      parsed.aiSources.custom.apiKey = ''
      result.migrated = true
      result.failures.push('aiSources.custom.apiKey')
    }
  }

  // 3. Migrate OAuth provider tokens (accessToken, refreshToken)
  // OAuth providers are stored as aiSources[providerName] where providerName != 'current' and != 'custom'
  if (parsed.aiSources && typeof parsed.aiSources === 'object') {
    for (const [key, value] of Object.entries(parsed.aiSources)) {
      // Skip non-provider keys
      if (key === 'current' || key === 'custom' || !value || typeof value !== 'object') {
        continue
      }

      const provider = value as Record<string, any>

      // Migrate accessToken
      if (isEncryptedValue(provider.accessToken)) {
        const decryptResult = tryDecrypt(provider.accessToken)
        if (decryptResult.success) {
          provider.accessToken = decryptResult.value
          result.migrated = true
          result.fields.push(`aiSources.${key}.accessToken`)
        } else {
          provider.accessToken = ''
          result.migrated = true
          result.failures.push(`aiSources.${key}.accessToken`)
        }
      }

      // Migrate refreshToken
      if (isEncryptedValue(provider.refreshToken)) {
        const decryptResult = tryDecrypt(provider.refreshToken)
        if (decryptResult.success) {
          provider.refreshToken = decryptResult.value
          result.migrated = true
          result.fields.push(`aiSources.${key}.refreshToken`)
        } else {
          provider.refreshToken = ''
          result.migrated = true
          result.failures.push(`aiSources.${key}.refreshToken`)
        }
      }
    }
  }

  // Save migrated config if any changes were made
  if (result.migrated) {
    try {
      writeFileSync(configPath, JSON.stringify(parsed, null, 2))

      if (result.fields.length > 0) {
        console.log(`[Config Migration] Successfully migrated: ${result.fields.join(', ')}`)
      }
      if (result.failures.length > 0) {
        console.warn(
          `[Config Migration] Failed to decrypt (cleared): ${result.failures.join(', ')}. ` +
            'User will need to re-enter these credentials.'
        )
      }
    } catch (error) {
      console.error('[Config Migration] Failed to save migrated config:', error)
      // Don't throw - let the app continue, user can re-enter credentials
    }
  }
}

// ============================================================================
// AI SOURCES V1 → V2 MIGRATION (ONE-TIME, PERSISTED)
// ============================================================================
// v1 stored aiSources as { current, custom: { apiKey, ... }, [provider]: { ... } }
// v2 uses { version: 2, currentId, sources: AISource[] }
//
// Previously, migrateAiSourcesToV2() ran inside every getConfig() call without
// persisting results to disk, generating a new UUID each time. This caused:
// 1. Redundant migration on every config read (~6+ times during startup)
// 2. Different currentId seen by different callers (UUID instability)
//
// This function runs once at startup and writes the result to disk, so
// subsequent getConfig() calls see version:2 and skip migration entirely.
// ============================================================================

/**
 * One-time migration: convert v1 aiSources to v2 format and persist to disk.
 *
 * Reads the config file directly (like migrateEncryptedCredentials), applies
 * the migration, and writes back. After this, the file has version:2 and
 * migrateAiSourcesToV2() in getConfig() becomes a no-op (isV2AiSources check).
 *
 * Safe to call multiple times — skips if already v2.
 */
function migrateAiSourcesToV2OnDisk(): void {
  const configPath = getConfigPath()

  if (!existsSync(configPath)) {
    return // No config file, nothing to migrate
  }

  let parsed: Record<string, any>
  try {
    const content = readFileSync(configPath, 'utf-8')
    parsed = JSON.parse(content)
  } catch (error) {
    console.error('[Config Migration] Failed to read config for v2 aiSources migration:', error)
    return
  }

  // Already v2 — nothing to do
  if (isV2AiSources(parsed?.aiSources)) {
    return
  }

  // Run the existing migration logic (produces v2 in-memory)
  const migrated = migrateAiSourcesToV2(parsed)

  // Only persist if migration produced sources or the file had v1 data
  // (even an empty sources array with version:2 is valid — means nothing to migrate)
  parsed.aiSources = migrated

  try {
    writeFileSync(configPath, JSON.stringify(parsed, null, 2))
    console.log('[Config Migration] Persisted v2 aiSources to disk:', {
      sourceCount: migrated.sources.length,
      currentId: migrated.currentId
    })
  } catch (error) {
    console.error('[Config Migration] Failed to persist v2 aiSources:', error)
    // Non-fatal: getConfig() will still do in-memory migration as fallback
  }
}

// ============================================================================
// API Config Change Notification (Callback Pattern)
// ============================================================================
// When API config changes (provider/apiKey/apiUrl), subscribers are notified.
// This allows agent.service to invalidate sessions without circular dependency.
// agent.service imports onApiConfigChange (agent → config, existing direction)
// config.service calls registered callbacks (no import from agent)
// ============================================================================

type ApiConfigChangeHandler = () => void
const apiConfigChangeHandlers: ApiConfigChangeHandler[] = []

// ============================================================================
// CREDENTIALS GENERATION COUNTER
// ============================================================================
// A monotonically increasing counter that increments whenever API credentials change.
// Sessions record their generation at creation time. When reusing a session, we compare
// generations - if different, the session was created with stale credentials and must
// be recreated. This is a standard cache invalidation pattern (similar to database
// optimistic locking) that provides deterministic correctness regardless of async timing.
// ============================================================================

let credentialsGeneration = 0

/**
 * Get the current credentials generation counter.
 * Sessions compare this value to detect stale credentials.
 */
export function getCredentialsGeneration(): number {
  return credentialsGeneration
}

/**
 * Register a callback to be notified when API config changes.
 * Used by agent.service to invalidate sessions on config change.
 *
 * @returns Unsubscribe function
 */
export function onApiConfigChange(handler: ApiConfigChangeHandler): () => void {
  apiConfigChangeHandlers.push(handler)
  return () => {
    const idx = apiConfigChangeHandlers.indexOf(handler)
    if (idx >= 0) apiConfigChangeHandlers.splice(idx, 1)
  }
}

// Types (shared with renderer)
interface HaloConfig {
  api: {
    provider: 'anthropic' | 'openai' | 'custom'
    apiKey: string
    apiUrl: string
    model: string
  }
  // Multi-source AI configuration (OAuth + Custom API)
  aiSources?: AISourcesConfig
  permissions: {
    fileAccess: 'allow' | 'ask' | 'deny'
    commandExecution: 'allow' | 'ask' | 'deny'
    networkAccess: 'allow' | 'ask' | 'deny'
    trustMode: boolean
  }
  appearance: {
    theme: 'light' | 'dark' | 'system'
  }
  system: {
    autoLaunch: boolean
  }
  remoteAccess: {
    enabled: boolean
    port: number
  }
  onboarding: {
    completed: boolean
  }
  // MCP servers configuration (compatible with Cursor / Claude Desktop format)
  mcpServers: Record<string, McpServerConfig>
  isFirstLaunch: boolean
  // Analytics configuration (auto-generated on first launch)
  analytics?: AnalyticsConfig
  // Git Bash configuration (Windows only)
  gitBash?: {
    installed: boolean
    path: string | null
    skipped: boolean
  }
}

// MCP server configuration types
type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig

interface McpStdioServerConfig {
  type?: 'stdio'  // Optional, defaults to stdio
  command: string
  args?: string[]
  env?: Record<string, string>
  timeout?: number
  disabled?: boolean  // Halo extension: temporarily disable this server
}

interface McpHttpServerConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
  disabled?: boolean  // Halo extension: temporarily disable this server
}

interface McpSseServerConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
  disabled?: boolean  // Halo extension: temporarily disable this server
}

// Paths
// Use os.homedir() instead of app.getPath('home') to respect HOME environment variable
// This is essential for E2E tests to run in isolated test directories
export function getHaloDir(): string {
  // 1. Support custom data directory via environment variable
  //    Useful for development to avoid conflicts with production data
  if (process.env.HALO_DATA_DIR) {
    let dir = process.env.HALO_DATA_DIR
    // Expand ~ to home directory (shell doesn't expand in env vars)
    if (dir.startsWith('~')) {
      dir = join(homedir(), dir.slice(1))
    }
    return dir
  }

  // 2. Auto-detect development mode: use separate directory
  //    app.isPackaged is false when running via electron-vite dev
  if (!app.isPackaged) {
    return join(homedir(), '.halo-dev')
  }

  // 3. Production: use default directory
  return join(homedir(), '.halo')
}

export function getConfigPath(): string {
  return join(getHaloDir(), 'config.json')
}

export function getTempSpacePath(): string {
  return join(getHaloDir(), 'temp')
}

export function getSpacesDir(): string {
  return join(getHaloDir(), 'spaces')
}

// Default model (Opus 4.5)
const DEFAULT_MODEL = 'claude-opus-4-5-20251101'

// Default configuration
const DEFAULT_CONFIG: HaloConfig = {
  api: {
    provider: 'anthropic',
    apiKey: '',
    apiUrl: 'https://api.anthropic.com',
    model: DEFAULT_MODEL
  },
  aiSources: {
    version: 2,
    currentId: null,
    sources: []
  },
  permissions: {
    fileAccess: 'allow',
    commandExecution: 'ask',
    networkAccess: 'allow',
    trustMode: false
  },
  appearance: {
    theme: 'dark'
  },
  system: {
    autoLaunch: false
  },
  remoteAccess: {
    enabled: false,
    port: 3456
  },
  onboarding: {
    completed: false
  },
  mcpServers: {},  // Empty by default
  isFirstLaunch: true
}

// ============================================================================
// AI SOURCES V2 MIGRATION
// ============================================================================
// v1 format: { current: 'custom', custom: {...}, oauth: {...}, 'github-copilot': {...} }
// v2 format: { version: 2, currentId: 'uuid', sources: [...] }
//
// Migration handles:
// 1. Legacy api field only (no aiSources)
// 2. v1 aiSources with custom/oauth/dynamic keys
// 3. Pre-release formats with custom_xxx keys (cleared)
// ============================================================================

/**
 * Check if aiSources is already v2 format
 */
function isV2AiSources(raw: unknown): raw is AISourcesConfig {
  if (!raw || typeof raw !== 'object') return false
  const obj = raw as Record<string, unknown>
  return obj.version === 2 && Array.isArray(obj.sources)
}

/**
 * Migrate legacy aiSources (v1) to v2 format
 */
function migrateAiSourcesToV2(parsed: Record<string, any>): AISourcesConfig {
  const raw = parsed?.aiSources
  const now = new Date().toISOString()

  // Already v2 format - return as is
  if (isV2AiSources(raw)) {
    return raw
  }

  // Initialize empty v2 config
  const newConfig: AISourcesConfig = {
    version: 2,
    currentId: null,
    sources: []
  }

  // Check for pre-release format (custom_xxx keys) - clear these
  if (raw && typeof raw === 'object') {
    const keys = Object.keys(raw)
    const hasPreRelease = keys.some(k => k.startsWith('custom_'))
    if (hasPreRelease) {
      console.log('[Config Migration] Pre-release format detected (custom_xxx keys), resetting aiSources')
      return newConfig
    }
  }

  // Migrate from legacy api field (no aiSources)
  const legacyApi = parsed?.api
  const hasLegacyApiOnly = !raw && legacyApi?.apiKey

  if (hasLegacyApiOnly) {
    const provider = legacyApi.provider === 'openai' ? 'openai' : 'anthropic'
    const builtin = getBuiltinProvider(provider)

    const source: AISource = {
      id: uuidv4(),
      name: builtin?.name || 'Default API',
      provider,
      authType: 'api-key',
      apiUrl: legacyApi.apiUrl || builtin?.apiUrl || 'https://api.anthropic.com',
      apiKey: legacyApi.apiKey,
      model: legacyApi.model || DEFAULT_MODEL,
      availableModels: builtin?.models || [{ id: legacyApi.model || DEFAULT_MODEL, name: legacyApi.model || 'Default' }],
      createdAt: now,
      updatedAt: now
    }

    newConfig.sources.push(source)
    newConfig.currentId = source.id
    console.log('[Config Migration] Migrated legacy api field to v2 aiSources')
    return newConfig
  }

  // Migrate from v1 aiSources format
  if (raw && typeof raw === 'object') {
    const v1Config = raw as LegacyAISourcesConfig

    // Migrate custom API source
    if (v1Config.custom?.apiKey) {
      const custom = v1Config.custom
      const provider = custom.provider === 'openai' ? 'openai' : 'anthropic'
      const builtin = getBuiltinProvider(provider)

      const source: AISource = {
        id: custom.id || uuidv4(),
        name: custom.name || builtin?.name || 'Custom API',
        provider,
        authType: 'api-key',
        apiUrl: custom.apiUrl || builtin?.apiUrl || 'https://api.anthropic.com',
        apiKey: custom.apiKey,
        model: custom.model || DEFAULT_MODEL,
        availableModels: custom.availableModels?.map(id => ({ id, name: id })) ||
          builtin?.models || [{ id: custom.model || DEFAULT_MODEL, name: custom.model || 'Default' }],
        createdAt: now,
        updatedAt: now
      }

      newConfig.sources.push(source)

      // Set as current if v1 current was 'custom'
      if (v1Config.current === 'custom') {
        newConfig.currentId = source.id
      }
    }

    // Migrate OAuth providers (any key except 'current' and 'custom')
    // DISABLED: OAuth migration is skipped to avoid complexity and bugs
    // Users with OAuth sources will need to re-login after upgrade
    /*
    for (const [key, value] of Object.entries(v1Config)) {
      if (key === 'current' || key === 'custom' || !value || typeof value !== 'object') {
        continue
      }

      const oauthConfig = value as OAuthSourceConfig

      // Skip if not logged in or no access token
      if (!oauthConfig.loggedIn || !oauthConfig.accessToken) {
        continue
      }

      const builtin = getBuiltinProvider(key)

      // Convert model names to ModelOption format
      const availableModels: ModelOption[] = (oauthConfig.availableModels || []).map(id => ({
        id,
        name: oauthConfig.modelNames?.[id] || id
      }))

      // Ensure at least one model
      if (availableModels.length === 0 && oauthConfig.model) {
        availableModels.push({
          id: oauthConfig.model,
          name: oauthConfig.modelNames?.[oauthConfig.model] || oauthConfig.model
        })
      }

      const source: AISource = {
        id: uuidv4(),
        name: builtin?.name || key,
        provider: key,
        authType: 'oauth',
        apiUrl: '',
        accessToken: oauthConfig.accessToken,
        refreshToken: oauthConfig.refreshToken,
        tokenExpires: oauthConfig.tokenExpires,
        user: oauthConfig.user,
        model: oauthConfig.model || '',
        availableModels,
        createdAt: now,
        updatedAt: now
      }

      newConfig.sources.push(source)

      // Set as current if v1 current matches this provider
      if (v1Config.current === key) {
        newConfig.currentId = source.id
      }
    }
    */

    // If no currentId set but we have sources, use the first one
    if (!newConfig.currentId && newConfig.sources.length > 0) {
      newConfig.currentId = newConfig.sources[0].id
    }

    console.log('[Config Migration] Migrated v1 aiSources to v2:', {
      sourceCount: newConfig.sources.length,
      currentId: newConfig.currentId
    })
  }

  return newConfig
}

/**
 * Normalize aiSources - handles migration from all legacy formats to v2
 */
function normalizeAiSources(parsed: Record<string, any>): AISourcesConfig {
  // Migrate to v2 format (handles all legacy formats)
  return migrateAiSourcesToV2(parsed)
}

function getAiSourcesSignature(aiSources?: AISourcesConfig): string {
  if (!aiSources) return ''

  // v2 format: use currentId and sources array
  if (aiSources.version === 2 && Array.isArray(aiSources.sources)) {
    const currentSource = aiSources.sources.find(s => s.id === aiSources.currentId)
    if (!currentSource) return ''

    // Note: model is excluded from signature because V2 Session supports dynamic model switching
    // (via setModel method). Only changes to credentials/provider should invalidate sessions.
    if (currentSource.authType === 'api-key') {
      return [
        'api-key',
        currentSource.provider || '',
        currentSource.apiUrl || '',
        currentSource.apiKey || ''
        // model excluded: dynamic switching supported
      ].join('|')
    }

    // OAuth source
    return [
      'oauth',
      currentSource.provider || '',
      currentSource.accessToken || '',
      currentSource.refreshToken || '',
      currentSource.tokenExpires || ''
      // model excluded: dynamic switching supported
    ].join('|')
  }

  // Legacy v1 format fallback (should not happen after migration)
  const legacy = aiSources as unknown as LegacyAISourcesConfig
  const current = legacy.current || 'custom'

  if (current === 'custom') {
    const custom = legacy.custom
    return [
      'custom',
      custom?.provider || '',
      custom?.apiUrl || '',
      custom?.apiKey || ''
    ].join('|')
  }

  const currentConfig = legacy[current] as Record<string, any> | undefined
  if (currentConfig && typeof currentConfig === 'object') {
    return [
      'oauth',
      current,
      currentConfig.accessToken || '',
      currentConfig.refreshToken || '',
      currentConfig.tokenExpires || ''
    ].join('|')
  }

  return current
}

// Initialize app directories
export async function initializeApp(): Promise<void> {
  const haloDir = getHaloDir()
  const tempDir = getTempSpacePath()
  const spacesDir = getSpacesDir()
  const tempArtifactsDir = join(tempDir, 'artifacts')
  const tempConversationsDir = join(tempDir, 'conversations')

  // Create directories if they don't exist
  const dirs = [haloDir, tempDir, spacesDir, tempArtifactsDir, tempConversationsDir]
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  // Create default config if it doesn't exist
  const configPath = getConfigPath()
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2))
  }

  // Migrate encrypted credentials to plaintext (v1.2.10 -> v1.2.12+)
  // This must run before any service reads the config to ensure decryption
  // happens at the file level, not at read time where failures cause issues.
  migrateEncryptedCredentials()

  // Migrate aiSources from v1 to v2 format (one-time, persisted to disk)
  // This must run after migrateEncryptedCredentials() so apiKeys are already plaintext.
  // Previously, migration ran inside every getConfig() call without persisting,
  // generating new UUIDs each time and causing inconsistent currentIds.
  migrateAiSourcesToV2OnDisk()
}

// Get configuration
export function getConfig(): HaloConfig {
  const configPath = getConfigPath()

  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG
  }

  try {
    const content = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(content)
    const aiSources = normalizeAiSources(parsed)
    // Deep merge to ensure all nested defaults are applied
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      api: { ...DEFAULT_CONFIG.api, ...parsed.api },
      aiSources,
      permissions: { ...DEFAULT_CONFIG.permissions, ...parsed.permissions },
      appearance: { ...DEFAULT_CONFIG.appearance, ...parsed.appearance },
      system: { ...DEFAULT_CONFIG.system, ...parsed.system },
      onboarding: { ...DEFAULT_CONFIG.onboarding, ...parsed.onboarding },
      // mcpServers is a flat map, just use parsed value or default
      mcpServers: parsed.mcpServers || DEFAULT_CONFIG.mcpServers,
      // analytics: keep as-is (managed by analytics.service.ts)
      analytics: parsed.analytics
    }
  } catch (error) {
    console.error('Failed to read config:', error)
    return DEFAULT_CONFIG
  }
}

// Save configuration
export function saveConfig(config: Partial<HaloConfig>): HaloConfig {
  const currentConfig = getConfig()
  const newConfig = { ...currentConfig, ...config }
  const previousAiSourcesSignature = getAiSourcesSignature(currentConfig.aiSources)

  // Deep merge for nested objects
  if (config.api) {
    newConfig.api = { ...currentConfig.api, ...config.api }
  }
  if (config.permissions) {
    newConfig.permissions = { ...currentConfig.permissions, ...config.permissions }
  }
  if (config.appearance) {
    newConfig.appearance = { ...currentConfig.appearance, ...config.appearance }
  }
  if (config.system) {
    newConfig.system = { ...currentConfig.system, ...config.system }
  }
  if (config.onboarding) {
    newConfig.onboarding = { ...currentConfig.onboarding, ...config.onboarding }
  }
  // mcpServers: replace entirely when provided (not merged)
  if (config.mcpServers !== undefined) {
    newConfig.mcpServers = config.mcpServers
  }
  // analytics: replace entirely when provided (managed by analytics.service.ts)
  if (config.analytics !== undefined) {
    newConfig.analytics = config.analytics
  }
  // gitBash: replace entirely when provided (Windows only)
  if ((config as any).gitBash !== undefined) {
    (newConfig as any).gitBash = (config as any).gitBash
  }

  const configPath = getConfigPath()
  writeFileSync(configPath, JSON.stringify(newConfig, null, 2))

  // Detect API config changes and notify subscribers
  // This allows agent.service to invalidate sessions when API config changes
  const nextAiSourcesSignature = getAiSourcesSignature(newConfig.aiSources)
  const aiSourcesChanged = previousAiSourcesSignature !== nextAiSourcesSignature

  if (config.api || config.aiSources) {
    const apiChanged =
      !!config.api &&
      (config.api.provider !== currentConfig.api.provider ||
        config.api.apiKey !== currentConfig.api.apiKey ||
        config.api.apiUrl !== currentConfig.api.apiUrl)

    if (apiChanged || aiSourcesChanged) {
      // Increment credentials generation counter - sessions will detect stale credentials
      credentialsGeneration++
      console.log(`[Config] Credentials generation: ${credentialsGeneration}`)
    }

    if ((apiChanged || aiSourcesChanged) && apiConfigChangeHandlers.length > 0) {
      console.log('[Config] API config changed, notifying subscribers...')
      // Use setTimeout to avoid blocking the save operation
      // and ensure all handlers are called asynchronously
      setTimeout(() => {
        apiConfigChangeHandlers.forEach(handler => {
          try {
            handler()
          } catch (e) {
            console.error('[Config] Error in API config change handler:', e)
          }
        })
      }, 0)
    }
  }

  return newConfig
}

/**
 * Set auto launch on system startup
 */
export function setAutoLaunch(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true, // Start minimized
    // On macOS, also set to open at login for all users (requires admin)
    // path: process.execPath, // Optional: specify executable path
  })

  // Save to config
  saveConfig({ system: { autoLaunch: enabled } })
  console.log(`[Config] Auto launch set to: ${enabled}`)
}

/**
 * Get current auto launch status
 */
export function getAutoLaunch(): boolean {
  const settings = app.getLoginItemSettings()
  return settings.openAtLogin
}
