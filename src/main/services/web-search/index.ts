/**
 * Web Search MCP - Module Entry Point
 *
 * Programmatic web search service that replaces Claude's built-in WebSearch.
 * Works in all regions and with all models.
 *
 * Features:
 * - Bing and Baidu search engines (auto-selected by query language)
 * - Google as an opt-in engine (explicit request only; off the default path)
 * - Structured failure reporting (unreachable / captcha / layout change) with
 *   AI-facing guidance
 * - Zero AI token consumption
 * - ~1-3 second response time
 *
 * Usage:
 * ```typescript
 * import { createWebSearchMcpServer } from '../web-search'
 *
 * // In session setup:
 * mcpServers['web-search'] = createWebSearchMcpServer()
 * ```
 */

// ============================================
// MCP Server
// ============================================

export { createWebSearchMcpServer, getWebSearchToolName } from './mcp-server'

// ============================================
// Search Context
// ============================================

export {
  WebSearchContext,
  getSearchContext,
  disposeSearchContext,
} from './search-context'

// ============================================
// Types
// ============================================

export type {
  SearchResult,
  SearchResponse,
  SearchOptions,
  SearchBlockReason,
  SearchBlockInfo,
  CookieSeed,
  EngineSelectors,
  EngineConfig,
} from './types'

// ============================================
// Engines (for advanced usage)
// ============================================

export {
  getEngine,
  getAllEngines,
  getEngineNames,
  selectBestEngine,
  type EngineName,
} from './engines'

