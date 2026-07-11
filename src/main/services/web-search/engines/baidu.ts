/**
 * Web Search MCP - Baidu Search Engine
 *
 * Baidu is the primary search engine for Chinese queries.
 * It provides better coverage for Chinese content and is
 * accessible from mainland China without VPN.
 *
 * Special considerations:
 * - Baidu wraps result links in redirect URLs (baidu.com/link?url=...), but
 *   exposes the real destination in the result container's "mu" attribute,
 *   which the extractor prefers (with the redirect as a fallback)
 * - More aggressive anti-bot measures
 * - Dynamic class names in some elements
 */

import { SearchEngine } from './base'
import { BAIDU_CONFIG } from '../config/selectors'
import type { EngineSelectors, SearchOptions, SearchResult, RawExtractionResult } from '../types'

// ============================================
// Baidu Search Engine
// ============================================

export class BaiduEngine extends SearchEngine {
  readonly name = BAIDU_CONFIG.name
  readonly displayName = BAIDU_CONFIG.displayName
  readonly searchUrlTemplate = BAIDU_CONFIG.searchUrlTemplate
  readonly selectors: EngineSelectors = BAIDU_CONFIG.selectors
  readonly fallbackSelectors: EngineSelectors = BAIDU_CONFIG.fallbackSelectors
  readonly waitForSelector = BAIDU_CONFIG.waitForSelector
  readonly extraWaitMs = BAIDU_CONFIG.extraWaitMs

  /**
   * Build Baidu search URL
   *
   * Baidu URL parameters:
   * - wd: search query (word)
   * - rn: results per page (default 10, max 50)
   * - ie: input encoding (utf-8)
   * - oe: output encoding (utf-8)
   */
  override buildSearchUrl(query: string, options: SearchOptions = {}): string {
    const params = new URLSearchParams()
    params.set('wd', query)

    // Request more results than needed
    const rn = Math.min((options.maxResults || 8) + 5, 30)
    params.set('rn', String(rn))

    // Ensure UTF-8 encoding
    params.set('ie', 'utf-8')
    params.set('oe', 'utf-8')

    return `https://www.baidu.com/s?${params.toString()}`
  }

  /**
   * Baidu-specific extraction script (exclusion-based)
   *
   * Baidu uses dynamic class names with hash suffixes that change between
   * deployments, making CSS selectors for snippets unreliable.
   *
   * Instead, we use an exclusion approach:
   * 1. Find each .result.c-container (organic results)
   * 2. Get h3 > a for title and link
   * 3. Clone the result node
   * 4. Remove title (h3), source attribution, images, and other noise
   * 5. Remaining text = snippet
   *
   * This is robust against DOM structure changes as long as:
   * - Results are in .result.c-container
   * - Titles are in h3 > a
   */
  override buildExtractionScript(maxResults: number): string {
    return `
      (function() {
        var results = [];
        var items = document.querySelectorAll('.result.c-container');

        for (var i = 0; i < items.length && results.length < ${maxResults}; i++) {
          var item = items[i];

          // Skip special result boxes (videos, "大家还在搜", etc.)
          if (item.classList.contains('result-op')) continue;

          // Skip ads (tuiguang = promotion)
          if (item.getAttribute('data-tuiguang') || item.querySelector('.ec_tuiguang_link')) continue;

          // Get title and link from h3 > a
          var titleEl = item.querySelector('h3 a');
          if (!titleEl) continue;

          var title = (titleEl.textContent || '').trim();
          // Prefer the real destination URL: Baidu stores it in the result
          // container's "mu" attribute. Fall back to the baidu.com/link
          // redirect href when "mu" is absent (some special result types).
          var redirect = titleEl.href || titleEl.getAttribute('href') || '';
          var real = item.getAttribute('mu') || '';
          var url = real.indexOf('http') === 0 ? real : redirect;
          if (!title || !url) continue;

          // Extract snippet using exclusion approach:
          // Clone the node, remove non-snippet elements, get remaining text
          var clone = item.cloneNode(true);

          // Remove title elements
          var h3s = clone.querySelectorAll('h3');
          for (var j = 0; j < h3s.length; j++) h3s[j].remove();

          // Remove source/attribution elements (class contains "source")
          var sources = clone.querySelectorAll('[class*="source"], .c-color-gray, .c-gap-top-small');
          for (var j = 0; j < sources.length; j++) sources[j].remove();

          // Remove images (only actual img/svg tags, NOT elements with "image" in class name
          // because Baidu uses classes like "single-image_69zQZ" on snippet containers)
          var imgs = clone.querySelectorAll('img, svg');
          for (var j = 0; j < imgs.length; j++) imgs[j].remove();

          // Remove "百度快照" and similar links
          var snapshots = clone.querySelectorAll('a[data-click*="snapshot"], .kuaizhao');
          for (var j = 0; j < snapshots.length; j++) snapshots[j].remove();

          // Get remaining text as snippet
          var snippet = (clone.textContent || '').replace(/\\s+/g, ' ').trim();

          // Limit snippet length
          if (snippet.length > 500) snippet = snippet.substring(0, 497) + '...';

          results.push({
            title: title.substring(0, 500),
            url: url,
            snippet: snippet
          });
        }

        return results;
      })()
    `
  }

