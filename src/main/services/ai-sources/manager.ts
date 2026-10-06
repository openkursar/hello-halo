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
  toPublicOAuthStartResult,
  toPublicOAuthCompleteResult,
  type AISourceType,
  type AISourcesConfig,
  type AISource,
  type OAuthSourceConfig,
  type AISourceUser,
  type BackendRequestConfig,
  type DirectCallEndpoint,
  type OAuthStartResult,
  type OAuthCompleteResult,
  type ModelOption,
  type ModelRefreshSummary,
  type ProviderId,
  type AuthQuotaSnapshot,
  DEFAULT_MODEL
} from '../../../shared/types'
import {
  getBuiltinProvider,
  isAnthropicProvider,
  isBuiltinProvider,
  resolveModelVision,
  CLAUDE_SUBSCRIPTION_MODELS
} from '../../../shared/constants'
import { getConfig, saveConfig, onApiConfigChange } from '../../foundation/config.service'
import { getCustomProvider } from './providers/custom.provider'
import { getGitHubCopilotProvider } from './providers/github-copilot.provider'
import { getClaudeProvider } from './providers/claude.provider'
import { getZhipuCodingOAuthProvider } from './providers/zhipu-coding-oauth.provider'
import { getChatGPTProvider } from './providers/chatgpt.provider'
import { getCliDelegatedProvider } from './providers/cli-delegated.provider'
import { loadAuthProvidersAsync } from './auth-loader'
import { loadProductConfig } from '../../foundation/product-config'
import { decryptString } from '../../foundation/secure-storage.service'
import { MASK_SENTINEL } from '../../foundation/config-encryption'
import { normalizeApiUrl, type RequestCredentials } from '../../openai-compat-router'
import { analytics } from '../analytics/analytics.service'
import { AnalyticsEvents } from '../analytics/types'

/**
 * Extended OAuth provider interface for token management
 */
interface OAuthProviderWithTokenManagement extends OAuthAISourceProvider {
  checkTokenWithConfig?(config: any): { valid: boolean; expiresIn?: number; needsRefresh: boolean }
  refreshTokenWithConfig?(config: any): Promise<ProviderResult<{
    accessToken: string
    refreshToken: string
    expiresAt: number
    apiUrl?: string
    profileArn?: string
  }>>
}

interface OAuthLoginAccount {
  key: string
  label: string
  id: string
}

interface OAuthLoginPayload extends OAuthCompleteResult {
  _tokenData?: { accessToken?: string; refreshToken?: string; expiresAt?: number; uid?: string }
  _accounts?: OAuthLoginAccount[]
  _availableModels?: string[]
  _modelNames?: Record<string, string>
  _modelCapabilities?: Record<string, ModelOption['capabilities']>
  _modelVision?: Record<string, boolean>
  _modelCatalogCache?: AISource['modelCatalogCache']
  _defaultModel?: string
  _catalogDegraded?: boolean
  _apiUrl?: string
  _accountId?: string
  _profileArn?: string
}

interface ManagedCatalogRefresh {
  source: AISource
  promise: Promise<ProviderResult<{ degraded: boolean }>>
}

/**
 * One pending authorization per provider. A newer start supersedes it; the slot
 * stays mapped to the newest login while older ones drain.
 */
interface ManagedOAuthLogin {
  loginId: string
  sourceId?: string
  target?: AISource
  context?: OAuthStartResult
  startPromise?: Promise<ProviderResult<OAuthStartResult>>
  completionPromise?: Promise<ProviderResult<OAuthCompleteResult>>
  cancellation?: Promise<void>
  cancelled: boolean
  expiresAt: number
  timer?: ReturnType<typeof setTimeout>
}

const OAUTH_LOGIN_TIMEOUT_MS = 10 * 60 * 1000
/** Providers renew a token minutes before it expires, so a minute-old answer is still current. */
const REQUEST_CREDENTIAL_RECHECK_MS = 60_000
const ACCOUNT_REMOVED_ERROR = 'This account was removed. Choose another account for this conversation.'
/** Upper bound on waiting for a superseded login whose provider work cannot be interrupted. */
const OAUTH_SUPERSEDE_DRAIN_MS = 15_000

/** Token and account identity change on every login and refresh, so they version a source's credential. */
function sameCredentials(current: AISource | null | undefined, captured: AISource): boolean {
  return !!current && current.accessToken === captured.accessToken &&
    current.refreshToken === captured.refreshToken && current.user?.uid === captured.user?.uid
}

