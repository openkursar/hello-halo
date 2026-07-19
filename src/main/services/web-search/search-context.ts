/**
 * Web Search MCP - Search Context
 *
 * Core execution logic for programmatic web search.
 * Uses Electron BrowserView to load search pages and extract results
 * via JavaScript execution - no AI interpretation needed.
 *
 * Performance characteristics:
 * - Cold start (first search): ~2-3s
 * - Subsequent searches: ~1-2s
 * - Zero AI token consumption
 */

import { browserViewManager } from '../browser-view.service'
import { resolveEngines, type SearchEngine, type EngineName } from './engines'
import type {
  SearchResult,
  SearchResponse,
  SearchOptions,
  RawExtractionResult,
  SearchBlockReason,
} from './types'

// ============================================
// Engine Execution Outcome
// ============================================

/**
 * Result of attempting a search with a single engine.
 *
 * Separates a successful extraction from the distinct failure modes so the
 * orchestrator can decide whether to fall back and what guidance to surface.
 */
type EngineOutcome =
  | { ok: true; results: SearchResult[] }
  | { ok: false; reason: SearchBlockReason }

// ============================================
// Constants
// ============================================

/** Default search timeout (ms) */
const DEFAULT_TIMEOUT = 15_000

/** Maximum time to wait for page load (ms) */
const PAGE_LOAD_TIMEOUT = 10_000

/** Polling interval for selector wait (ms) */
const POLL_INTERVAL = 100

/** View ID prefix for search views */
const VIEW_ID_PREFIX = 'web-search-'

// ============================================
// Utility Functions
// ============================================

/**
 * Create a promise that rejects after timeout
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${message} (timeout: ${ms}ms)`))
    }, ms)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Generate unique view ID
 */
