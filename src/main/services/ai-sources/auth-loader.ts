/**
 * Auth Provider Loader
 *
 * Dynamically loads authentication providers based on product.json configuration.
 *
 * Design Principles:
 * - Configuration-driven provider loading
 * - Graceful fallback when providers are unavailable
 * - Type-safe provider interface enforcement
 *
 * Product-config reading (product.json shape, loaders, data-folder name,
 * service/IM/telemetry defaults) lives in the foundation tier
 * (`foundation/product-config.ts`). This module imports what it needs from
 * there and keeps only the provider-loading domain logic.
 */

import { join, dirname } from 'path'
import { pathToFileURL } from 'url'
import { existsSync } from 'fs'
import type { AISourceProvider, OAuthAISourceProvider } from '../../../shared/interfaces'
import { type AuthProviderConfig, type AISourceType } from '../../../shared/types'
import { loadProductConfig, getProductConfigPath } from '../../foundation/product-config'

// AuthProviderConfig is defined in src/shared/types/ai-sources.ts so the main
// loader and the renderer setup UI share one source of truth. Re-exported here
// for ergonomic local imports from this module.
export { type AuthProviderConfig }

/**
 * Loaded provider with its configuration
 */
export interface LoadedProvider {
  config: AuthProviderConfig
  provider: AISourceProvider | null
  loadError?: string
}

// ============================================================================
// Provider Loading
// ============================================================================

/**
 * Resolve the absolute path to a provider module
 */
function resolveProviderPath(providerConfig: AuthProviderConfig): string | null {
  if (!providerConfig.path) return null

  const configPath = getProductConfigPath()
  const configDir = dirname(configPath)

  // Remove leading ./ from path if present
  const cleanPath = providerConfig.path.startsWith('./')
    ? providerConfig.path.slice(2)
    : providerConfig.path

  // Resolve path relative to product.json
  return join(configDir, cleanPath)
}

/**
 * Load a provider module dynamically using ESM import()
 */
async function loadProviderModuleAsync(providerPath: string): Promise<AISourceProvider | null> {
  try {
    // Check if the provider directory exists
    if (!existsSync(providerPath)) {
      console.log(`[AuthLoader] Provider path does not exist: ${providerPath}`)
      return null
    }

    // Use file URL to ensure Windows paths import correctly
    const importUrl = pathToFileURL(providerPath).href
    console.log(`[AuthLoader] Attempting to load provider from: ${importUrl}`)

    // Use dynamic import for ESM compatibility
    const providerModule = await import(importUrl)

    // Look for a getter function (e.g., getGoogleProvider)
    const getterNames = Object.keys(providerModule).filter(key =>
      key.startsWith('get') && key.endsWith('Provider') && typeof providerModule[key] === 'function'
    )

    if (getterNames.length > 0) {
      const provider = providerModule[getterNames[0]]()
      console.log(`[AuthLoader] Loaded provider from ${providerPath} using ${getterNames[0]}`)
      return provider
    }

    // Fallback: look for a class export
    const classNames = Object.keys(providerModule).filter(key =>
      key.endsWith('Provider') && typeof providerModule[key] === 'function'
    )

    if (classNames.length > 0) {
      const ProviderClass = providerModule[classNames[0]]
      const provider = new ProviderClass()
      console.log(`[AuthLoader] Loaded provider from ${providerPath} using class ${classNames[0]}`)
      return provider
    }

    console.warn(`[AuthLoader] No provider found in module: ${providerPath}`)
    return null
  } catch (error) {
    console.error(`[AuthLoader] Failed to load provider from ${providerPath}:`, error)
    return null
  }
}

/**
 * Load all enabled providers based on product.json configuration
 * This is the core configuration-driven loading mechanism
 */
export async function loadAuthProvidersAsync(): Promise<LoadedProvider[]> {
  const config = loadProductConfig()
  const loadedProviders: LoadedProvider[] = []

  for (const providerConfig of config.authProviders) {
    if (!providerConfig.enabled) {
      console.log(`[AuthLoader] Skipping disabled provider: ${providerConfig.type}`)
      continue
    }

    const loaded: LoadedProvider = {
      config: providerConfig,
      provider: null
    }

    if (providerConfig.builtin) {
      // Built-in provider (loaded separately by manager)
      console.log(`[AuthLoader] Built-in provider: ${providerConfig.type}`)
      loaded.provider = null // Will be loaded by manager
    } else if (providerConfig.preset) {
      // Preset API provider - rendered as an API-key form in the renderer.
      // No backend module to load; the chat dispatcher handles requests via
      // the persisted AISource.apiType + apiUrl.
      console.log(`[AuthLoader] Preset API provider: ${providerConfig.type}`)
      loaded.provider = null
    } else if (providerConfig.path) {
      // External provider - load from path using dynamic import
      const providerPath = resolveProviderPath(providerConfig)
      if (providerPath) {
        loaded.provider = await loadProviderModuleAsync(providerPath)
        if (!loaded.provider) {
          loaded.loadError = `Failed to load from ${providerPath}`
        }
      }
    }

    loadedProviders.push(loaded)
  }

  return loadedProviders
}

/**
 * Synchronous version for backward compatibility (returns configs only)
 * @deprecated Use loadAuthProvidersAsync for full provider loading
 */
export function loadAuthProviders(): LoadedProvider[] {
  const config = loadProductConfig()
  return config.authProviders
    .filter(p => p.enabled)
    .map(providerConfig => ({
      config: providerConfig,
      provider: null,
      loadError: (providerConfig.builtin || providerConfig.preset)
        ? undefined
        : 'Use loadAuthProvidersAsync for dynamic loading'
    }))
}

/**
 * Get enabled auth provider configurations for UI
 * This returns only the configs, not the loaded providers
 */
export function getEnabledAuthProviderConfigs(): AuthProviderConfig[] {
  const config = loadProductConfig()
  return config.authProviders.filter(p => p.enabled)
}

/**
 * Check if a specific provider type is available
 */
export function isProviderAvailable(type: AISourceType): boolean {
  const providers = loadAuthProviders()
  const provider = providers.find(p => p.config.type === type)
  return provider !== undefined && (
    provider.config.builtin === true ||
    provider.config.preset !== undefined ||
    provider.provider !== null
  )
}

/**
 * Get a specific provider by type
 */
export function getProviderByType(type: AISourceType): LoadedProvider | null {
  const providers = loadAuthProviders()
  return providers.find(p => p.config.type === type) || null
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a provider supports OAuth
 */
export function isOAuthProvider(provider: AISourceProvider): provider is OAuthAISourceProvider {
  return 'startLogin' in provider && 'completeLogin' in provider
}
