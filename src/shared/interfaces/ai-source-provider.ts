/**
 * AI Source Provider Interface
 *
 * This interface defines the contract that all AI source providers must implement.
 * Following the Open/Closed Principle - open for extension, closed for modification.
 *
 * Each provider handles:
 * - Authentication (if needed)
 * - Configuration management
 * - Backend request configuration generation
 *
 * Design Notes:
 * - Providers are stateless services
 * - Configuration is stored externally (config service)
 * - Providers generate BackendRequestConfig for the OpenAI compat router
 *
 * Architecture Note (v2 Migration - IMPORTANT for contributors):
 * ==============================================================
 * The internal data structure migrated from v1 to v2:
 *   v1: { current: 'custom', custom: {...}, 'github-copilot': {...} }
 *   v2: { version: 2, currentId: 'uuid', sources: AISource[] }
 *
 * However, the provider interface still uses v1-style config access for
 * backward compatibility with external plugins:
 *
 * - For OAuth providers: AISourceManager converts v2 AISource to v1 format
 *   via buildLegacyOAuthConfig() before calling provider methods.
 *   External plugins continue to work without modification.
 *
 * - For API Key providers: AISourceManager handles config directly from
 *   AISource object, provider methods are NOT called at runtime.
 *
 * TODO (Future Major Version):
 * - Migrate provider interface to accept AISource directly
 * - Update all providers to use new interface
 * - Update docs/custom-providers.md accordingly
 */

import type {
  AISourceType,
  BackendRequestConfig,
  AISourcesConfig,
  OAuthSourceConfig,
  CustomSourceConfig,
  OAuthStartResult,
  OAuthCompleteResult,
  AISourceUserInfo,
  AuthQuotaSnapshot
} from '../types'

/**
 * Result type for async operations
 */
export interface ProviderResult<T> {
  success: boolean
  data?: T
  error?: string
}

/**
 * OAuth Provider Interface
 *
 * For sources that require OAuth login flow
 */
export interface OAuthProvider {
  /**
   * Start the OAuth login flow
   * Opens browser to login URL and returns state for tracking
   */
  startLogin(): Promise<ProviderResult<OAuthStartResult>>

  /**
   * Complete the OAuth login flow
   * Polls for token completion and returns user info
   */
  completeLogin(state: string): Promise<ProviderResult<OAuthCompleteResult>>

  /**
   * Refresh the access token if expired
   */
  refreshToken(): Promise<ProviderResult<void>>

  /**
   * Check if the current token is valid
   */
  checkToken(): Promise<ProviderResult<{ valid: boolean; expiresIn?: number }>>

  /**
   * Logout and clear tokens
   */
  logout(): Promise<ProviderResult<void>>
}

/**
 * AI Source Provider Interface
 *
 * All AI source providers must implement this interface.
 * Providers are responsible for:
 * - Managing their specific configuration
 * - Generating backend request configuration
 * - Handling authentication if required
 *
 * Note: The config parameter uses v1 legacy format for backward compatibility.
 * See file header comments for migration details.
 */
export interface AISourceProvider {
  /**
   * Unique identifier for this provider
   */
  readonly type: AISourceType

  /**
   * Human-readable name for display
   */
  readonly displayName: string

  /**
   * Check if this provider is configured and ready to use
   *
   * @param config Legacy format: { current: string, [providerType]: {...} }
   *               For OAuth providers, manager passes converted v1 format.
   *               For API Key providers, this method is NOT called at runtime.
   */
  isConfigured(config: AISourcesConfig): boolean

  /**
   * Get backend request configuration for making API calls
   *
   * This is the core method that generates the config needed
   * by the OpenAI compat router to make actual API requests.
   *
   * @param config Legacy format: { current: string, [providerType]: {...} }
   *               For OAuth providers, manager passes converted v1 format.
   *               For API Key providers, this method is NOT called at runtime.
   * @returns Backend request config or null if not configured
   */
  getBackendConfig(config: AISourcesConfig): BackendRequestConfig | null

  /**
   * Get the current model ID for this provider
   *
   * @param config Legacy format (see above)
   */
  getCurrentModel(config: AISourcesConfig): string | null

  /**
   * Get available models for this provider
   * May fetch from remote API or return static list
   *
   * @param config Legacy format (see above)
   */
  getAvailableModels(config: AISourcesConfig): Promise<string[]>

  /**
   * Refresh provider-specific configuration from remote API
   * (e.g., fetch available models, update user info)
   *
   * @param config Legacy format (see above)
   * @returns Updated configuration for this provider
   */
  refreshConfig?(config: AISourcesConfig): Promise<ProviderResult<Partial<AISourcesConfig>>>
}

/**
 * OAuth AI Source Provider Interface
 *
 * Extends AISourceProvider for providers that use OAuth authentication
 */
export interface OAuthAISourceProvider extends AISourceProvider, OAuthProvider {
  /**
   * Get the current logged-in user info
   */
  getUserInfo(config: AISourcesConfig): AISourceUserInfo | null

  /**
   * Report the current metered quota for this source. Optional capability:
   * absent means the provider has no quota concept and no UI is shown. Only a
   * managed OAuth provider that owns its server can report a spendable balance.
   *
   * @param config Legacy format (see file header); accessToken is decrypted.
   */
  getQuota?(config: AISourcesConfig): Promise<ProviderResult<AuthQuotaSnapshot>>
}

/**
 * Type guard to check if provider supports OAuth
 */
export function isOAuthProvider(provider: AISourceProvider): provider is OAuthAISourceProvider {
  return 'startLogin' in provider && 'completeLogin' in provider
}

/**
 * Provider Registry Entry
 *
 * Used by AISourceManager to maintain provider instances
 */
export interface ProviderRegistryEntry {
  type: AISourceType
  provider: AISourceProvider
  priority: number // Lower = higher priority for fallback selection
}
