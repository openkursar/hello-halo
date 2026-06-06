/**
 * AI Source Manager (v2)
 *
 * Central manager for all AI source providers.
 * Responsible for:
 * - Provider registration and lifecycle
 * - Configuration management (v2 format with sources array)
 * - Backend config generation for OpenAI compat router
 * - OAuth flow coordination
 *
 * Design Principles:
 * - Single point of access for all AI source operations
 * - Decoupled from specific provider implementations
 * - Dynamic provider loading via auth-loader
 * - Thread-safe singleton pattern
 * - Supports v2 AISourcesConfig format
 */

import { app } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import type {
  AISourceProvider,
  OAuthAISourceProvider,
  ProviderResult
} from '../../../shared/interfaces'
import {
  getCurrentSource,
  createEmptyAISourcesConfig,
  resolveLocalizedText,
  type AISourceType,
  type AISourcesConfig,
  type AISource,
  type BackendRequestConfig,
  type OAuthStartResult,
  type OAuthCompleteResult,
  type ModelOption,
  type ProviderId
} from '../../../shared/types'
import { getBuiltinProvider, isAnthropicProvider, isBuiltinProvider } from '../../../shared/constants'
import { getConfig, saveConfig } from '../../foundation/config.service'
import { getCustomProvider } from './providers/custom.provider'
import { getGitHubCopilotProvider } from './providers/github-copilot.provider'
import { getClaudeProvider } from './providers/claude.provider'
import { loadAuthProvidersAsync } from './auth-loader'
import { loadProductConfig } from '../../foundation/product-config'
import { decryptString } from '../../foundation/secure-storage.service'
import { normalizeApiUrl } from '../../openai-compat-router'

/**
 * Extended OAuth provider interface for token management
 */
interface OAuthProviderWithTokenManagement extends OAuthAISourceProvider {
  checkTokenWithConfig?(config: any): { valid: boolean; expiresIn?: number; needsRefresh: boolean }
  refreshTokenWithConfig?(config: any): Promise<ProviderResult<{
    accessToken: string
    refreshToken: string
    expiresAt: number
  }>>
}

/**
 * Get display name for a provider type from product.json config
 */
function getProviderDisplayName(providerType: ProviderId): string {
  const config = loadProductConfig()
  const provider = config.authProviders.find(p => p.type === providerType)
  if (provider?.displayName) return resolveLocalizedText(provider.displayName, app.getLocale())
  return providerType
}

/**
 * AISourceManager - Singleton manager for AI sources
 */
class AISourceManager {
  private providers: Map<AISourceType, AISourceProvider> = new Map()
  private initialized = false
  private initPromise: Promise<void> | null = null

  constructor() {
    // Register built-in providers immediately
    this.registerProvider(getCustomProvider())
    this.registerProvider(getGitHubCopilotProvider())
    this.registerProvider(getClaudeProvider())

    // Sync saved sources' model lists with current BUILTIN_PROVIDERS
    this.syncBuiltinModels()

    // Start async initialization (optional providers + dynamic loading)
    this.initPromise = this.initializeAsync()
  }

  /**
   * Async initialization - loads providers from product.json configuration
   */
  private async initializeAsync(): Promise<void> {
    const loadedProviders = await loadAuthProvidersAsync()

    for (const loaded of loadedProviders) {
      if (loaded.config.builtin) {
        continue
      }

      if (loaded.provider) {
        this.registerProvider(loaded.provider)
      } else if (loaded.loadError) {
        console.warn(`[AISourceManager] Provider ${loaded.config.type} not loaded: ${loaded.loadError}`)
      }
    }

    this.initialized = true
    console.log('[AISourceManager] Initialization complete, providers:', Array.from(this.providers.keys()).join(', '))
  }

