/**
 * Web Search MCP - Google Search Engine
 *
 * Google is an opt-in engine: it is NOT used during automatic engine
 * selection (see `autoSelectable = false`) and is only invoked when the AI
 * explicitly chooses it (e.g. for a comprehensive cross-source investigation)
 * or when the user asks for Google specifically. This keeps Google off the
 * default search path, where it would be a liability for users without a
 * proxy.
 *
 * Resilience strategy (maintainability core):
 * Google ships hash-based class names (MjjYud, VwiC3b, A6K0A) that change
 * between deployments. This engine deliberately anchors extraction on three
 * primitives that have been stable for years instead:
 *   1. The `#rso` / `#search` container ids
 *   2. The semantic `h3` title tag
 *   3. The `h3.closest('a[href]')` structural relationship
 * Class names are used only as a snippet fast-path, with an exclusion-based
 * fallback. A Google redesign that renames classes does not break extraction.
 *
 * Failure handling:
 * Block detection distinguishes verification/consent pages from "layout
 * changed" (parsed nothing) so the caller can return actionable guidance.
 * Network unreachability is detected one layer up, in search-context.
 */

import { SearchEngine } from './base'
import { GOOGLE_CONFIG } from '../config/selectors'
import type {
  EngineSelectors,
  SearchOptions,
  SearchResult,
  RawExtractionResult,
  CookieSeed,
  SearchBlockReason,
} from '../types'

// ============================================
// Google Search Engine
// ============================================

export class GoogleEngine extends SearchEngine {
  readonly name = GOOGLE_CONFIG.name
  readonly displayName = GOOGLE_CONFIG.displayName
  readonly searchUrlTemplate = GOOGLE_CONFIG.searchUrlTemplate
  readonly selectors: EngineSelectors = GOOGLE_CONFIG.selectors
  readonly fallbackSelectors: EngineSelectors = GOOGLE_CONFIG.fallbackSelectors
  readonly waitForSelector = GOOGLE_CONFIG.waitForSelector
  readonly extraWaitMs = GOOGLE_CONFIG.extraWaitMs

  /** Opt-in only: never chosen by automatic selection. */
  readonly autoSelectable = false

  /**
   * Build the Google search URL.
   *
   * Google parameters:
   * - q: query
   * - hl: interface/result language
   * - gl: result country/region
   * - num: result count hint
   *
   * Defaults to the English/US interface (the canonical, highest-quality
   * surface for international queries). Chinese queries switch to Chinese
   * locale. The host may geo-redirect (e.g. google.com -> google.com.hk) but
   * hl/gl survive the redirect and govern the actual results.
   */
  override buildSearchUrl(query: string, options: SearchOptions = {}): string {
    const params = new URLSearchParams()
    params.set('q', query)

    if (this.detectChinese(query)) {
      params.set('hl', 'zh-CN')
      params.set('gl', 'cn')
    } else {
      params.set('hl', 'en')
      params.set('gl', 'us')
    }

    // Request a few extra results; some are filtered during post-processing.
    const num = Math.min((options.maxResults || 8) + 5, 30)
    params.set('num', String(num))

    return `https://www.google.com/search?${params.toString()}`
  }

  /**
   * Seed Google's consent acknowledgement before navigation.
   *
   * Best-effort only. The shared persistent browser session is the primary
   * mechanism (a user who has opened Google in the app already has consent
   * cookies, so the offscreen view loads straight to results). These seeds
   * help a cold/fresh profile avoid the consent interstitial; if Google's
   * signed-cookie requirements reject them, block detection + guidance still
   * provide a graceful fallback.
   */
  override cookieSeeds(): CookieSeed[] {
    const oneYear = Math.floor(Date.now() / 1000) + 365 * 24 * 3600
    const seeds: CookieSeed[] = []
    for (const url of ['https://www.google.com', 'https://www.google.com.hk']) {
      seeds.push(
        { url, name: 'SOCS', value: 'CAESHAgBEhIaAB', expirationDate: oneYear },
        { url, name: 'CONSENT', value: 'YES+', expirationDate: oneYear }
      )
    }
    return seeds
  }

  /**
   * Primary extraction: anchor on `#rso` and h3 titles.
   */
  override buildExtractionScript(maxResults: number): string {
    return this.buildScript('#rso, #search', maxResults)
  }

