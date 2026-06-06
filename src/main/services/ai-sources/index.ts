/**
 * AI Sources Module
 *
 * Unified entry point for AI source management.
 * Import from this module for clean access to all AI source functionality.
 */

// Manager
export { getAISourceManager, AISourceManager } from './manager'

// Auth Loader (for dynamic provider loading)
export {
  loadAuthProviders,
  getEnabledAuthProviderConfigs,
  isProviderAvailable,
  getProviderByType,
  isOAuthProvider,
  type AuthProviderConfig,
  type LoadedProvider
} from './auth-loader'

// Product config now lives in the foundation tier; re-exported here so
// existing `services/ai-sources` consumers keep a stable import surface.
export { loadProductConfig, type ProductConfig } from '../../foundation/product-config'

// Built-in Providers
export { getCustomProvider, CustomAISourceProvider } from './providers/custom.provider'
export { getGitHubCopilotProvider, GitHubCopilotProvider } from './providers/github-copilot.provider'
export { getClaudeProvider, ClaudeProvider } from './providers/claude.provider'