function generateViewId(): string {
  return `${VIEW_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ============================================
// Search Context Class
// ============================================

/**
 * WebSearchContext - Manages search execution
 *
 * Each search creates a temporary offscreen BrowserView,
 * executes the search, extracts results, and cleans up.
 */
export class WebSearchContext {
  private activeViews = new Set<string>()

  /**
   * Execute a web search
   *
   * @param query - Search query
   * @param options - Search options
   * @returns Search response with results
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const startTime = Date.now()
    const maxResults = Math.min(options.maxResults || 8, 20)
    const timeout = options.timeout || DEFAULT_TIMEOUT

    // Resolve which engines to try
    const engines = resolveEngines(options.engine as 'auto' | EngineName | undefined, query)

    console.log(`[WebSearch] Starting search: "${query.slice(0, 50)}${query.length > 50 ? '...' : ''}"`)
    console.log(`[WebSearch] Engines to try: ${engines.map(e => e.name).join(', ')}`)

    let lastReason: SearchBlockReason = 'no_results'
    let lastEngine: SearchEngine = engines[0]

    // Try each engine in order
    for (const engine of engines) {
      lastEngine = engine
      try {
        console.log(`[WebSearch] Trying engine: ${engine.displayName}`)

        const outcome = await this.executeSearch(engine, query, maxResults, timeout)

        if (outcome.ok) {
          const searchTime = Date.now() - startTime
          console.log(`[WebSearch] Success: ${outcome.results.length} results from ${engine.displayName} in ${searchTime}ms`)

          return {
            query,
            engine: engine.name,
            results: outcome.results,
            searchTime,
          }
        }

        lastReason = outcome.reason
        console.log(`[WebSearch] ${engine.displayName} failed (${outcome.reason}), trying next engine`)
      } catch (error) {
        // Unexpected error (not a handled outcome): treat as unreachable.
        lastReason = 'unreachable'
        console.warn(`[WebSearch] ${engine.displayName} threw:`, (error as Error).message)
        // Continue to next engine
      }
    }

    // All engines failed: surface a structured, actionable failure.
    const searchTime = Date.now() - startTime
    const guidance = lastEngine.buildBlockGuidance(lastReason, query)

    console.error(`[WebSearch] All engines failed after ${searchTime}ms (${lastReason})`)

    // Return empty results with structured guidance instead of throwing, so the
    // AI can reason about the next step (retry another engine, ask the user).
    return {
      query,
      engine: lastEngine.name,
      results: [],
      searchTime,
      blocked: {
        reason: lastReason,
        engine: lastEngine.name,
        guidance,
      },
      warning: guidance,
    }
  }

  /**
   * Execute search with a specific engine.
   *
   * Returns a structured {@link EngineOutcome} rather than throwing, so the
   * orchestrator can distinguish success from each failure mode (unreachable,
   * captcha/consent, layout change, no results).
   */
  private async executeSearch(
    engine: SearchEngine,
    query: string,
    maxResults: number,
    timeout: number
  ): Promise<EngineOutcome> {
    const viewId = generateViewId()
    this.activeViews.add(viewId)

    try {
      // Build search URL
      const searchUrl = engine.buildSearchUrl(query, { maxResults })
      console.log(`[WebSearch] URL: ${searchUrl.slice(0, 100)}${searchUrl.length > 100 ? '...' : ''}`)

      // Create offscreen BrowserView
      console.log(`[WebSearch] Creating offscreen view: ${viewId}`)
      await browserViewManager.create(viewId, undefined, { offscreen: true })

      // Get webContents for this view
      const webContents = browserViewManager.getWebContents(viewId)
      if (!webContents) {
        throw new Error('Failed to get webContents for search view')
      }

      // Seed engine cookies (consent/region) on this session before navigating.
      await this.applyCookieSeeds(webContents.session, engine)

      // Navigate to search URL. A navigation failure means the engine host is
      // unreachable (network/proxy) — a distinct, actionable outcome.
      console.log(`[WebSearch] Navigating to search page...`)
      try {
        await this.navigateWithTimeout(webContents, searchUrl, PAGE_LOAD_TIMEOUT)
      } catch (navError) {
        console.warn(`[WebSearch] ${engine.displayName} navigation failed:`, (navError as Error).message)
        return { ok: false, reason: 'unreachable' }
      }

      // Early block detection: a verification/consent page never renders
      // results, so fail fast before waiting on the results selector.
      const earlyReason = await this.detectBlock(webContents, engine)
      if (earlyReason === 'captcha') {
        console.warn(`[WebSearch] ${engine.displayName} served a verification/consent page`)
        return { ok: false, reason: 'captcha' }
      }

      // Wait for results to appear
      console.log(`[WebSearch] Waiting for results selector: ${engine.waitForSelector}`)
      await this.waitForSelector(webContents, engine.waitForSelector, timeout)

      // Extra wait for dynamic content
      if (engine.extraWaitMs > 0) {
        console.log(`[WebSearch] Extra wait: ${engine.extraWaitMs}ms`)
        await sleep(engine.extraWaitMs)
      }

      // Extract results using primary selectors
      console.log(`[WebSearch] Extracting results...`)
      let rawResults = await this.extractResults(webContents, engine.buildExtractionScript(maxResults))

      // If no results, try fallback selectors
      if (rawResults.length === 0) {
        const fallbackScript = engine.buildFallbackExtractionScript(maxResults)
        if (fallbackScript) {
          console.log(`[WebSearch] Primary selectors failed, trying fallback...`)
          rawResults = await this.extractResults(webContents, fallbackScript)
        }
      }

      // Post-process results
      const results = engine.postProcess(rawResults)
      console.log(`[WebSearch] Extracted ${rawResults.length} raw, ${results.length} after processing`)

      if (results.length > 0) {
        return { ok: true, results }
      }

      // No results: re-check for a block to distinguish a layout change (page
      // present but unparseable) from a genuine empty result set.
      const lateReason = await this.detectBlock(webContents, engine)
      return { ok: false, reason: lateReason ?? 'no_results' }
    } finally {
      // Always clean up the view
      await this.cleanupView(viewId)
    }
  }

  /**
   * Seed an engine's cookies (consent/region) into the session before loading.
   *
   * Best-effort: a failed seed is logged and ignored so it never aborts the
   * search. Engines that need no cookies (the default) skip this entirely.
   */
  private async applyCookieSeeds(
    ses: Electron.Session,
    engine: SearchEngine
  ): Promise<void> {
    const seeds = engine.cookieSeeds()
    if (seeds.length === 0) return

    const defaultExpiry = Math.floor(Date.now() / 1000) + 365 * 24 * 3600
    await Promise.all(
      seeds.map(seed =>
        ses.cookies
          .set({
            url: seed.url,
            name: seed.name,
            value: seed.value,
            domain: seed.domain,
            path: seed.path ?? '/',
            secure: seed.url.startsWith('https'),
            expirationDate: seed.expirationDate ?? defaultExpiry,
          })
          .catch(error =>
            console.warn(`[WebSearch] Cookie seed failed (${seed.name}):`, (error as Error).message)
          )
      )
    )
  }

  /**
   * Run an engine's block-detection script against the loaded page.
   *
   * @returns A {@link SearchBlockReason} when the page is blocked/unparseable,
   *   or null when it looks healthy or the engine has no detection script.
   */
  private async detectBlock(
    webContents: Electron.WebContents,
    engine: SearchEngine
  ): Promise<SearchBlockReason | null> {
    const script = engine.buildBlockDetectionScript()
    if (!script) return null
    try {
      const reason = await webContents.executeJavaScript(script)
      if (reason === 'captcha' || reason === 'layout_changed' || reason === 'unreachable' || reason === 'no_results') {
        return reason
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * Navigate to URL with timeout
   */
  private async navigateWithTimeout(
    webContents: Electron.WebContents,
    url: string,
    timeout: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Navigation timeout: ${url}`))
      }, timeout)

      const cleanup = () => {
        clearTimeout(timer)
        webContents.removeListener('did-finish-load', onLoad)
        webContents.removeListener('did-fail-load', onFail)
      }

      const onLoad = () => {
        cleanup()
        resolve()
      }

      const onFail = (
        _event: Electron.Event,
        errorCode: number,
        errorDescription: string,
        _validatedURL: string,
        isMainFrame: boolean
      ) => {
        if (!isMainFrame) return
        // Ignore aborted loads (code -3)
        if (errorCode === -3) {
          cleanup()
          resolve()
          return
        }
        cleanup()
        reject(new Error(`Navigation failed: ${errorDescription} (code: ${errorCode})`))
      }

      webContents.once('did-finish-load', onLoad)
      webContents.once('did-fail-load', onFail)

      webContents.loadURL(url).catch((error) => {
        cleanup()
        reject(error)
      })
    })
  }

  /**
   * Wait for a selector to appear on the page
   */
  private async waitForSelector(
    webContents: Electron.WebContents,
    selector: string,
    timeout: number
  ): Promise<void> {
    const startTime = Date.now()
    const escapedSelector = selector.replace(/'/g, "\\'")

    while (Date.now() - startTime < timeout) {
      try {
        const exists = await webContents.executeJavaScript(
          `!!document.querySelector('${escapedSelector}')`
        )
        if (exists) {
          return
        }
      } catch (error) {
        // Page might be navigating, ignore and retry
      }

      await sleep(POLL_INTERVAL)
    }

    // Timeout - but don't throw, try to extract anyway
    console.warn(`[WebSearch] Selector wait timeout: ${selector}`)
  }

  /**
   * Extract results by executing JavaScript in the page
   */
  private async extractResults(
    webContents: Electron.WebContents,
    script: string
  ): Promise<RawExtractionResult[]> {
    try {
      const results = await webContents.executeJavaScript(script)
      return Array.isArray(results) ? results : []
    } catch (error) {
      console.error('[WebSearch] Extraction failed:', (error as Error).message)
      return []
    }
  }

  /**
   * Clean up a BrowserView
   */
  private async cleanupView(viewId: string): Promise<void> {
    if (!this.activeViews.delete(viewId)) return // already disposed
    try {
      browserViewManager.destroy(viewId)
      console.log(`[WebSearch] View cleaned up: ${viewId}`)
    } catch (error) {
      console.warn(`[WebSearch] Failed to cleanup view ${viewId}:`, (error as Error).message)
    }
  }

  /**
   * Clean up all resources
   */
  async dispose(): Promise<void> {
    for (const viewId of this.activeViews) {
      try {
        browserViewManager.destroy(viewId)
        console.log(`[WebSearch] View cleaned up: ${viewId}`)
      } catch (error) {
        console.warn(`[WebSearch] Failed to cleanup view ${viewId}:`, (error as Error).message)
      }
    }
    this.activeViews.clear()
  }
}

// ============================================
// Singleton Instance
// ============================================

let searchContext: WebSearchContext | null = null

/**
 * Get the singleton search context
 */
export function getSearchContext(): WebSearchContext {
  if (!searchContext) {
    searchContext = new WebSearchContext()
  }
  return searchContext
}

/**
 * Dispose the singleton search context
 */
export async function disposeSearchContext(): Promise<void> {
  if (searchContext) {
    await searchContext.dispose()
    searchContext = null
  }
}
