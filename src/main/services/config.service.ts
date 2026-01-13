/**
 * Config Service - Manages application configuration
 */

import { app } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

// Import analytics config type
import type { AnalyticsConfig } from './analytics/types'

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
    minimizeToTray: boolean
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
    autoLaunch: false,
    minimizeToTray: false
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
    // Deep merge to ensure all nested defaults are applied
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      api: { ...DEFAULT_CONFIG.api, ...parsed.api },
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
  if (config.api) {
    const apiChanged =
      config.api.provider !== currentConfig.api.provider ||
      config.api.apiKey !== currentConfig.api.apiKey ||
      config.api.apiUrl !== currentConfig.api.apiUrl

    if (apiChanged && apiConfigChangeHandlers.length > 0) {
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

// Validate API connection
export async function validateApiConnection(
  apiKey: string,
  apiUrl: string,
  provider: string
): Promise<{ valid: boolean; message?: string; model?: string }> {
  try {
    const trimSlash = (s: string) => s.replace(/\/+$/, '')
    const normalizeOpenAIV1Base = (input: string) => {
      // Accept:
      // - https://host
      // - https://host/v1
      // - https://host/v1/chat/completions
      // - https://host/chat/completions
      let base = trimSlash(input)
      // If user pasted full chat/completions endpoint, strip it
      if (base.endsWith('/chat/completions')) {
        base = base.slice(0, -'/chat/completions'.length)
        base = trimSlash(base)
      }
      // If already contains /v1 anywhere, normalize to ".../v1"
      const v1Idx = base.indexOf('/v1')
      if (v1Idx >= 0) {
        base = base.slice(0, v1Idx + 3) // include "/v1"
        base = trimSlash(base)
        return base
      }
      return `${base}/v1`
    }

    // OpenAI compatible validation: GET /v1/models (does not depend on user-selected model)
    if (provider === 'openai') {
      const baseV1 = normalizeOpenAIV1Base(apiUrl)
      const modelsUrl = `${baseV1}/models`

      const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`
        }
      })

      if (response.ok) {
        const data: any = await response.json().catch(() => ({}))
        const modelId =
          data?.data?.[0]?.id ||
          data?.model ||
          undefined
        return { valid: true, model: modelId }
      }

      const errorText = await response.text().catch(() => '')
      return {
        valid: false,
        message: errorText || `HTTP ${response.status}`
      }
    }

    // Anthropic compatible validation: POST /v1/messages
    const base = trimSlash(apiUrl)
    const messagesUrl = `${base}/v1/messages`
    const response = await fetch(messagesUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }]
      })
    })

    if (response.ok) {
      const data = await response.json()
      return {
        valid: true,
        model: data.model || DEFAULT_MODEL
      }
    } else {
      const error = await response.json().catch(() => ({}))
      return {
        valid: false,
        message: error.error?.message || `HTTP ${response.status}`
      }
    }
  } catch (error: unknown) {
    const err = error as Error
    return {
      valid: false,
      message: err.message || 'Connection failed'
    }
  }
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
  saveConfig({ system: { autoLaunch: enabled, minimizeToTray: getConfig().system.minimizeToTray } })
  console.log(`[Config] Auto launch set to: ${enabled}`)
}

/**
 * Get current auto launch status
 */
export function getAutoLaunch(): boolean {
  const settings = app.getLoginItemSettings()
  return settings.openAtLogin
}

/**
 * Set minimize to tray behavior
 */
export function setMinimizeToTray(enabled: boolean): void {
  saveConfig({ system: { autoLaunch: getConfig().system.autoLaunch, minimizeToTray: enabled } })
  console.log(`[Config] Minimize to tray set to: ${enabled}`)
}

/**
 * Get minimize to tray setting
 */
export function getMinimizeToTray(): boolean {
  return getConfig().system.minimizeToTray
}