  /**
   * Fallback extraction: widen the root to the whole document but keep the
   * same h3 + anchor anchoring.
   */
  override buildFallbackExtractionScript(maxResults: number): string {
    return this.buildScript('body', maxResults)
  }

  /**
   * Build the h3-anchored extraction script for a given root selector.
   *
   * Resilient logic:
   *   - iterate every `h3` under the root (titles are semantic and stable)
   *   - resolve the result link via `h3.closest('a')` (structural, stable)
   *   - skip ad/PAA zones via `closest()`
   *   - snippet: try `[data-sncf]`/`.VwiC3b` in the nearest block, else fall
   *     back to an exclusion clone (remove the title anchor + citations, keep
   *     remaining text)
   * URL redirect unwrapping and host filtering are handled in postProcess so
   * they are unit-testable without a DOM.
   */
  private buildScript(rootSelector: string, maxResults: number): string {
    return `
      (function() {
        var results = [];
        var root = document.querySelector('${rootSelector}') || document.body;
        if (!root) return results;
        var heads = root.querySelectorAll('h3');
        var seen = {};

        for (var i = 0; i < heads.length && results.length < ${maxResults}; i++) {
          var h3 = heads[i];
          var a = h3.closest('a');
          if (!a) continue;

          var href = a.href || a.getAttribute('href') || '';
          if (!href) continue;

          // Skip ad and "people also ask" zones
          if (a.closest('[data-text-ad]') || a.closest('.related-question-pair')) continue;

          var title = (h3.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!title) continue;

          // Dedup early by raw href
          if (seen[href]) continue;
          seen[href] = true;

          // Locate the result block to mine a snippet from. Prefer the
          // dedicated snippet element; fall back to the whole block.
          var block = a.closest('div.MjjYud') || a.closest('div.g') || h3.parentElement;
          var snippet = '';
          if (block) {
            var source = block.querySelector('[data-sncf], .VwiC3b') || block;
            // Clone and strip non-snippet content so interactive controls
            // (expander labels like "Read more"), titles, citations and
            // "translate this page" links never leak into the text. Anchors,
            // buttons and expanders are removed structurally (locale-independent).
            var clone = source.cloneNode(true);
            var drop = clone.querySelectorAll(
              'a, button, cite, [role="button"], [role="heading"], [aria-expanded], g-snackbar'
            );
            for (var j = 0; j < drop.length; j++) drop[j].remove();
            snippet = clone.textContent || '';
          }
          snippet = snippet.replace(/\\s+/g, ' ').trim();
          if (snippet.length > 600) snippet = snippet.substring(0, 597) + '...';

          results.push({
            title: title.substring(0, 500),
            url: href,
            snippet: snippet
          });
        }

        return results;
      })()
    `
  }

  /**
   * Detect a blocked Google page (verification/consent or a parse failure).
   *
   * Returns one of the SearchBlockReason strings or null. Network failures are
   * not detected here — they surface as navigation errors in search-context.
   */
  override buildBlockDetectionScript(): string | null {
    return `
      (function() {
        var href = location.href || '';
        var host = location.hostname || '';
        if (href.indexOf('/sorry/') !== -1) return 'captcha';
        if (document.querySelector('form#captcha-form, form[action*="sorry"]')) return 'captcha';
        if (host.indexOf('consent.google') !== -1) return 'captcha';
        if (document.querySelector('form[action*="consent"]')) return 'captcha';
        var hasResultsRoot = !!document.querySelector('#search, #rso');
        var hasTitle = !!document.querySelector('#rso h3, #search h3');
        if (hasResultsRoot && !hasTitle) return 'layout_changed';
        return null;
      })()
    `
  }

  /**
   * Post-process Google results.
   *
   * - Unwraps redirect links (`/url?q=` / `google.com/url?...`) to the real URL
   * - Drops Google-internal/non-result links (search, image, ad redirects)
   * - Deduplicates by normalized URL and assigns positions
   */
  override postProcess(rawResults: RawExtractionResult[]): SearchResult[] {
    const seen = new Set<string>()
    const results: SearchResult[] = []

    for (const raw of rawResults) {
      if (!raw.title || !raw.url) continue

      const url = this.unwrapRedirect(raw.url)
      if (!url.startsWith('http://') && !url.startsWith('https://')) continue
      if (this.isGoogleInternalUrl(url)) continue

      const normalizedUrl = this.normalizeUrl(url)
      if (seen.has(normalizedUrl)) continue
      seen.add(normalizedUrl)

      results.push({
        title: this.cleanText(raw.title),
        url,
        snippet: this.cleanText(raw.snippet || ''),
        position: results.length + 1,
      })
    }

    return results
  }

