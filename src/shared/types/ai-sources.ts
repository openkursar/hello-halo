/**
 * AI Sources - Unified Type Definitions (v2)
 *
 * This module defines all types related to AI source providers.
 * These types are shared between main process and renderer.
 *
 * Design Principles:
 * - Single source of truth for all AI-related types
 * - Extensible for future providers
 * - Minimal coupling with specific provider implementations
 * - All sources use unified AISource structure
 *
 * Version History:
 * - v1: Separate custom/oauth configs with dynamic keys
 * - v2: Unified AISource array structure (current)
 */

import { v4 as uuidv4 } from 'uuid'
import type { ModelCapabilityOverride } from './model-capabilities'

// ============================================================================
// Localization Utilities
// ============================================================================

/**
 * Localized text - either a plain string or an object keyed by locale code
 */
export type LocalizedText = string | Record<string, string>

/**
 * Resolve LocalizedText to a string for the given locale.
 * Falls back: exact match -> prefix match -> 'en' -> first value.
 */
export function resolveLocalizedText(value: LocalizedText, locale: string): string {
  if (typeof value === 'string') return value
  if (value[locale]) return value[locale]
  const prefix = locale.split('-')[0]
  const match = Object.keys(value).find(k => k.startsWith(prefix))
  if (match) return value[match]
  return value['en'] || Object.values(value)[0] || ''
}

// ============================================================================
// Core Enums and Constants
// ============================================================================

/**
 * Authentication method type
 */
export type AuthType = 'api-key' | 'oauth'

/**
 * Built-in provider IDs
 * - anthropic: Anthropic Claude API (supports custom URL for proxies)
 * - openai: OpenAI Compatible API (supports any OpenAI-compatible endpoint)
 * - deepseek: DeepSeek API
 * - github-copilot: GitHub Copilot OAuth
 * - claude: Claude.ai OAuth (Claude Pro/Max subscription)
 */
export type BuiltinProviderId =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'siliconflow'
  | 'aliyun'
  | 'moonshot'
  | 'moonshot-global'
  | 'zhipu'
  | 'minimax'
  | 'minimax-global'
  | 'minimax-token-plan'
  | 'minimax-token-plan-global'
  | 'yi'
  | 'stepfun'
  | 'openrouter'
  | 'requesty'
  | 'groq'
  | 'mistral'
  | 'deepinfra'
  | 'together'
  | 'fireworks'
  | 'xai'
  | 'litellm'
  | 'github-copilot'
  | 'claude'

/**
 * Provider ID (built-in + future extensions)
 */
export type ProviderId = BuiltinProviderId | string

/**
 * Login status for OAuth-based sources
 */
export type LoginStatus = 'idle' | 'starting' | 'waiting' | 'completing' | 'success' | 'error'

/**
 * Legacy API Provider type (for backward compatibility)
 */
export type ApiProvider = 'anthropic' | 'openai'

// ============================================================================
// Model Definitions
// ============================================================================

/**
 * Model option for UI display
 */
export interface ModelOption {
  id: string
  name: string
  description?: string
  /** Whether this model supports vision (image) input. undefined = infer from model ID */
  supportsVision?: boolean
}

/**
 * Available Claude models (legacy, for backward compatibility)
 */
export const AVAILABLE_MODELS: ModelOption[] = [
  {
    id: 'claude-mythos-preview',
    name: 'Claude Mythos (Preview)',
    description: 'Next-generation frontier model, preview access'
  },
  {
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    description: 'Frontier model with native 1M context, strongest coding and agentic performance'
  },
  {
    id: 'claude-opus-4-7',
    name: 'Claude Opus 4.7',
    description: 'Latest and most powerful model, great for complex reasoning and architecture decisions'
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    description: 'Most powerful model, great for complex reasoning and architecture decisions'
  },
  {
    id: 'claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    description: 'great for complex reasoning and architecture decisions'
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    description: 'Balanced performance and cost, suitable for most tasks'
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    description: 'Balanced performance and cost, suitable for most tasks'
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    description: 'Fast and lightweight, ideal for simple tasks'
  }
]

export const DEFAULT_MODEL = 'claude-sonnet-4-6'

// ============================================================================
// AI Source Configuration Types (v2)
// ============================================================================

/**
 * User info from OAuth provider
 */
