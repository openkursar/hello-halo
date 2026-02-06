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
 */
export type BuiltinProviderId =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'siliconflow'
  | 'aliyun'
  | 'moonshot'
  | 'zhipu'
  | 'minimax'
  | 'yi'
  | 'stepfun'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'deepinfra'
  | 'together'
  | 'fireworks'
  | 'xai'
  | 'github-copilot'

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
}

/**
 * Available Claude models (legacy, for backward compatibility)
 */
export const AVAILABLE_MODELS: ModelOption[] = [
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

export const DEFAULT_MODEL = 'claude-opus-4-5-20251101'

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
  apiType?: 'chat_completions' | 'responses'

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
  apiType?: 'chat_completions' | 'responses'
  forceStream?: boolean
  filterContent?: boolean
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