  /**
   * Unwrap a Google redirect link to the underlying destination URL.
   *
   * In an authenticated/consented session Google usually emits direct links,
   * but `/url?q=...` (and the absolute `https://www.google.com/url?...` form)
   * can still appear. Returns the original input when it is not a redirect.
   */
  private unwrapRedirect(rawUrl: string): string {
    if (rawUrl.indexOf('/url?') === -1) return rawUrl
    try {
      const parsed = new URL(rawUrl, 'https://www.google.com')
      const target = parsed.searchParams.get('q') || parsed.searchParams.get('url')
      return target || rawUrl
    } catch {
      return rawUrl
    }
  }

  /**
   * Check whether a URL is a Google-internal/non-result link.
   */
  private isGoogleInternalUrl(url: string): boolean {
    let host: string
    let pathname: string
    try {
      const parsed = new URL(url)
      host = parsed.hostname
      pathname = parsed.pathname
    } catch {
      return false
    }

    if (!this.isGoogleHost(host)) return false

    // Google host: only allow content paths, reject search/redirect endpoints
    const internalPaths = ['/search', '/url', '/imgres', '/aclk', '/preferences', '/setprefs', '/advanced_search']
    return internalPaths.some(p => pathname === p || pathname.startsWith(p))
  }

  /**
   * Whether a hostname is a Google search domain (google.com, www.google.co.uk,
   * books.google.com, google.com.hk, ...).
   *
   * Anchors on `google` being the registrable label: it must be followed only
   * by short suffix labels (a gTLD, or a ccSLD like `co.uk` / `com.hk`). This
   * rejects look-alikes such as `google.com.evil.com` (the suffix after
   * `google` contains a non-suffix label) and `mygoogle.com` (no `google`
   * label).
   */
  private isGoogleHost(host: string): boolean {
    const labels = host.toLowerCase().split('.')
    const idx = labels.indexOf('google')
    if (idx === -1) return false
    const suffix = labels.slice(idx + 1)
    return suffix.length >= 1 && suffix.length <= 2 && suffix.every(l => /^[a-z]{2,3}$/.test(l))
  }

  /**
   * Google-specific guidance for failed outcomes.
   *
   * Covers the three real failure modes (unreachable / captcha / layout change)
   * and the empty-results case, and always directs the AI to continue with
   * another engine and tell the user what actually happened.
   */
  override buildBlockGuidance(reason: SearchBlockReason, query: string): string {
    const tail =
      ` Continue the task by retrying web_search with engine "bing" or "baidu", ` +
      `and tell the user that Google did not succeed and which engine you used ` +
      `instead — do not silently substitute results. If the user specifically ` +
      `needs Google-only results, you may use the AI browser to search Google directly.`

    switch (reason) {
      case 'unreachable':
        return (
          `Google appears unreachable for "${query}" (network timeout — common ` +
          `without a proxy/VPN).` + tail
        )
      case 'captcha':
        return (
          `Google returned a bot-verification/consent page for "${query}" instead ` +
          `of results.` + tail
        )
      case 'layout_changed':
        return (
          `Google loaded but no results could be parsed for "${query}" (its page ` +
          `structure may have changed).` + tail
        )
      case 'no_results':
      default:
        return (
          `Google returned no results for "${query}".` + tail
        )
    }
  }

  /**
   * Priority score.
   *
   * Google is excluded from automatic selection (`autoSelectable = false`), so
   * this score does not affect the default path. It is kept English-favouring
   * for sane behaviour should the engine ever be opted into a scored context.
   */
  override getPriorityScore(query: string): number {
    const chineseChars = (query.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
    const totalChars = query.replace(/\s/g, '').length
    if (totalChars === 0) return 50
    return chineseChars / totalChars < 0.5 ? 70 : 40
  }
}

// Singleton instance
export const googleEngine = new GoogleEngine()
