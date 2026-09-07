/**
 * Custom AI Source Provider
 *
 * Handles custom API configuration (Anthropic Claude or OpenAI compatible).
 * This is the simplest provider - no OAuth, just API key configuration.
 *
 * Design Notes:
 * - Stateless: all state comes from config
 * - No authentication flow needed
 * - Supports both Anthropic and OpenAI compatible endpoints
 *
 * Architecture Note (v2 Migration):
 * ================================
 * As of v2, the data structure changed from:
 *   v1: { current: 'custom', custom: {...}, 'github-copilot': {...} }
 *   v2: { version: 2, currentId: 'uuid', sources: AISource[] }
 *
 * For API Key providers (like 'custom'), the AISourceManager now handles
 * configuration directly from the AISource object, WITHOUT calling these
 * provider methods. These methods are kept for interface compliance but
 * are NOT called at runtime.
 *
 * For OAuth providers, the manager uses buildLegacyOAuthConfig() to convert
 * v2 AISource to v1 format before calling provider methods, ensuring backward
 * compatibility with external plugins.
 *
 * TODO: In a future major version, migrate provider interface to accept
 * AISource directly instead of legacy config format.
 */

import type {
  AISourceProvider,
  ProviderResult
} from '../../../../shared/interfaces'
import type {
  AISourcesConfig,
  AISourceType,
  BackendRequestConfig,
  CustomSourceConfig,
  LegacyAISourcesConfig
} from '../../../../shared/types'
import { AVAILABLE_MODELS } from '../../../../shared/types'

/**
 * Anthropic API base URL
 */
const ANTHROPIC_API_URL = 'https://api.anthropic.com'

/**
 * Custom AI Source Provider Implementation
 *
 * NOTE: For 'custom' (API Key) providers, these methods are NOT called by
 * AISourceManager at runtime. The manager reads configuration directly from
 * the AISource object. These implementations exist only for interface
 * compliance and potential future use.
 */
export class CustomAISourceProvider implements AISourceProvider {
  readonly type: AISourceType = 'custom'
  readonly displayName = 'Custom API'

  /**
   * Check if custom API is configured
   *
   * @param config - Legacy format config (v1), not called for API Key providers
   */
  isConfigured(config: AISourcesConfig): boolean {
    const customConfig = (config as unknown as LegacyAISourcesConfig).custom as CustomSourceConfig | undefined
    return !!(customConfig?.apiKey)
  }

  /**
   * Get backend request configuration
   *
   * @param config - Legacy format config (v1), not called for API Key providers
   */
  getBackendConfig(config: AISourcesConfig): BackendRequestConfig | null {
    const customConfig = (config as unknown as LegacyAISourcesConfig).custom as CustomSourceConfig | undefined
    if (!customConfig?.apiKey) {
      return null
    }

    const isAnthropic = customConfig.provider === 'anthropic'
    const baseUrl = customConfig.apiUrl || ANTHROPIC_API_URL

    // Remove trailing slash from base URL if present
    const cleanBaseUrl = baseUrl.replace(/\/$/, '')

    // Return URL as-is - user provides the complete endpoint URL
    // For Anthropic: base URL only (SDK will add /v1/messages)
    // For OpenAI compatible: user should provide full endpoint like https://api.example.com/v1/chat/completions
    return {
      url: cleanBaseUrl,
      key: customConfig.apiKey,
      model: customConfig.model,
      // For OpenAI compatible, infer API type from URL
      apiType: isAnthropic ? undefined : this.inferApiTypeFromUrl(cleanBaseUrl)
    }
  }

  /**
   * Infer API type from URL
   */
  private inferApiTypeFromUrl(url: string): 'chat_completions' | 'responses' {
    if (url.includes('/responses')) return 'responses'
    // Default to chat_completions (most common for third-party providers)
    return 'chat_completions'
  }

  /**
   * Get current model ID
   *
   * @param config - Legacy format config (v1), not called for API Key providers
   */
  getCurrentModel(config: AISourcesConfig): string | null {
    const customConfig = (config as unknown as LegacyAISourcesConfig).custom as CustomSourceConfig | undefined
    return customConfig?.model || null
  }

  /**
   * Get available models - returns static list for custom API
   *
   * @param config - Legacy format config (v1), not called for API Key providers
   */
  async getAvailableModels(config: AISourcesConfig): Promise<string[]> {
    const customConfig = (config as unknown as LegacyAISourcesConfig).custom as CustomSourceConfig | undefined
    if (!customConfig) {
      return []
    }

    // For Anthropic provider, return known Claude models
    if (customConfig.provider === 'anthropic') {
      return AVAILABLE_MODELS.map(m => m.id)
    }

    // For OpenAI compatible, we don't know the models
    // User needs to specify manually
    return []
  }

  /**
   * No refresh needed for custom API
   */
  async refreshConfig(_config: AISourcesConfig): Promise<ProviderResult<Partial<AISourcesConfig>>> {
    // Custom API doesn't need refresh - configuration is static
    return { success: true, data: {} }
  }
}

/**
 * Singleton instance
 */
let instance: CustomAISourceProvider | null = null

/**
 * Get the CustomAISourceProvider instance
 */
export function getCustomProvider(): CustomAISourceProvider {
  if (!instance) {
    instance = new CustomAISourceProvider()
  }
  return instance
}