  /**
   * Ensure manager is fully initialized before operations
   */
  async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise
    }
  }

  /**
   * Register a new provider
   */
  registerProvider(provider: AISourceProvider): void {
    this.providers.set(provider.type, provider)
    console.log(`[AISourceManager] Registered provider: ${provider.type}`)
  }

  /**
   * Get a specific provider
   */
  getProvider(type: AISourceType): AISourceProvider | undefined {
    return this.providers.get(type)
  }

  /**
   * Get all registered providers
   */
  getAllProviders(): AISourceProvider[] {
    return Array.from(this.providers.values())
  }

  /**
   * Get aiSources config from HaloConfig (v2 format)
   */
  private getAiSourcesConfig(): AISourcesConfig {
    const config = getConfig() as any
    const aiSources = config.aiSources
    if (aiSources?.version === 2 && Array.isArray(aiSources.sources)) {
      return aiSources
    }
    return createEmptyAISourcesConfig()
  }

  /**
   * Get the current active source
   */
  getCurrentSourceConfig(): AISource | null {
    const aiSources = this.getDecryptedAiSources()
    return getCurrentSource(aiSources)
  }

  /**
   * Get backend request configuration for the current source
   * This is the main method used by agent.service.ts
   */
  getBackendConfig(): BackendRequestConfig | null {
    const aiSources = this.getDecryptedAiSources()
    const source = getCurrentSource(aiSources)

    console.log('[AISourceManager] getBackendConfig called')
    console.log('[AISourceManager] currentId:', aiSources.currentId)
    console.log('[AISourceManager] sources count:', aiSources.sources.length)

    if (!source) {
      console.warn('[AISourceManager] No current source configured')
      return null
    }

    console.log('[AISourceManager] Found source:', source.name, 'provider:', source.provider)

    // Check if source is configured
    if (source.authType === 'api-key' && !source.apiKey) {
      console.warn('[AISourceManager] API key source missing apiKey')
      return null
    }
    if (source.authType === 'oauth' && !source.accessToken) {
      console.warn('[AISourceManager] OAuth source missing accessToken')
      return null
    }

    // OAuth: delegate to provider (handles token exchange, custom headers, etc.)
    if (source.authType === 'oauth') {
      const provider = this.providers.get(source.provider)
      if (!provider) {
        console.warn(`[AISourceManager] No provider found for OAuth source: ${source.provider}`)
        return null
      }
      const legacyConfig = this.buildLegacyOAuthConfig(source)
      const result = provider.getBackendConfig(legacyConfig)
      console.log(`[AISourceManager] OAuth provider returned adapterId: ${result?.adapterId || 'none'}`)
      return result
    }

    // API Key: build config directly
    const isAnthropic = isAnthropicProvider(source.provider)
    const isAnthropicPassthrough = source.apiType === 'anthropic_passthrough'

    // Normalize URL: ensure protocol prefix, then apply wire-format normalization.
    // Native Anthropic skips normalization because the Claude SDK appends
    // /v1/messages itself; the passthrough and OpenAI paths route through the
    // router which POSTs backendUrl verbatim, so the full endpoint must be
    // composed here.
    let normalizedUrl = source.apiUrl
    if (normalizedUrl && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalizedUrl)) {
      normalizedUrl = `http://${normalizedUrl}`
    }
    if (!isAnthropic) {
      normalizedUrl = normalizeApiUrl(
        normalizedUrl,
        isAnthropicPassthrough ? 'anthropic_passthrough' : 'openai'
      )
    }

    // Build backend config
    const config: BackendRequestConfig = {
      url: normalizedUrl,
      key: source.apiKey!,
      model: source.model
    }

    // Set API type only if explicitly configured on the source.
    // When not set, request-handler infers from URL suffix (/chat/completions or /responses).
    // TODO: Add apiType selector in ProviderSelector UI for explicit control.
    if (!isAnthropic && source.apiType) {
      config.apiType = source.apiType
    }

    console.log('[AISourceManager] getBackendConfig result:', {
      url: config.url,
      model: config.model,
      hasKey: !!config.key,
      apiType: config.apiType,
      adapterId: config.adapterId || 'none',
      path: 'api-key'
    })

    return config
  }

  /**
   * Check if any AI source is configured
   */
  hasAnySource(): boolean {
    const aiSources = this.getAiSourcesConfig()
    return aiSources.sources.some(s => {
      if (s.authType === 'api-key') return !!s.apiKey
      return !!s.accessToken
    })
  }

  /**
   * Check if a specific source is configured
   */
  isSourceConfigured(sourceId: string): boolean {
    const aiSources = this.getAiSourcesConfig()
    const source = aiSources.sources.find(s => s.id === sourceId)
    if (!source) return false

    if (source.authType === 'api-key') return !!source.apiKey
    return !!source.accessToken
  }

  /**
   * Get backend request configuration for a specific source (used for per-app model overrides).
   * Unlike getBackendConfig() which uses the current/global source, this targets a specific source+model.
   */
  getBackendConfigForSource(sourceId: string, modelId?: string): BackendRequestConfig | null {
    const aiSources = this.getDecryptedAiSources()
    const source = aiSources.sources.find(s => s.id === sourceId)

    if (!source) {
      console.warn(`[AISourceManager] getBackendConfigForSource: source not found: ${sourceId}`)
      return null
    }

    // Check if source is configured
    if (source.authType === 'api-key' && !source.apiKey) {
      console.warn('[AISourceManager] getBackendConfigForSource: API key source missing apiKey')
      return null
    }
    if (source.authType === 'oauth' && !source.accessToken) {
      console.warn('[AISourceManager] getBackendConfigForSource: OAuth source missing accessToken')
      return null
    }

    // OAuth: delegate to provider
    if (source.authType === 'oauth') {
      const provider = this.providers.get(source.provider)
      if (!provider) {
        console.warn(`[AISourceManager] No provider found for OAuth source: ${source.provider}`)
        return null
      }
      // Substitute the override model into the legacy config BEFORE calling
      // provider.getBackendConfig, so model-derived fields (anthropic-beta
      // header, endpoint URL, etc.) are computed against the effective model
      // — not against source.model. See buildLegacyOAuthConfig() for the full
      // rationale; a post-call `config.model = modelId` patch (the previous
      // behaviour) is unsafe because it leaves derived headers stale.
      const legacyConfig = this.buildLegacyOAuthConfig(source, modelId)
      return provider.getBackendConfig(legacyConfig)
    }

    // API Key: build config directly. See getBackendConfig() for the rationale
    // behind the wire-format normalization branching.
    const isAnthropic = isAnthropicProvider(source.provider)
    const isAnthropicPassthrough = source.apiType === 'anthropic_passthrough'
    let normalizedUrl = source.apiUrl
    if (normalizedUrl && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalizedUrl)) {
      normalizedUrl = `http://${normalizedUrl}`
    }
    if (!isAnthropic) {
      normalizedUrl = normalizeApiUrl(
        normalizedUrl,
        isAnthropicPassthrough ? 'anthropic_passthrough' : 'openai'
      )
    }

    const config: BackendRequestConfig = {
      url: normalizedUrl,
      key: source.apiKey!,
      model: modelId || source.model
    }

    if (!isAnthropic && source.apiType) {
      config.apiType = source.apiType
    }

    return config
  }

  // ========== Source CRUD Operations ==========

  /**
   * Add a new source
   */
  addSource(source: AISource): AISourcesConfig {
    const aiSources = this.getAiSourcesConfig()

    const newSources = [...aiSources.sources, source]
    const newConfig: AISourcesConfig = {
      version: 2,
      currentId: aiSources.currentId || source.id,
      sources: newSources
    }

    saveConfig({ aiSources: newConfig } as any)
    console.log(`[AISourceManager] Added source: ${source.name} (${source.id})`)

    return newConfig
  }

  /**
   * Update an existing source
   */
  updateSource(sourceId: string, updates: Partial<AISource>): AISourcesConfig {
    const aiSources = this.getAiSourcesConfig()

    const newConfig: AISourcesConfig = {
      ...aiSources,
      sources: aiSources.sources.map(s =>
        s.id === sourceId
          ? { ...s, ...updates, updatedAt: new Date().toISOString() }
          : s
      )
    }

    saveConfig({ aiSources: newConfig } as any)
    console.log(`[AISourceManager] Updated source: ${sourceId}`)

    return newConfig
  }

  /**
   * Delete a source
   */
  deleteSource(sourceId: string): AISourcesConfig {
    const aiSources = this.getAiSourcesConfig()

    const newSources = aiSources.sources.filter(s => s.id !== sourceId)
    let newCurrentId = aiSources.currentId

    // If deleted was current, switch to first available
    if (aiSources.currentId === sourceId) {
      newCurrentId = newSources.length > 0 ? newSources[0].id : null
    }

    const newConfig: AISourcesConfig = {
      version: 2,
      currentId: newCurrentId,
      sources: newSources
    }

    saveConfig({ aiSources: newConfig } as any)
    console.log(`[AISourceManager] Deleted source: ${sourceId}`)

    return newConfig
  }

  /**
   * Set current source
   */
  setCurrentSource(sourceId: string): AISourcesConfig {
    const aiSources = this.getAiSourcesConfig()

    if (!aiSources.sources.some(s => s.id === sourceId)) {
      console.warn(`[AISourceManager] Source not found: ${sourceId}`)
      return aiSources
    }

    const newConfig: AISourcesConfig = {
      ...aiSources,
      currentId: sourceId
    }

    saveConfig({ aiSources: newConfig } as any)
    console.log(`[AISourceManager] Set current source: ${sourceId}`)

    return newConfig
  }

  /**
   * Set model for current source
   */
  setCurrentModel(modelId: string): AISourcesConfig {
    const aiSources = this.getAiSourcesConfig()
    if (!aiSources.currentId) return aiSources

    return this.updateSource(aiSources.currentId, { model: modelId })
  }

  // ========== OAuth Methods ==========

  /**
   * Start OAuth login for a provider type
   */
  async startOAuthLogin(providerType: ProviderId): Promise<ProviderResult<OAuthStartResult>> {
    await this.ensureInitialized()

    const provider = this.providers.get(providerType)
    if (!provider) {
      return { success: false, error: `Unknown provider type: ${providerType}` }
    }

    if (!this.isOAuthProvider(provider)) {
      return { success: false, error: `Provider ${providerType} does not support OAuth` }
    }

    return provider.startLogin()
  }

  /**
   * Complete OAuth login for a provider type
   */
  async completeOAuthLogin(
    providerType: ProviderId,
    state: string
  ): Promise<ProviderResult<OAuthCompleteResult>> {
    await this.ensureInitialized()

    const provider = this.providers.get(providerType)
    if (!provider) {
      return { success: false, error: `Unknown provider type: ${providerType}` }
    }

    if (!this.isOAuthProvider(provider)) {
      return { success: false, error: `Provider ${providerType} does not support OAuth` }
    }

    const result = await provider.completeLogin(state)

    if (result.success && result.data) {
      await this.handleOAuthLoginSuccess(providerType, result.data)
    }

    return result
  }

  /**
   * Handle successful OAuth login - create or update OAuth source in v2 format
   * If a source with the same provider already exists, update it instead of creating a new one
   */
  private async handleOAuthLoginSuccess(
    providerType: ProviderId,
    loginResult: OAuthCompleteResult
  ): Promise<void> {
    const data = loginResult as any
    const tokenData = data._tokenData
    const availableModels: string[] = data._availableModels || []
    const modelNames: Record<string, string> = data._modelNames || {}
    const defaultModel = data._defaultModel || ''

    const builtin = getBuiltinProvider(providerType)
    const now = new Date().toISOString()

    // Convert to ModelOption format
    const models: ModelOption[] = availableModels.map(id => ({
      id,
      name: modelNames[id] || id
    }))

    if (models.length === 0 && defaultModel) {
      models.push({ id: defaultModel, name: modelNames[defaultModel] || defaultModel })
    }

    const aiSources = this.getAiSourcesConfig()

    // Check if an OAuth source with the same provider already exists
    const existingSource = aiSources.sources.find(
      s => s.provider === providerType && s.authType === 'oauth'
    )

    let newSources: AISource[]
    let sourceId: string

    if (existingSource) {
      // Update existing source
      sourceId = existingSource.id
      newSources = aiSources.sources.map(s => {
        if (s.id === existingSource.id) {
          return {
            ...s,
            accessToken: tokenData?.accessToken || '',
            refreshToken: tokenData?.refreshToken || '',
            tokenExpires: tokenData?.expiresAt,
            user: {
              name: loginResult.user?.name || '',
              uid: tokenData?.uid || ''
            },
            model: defaultModel || s.model,
            availableModels: models.length > 0 ? models : s.availableModels,
            updatedAt: now
          }
        }
        return s
      })
      console.log(`[AISourceManager] OAuth login for ${providerType} updated existing source: ${sourceId}`)
    } else {
      // Create new source
      sourceId = uuidv4()
      const newSource: AISource = {
        id: sourceId,
        name: builtin?.name || getProviderDisplayName(providerType),
        provider: providerType,
        authType: 'oauth',
        apiUrl: '',
        accessToken: tokenData?.accessToken || '',
        refreshToken: tokenData?.refreshToken || '',
        tokenExpires: tokenData?.expiresAt,
        user: {
          name: loginResult.user?.name || '',
          uid: tokenData?.uid || ''
        },
        model: defaultModel,
        availableModels: models,
        createdAt: now,
        updatedAt: now
      }
      newSources = [...aiSources.sources, newSource]
      console.log(`[AISourceManager] OAuth login for ${providerType} created new source: ${sourceId}`)
    }

    const newConfig: AISourcesConfig = {
      version: 2,
      currentId: sourceId,
      sources: newSources
    }

    saveConfig({
      aiSources: newConfig,
      isFirstLaunch: false
    } as any)
  }

  /**
   * Logout from a source (for OAuth sources)
   */
  async logout(sourceId: string): Promise<ProviderResult<void>> {
    const aiSources = this.getAiSourcesConfig()
    const source = aiSources.sources.find(s => s.id === sourceId)

    if (!source) {
      return { success: false, error: 'Source not found' }
    }

    // Call provider logout if OAuth
    if (source.authType === 'oauth') {
      const provider = this.providers.get(source.provider)
      if (provider && this.isOAuthProvider(provider)) {
        await provider.logout()
      }
    }

    this.deleteSource(sourceId)
    console.log(`[AISourceManager] Logout complete for source: ${sourceId}`)

    return { success: true }
  }

  // ========== Token Management ==========

  /**
   * Check and refresh token if needed (for OAuth sources)
   */
  async ensureValidToken(sourceId: string): Promise<ProviderResult<void>> {
    const aiSources = this.getDecryptedAiSources()
    const source = aiSources.sources.find(s => s.id === sourceId)

    if (!source || source.authType !== 'oauth') {
      return { success: true }
    }

    const provider = this.providers.get(source.provider) as OAuthProviderWithTokenManagement | undefined
    if (!provider?.checkTokenWithConfig || !provider?.refreshTokenWithConfig) {
      return { success: true }
    }

    // Build legacy config format for provider
    const legacyConfig = this.buildLegacyOAuthConfig(source)
    const tokenStatus = provider.checkTokenWithConfig(legacyConfig)

    console.log(`[AISourceManager] Token status for ${source.name}:`, tokenStatus)

    if (!tokenStatus.valid || tokenStatus.needsRefresh) {
      const refreshResult = await provider.refreshTokenWithConfig(legacyConfig)

      if (refreshResult.success && refreshResult.data) {
        this.updateSource(sourceId, {
          accessToken: refreshResult.data.accessToken,
          refreshToken: refreshResult.data.refreshToken,
          tokenExpires: refreshResult.data.expiresAt
        })
        console.log('[AISourceManager] Token refreshed and saved')
      } else {
        console.error(`[AISourceManager] Token refresh failed:`, refreshResult.error)
        return refreshResult
      }
    }

    return { success: true }
  }

  // ========== Configuration Refresh ==========

  /**
   * Sync availableModels for sources using builtin providers.
   *
   * When BUILTIN_PROVIDERS is updated (e.g. new model added in a release),
   * already-saved sources still have the old snapshot. This method updates
   * the builtin portion of each matching source's availableModels.
   *
   * Only syncs when the saved model list consists entirely of builtin models
   * (i.e. user has NOT fetched custom models from a remote API). If the user
   * fetched their own models, their list is the source of truth and we don't
   * inject builtin defaults.
   *
   * Called synchronously at startup from the constructor.
   */
  private syncBuiltinModels(): void {
    const aiSources = this.getAiSourcesConfig()
    if (aiSources.sources.length === 0) return

    let dirty = false
    const updatedSources = aiSources.sources.map(source => {
      // Only sync api-key sources that use a builtin provider
      if (source.authType !== 'api-key' || !isBuiltinProvider(source.provider)) {
        return source
      }

      const builtin = getBuiltinProvider(source.provider)
      if (!builtin || builtin.models.length === 0) return source

      const existing = source.availableModels || []
      if (existing.length === 0) return source

      // Check if the saved list is purely builtin models (no user-fetched models).
      // If the user fetched custom models via "Fetch Models", there will be model IDs
      // not present in BUILTIN_PROVIDERS — in that case, skip sync to avoid injecting
      // irrelevant defaults into a custom model list.
      const builtinIds = new Set(builtin.models.map(m => m.id))
      const hasUserModels = existing.some(m => !builtinIds.has(m.id))
      if (hasUserModels) return source

      // All existing models are from builtin — safe to replace with latest builtin list
      const existingIds = new Set(existing.map(m => m.id))
      const newModels = builtin.models.filter(m => !existingIds.has(m.id))
      if (newModels.length === 0) return source

      dirty = true
      console.log(`[AISourceManager] Syncing ${newModels.length} new model(s) to source "${source.name}":`, newModels.map(m => m.id).join(', '))

      return {
        ...source,
        availableModels: [...builtin.models]
      }
    })

    if (dirty) {
      const newConfig: AISourcesConfig = {
        ...aiSources,
        sources: updatedSources
      }
      saveConfig({ aiSources: newConfig } as any)
      console.log('[AISourceManager] Builtin models synced to config')
    }
  }

  /**
   * Refresh configuration for a specific source.
   *
   * Delegates to the provider's refreshConfig() to fetch the latest model
   * list from the remote API, then merges the result back into stored config.
   *
   * Only non-sensitive fields (availableModels, model, updatedAt) are written;
   * encrypted tokens on disk are never touched.
   */
  async refreshSourceConfig(sourceId: string): Promise<ProviderResult<void>> {
    await this.ensureInitialized()

    // Decrypted config is needed so providers can make authenticated API calls
    const aiSources = this.getDecryptedAiSources()
    const source = aiSources.sources.find(s => s.id === sourceId)

    if (!source) {
      return { success: false, error: 'Source not found' }
    }

    const provider = this.providers.get(source.provider)
    if (!provider?.refreshConfig) {
      // Provider does not support refresh — not an error
      return { success: true }
    }

    // Build legacy config format that all providers consume
    const legacyConfig = this.buildLegacyOAuthConfig(source)

    console.log(`[AISourceManager] Refreshing source "${source.name}" (${source.provider})`)

    const result = await provider.refreshConfig(legacyConfig)

    if (!result.success || !result.data) {
      console.warn(`[AISourceManager] Refresh failed for "${source.name}":`, result.error)
      return { success: false, error: result.error || 'Refresh failed' }
    }

    // Provider returns { [providerType]: { availableModels, modelNames, model, ... } }
    const providerData = (result.data as Record<string, any>)[source.provider]
    if (!providerData) {
      return { success: true } // No updates from provider
    }

    // Convert provider's string[] + modelNames to v2 ModelOption[]
    const modelIds: string[] = providerData.availableModels || []
    const modelNames: Record<string, string> = providerData.modelNames || {}
    const models: ModelOption[] = modelIds.map(id => ({
      id,
      name: modelNames[id] || id
    }))

    // Read fresh config from disk to avoid overwriting concurrent token rotations
    const freshAiSources = this.getAiSourcesConfig()
    const now = new Date().toISOString()

    const updatedSources = freshAiSources.sources.map(s => {
      if (s.id !== sourceId) return s
      return {
        ...s,
        availableModels: models.length > 0 ? models : s.availableModels,
        model: providerData.model || s.model,
        updatedAt: now
      }
    })

    saveConfig({
      aiSources: {
        ...freshAiSources,
        sources: updatedSources
      }
    } as any)

    console.log(`[AISourceManager] Refreshed "${source.name}": ${models.length} models, model: ${providerData.model || '(unchanged)'}`)
    return { success: true }
  }

  /**
   * Refresh all source configurations
   */
  async refreshAllConfigs(): Promise<void> {
    await this.ensureInitialized()
    const aiSources = this.getAiSourcesConfig()

    for (const source of aiSources.sources) {
      try {
        await this.refreshSourceConfig(source.id)
      } catch (error) {
        console.error(`[AISourceManager] Failed to refresh ${source.name}:`, error)
      }
    }
  }

  // ========== Helper Methods ==========

  private isOAuthProvider(provider: AISourceProvider): provider is OAuthAISourceProvider {
    return 'startLogin' in provider && 'completeLogin' in provider
  }

  /**
   * Build legacy OAuth config format for provider.getBackendConfig()
   * Converts v2 AISource to v1 format expected by OAuth providers.
   *
   * IMPORTANT — single source of truth for model-derived fields:
   *   Some providers (e.g. claude, github-copilot) derive other fields from
   *   `model` inside getBackendConfig() — for example, claude.provider adds
   *   the `context-1m-2025-08-07` anthropic-beta header iff the model has a
   *   `[1m]` suffix; github-copilot picks the Anthropic vs OpenAI endpoint
   *   based on `model.startsWith('claude-')`.
   *
   *   When a per-app override model is in play, we MUST substitute it into
   *   the legacy config BEFORE handing it to the provider — otherwise the
   *   provider sees the source's default model, computes derived fields
   *   against that, and any later `config.model = overrideModel` patch is
   *   incomplete (model field is right, headers/url are wrong). That mismatch
   *   has caused production 429s when the source default was a `[1m]` variant
   *   but a digital human override picked a non-1m model: the request body
   *   carried the non-1m model id, but the header still requested the 1m beta,
   *   pinning the call to the long-context billing tier.
   *
   * @param source         The v2 AISource record
   * @param overrideModel  Optional per-call model override (e.g. from an
   *                       app's userOverrides.modelId). When provided, it
   *                       fully replaces source.model in the legacy config
   *                       so all derived fields are computed against it.
   */
  private buildLegacyOAuthConfig(source: AISource, overrideModel?: string): any {
    const effectiveModel = overrideModel || source.model
    return {
      current: source.provider,
      [source.provider]: {
        loggedIn: true,
        user: source.user,
        model: effectiveModel,
        availableModels: source.availableModels.map(m => m.id),
        accessToken: source.accessToken,
        refreshToken: source.refreshToken,
        tokenExpires: source.tokenExpires
      }
    }
  }

  /**
   * Get AISourcesConfig with decrypted tokens and API keys
   */
  private getDecryptedAiSources(): AISourcesConfig {
    const aiSources = this.getAiSourcesConfig()

    const decryptedSources = aiSources.sources.map(source => {
      const decrypted = { ...source }

      if (source.authType === 'api-key' && source.apiKey) {
        decrypted.apiKey = decryptString(source.apiKey)
      }
      if (source.authType === 'oauth') {
        if (source.accessToken) {
          decrypted.accessToken = decryptString(source.accessToken)
        }
        if (source.refreshToken) {
          decrypted.refreshToken = decryptString(source.refreshToken)
        }
      }

      return decrypted
    })

    return {
      ...aiSources,
      sources: decryptedSources
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let managerInstance: AISourceManager | null = null

export function getAISourceManager(): AISourceManager {
  if (!managerInstance) {
    managerInstance = new AISourceManager()
  }
  return managerInstance
}

export { AISourceManager }