export interface AISourceUser {
  name: string
  avatar?: string
  /** User ID (for API headers, should be ASCII-safe) */
  uid?: string
}

/**
 * AI Source - Unified configuration for all sources
 * Both API Key and OAuth sources use this same structure
 */
export interface AISource {
  // ===== Basic Info (Required) =====
  /** Unique identifier, UUID format */
  id: string
  /** Display name, user-defined */
  name: string
  /** Provider ID (e.g., 'anthropic', 'deepseek', 'custom') */
  provider: ProviderId
  /** Authentication method */
  authType: AuthType

  // ===== API Configuration (Required) =====
  /** API endpoint URL (base URL, e.g., https://api.openai.com/v1) */
  apiUrl: string
  /** API type for OpenAI compatible providers (default: chat_completions) */
  apiType?: 'chat_completions' | 'responses' | 'anthropic_passthrough' | 'kiro'

  // ===== Authentication Credentials (Based on authType) =====
  /** API Key (for authType = 'api-key') */
  apiKey?: string

  /** OAuth Access Token (for authType = 'oauth') */
  accessToken?: string
  /** OAuth Refresh Token */
  refreshToken?: string
  /** Token expiration timestamp (Unix ms) */
  tokenExpires?: number
  /** OAuth user info */
  user?: AISourceUser

  // ===== Model Configuration (Required) =====
  /** Currently selected model ID */
  model: string
  /** Available models list (at least one required) */
  availableModels: ModelOption[]

  // ===== Metadata (Required) =====
  /** Creation timestamp (ISO 8601) */
  createdAt: string
  /** Last update timestamp (ISO 8601) */
  updatedAt: string

  // ===== Model Capability Overrides (Optional) =====
  /**
   * Per-model capability overrides for this source.
   * Keys are model IDs; values are partial capability overrides.
   * Takes precedence over the preset data in model-capabilities.json.
   *
   * Example: override context window for a local Ollama model:
   *   { "llama3": { "contextWindow": 8192 } }
   */
  modelOverrides?: Record<string, ModelCapabilityOverride>

  // ===== Origin Marker (Optional) =====
  /**
   * Set to `true` when the source was created via a preset-API auth provider
   * entry (`product.json authProviders[].preset`). The renderer settings editor
   * uses this to switch into a stripped-down "rotate key + pick model" form
   * (apiUrl is fixed, provider switching is hidden) instead of the generic
   * builtin-provider editor — which cannot represent preset sources because
   * `provider: 'custom'` has no `BuiltinProvider` entry.
   *
   * Persisted on disk; older sources without this flag remain editable via the
   * legacy code paths (backward compatible).
   */
  isPreset?: boolean
}

/**
 * AI Sources configuration (stored in config.json)
 */
export interface AISourcesConfig {
  /** Schema version, currently 2 */
  version: 2
  /** Currently active source ID, null if not configured */
  currentId: string | null
  /** All configured sources */
  sources: AISource[]
}

// ============================================================================
// Legacy Types (For Backward Compatibility and Migration)
// ============================================================================

/**
 * Legacy OAuth source configuration (v1)
 */
export interface OAuthSourceConfig {
  loggedIn: boolean
  user?: AISourceUser
  model: string
  availableModels: string[]
  modelNames?: Record<string, string>
  accessToken?: string
  refreshToken?: string
  tokenExpires?: number
}

/**
 * Legacy Custom API source configuration (v1)
 */
export interface CustomSourceConfig {
  provider: ApiProvider
  apiKey: string
  apiUrl: string
  model: string
  id?: string
  name?: string
  type?: 'custom'
  availableModels?: string[]
}

/**
 * Legacy AI Sources configuration (v1)
 */
export interface LegacyAISourcesConfig {
  current: string
  oauth?: OAuthSourceConfig
  custom?: CustomSourceConfig
  [key: string]: string | OAuthSourceConfig | CustomSourceConfig | undefined
}

// ============================================================================
// Backend Configuration Types (for request routing)
// ============================================================================

/**
 * Configuration for making API requests
 * Used by OpenAI compat router
 */
export interface BackendRequestConfig {
  url: string
  key: string
  model?: string
  headers?: Record<string, string>
  apiType?: 'chat_completions' | 'responses' | 'anthropic_passthrough' | 'kiro'
  forceStream?: boolean
  filterContent?: boolean
  /** AWS CodeWhisperer profile ARN (Kiro Desktop auth only) */
  profileArn?: string
  /** Provider adapter ID — selects a registered adapter for request/response transformations */
  adapterId?: string
}