/** Multi-account providers list every authorized account; the others authorize exactly one. */
function loginAccounts(data: OAuthLoginPayload): OAuthLoginAccount[] {
  if (data._accounts?.length) return data._accounts
  return [{
    key: data._tokenData?.accessToken || '',
    id: data._tokenData?.uid || data.user?.uid || '',
    label: data.user?.name || ''
  }]
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
  private logins = new Map<ProviderId, ManagedOAuthLogin>()
  private tokenRefreshes = new Map<string, { source: AISource; model: string; promise: Promise<ProviderResult<void>> }>()
  private catalogRefreshes = new Map<string, ManagedCatalogRefresh>()
  /** Keyed by source and model; see resolveRequestCredentials. */
  private requestCredentials = new Map<string, { sourceId: string; credentials: RequestCredentials | null; checkedAt: number }>()

  constructor() {
    // Register built-in providers immediately
    this.registerProvider(getCustomProvider())
    this.registerProvider(getGitHubCopilotProvider())
    this.registerProvider(getClaudeProvider())
    this.registerProvider(getZhipuCodingOAuthProvider())
    this.registerProvider(getChatGPTProvider())
    // Delegated auth depends on the CLI's credential store, whose layout is
    // only verified on macOS. Registering it elsewhere would surface a source
    // that cannot be logged into. See product.json `platforms`.
    if (process.platform === 'darwin') {
      this.registerProvider(getCliDelegatedProvider())
    }

    // Sync saved sources' model lists with current BUILTIN_PROVIDERS
    this.syncBuiltinModels()

    // Edits that bypass this manager (settings saved as a whole) still reach cached request credentials.
    onApiConfigChange(change => this.dropRequestCredentials(change?.sourceIds))

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

  getSourceConfig(sourceId: string): AISource | null {
    return this.getDecryptedAiSources().sources.find(source => source.id === sourceId) ?? null
  }

  /** Store identity follows the selected account, otherwise the first configured one. */
  getOAuthSource(providerType: ProviderId): AISource | null {
    const config = this.getDecryptedAiSources()
    const matches = (source: AISource) => source.provider === providerType &&
      source.authType === 'oauth' && !!source.accessToken
    const current = getCurrentSource(config)
    if (current?.provider === providerType && current.authType === 'oauth') return current
    return config.sources.find(matches) ?? null
  }

  /**
   * Return a valid OAuth access token for a provider type, or null when no such
   * source is signed in. Refreshes an expiring token first. Used by the
   * store to authenticate to an identity-bound registry server.
   */
  async getOAuthAccessToken(providerType: ProviderId): Promise<string | null> {
    const source = this.getOAuthSource(providerType)
    if (!source) return null
    const result = await this.ensureValidToken(source.id)
    if (!result.success) return null
    const refreshed = this.getDecryptedAiSources().sources.find(s => s.id === source.id)
    return refreshed?.accessToken ?? null
  }

  /** The signed-in OAuth user for a provider, or null when not signed in. */
  getOAuthIdentity(providerType: ProviderId): AISourceUser | null {
    const source = this.getOAuthSource(providerType)
    return source?.user ?? null
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

    // Provider-built: OAuth handles token exchange and custom headers;
    // delegated builds a keyless config the CLI subprocess authenticates itself.
    if (source.authType === 'oauth' || source.authType === 'delegated') {
      const provider = this.providers.get(source.provider)
      if (!provider) {
        console.warn(`[AISourceManager] No provider found for ${source.authType} source: ${source.provider}`)
        return null
      }
      const legacyConfig = this.buildLegacyOAuthConfig(source)
      const result = provider.getBackendConfig(legacyConfig)
      console.log(`[AISourceManager] ${source.authType} provider returned adapterId: ${result?.adapterId || 'none'}`)
      this.stampVisionCapability(source, result)
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

    this.stampVisionCapability(source, config)

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
   * Resolve the current source into a ready-to-POST descriptor for a direct,
   * non-streaming HTTP call that bypasses the SDK and the compat router (e.g.
   * Tlon ingest). Built on getBackendConfig() so URL normalization, wire
   * format and auth headers are defined in one place rather than re-derived by
   * each direct caller.
   *
   * `apiType` is passed through so callers can reject `responses` / `kiro`,
   * which need the router's request/response translation and cannot be spoken
   * directly. Returns null when no source is configured.
   */
  getDirectCallEndpoint(): DirectCallEndpoint | null {
    const source = getCurrentSource(this.getDecryptedAiSources())
    if (!source) return null
    const backend = this.getBackendConfig()
    if (!backend) return null

    const wireFormat: 'anthropic' | 'openai' =
      isAnthropicProvider(source.provider) || backend.apiType === 'anthropic_passthrough'
        ? 'anthropic'
        : 'openai'

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    let url = backend.url

    if (wireFormat === 'anthropic') {
      // getBackendConfig leaves a native-Anthropic url as the base (the SDK
      // appends /v1/messages); a direct call must append it itself.
      if (!/\/v1\/messages$/.test(url)) {
        url = `${url.replace(/\/+$/, '')}/v1/messages`
      }
      headers['anthropic-version'] = '2023-06-01'
    }

    const hasAuth =
      !!backend.headers &&
      Object.keys(backend.headers).some(k => k.toLowerCase() === 'authorization')
    if (hasAuth) {
      // OAuth providers (claude/copilot) inject their own Authorization + betas.
      Object.assign(headers, backend.headers)
    } else if (wireFormat === 'anthropic') {
      headers['x-api-key'] = backend.key
    } else {
      headers['authorization'] = `Bearer ${backend.key}`
    }

    // The [1m] suffix is an SDK-only context-window hint stripped at the router
    // wire boundary; the real Anthropic API rejects non-canonical model ids.
    const rawModel = backend.model || source.model
    const model = wireFormat === 'anthropic' ? rawModel.replace(/\[1m\]$/i, '') : rawModel

    return { url, headers, wireFormat, model, apiType: backend.apiType }
  }

  /**
   * Check if any AI source is configured
   */
  hasAnySource(): boolean {
    const aiSources = this.getAiSourcesConfig()
    return aiSources.sources.some(s => {
      if (s.authType === 'api-key') return !!s.apiKey
      // Delegated sources hold no credential — their existence is the config.
      if (s.authType === 'delegated') return true
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
    if (source.authType === 'delegated') return true
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

    // Provider-built: see getBackendConfig() for the OAuth/delegated split.
    if (source.authType === 'oauth' || source.authType === 'delegated') {
      const provider = this.providers.get(source.provider)
      if (!provider) {
        console.warn(`[AISourceManager] No provider found for ${source.authType} source: ${source.provider}`)
        return null
      }
      // Substitute the override model into the legacy config BEFORE calling
      // provider.getBackendConfig, so model-derived fields (anthropic-beta
      // header, endpoint URL, etc.) are computed against the effective model
      // — not against source.model. See buildLegacyOAuthConfig() for the full
      // rationale; a post-call `config.model = modelId` patch (the previous
      // behaviour) is unsafe because it leaves derived headers stale.
      const legacyConfig = this.buildLegacyOAuthConfig(source, modelId)
      const result = provider.getBackendConfig(legacyConfig)
      this.stampVisionCapability(source, result)
      return result
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

    this.stampVisionCapability(source, config)

    return config
  }

  /**
   * Stamp the source's effective vision capability onto a resolved backend
   * config, so the request pipeline (image fallback, image stripping) decides
   * from the same answer the input UI shows the user.
   *
   * Applies to OAuth and API-key sources alike: the OAuth branches delegate
   * config building to the provider, which knows nothing about per-model
   * capability, so the value has to be attached here or it is lost.
   */
  private stampVisionCapability(source: AISource, config: BackendRequestConfig | null): void {
    if (!config) return
    config.sourceId = source.id
    config.visionOverride = resolveModelVision(source, config.model)
  }

  // ========== Source CRUD Operations ==========

  /**
   * Add a new source
   */
  addSource(source: AISource): AISourcesConfig {
    if (source.authType !== 'api-key') throw new Error('Managed accounts must be added through their login flow')
    return this.appendSource(source)
  }

  private appendSource(source: AISource): AISourcesConfig {
    const aiSources = this.getAiSourcesConfig()
    if (aiSources.sources.some(item => item.id === source.id)) throw new Error('Source already exists')

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
   * Create or refresh the delegated source and make it current.
   *
   * The delegated counterpart of completeOAuthLogin: there is no token to
   * store, so this only records that the CLI slot is signed in and which
   * account it holds. One source per install, because the slot is singular.
   */
  upsertDelegatedSource(account: string): AISource {
    const provider = getCliDelegatedProvider()
    const models = Object.entries(CLAUDE_SUBSCRIPTION_MODELS).map(([id, name]) => ({ id, name }))
    const aiSources = this.getAiSourcesConfig()
    const existing = aiSources.sources.find(s => s.authType === 'delegated' && s.provider === provider.type)
    const now = new Date().toISOString()

    if (existing) {
      const source: AISource = {
        ...existing,
        user: { name: account, uid: '' },
        availableModels: models,
        updatedAt: now
      }
      this.writeSource(existing.id, source)
      this.setCurrentSource(existing.id)
      return source
    }

    const source: AISource = {
      id: uuidv4(),
      name: provider.displayName,
      provider: provider.type,
      authType: 'delegated',
      apiUrl: '',
      user: { name: account, uid: '' },
      model: DEFAULT_MODEL,
      availableModels: models,
      createdAt: now,
      updatedAt: now
    }

    this.appendSource(source)
    this.setCurrentSource(source.id)
    console.log(`[AISourceManager] Delegated source created: ${source.id}`)
    return source
  }

  /**
   * Update an existing source
   */
  updateSource(sourceId: string, updates: Partial<AISource>): AISourcesConfig {
    const source = this.getAiSourcesConfig().sources.find(item => item.id === sourceId)
    if (!source) throw new Error('Source not found')
    const metadata = { ...updates }
    delete metadata.id
    delete metadata.createdAt
    delete metadata.authType
    if (metadata.apiKey === MASK_SENTINEL) delete metadata.apiKey
    if (source.authType === 'oauth' || source.authType === 'delegated') {
      delete metadata.provider
      delete metadata.authType
      delete metadata.apiKey
      delete metadata.accessToken
      delete metadata.refreshToken
      delete metadata.tokenExpires
      delete metadata.user
      delete metadata.apiUrl
      delete metadata.apiType
      delete metadata.accountId
      delete metadata.profileArn
      delete metadata.modelCatalogCache
    }
    return this.writeSource(sourceId, metadata)
  }

  private writeSource(sourceId: string, updates: Partial<AISource>): AISourcesConfig {
    this.dropRequestCredentials([sourceId])
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

    return newConfig
  }

  /**
   * Delete a source
   */
  deleteSource(sourceId: string): AISourcesConfig {
    const aiSources = this.getAiSourcesConfig()

    this.tokenRefreshes.delete(sourceId)
    this.catalogRefreshes.delete(sourceId)
    this.dropRequestCredentials([sourceId])
    for (const [providerType, login] of this.logins) {
      if (login.sourceId === sourceId) void this.abandonLogin(providerType, login)
    }
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

  /**
   * User-initiated source switch (Settings UI). Distinct from
   * `setCurrentSource`, which also runs during login/token-refresh flows
   * (`upsertDelegatedSource`) to auto-select the only available source —
   * that isn't a choice the user made among alternatives, so it must not
   * inflate this metric. Shared by IPC and HTTP so both transports are
   * covered from one call site.
   */
  switchCurrentSource(sourceId: string): AISourcesConfig {
    const result = this.setCurrentSource(sourceId)
    if (result.currentId === sourceId) {
      const switched = getCurrentSource(result)
      void analytics.track(AnalyticsEvents.SETTINGS_SOURCE_SWITCH, {
        sourceId,
        sourceName: switched?.name,
        provider: switched?.provider,
        authType: switched?.authType,
      })
    }
    return result
  }

  /**
   * User-initiated model switch (Settings UI). Shared by IPC and HTTP so
   * both transports are covered from one call site.
   */
  switchCurrentModel(modelId: string): AISourcesConfig {
    const before = this.getAiSourcesConfig()
    const result = this.setCurrentModel(modelId)
    if (before.currentId) {
      const source = getCurrentSource(result)
      console.log(
        `[AISourceManager] Set current model: ${modelId} ` +
        `(source=${before.currentId}, provider=${source?.provider ?? 'unknown'})`
      )
      void analytics.track(AnalyticsEvents.SETTINGS_MODEL_SWITCH, {
        sourceId: before.currentId,
        sourceName: source?.name,
        provider: source?.provider,
        modelName: modelId,
      })
    }
    return result
  }

  // ========== OAuth Methods ==========

  /**
   * Start adding (no sourceId) or reauthenticating (sourceId) an OAuth account.
   * A newer start for the same provider supersedes the pending one; it waits
   * for that login to drain, so the provider's single authorization slot is
   * never shared between two logins.
   */
  async startOAuthLogin(providerType: ProviderId, sourceId?: string): Promise<ProviderResult<OAuthStartResult>> {
    await this.ensureInitialized()
    const provider = this.providers.get(providerType)
    if (!provider || !this.isOAuthProvider(provider)) {
      console.warn(`[AISourceManager] OAuth start refused: provider=${providerType} source=${sourceId ?? 'new'} provider unavailable or unsupported`)
      return { success: false, error: `Provider ${providerType} does not support OAuth` }
    }
    const target = sourceId ? this.getSourceConfig(sourceId) : undefined
    if (sourceId && (!target || target.provider !== providerType || target.authType !== 'oauth')) {
      console.warn(`[AISourceManager] OAuth start refused: provider=${providerType} source=${sourceId} target unavailable or mismatched`)
      return { success: false, error: 'OAuth source not found for this provider' }
    }
    const previous = this.logins.get(providerType)
    const login: ManagedOAuthLogin = {
      loginId: uuidv4(), sourceId, target: target ?? undefined,
      cancelled: false, expiresAt: Date.now() + OAUTH_LOGIN_TIMEOUT_MS
    }
    this.logins.set(providerType, login)
    login.timer = setTimeout(() => {
      console.warn(`[AISourceManager] OAuth authorization timed out: provider=${providerType}`)
      void this.abandonLogin(providerType, login)
    }, OAUTH_LOGIN_TIMEOUT_MS)
    login.timer.unref?.()
    login.startPromise = this.startProviderLogin(providerType, provider, login, previous)
    return login.startPromise
  }

  private async startProviderLogin(
    providerType: ProviderId,
    provider: OAuthAISourceProvider,
    login: ManagedOAuthLogin,
    previous?: ManagedOAuthLogin
  ): Promise<ProviderResult<OAuthStartResult>> {
    try {
      if (previous) {
        console.log(`[AISourceManager] OAuth login superseded: provider=${providerType} source=${previous.sourceId ?? 'new'}`)
        await this.drainLogin(providerType, previous)
      }
      if (login.cancelled) {
        console.warn(`[AISourceManager] OAuth start discarded: provider=${providerType} cancelled while the previous login drained`)
        return { success: false, error: 'Login cancelled' }
      }
      const result = await provider.startLogin()
      if (login.cancelled || Date.now() >= login.expiresAt) {
        console.warn(`[AISourceManager] Discarded OAuth start: provider=${providerType} source=${login.sourceId ?? 'new'} authorization cancelled`)
        // The cancellation ran before this authorization existed; clear what the start created.
        await login.cancellation
        try {
          await provider.cancelLogin?.()
        } catch (error) {
          console.warn(`[AISourceManager] OAuth cancellation cleanup failed: provider=${providerType}`, error)
        }
        return { success: false, error: 'Login cancelled or expired' }
      }
      if (!result.success || !result.data) {
        console.warn(`[AISourceManager] OAuth start failed: provider=${providerType} source=${login.sourceId ?? 'new'} ${result.success ? 'missing authorization context' : 'provider rejected authorization'}`)
        return { success: false, error: result.error || 'Failed to start login' }
      }
      login.context = toPublicOAuthStartResult({ ...result.data, loginId: login.loginId })
      return { success: true, data: login.context }
    } catch (error) {
      console.error(`[AISourceManager] OAuth start failed: provider=${providerType}`, error)
      return { success: false, error: 'Failed to start login' }
    } finally {
      if (!login.context) this.finishOAuthLogin(providerType, login)
    }
  }

  getOAuthLoginContext(providerType: ProviderId, loginId?: string): OAuthStartResult | null {
    const login = this.logins.get(providerType)
    return loginId && login?.loginId === loginId && !login.cancelled && Date.now() < login.expiresAt && login.context
      ? toPublicOAuthStartResult(login.context) : null
  }

  /** Cancels only the caller's own login; a superseded or finished one is already gone. */
  async cancelOAuthLogin(providerType: ProviderId, loginId?: string): Promise<ProviderResult<void>> {
    if (!loginId) {
      console.warn(`[AISourceManager] OAuth cancellation refused: provider=${providerType} missing login id`)
      return { success: false, error: 'Login ID is required' }
    }
    const login = this.logins.get(providerType)
    if (!login || login.loginId !== loginId) return { success: true }
    await this.abandonLogin(providerType, login)
    return { success: true }
  }

  /** Idempotent. The slot is released once the login's own provider work has settled. */
  private abandonLogin(providerType: ProviderId, login: ManagedOAuthLogin): Promise<void> {
    if (login.cancellation) return login.cancellation
    login.cancelled = true
    if (login.timer) clearTimeout(login.timer)
    login.cancellation = (async () => {
      try {
        const provider = this.providers.get(providerType)
        if (provider && this.isOAuthProvider(provider)) await provider.cancelLogin?.()
      } catch (error) {
        console.warn(`[AISourceManager] OAuth cancellation cleanup failed: provider=${providerType}`, error)
      }
    })()
    void Promise.allSettled([login.startPromise, login.completionPromise, login.cancellation])
      .then(() => this.finishOAuthLogin(providerType, login))
    return login.cancellation
  }

  private async drainLogin(providerType: ProviderId, login: ManagedOAuthLogin): Promise<void> {
    await this.abandonLogin(providerType, login)
    let timer: ReturnType<typeof setTimeout> | undefined
    const drained = await Promise.race([
      Promise.allSettled([login.startPromise, login.completionPromise]).then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), OAUTH_SUPERSEDE_DRAIN_MS) })
    ])
    clearTimeout(timer)
    if (!drained) {
      console.warn(`[AISourceManager] Superseded OAuth login still running after ${OAUTH_SUPERSEDE_DRAIN_MS}ms: provider=${providerType}; starting the new login anyway`)
    }
  }

  private finishOAuthLogin(providerType: ProviderId, login: ManagedOAuthLogin): void {
    if (login.timer) clearTimeout(login.timer)
    if (this.logins.get(providerType) === login) this.logins.delete(providerType)
  }

  /**
   * Complete OAuth login for a provider type
   */
  async completeOAuthLogin(
    providerType: ProviderId,
    state: string,
    loginId?: string
  ): Promise<ProviderResult<OAuthCompleteResult>> {
    await this.ensureInitialized()
    const provider = this.providers.get(providerType)
    if (!provider || !this.isOAuthProvider(provider)) {
      console.warn(`[AISourceManager] OAuth completion refused: provider=${providerType} provider unavailable or unsupported`)
      return { success: false, error: `Provider ${providerType} does not support OAuth` }
    }
    const login = this.logins.get(providerType)
    if (!loginId || !login || login.cancelled || login.loginId !== loginId || !login.context) {
      console.warn(`[AISourceManager] OAuth completion refused: provider=${providerType} no matching active authorization`)
      return { success: false, error: 'No matching pending authentication' }
    }
    if (Date.now() >= login.expiresAt) {
      console.warn(`[AISourceManager] OAuth completion refused: provider=${providerType} authorization expired`)
      await this.abandonLogin(providerType, login)
      return { success: false, error: 'Login expired' }
    }
    if (login.completionPromise) return login.completionPromise
    login.completionPromise = this.completeProviderLogin(providerType, provider, login, state)
    return login.completionPromise
  }

  private async completeProviderLogin(
    providerType: ProviderId,
    provider: OAuthAISourceProvider,
    login: ManagedOAuthLogin,
    state: string
  ): Promise<ProviderResult<OAuthCompleteResult>> {
    try {
      const result = await provider.completeLogin(state)
      if (login.cancelled || Date.now() >= login.expiresAt) {
        console.warn(`[AISourceManager] Discarded cancelled OAuth completion: provider=${providerType}`)
        return { success: false, error: 'Login cancelled or expired' }
      }
      if (!result.success || !result.data) {
        console.warn(`[AISourceManager] OAuth completion failed: provider=${providerType} source=${login.sourceId ?? 'new'} ${result.success ? 'missing account credentials' : 'provider rejected authorization'}`)
        return { success: false, error: result.error || 'Login failed' }
      }
      const data = result.data as OAuthLoginPayload
      const storedMatches = await this.matchStoredAccounts(providerType, provider, loginAccounts(data), login.target)
      if (login.cancelled || Date.now() >= login.expiresAt) {
        console.warn(`[AISourceManager] Discarded OAuth completion after identity verification: provider=${providerType} cancelled or expired`)
        return { success: false, error: 'Login cancelled or expired' }
      }
      if (login.target && !sameCredentials(this.getSourceConfig(login.target.id), login.target)) {
        console.warn(`[AISourceManager] Discarded obsolete reauthentication: source=${login.target.id}`)
        return { success: false, error: 'Account changed or was removed during login. Please retry.' }
      }
      const sourceIds = this.handleOAuthLoginSuccess(providerType, data, login.target?.id, storedMatches)
      return {
        success: true,
        data: toPublicOAuthCompleteResult({ success: true, user: data.user, sourceId: sourceIds[0], sourceIds })
      }
    } catch (error) {
      console.error(`[AISourceManager] OAuth completion failed: provider=${providerType}`, error)
      return { success: false, error: error instanceof Error ? error.message : 'Login failed' }
    } finally {
      this.finishOAuthLogin(providerType, login)
    }
  }

  /**
   * Stored sources whose identity predates the provider's current format,
   * keyed by the account id the provider now reports for them. Only accounts
   * without an exact identity match are looked up, so a normal login makes no
   * extra request.
   */
  private async matchStoredAccounts(
    providerType: ProviderId,
    provider: OAuthAISourceProvider,
    accounts: OAuthLoginAccount[],
    target?: AISource
  ): Promise<Map<string, string>> {
    const matches = new Map<string, string>()
    const accountIds = new Set(accounts.map(account => account.id).filter(Boolean))
    if (!provider.getAccountId || accountIds.size === 0) return matches
    const sources = this.getAiSourcesConfig().sources
      .filter(source => source.provider === providerType && source.authType === 'oauth')
    // A reauthentication only needs its target's current id; a new login only
    // considers accounts no stored source already claims.
    const claimed = new Set(sources.map(source => source.user?.uid).filter((uid): uid is string => !!uid))
    const unmatched = target ? accountIds : new Set([...accountIds].filter(id => !claimed.has(id)))
    const candidates = target
      ? (target.user?.uid && !accountIds.has(target.user.uid) ? [target] : [])
      : sources.filter(source => !accountIds.has(source.user?.uid ?? ''))
    if (unmatched.size === 0 || candidates.length === 0) return matches

    await Promise.all(candidates.map(async candidate => {
      try {
        // A target is checked with the credential the login captured, so the
        // later unchanged-credential check still holds; other accounts may
        // need a renewed token before the provider can name them.
        const refreshed: ProviderResult<void> = target ? { success: true } : await this.ensureValidToken(candidate.id)
        const current = refreshed.success ? this.getSourceConfig(candidate.id) : null
        if (!current) {
          console.warn(`[AISourceManager] Stored account identity unavailable: source=${candidate.id} ${refreshed.error || 'source removed'}`)
          return
        }
        const accountId = await provider.getAccountId!(this.buildLegacyOAuthConfig(current))
        if (accountId && unmatched.has(accountId) && !matches.has(accountId)) {
          matches.set(accountId, candidate.id)
          console.log(`[AISourceManager] Matched stored account by provider identity: provider=${providerType} source=${candidate.id}`)
        }
      } catch (error) {
        console.warn(`[AISourceManager] Stored account identity unavailable: source=${candidate.id}`, error)
      }
    }))
    return matches
  }

  private handleOAuthLoginSuccess(
    providerType: ProviderId,
    data: OAuthLoginPayload,
    targetId: string | undefined,
    storedMatches: Map<string, string>
  ): string[] {
    const tokenData = data._tokenData
    const defaultModel = data._defaultModel || ''
    const models: ModelOption[] = (data._availableModels || []).map(id => ({
      id, name: data._modelNames?.[id] || id,
      ...(data._modelCapabilities?.[id] ? { capabilities: data._modelCapabilities[id] } : {}),
      ...(typeof data._modelVision?.[id] === 'boolean' ? { supportsVision: data._modelVision[id] } : {})
    }))
    if (!models.length && defaultModel) models.push({ id: defaultModel, name: data._modelNames?.[defaultModel] || defaultModel })
    const aiSources = this.getAiSourcesConfig()
    const target = targetId ? aiSources.sources.find(source => source.id === targetId) : undefined
    if (targetId && !target) throw new Error('Source was removed during login')
    const accounts = loginAccounts(data)
    if (accounts.some(account => !account.key)) throw new Error('Login returned no access token')
    const matchesTarget = (account: OAuthLoginAccount) => !target?.user?.uid ||
      (!!account.id && (account.id === target.user.uid || storedMatches.get(account.id) === target.id))
    const selectedAccounts = target
      ? [accounts.find(matchesTarget) ?? (() => { throw new Error('A different account was authorized. Add it as a new account instead.') })()]
      : accounts
    let sources = [...aiSources.sources]
    const ids: string[] = []
    const now = new Date().toISOString()
    const sameProvider = (source: AISource) => source.provider === providerType && source.authType === 'oauth'
    for (const account of selectedAccounts) {
      let existing = target
      if (!existing && account.id) {
        const storedId = storedMatches.get(account.id)
        existing = sources.find(source => sameProvider(source) && source.user?.uid === account.id) ??
          (storedId ? sources.find(source => source.id === storedId) : undefined)
      } else if (!existing) {
        // Without a verified identity, multiple accounts cannot be told apart:
        // reuse the provider's only unverified source instead of adding another.
        const unverified = sources.filter(source => sameProvider(source) && !source.user?.uid)
        existing = unverified.length === 1 ? unverified[0] : undefined
        console.warn(`[AISourceManager] OAuth login without verified account identity: provider=${providerType} ${existing ? `reusing source=${existing.id}` : 'adding a new source'}`)
      }
      const id = existing?.id || uuidv4()
      const offline = data._catalogDegraded && existing
        ? this.providers.get(providerType)?.getOfflineConfig?.(this.buildLegacyOAuthConfig(existing))
        : undefined
      const offlineData = (offline as Record<string, OAuthSourceConfig> | undefined)?.[providerType]
      const loginModels = offlineData?.availableModels?.map(modelId => ({
        ...existing?.availableModels.find(model => model.id === modelId),
        id: modelId, name: offlineData.modelNames?.[modelId] || modelId,
        ...(offlineData.modelCapabilities?.[modelId] ? { capabilities: offlineData.modelCapabilities[modelId] } : {}),
        ...(typeof offlineData.modelVision?.[modelId] === 'boolean' ? { supportsVision: offlineData.modelVision[modelId] } : {})
      })) ?? (models.length ? models : existing?.availableModels || [])
      const name = existing?.name || (data._accounts?.length
        ? account.label : getBuiltinProvider(providerType)?.name || getProviderDisplayName(providerType))
      const source: AISource = {
        ...existing,
        id, name, provider: providerType, authType: 'oauth',
        apiUrl: data._apiUrl ?? existing?.apiUrl ?? '',
        accountId: data._accountId ?? existing?.accountId,
        profileArn: data._profileArn ?? existing?.profileArn,
        accessToken: account.key,
        refreshToken: data._accounts?.length ? '' : tokenData?.refreshToken || existing?.refreshToken || '',
        tokenExpires: tokenData?.expiresAt,
        user: { ...data.user, name: account.label, uid: account.id || existing?.user?.uid || '' },
        model: existing?.model || defaultModel,
        availableModels: loginModels,
        modelCatalogCache: data._modelCatalogCache ?? existing?.modelCatalogCache,
        createdAt: existing?.createdAt || now, updatedAt: now
      }
      sources = existing ? sources.map(item => item.id === id ? source : item) : [...sources, source]
      this.tokenRefreshes.delete(id)
      this.catalogRefreshes.delete(id)
      this.dropRequestCredentials([id])
      ids.push(id)
    }
    saveConfig({ aiSources: {
      ...aiSources, currentId: aiSources.currentId || ids[0] || null, sources
    }, isFirstLaunch: false } as any)
    console.log(`[AISourceManager] OAuth account credentials saved: provider=${providerType} sources=${ids.join(',')}`)
    return ids
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

    const decrypted = this.getSourceConfig(sourceId) || source
    // Remove locally before awaiting revocation so late refreshes cannot revive
    // the account or delete credentials obtained by a subsequent login.
    this.deleteSource(sourceId)
    if (source.authType === 'oauth') {
      const provider = this.providers.get(source.provider)
      if (provider && this.isOAuthProvider(provider)) {
        try {
          await provider.logout(this.buildLegacyOAuthConfig(decrypted))
        } catch (error) {
          console.warn(`[AISourceManager] Account removed; upstream logout failed: source=${sourceId}`, error)
        }
      }
    }

    console.log(`[AISourceManager] Logout complete for source: ${sourceId}`)

    return { success: true }
  }

  // ========== Token Management ==========

  /**
   * Check and refresh token if needed (for OAuth sources)
   */
  async ensureValidToken(sourceId: string, modelId?: string): Promise<ProviderResult<void>> {
    const source = this.getSourceConfig(sourceId)
    if (!source) {
      console.warn(`[AISourceManager] Token preparation refused: source=${sourceId} source not found`)
      return { success: false, error: 'Source not found' }
    }
    if (source.authType !== 'oauth') return { success: true }
    if (!source.accessToken) {
      console.warn(`[AISourceManager] Token preparation refused: source=${sourceId} account is not signed in`)
      return { success: false, error: 'Account is not signed in. Please sign in again.' }
    }
    const provider = this.providers.get(source.provider) as OAuthProviderWithTokenManagement | undefined
    if (!provider) {
      console.warn(`[AISourceManager] Token preparation refused: source=${sourceId} provider=${source.provider} provider unavailable`)
      return { success: false, error: 'Authentication provider is unavailable' }
    }
    if (!provider.checkTokenWithConfig || !provider.refreshTokenWithConfig) return { success: true }
    const model = modelId || source.model
    const pending = this.tokenRefreshes.get(sourceId)
    if (pending && sameCredentials(source, pending.source)) {
      if (pending.model === model) return pending.promise
      await pending.promise
      return this.ensureValidToken(sourceId, modelId)
    }
    const legacyConfig = this.buildLegacyOAuthConfig(source, modelId)
    const tokenStatus = provider.checkTokenWithConfig(legacyConfig)
    if (tokenStatus.valid && !tokenStatus.needsRefresh) return { success: true }
    const refresh = { source, model, promise: Promise.resolve<ProviderResult<void>>({ success: true }) }
    this.tokenRefreshes.set(sourceId, refresh)
    refresh.promise = (async (): Promise<ProviderResult<void>> => {
      try {
        const result = await provider.refreshTokenWithConfig!(legacyConfig)
        const current = this.getSourceConfig(sourceId)
        if (this.tokenRefreshes.get(sourceId) !== refresh || !sameCredentials(current, source)) {
          console.warn(`[AISourceManager] Discarded obsolete token refresh: source=${sourceId}`)
          return current?.accessToken
            ? { success: true } : { success: false, error: 'Account was removed during token refresh' }
        }
        if (!result.success || !result.data?.accessToken) {
          console.warn(`[AISourceManager] Token refresh failed: source=${sourceId} reason=${result.error || 'No access token'}`)
          return { success: false, error: result.error || 'Token refresh returned no access token' }
        }
        this.writeSource(sourceId, {
          accessToken: result.data.accessToken,
          refreshToken: result.data.refreshToken || source.refreshToken,
          tokenExpires: result.data.expiresAt,
          ...(result.data.apiUrl ? { apiUrl: result.data.apiUrl } : {}),
          ...(result.data.profileArn ? { profileArn: result.data.profileArn } : {})
        })
        return { success: true }
      } catch (error) {
        console.error(`[AISourceManager] Token refresh failed: source=${sourceId}`, error)
        return { success: false, error: error instanceof Error ? error.message : 'Token refresh failed' }
      } finally {
        if (this.tokenRefreshes.get(sourceId) === refresh) this.tokenRefreshes.delete(sourceId)
      }
    })()
    return refresh.promise
  }

  /**
   * The current credential for a request the router proxies on an account's
   * behalf. Answers from memory for up to a minute; any write to the account
   * drops its answers at once. Null keeps the session's encoded credential.
   * Throws when the account can no longer be used, so the request fails with
   * a clear reason instead of borrowing a credential the user removed.
   */
  async resolveRequestCredentials(sourceId: string, model?: string): Promise<RequestCredentials | null> {
    const key = `${sourceId}\u0000${model ?? ''}`
    const cached = this.requestCredentials.get(key)
    if (cached && Date.now() - cached.checkedAt < REQUEST_CREDENTIAL_RECHECK_MS) return cached.credentials

    const source = this.getSourceConfig(sourceId)
    if (!source) throw new Error(ACCOUNT_REMOVED_ERROR)
    let credentials: RequestCredentials | null = null
    if (source.authType === 'oauth') {
      if (!source.accessToken) throw new Error('This account is signed out. Sign in again to continue.')
      const token = await this.ensureValidToken(sourceId, model)
      if (token.success) {
        const backend = this.getBackendConfigForSource(sourceId, model)
        credentials = backend
          ? { key: backend.key, headers: backend.headers, profileArn: backend.profileArn }
          : null
      } else if (!this.getSourceConfig(sourceId)) {
        throw new Error(ACCOUNT_REMOVED_ERROR)
      } else {
        // The renewal may have failed transiently; the encoded token can still be valid. Retried after the recheck interval.
        console.warn(`[AISourceManager] Request credential not renewed: source=${sourceId} ${token.error ?? 'unknown error'}; keeping the session credential`)
      }
    }
    this.requestCredentials.set(key, { sourceId, credentials, checkedAt: Date.now() })
    return credentials
  }

  /** Undefined drops every cached answer. */
  private dropRequestCredentials(sourceIds?: string[]): void {
    if (!sourceIds) {
      this.requestCredentials.clear()
      return
    }
    for (const [key, entry] of this.requestCredentials) {
      if (sourceIds.includes(entry.sourceId)) this.requestCredentials.delete(key)
    }
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
   * Only non-sensitive fields (availableModels, model, modelOverrides,
   * updatedAt) are written; encrypted tokens on disk are never touched.
   */
  async refreshSourceConfig(sourceId: string): Promise<ProviderResult<{ degraded: boolean }>> {
    await this.ensureInitialized()
    const source = this.getSourceConfig(sourceId)
    if (!source) {
      console.warn(`[AISourceManager] Catalog refresh refused: source=${sourceId} no longer exists`)
      return { success: false, error: 'Source not found' }
    }
    const pending = this.catalogRefreshes.get(sourceId)
    if (pending && sameCredentials(source, pending.source)) return pending.promise
    const refresh: ManagedCatalogRefresh = { source, promise: Promise.resolve({ success: true }) }
    this.catalogRefreshes.set(sourceId, refresh)
    refresh.promise = this.refreshSourceCatalog(sourceId, refresh).finally(() => {
      if (this.catalogRefreshes.get(sourceId) === refresh) this.catalogRefreshes.delete(sourceId)
    })
    return refresh.promise
  }

  private async refreshSourceCatalog(sourceId: string, refresh: ManagedCatalogRefresh): Promise<ProviderResult<{ degraded: boolean }>> {
    // Capability check first — decide "unsupported" without an unrelated token
    // refresh. Uses the plain (non-decrypted) config since only provider type
    // is needed here.
    const source = this.getAiSourcesConfig().sources.find(s => s.id === sourceId)
    if (!source) {
      return { success: false, error: 'Source not found' }
    }

    const provider = this.providers.get(source.provider)
    if (!provider?.refreshConfig) {
      // Provider does not support refresh — not an error
      return { success: true }
    }

    // Renew an expired OAuth token before the provider calls its server;
    // providers never retry internally. Without this, a refresh scheduled at
    // startup runs against whatever token was on disk — expired after the app
    // was closed overnight — and the resulting 401 degrades the source to its
    // hardcoded fallback catalog for the rest of the session.
    const tokenResult = await this.ensureValidToken(sourceId)
    if (!tokenResult.success) {
      console.warn(`[AISourceManager] Catalog refresh authentication failed for ${source.id} (${source.provider}); offline reconstruction: ${Boolean(provider.getOfflineConfig)}`)
      if (!provider.getOfflineConfig) {
        return { success: false, error: tokenResult.error || 'Token refresh failed' }
      }
    }

    // Re-read decrypted config AFTER refresh so a rotated token is carried in.
    // Decrypted config is needed so providers can make authenticated API calls.
    const refreshed = this.getDecryptedAiSources().sources.find(s => s.id === sourceId)
    if (!refreshed) {
      console.warn(`[AISourceManager] Catalog refresh discarded after authentication: source=${sourceId} was removed`)
      return { success: false, error: 'Source not found' }
    }

    if (this.catalogRefreshes.get(sourceId) !== refresh) {
      console.warn(`[AISourceManager] Catalog refresh discarded before fetch: source=${sourceId} account changed`)
      return { success: false, error: 'Account changed during model refresh. Please retry.' }
    }
    refresh.source = refreshed
    // Build legacy config format that all providers consume
    const legacyConfig = this.buildLegacyOAuthConfig(refreshed)

    console.log(`[AISourceManager] Refreshing source "${source.name}" (${source.provider})`)

    const result = tokenResult.success
      ? await provider.refreshConfig(legacyConfig)
      : { success: true, data: provider.getOfflineConfig!(legacyConfig) }

    if (!result.success || !result.data) {
      console.warn(`[AISourceManager] Refresh failed for "${source.name}":`, result.error)
      return { success: false, error: result.error || 'Refresh failed' }
    }

    // Provider returns { [providerType]: { availableModels, modelNames, model, ... } }
    const providerData = (result.data as Record<string, any>)[source.provider]
    if (!providerData) {
      return { success: true } // No updates from provider
    }

    // Unreconciled fallback lists from other providers must not erase fetched metadata.
    if (providerData.degraded && !providerData.catalogReconciled) {
      console.warn(
        `[AISourceManager] Refresh degraded for "${source.name}" (${source.provider}): ` +
          `provider served a fallback catalog, keeping stored models and capabilities`
      )
      return { success: true, data: { degraded: true } }
    }

    // Convert provider's string[] + modelNames to v2 ModelOption[]
    const modelIds: string[] = providerData.availableModels || []
    const modelNames: Record<string, string> = providerData.modelNames || {}
    const models: ModelOption[] = modelIds.map(id => ({
      id,
      name: modelNames[id] || id,
      ...(providerData.modelCapabilities?.[id] ? { capabilities: providerData.modelCapabilities[id] } : {}),
      ...(typeof providerData.modelVision?.[id] === 'boolean' ? { supportsVision: providerData.modelVision[id] } : {})
    }))

    // Read fresh config from disk to avoid overwriting concurrent token rotations
    const freshAiSources = this.getAiSourcesConfig()
    const current = this.getSourceConfig(sourceId)
    if (this.catalogRefreshes.get(sourceId) !== refresh || !sameCredentials(current, refreshed)) {
      console.warn(`[AISourceManager] Discarded obsolete model catalog: source=${sourceId}`)
      return { success: false, error: 'Account changed during model refresh. Please retry.' }
    }
    const now = new Date().toISOString()

    const nextOverrides = providerData.modelOverrides as AISource['modelOverrides']

    const updatedSources = freshAiSources.sources.map(s => {
      if (s.id !== sourceId) return s
      return {
        ...s,
        availableModels: models.length > 0 || providerData.catalogReconciled
          ? models.map(model => providerData.degraded
            ? { ...s.availableModels.find(item => item.id === model.id), ...model }
            : model)
          : s.availableModels,
        model: providerData.degraded || s.model !== refreshed.model ? s.model : (providerData.model || s.model),
        modelCatalogCache: providerData.modelCatalogCache ?? s.modelCatalogCache,
        modelOverrides: JSON.stringify(s.modelOverrides) === JSON.stringify(refreshed.modelOverrides)
          ? nextOverrides ?? s.modelOverrides : s.modelOverrides,
        updatedAt: now
      }
    })

    saveConfig({
      aiSources: {
        ...freshAiSources,
        sources: updatedSources
      }
    } as any)

    console.log(`[AISourceManager] Catalog ${providerData.degraded ? 'reconstructed offline' : 'refreshed'} for ${source.id} (${source.provider}): ${models.length} models`)
    return { success: true, data: { degraded: Boolean(providerData.degraded) } }
  }

  async refreshAllConfigs(): Promise<ModelRefreshSummary> {
    await this.ensureInitialized()
    const aiSources = this.getAiSourcesConfig()
    const summary: ModelRefreshSummary = { degradedSourceIds: [], failedSourceIds: [] }

    for (const source of aiSources.sources) {
      try {
        const result = await this.refreshSourceConfig(source.id)
        if (!result.success) summary.failedSourceIds.push(source.id)
        else if (result.data?.degraded) summary.degradedSourceIds.push(source.id)
      } catch (error) {
        summary.failedSourceIds.push(source.id)
        console.error(`[AISourceManager] Failed to refresh ${source.name}:`, error)
      }
    }
    return summary
  }

  // ========== Metered Quota ==========

  /**
   * Report the current metered quota for a source. The provider owns the
   * semantics: it queries its own server with a fresh token and returns a
   * uniform AuthQuotaSnapshot. A provider that is not OAuth or lacks getQuota()
   * has no quota concept and returns `data: null` (unsupported, not an error).
   */
  async getSourceQuota(sourceId: string): Promise<ProviderResult<AuthQuotaSnapshot | null>> {
    await this.ensureInitialized()

    // Capability check first — decide "unsupported" without an unrelated token
    // refresh. Uses the plain (non-decrypted) config since only provider type is
    // needed here.
    const source = this.getAiSourcesConfig().sources.find(s => s.id === sourceId)
    if (!source) {
      return { success: false, error: 'Source not found' }
    }

    const provider = this.providers.get(source.provider)
    if (!provider || !this.isOAuthProvider(provider) || !provider.getQuota) {
      return { success: true, data: null }
    }

    // Renew an expired OAuth token before the provider calls its server;
    // providers never retry internally.
    const tokenResult = await this.ensureValidToken(sourceId)
    if (!tokenResult.success) {
      return { success: false, error: tokenResult.error || 'Token refresh failed' }
    }

    // Re-read decrypted config AFTER refresh so a rotated token is carried in.
    const refreshed = this.getDecryptedAiSources().sources.find(s => s.id === sourceId)
    if (!refreshed) {
      return { success: false, error: 'Source not found' }
    }

    const legacyConfig = this.buildLegacyOAuthConfig(refreshed)
    const result = await provider.getQuota(legacyConfig)
    if (!result.success) {
      console.warn(`[AISourceManager] Quota fetch failed for "${refreshed.name}":`, result.error)
      return { success: false, error: result.error || 'Quota fetch failed' }
    }

    return { success: true, data: result.data ?? null }
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
        sourceId: source.id,
        apiUrl: source.apiUrl,
        accountId: source.accountId,
        profileArn: source.profileArn,
        loggedIn: true,
        user: source.user,
        model: effectiveModel,
        // Runtime-tolerant: a legacy or externally written source can omit the
        // list, and a throw here would abort logout before the source is deleted.
        availableModels: (source.availableModels || []).map(m => m.id),
        modelNames: Object.fromEntries((source.availableModels || []).map(m => [m.id, m.name])),
        modelCapabilities: Object.fromEntries((source.availableModels || []).filter(m => m.capabilities).map(m => [m.id, m.capabilities])),
        modelVision: Object.fromEntries((source.availableModels || []).filter(m => typeof m.supportsVision === 'boolean').map(m => [m.id, m.supportsVision])),
        modelCatalogCache: source.modelCatalogCache,
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