  /**
   * Post-process Baidu results
   *
   * Baidu-specific processing:
   * - URLs are already resolved to real destinations during extraction (via
   *   the "mu" attribute), falling back to baidu.com/link redirects
   * - Clean up Baidu-specific artifacts
   * - Filter out Baidu internal pages
   */
  override postProcess(rawResults: RawExtractionResult[]): SearchResult[] {
    const seen = new Set<string>()
    const results: SearchResult[] = []

    for (const raw of rawResults) {
      // Skip invalid results
      if (!raw.title || !raw.url) continue

      const url = raw.url

      // Skip non-http URLs
      if (!url.startsWith('http://') && !url.startsWith('https://')) continue

      // Skip Baidu internal pages (help, about, etc.)
      if (this.isBaiduInternalUrl(url)) continue

      // Normalize for deduplication
      const normalizedUrl = this.normalizeUrl(url)
      if (seen.has(normalizedUrl)) continue
      seen.add(normalizedUrl)

      results.push({
        title: this.cleanBaiduText(raw.title),
        url: url,
        snippet: this.cleanBaiduText(raw.snippet || ''),
        position: results.length + 1,
      })
    }

    return results
  }

  /**
   * Check if URL is a Baidu internal page
   */
  private isBaiduInternalUrl(url: string): boolean {
    const internalPatterns = [
      'baidu.com/more',
      'baidu.com/gaoji',
      'baidu.com/help',
      'baidu.com/duty',
      'baidu.com/about',
      'www.baidu.com/s?', // Search page itself
      'tieba.baidu.com',  // Tieba (forum) - often low quality
      'zhidao.baidu.com', // Zhidao (Q&A) - keep these actually
      'baike.baidu.com',  // Baike (wiki) - keep these
    ]

    // Only filter out truly internal pages, keep content pages
    const strictInternalPatterns = [
      'baidu.com/more',
      'baidu.com/gaoji',
      'baidu.com/help',
      'baidu.com/duty',
      'baidu.com/about',
    ]

    return strictInternalPatterns.some(pattern => url.includes(pattern))
  }

  /**
   * Clean Baidu-specific text artifacts
   */
  private cleanBaiduText(text: string): string {
    return text
      // Remove Baidu-specific markers
      .replace(/百度快照/g, '')
      .replace(/百度文库/g, '')
      .replace(/\s*-\s*百度[^\s]*/g, '')
      // Remove date patterns often prepended
      .replace(/^\d{4}年\d{1,2}月\d{1,2}日\s*[-—]\s*/g, '')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      .trim()
  }

  /**
   * Baidu priority score
   *
   * Baidu is preferred for:
   * - Pure Chinese queries (score: 85)
   * - Mixed, mostly Chinese (score: 70)
   * - Mixed, mostly English (score: 40)
   * - Pure English (score: 30, Bing is better)
   */
  override getPriorityScore(query: string): number {
    const chineseChars = (query.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
    const totalChars = query.replace(/\s/g, '').length

    if (totalChars === 0) return 50

    const chineseRatio = chineseChars / totalChars

    if (chineseRatio > 0.8) {
      // Pure Chinese - Baidu is excellent
      return 85
    } else if (chineseRatio > 0.5) {
      // Mostly Chinese - Baidu is good
      return 70
    } else if (chineseRatio > 0.2) {
      // Mixed - slight preference for Bing
      return 45
    } else {
      // Mostly/pure English - Bing is better
      return 30
    }
  }
}

// Singleton instance
export const baiduEngine = new BaiduEngine()
