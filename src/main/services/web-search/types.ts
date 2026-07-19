/**
 * Web Search MCP - Type Definitions
 *
 * Core types for the programmatic web search service.
 * This module provides type-safe interfaces for search operations.
 */

// ============================================
// Search Result Types
// ============================================

/**
 * A single search result item
 */
export interface SearchResult {
  /** Result title */
  title: string
  /** Result URL */
  url: string
  /** Result snippet/description */
  snippet: string
  /** Position in search results (1-indexed) */
  position: number
}

/**
 * Reason a search could not complete normally.
 *
 * Distinguishes genuine failure modes from "no matching results" so the
 * caller (the AI) can reason about the next step instead of treating every
 * empty response the same way.
 *
 * - `unreachable`: the engine host could not be loaded (network/proxy issue,
 *   navigation timeout). The most common Google failure for users without a
 *   proxy.
 * - `captcha`: the engine served a bot-verification or consent interstitial
 *   instead of results.
 * - `layout_changed`: the results page loaded but no results could be parsed,
 *   which usually means the engine changed its DOM (selector drift).
 * - `no_results`: the query genuinely returned nothing.
 */
export type SearchBlockReason = 'unreachable' | 'captcha' | 'layout_changed' | 'no_results'

/**
 * Structured description of a failed search, including AI-facing guidance.
 *
 * When present on a {@link SearchResponse}, the search did not yield results
 * and `guidance` explains what happened and what the AI can do next (retry
 * with another engine, ask the user, etc.).
 */
export interface SearchBlockInfo {
  /** Machine-readable failure reason. */
  reason: SearchBlockReason
  /** Engine that produced the failure. */
  engine: string
  /** AI-facing guidance describing the failure and recommended next steps. */
  guidance: string
}

/**
 * Complete search response
 */
export interface SearchResponse {
  /** Original search query */
  query: string
  /** Search engine used */
  engine: string
  /** Search results */
  results: SearchResult[]
  /** Total search time in milliseconds */
  searchTime: number
  /** Whether results were served from cache */
  cached?: boolean
  /** Error message if search partially failed */
  warning?: string
  /**
   * Present when the search could not complete normally (empty results).
   * Carries the failure reason and guidance for the AI to decide next steps.
   */
  blocked?: SearchBlockInfo
}

// ============================================
// Search Options
// ============================================

/**
 * Options for search execution
 */
export interface SearchOptions {
  /** Maximum number of results to return (default: 8, max: 20) */
  maxResults?: number
  /** Preferred search engine (default: 'auto') */
  engine?: 'bing' | 'baidu' | 'google' | 'auto'
  /** Search language hint (default: auto-detect from query) */
  language?: string
  /** Search timeout in milliseconds (default: 15000) */
  timeout?: number
}

// ============================================
// Engine Configuration
// ============================================

/**
 * DOM selectors for a search engine
 *
 * These selectors are used to extract search results from the page.
 * When a search engine updates their DOM structure, only these
 * selectors need to be updated.
 */
export interface EngineSelectors {
  /** Container element for all search results */
  resultContainer: string
  /** Individual search result item */
  resultItem: string
  /** Title element (relative to resultItem) */
  title: string
  /** Link element (relative to resultItem) */
  link: string
  /** Snippet/description element (relative to resultItem) */
  snippet: string
  /** Elements to exclude (ads, related searches, etc.) */
  excludeSelectors?: string[]
}

/**
 * A cookie an engine wants seeded into the browser session before navigation.
 *
 * Used to satisfy region/consent preconditions deterministically (e.g. Google's
 * consent acknowledgement) instead of relying on the AI to dismiss an
 * interstitial. Seeding is best-effort: the persistent browser session is the
 * primary source of truth, and a failed seed never aborts the search.
 */
export interface CookieSeed {
  /** URL the cookie is associated with (scheme determines `secure`). */
  url: string
  /** Cookie name. */
  name: string
  /** Cookie value. */
  value: string
  /** Optional explicit domain (e.g. `.google.com`). */
  domain?: string
  /** Optional path (defaults to `/`). */
  path?: string
  /** Optional expiry as seconds since epoch (defaults to ~1 year out). */
  expirationDate?: number
}

/**
 * Complete engine configuration
 */
export interface EngineConfig {
  /** Engine identifier */
  name: string
  /** Human-readable display name */
  displayName: string
  /** Base search URL template */
  searchUrlTemplate: string
  /** Primary selectors */
  selectors: EngineSelectors
  /** Fallback selectors (used when primary fails) */
  fallbackSelectors?: EngineSelectors
  /** Selector to wait for before extracting results */
  waitForSelector: string
  /** Additional wait time after selector appears (ms) */
  extraWaitMs?: number
}

// ============================================
// Internal Types
// ============================================

/**
 * Raw extraction result from page JavaScript
 */
export interface RawExtractionResult {
  title: string
  url: string
  snippet: string
}

/**
 * Search execution context state
 */
export interface SearchContextState {
  /** Whether the context is initialized */
  initialized: boolean
  /** Current active view ID */
  activeViewId: string | null
  /** Timestamp of last search */
  lastSearchTime: number
}