// ============================================================================
// Login Flow Types
// ============================================================================

/**
 * OAuth login state tracking
 */
export interface OAuthLoginState {
  status: LoginStatus
  state?: string
  error?: string
}

/**
 * Result from starting an OAuth login flow
 */
export interface OAuthStartResult {
  loginUrl: string
  state: string
  /** User code for device code flow (e.g., GitHub Copilot) */
  userCode?: string
  /** Verification URL for device code flow */
  verificationUri?: string
  /**
   * Redirect URI for redirect-flow OAuth (PKCE).
   * Returned by providers that need the renderer to know which URL the
   * BrowserWindow should intercept. Owning this value in the provider keeps
   * the renderer free of provider-specific endpoint constants.
   */
  redirectUri?: string
}

/**
 * Result from completing an OAuth login flow
 */
export interface OAuthCompleteResult {
  success: boolean
  user?: AISourceUser
  error?: string
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create empty AI Sources config
 */
export function createEmptyAISourcesConfig(): AISourcesConfig {
  return {
    version: 2,
    currentId: null,
    sources: []
  }
}

/**
 * Get current active source
 */
export function getCurrentSource(config: AISourcesConfig): AISource | null {
  if (!config.currentId) return null
  return config.sources.find(s => s.id === config.currentId) || null
}

/**
 * Get source by ID
 */
export function getSourceById(config: AISourcesConfig, id: string): AISource | null {
  return config.sources.find(s => s.id === id) || null
}

/**
 * Get current model display name
 */
export function getCurrentModelName(config: AISourcesConfig): string {
  const source = getCurrentSource(config)
  if (!source) return 'No model'

  const modelOption = source.availableModels.find(m => m.id === source.model)
  return modelOption?.name || source.model
}

/**
 * Check if any AI source is configured and ready to use
 */
export function hasAnyAISource(config: AISourcesConfig): boolean {
  return config.sources.length > 0 && config.sources.some(s => {
    if (s.authType === 'api-key') {
      return !!s.apiKey
    }
    return !!s.accessToken
  })
}

/**
 * Check if a specific source is configured
 */
export function isSourceConfigured(source: AISource): boolean {
  if (source.authType === 'api-key') {
    return !!source.apiKey
  }
  return !!source.accessToken
}

/**
 * Create a new AI Source
 */
export function createSource(params: {
  name: string
  provider: ProviderId
  authType: AuthType
  apiUrl: string
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  tokenExpires?: number
  user?: AISourceUser
  model: string
  availableModels: ModelOption[]
}): AISource {
  const now = new Date().toISOString()
  return {
    id: uuidv4(),
    name: params.name,
    provider: params.provider,
    authType: params.authType,
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
    accessToken: params.accessToken,
    refreshToken: params.refreshToken,
    tokenExpires: params.tokenExpires,
    user: params.user,
    model: params.model,
    availableModels: params.availableModels,
    createdAt: now,
    updatedAt: now
  }
}

/**
 * Add source to config
 */
export function addSource(config: AISourcesConfig, source: AISource): AISourcesConfig {
  return {
    ...config,
    sources: [...config.sources, source],
    // Auto-select if no current source
    currentId: config.currentId || source.id
  }
}

/**
 * Update a source
 */
export function updateSource(
  config: AISourcesConfig,
  id: string,
  updates: Partial<AISource>
): AISourcesConfig {
  return {
    ...config,
    sources: config.sources.map(s =>
      s.id === id
        ? { ...s, ...updates, updatedAt: new Date().toISOString() }
        : s
    )
  }
}

/**
 * Delete a source
 */
export function deleteSource(config: AISourcesConfig, id: string): AISourcesConfig {
  const newSources = config.sources.filter(s => s.id !== id)
  let newCurrentId = config.currentId

  // If deleted was current, switch to first available
  if (config.currentId === id) {
    newCurrentId = newSources.length > 0 ? newSources[0].id : null
  }

  return {
    ...config,
    sources: newSources,
    currentId: newCurrentId
  }
}

/**
 * Set current source
 */
export function setCurrentSource(config: AISourcesConfig, id: string): AISourcesConfig {
  if (!config.sources.some(s => s.id === id)) {
    return config // ID doesn't exist
  }
  return { ...config, currentId: id }
}

/**
 * Set model for current source
 */
export function setCurrentModel(config: AISourcesConfig, modelId: string): AISourcesConfig {
  if (!config.currentId) return config
  return updateSource(config, config.currentId, { model: modelId })
}

/**
 * Get available models for a source
 */
export function getAvailableModels(source: AISource): ModelOption[] {
  return source.availableModels || []
}

/**
 * Backward compatibility alias
 */
export type AISourceType = string
export type AISourceUserInfo = AISourceUser

// ============================================================================
// Auth Provider Configuration (shared between main loader and renderer UI)
// ============================================================================

/**
 * Documentation link shown alongside a login entry (e.g. how to apply for an
 * account or API key). Rendered on the login selector card and inside preset
 * API-key forms.
 */
export interface ProviderDocsLink {
  url: string
  /** Localized link label. Defaults to a generic "Learn more" string. */
  label?: LocalizedText
}

/**
 * Authentication provider entry as declared in product.json `authProviders[]`.
 *
 * Used as the single source of truth across the main process loader
 * (`src/main/services/ai-sources/auth-loader.ts`) and the renderer setup UI
 * (`LoginSelector.tsx`, `SetupPage.tsx`, `ApiSetup.tsx`). Keeping the type here
 * prevents the two layers from drifting as fields are added (e.g. `preset`).
 *
 * Three mutually-exclusive shapes are supported by the loader:
 *   1. `builtin: true`              — provider code is bundled in-tree.
 *   2. `path: '...'`                — external OAuth provider module loaded via dynamic import.
 *   3. `preset: { ... }`            — fixed-baseUrl API-key form, no provider module loaded.
 */
export interface AuthProviderConfig {
  /** Provider type identifier (e.g., 'oauth', 'custom', 'preset-api') */
  type: AISourceType
  /** Display name for UI (supports i18n: string or { "en": "...", "zh-CN": "..." }) */
  displayName: LocalizedText
  /** Description text for UI (supports i18n: string or { "en": "...", "zh-CN": "..." }) */
  description: LocalizedText
  /** Lucide icon name */
  icon: string
  /** Icon background color (hex color like '#24292e') */
  iconBgColor: string
  /** Whether this is the recommended option */
  recommended: boolean
  /** Whether this provider is enabled */
  enabled: boolean
  /** Path to an external provider module, resolved relative to product.json */
  path?: string
  /** Whether this is a built-in provider (loaded by manager, no path required) */
  builtin?: boolean
  /**
   * Preset API configuration. When present, the renderer routes this entry to
   * an API-key form with a fixed baseUrl (no provider module is loaded).
   * Mutually exclusive with `path`.
   */
  preset?: PresetApiConfig
  /**
   * Optional documentation link rendered on the login selector card (e.g. how to
   * apply for an account). For `preset` entries the link also appears inside the
   * API-key form via `preset.docs`.
   */
  docs?: ProviderDocsLink
}

// ============================================================================
// Preset API Configuration (for preset-api login entries in product.json)
// ============================================================================

/**
 * Preset API configuration declared in product.json `authProviders[].preset`.
 *
 * When an auth provider entry carries this object, the renderer presents an
 * "API Key only" login form with a fixed baseUrl — the user does not see (or
 * configure) the gateway URL. The persisted AISource records `apiType` so the
 * chat dispatcher routes the right protocol upstream.
 *
 * Mutually exclusive with `path` (dynamic OAuth provider modules).
 */
export interface PresetApiConfig {
  /** Fixed base URL of the gateway (no /v1 or path suffix is required) */
  baseUrl: string
  /**
   * Persisted to AISource.apiType. Determines dispatch path for the in-process
   * router used by the Anthropic / Halo SDK engines. The Codex engine ignores
   * this field and uses the OpenAI protocol directly against the same baseUrl.
   */
  apiType: 'chat_completions' | 'responses' | 'anthropic_passthrough' | 'kiro'
  /** Path appended to baseUrl for GET model list. Defaults to '/v1/models'. */
  modelsPath?: string
  /** Used when the live /models call fails or returns an empty list */
  fallbackModels?: ModelOption[]
  /** Optional documentation link rendered next to the API Key input */
  docs?: ProviderDocsLink
}
