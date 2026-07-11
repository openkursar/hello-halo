/**
 * Unit tests for the Google web-search engine and registry integration.
 *
 * Invariants under test:
 *   - Google is opt-in: excluded from "auto" selection, used only by name.
 *   - URL building is locale-aware (English default, Chinese override) and asks
 *     for extra results.
 *   - postProcess unwraps `/url?q=` redirects, drops Google-internal/non-result
 *     links, and deduplicates.
 *   - Block guidance is actionable for every failure reason (always points to a
 *     fallback engine and to informing the user).
 *
 * DOM extraction is verified against the live page during development; it is not
 * exercised here because the unit environment has no browser DOM.
 */

import { describe, expect, it } from 'vitest'
import { googleEngine, GoogleEngine } from '../../../src/main/services/web-search/engines/google'
import {
  resolveEngines,
  getEnginesInFallbackOrder,
  getEngineNames,
  getEngine,
} from '../../../src/main/services/web-search/engines'
import type { RawExtractionResult } from '../../../src/main/services/web-search/types'

describe('GoogleEngine.autoSelectable', () => {
  it('is not auto-selectable', () => {
    expect(googleEngine.autoSelectable).toBe(false)
  })
})

describe('registry: Google is opt-in only', () => {
  it('is registered and retrievable by name', () => {
    expect(getEngineNames()).toContain('google')
    expect(getEngine('google')).toBe(googleEngine)
  })

  it('is excluded from auto fallback order', () => {
    const names = getEnginesInFallbackOrder('anything').map(e => e.name)
    expect(names).not.toContain('google')
    expect(names).toContain('bing')
    expect(names).toContain('baidu')
  })

  it('"auto" never resolves to Google', () => {
    const names = resolveEngines('auto', 'english query').map(e => e.name)
    expect(names).not.toContain('google')
  })

  it('an explicit "google" request resolves to exactly Google with no fallback', () => {
    const engines = resolveEngines('google', 'english query')
    expect(engines.map(e => e.name)).toEqual(['google'])
  })
})

describe('GoogleEngine.buildSearchUrl', () => {
  it('defaults to the English/US locale and requests extra results', () => {
    const url = new URL(googleEngine.buildSearchUrl('claude opus model', { maxResults: 8 }))
    expect(url.hostname).toBe('www.google.com')
    expect(url.searchParams.get('q')).toBe('claude opus model')
    expect(url.searchParams.get('hl')).toBe('en')
    expect(url.searchParams.get('gl')).toBe('us')
    expect(Number(url.searchParams.get('num'))).toBeGreaterThan(8)
  })

  it('switches to the Chinese locale for Chinese queries', () => {
    const url = new URL(googleEngine.buildSearchUrl('克劳德 模型'))
    expect(url.searchParams.get('hl')).toBe('zh-CN')
    expect(url.searchParams.get('gl')).toBe('cn')
  })

  it('caps the requested result count', () => {
    const url = new URL(googleEngine.buildSearchUrl('q', { maxResults: 100 }))
    expect(Number(url.searchParams.get('num'))).toBeLessThanOrEqual(30)
  })
})

describe('GoogleEngine.postProcess', () => {
  it('keeps direct organic results and assigns positions', () => {
    const raw: RawExtractionResult[] = [
      { title: 'Anthropic', url: 'https://www.anthropic.com/claude', snippet: 'a' },
      { title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Claude', snippet: 'b' },
    ]
    const out = googleEngine.postProcess(raw)
    expect(out).toHaveLength(2)
    expect(out[0].position).toBe(1)
    expect(out[1].position).toBe(2)
  })

  it('unwraps /url?q= redirect links to the real destination', () => {
    const raw: RawExtractionResult[] = [
      { title: 'Example', url: '/url?q=https%3A%2F%2Fexample.com%2Fpage&sa=U', snippet: 's' },
    ]
    const out = googleEngine.postProcess(raw)
    expect(out).toHaveLength(1)
    expect(out[0].url).toBe('https://example.com/page')
  })

  it('unwraps absolute google.com/url redirects', () => {
    const raw: RawExtractionResult[] = [
      { title: 'Example', url: 'https://www.google.com/url?q=https://example.org/x', snippet: 's' },
    ]
    const out = googleEngine.postProcess(raw)
    expect(out[0].url).toBe('https://example.org/x')
  })

  it('drops Google-internal/non-result links', () => {
    const raw: RawExtractionResult[] = [
      { title: 'Search', url: 'https://www.google.com/search?q=foo', snippet: '' },
      { title: 'Prefs', url: 'https://www.google.com/preferences?hl=en', snippet: '' },
      { title: 'ccTLD search', url: 'https://www.google.co.uk/search?q=foo', snippet: '' },
      { title: 'Real', url: 'https://example.com', snippet: '' },
    ]
    const out = googleEngine.postProcess(raw)
    expect(out.map(r => r.url)).toEqual(['https://example.com'])
  })

  it('keeps Google content domains (not search endpoints)', () => {
    const raw: RawExtractionResult[] = [
      { title: 'Books', url: 'https://books.google.com/books?id=1', snippet: '' },
      { title: 'Blog', url: 'https://blog.google/products/', snippet: '' },
    ]
    const out = googleEngine.postProcess(raw)
    expect(out.map(r => r.url)).toEqual([
      'https://books.google.com/books?id=1',
      'https://blog.google/products/',
    ])
  })

  it('does not over-filter Google look-alike hosts', () => {
    // Neither is a real Google domain — both must survive the internal filter.
    const raw: RawExtractionResult[] = [
      { title: 'Evil', url: 'https://google.com.evil.com/search?q=x', snippet: '' },
      { title: 'Mygoogle', url: 'https://mygoogle.com/search', snippet: '' },
    ]
    const out = googleEngine.postProcess(raw)
    expect(out.map(r => r.url)).toEqual([
      'https://google.com.evil.com/search?q=x',
      'https://mygoogle.com/search',
    ])
  })

  it('deduplicates results that resolve to the same URL', () => {
    const raw: RawExtractionResult[] = [
      { title: 'A', url: 'https://example.com/page', snippet: '' },
      { title: 'A dup', url: 'https://example.com/page/', snippet: '' },
      { title: 'A redirect dup', url: '/url?q=https%3A%2F%2Fexample.com%2Fpage', snippet: '' },
    ]
    const out = googleEngine.postProcess(raw)
    expect(out).toHaveLength(1)
  })

  it('skips entries missing a title or URL', () => {
    const raw: RawExtractionResult[] = [
      { title: '', url: 'https://example.com', snippet: '' },
      { title: 'No url', url: '', snippet: '' },
    ]
    expect(googleEngine.postProcess(raw)).toHaveLength(0)
  })
})

describe('GoogleEngine.buildBlockGuidance', () => {
  const reasons = ['unreachable', 'captcha', 'layout_changed', 'no_results'] as const

  for (const reason of reasons) {
    it(`gives actionable guidance for "${reason}"`, () => {
      const text = googleEngine.buildBlockGuidance(reason, 'my query')
      // Always names a fallback engine and instructs to inform the user.
      expect(text).toMatch(/bing|baidu/i)
      expect(text.toLowerCase()).toContain('user')
      expect(text).toContain('my query')
    })
  }

  it('mentions the proxy/network cause for unreachable', () => {
    expect(googleEngine.buildBlockGuidance('unreachable', 'q').toLowerCase()).toMatch(/proxy|network|reach/)
  })
})

describe('GoogleEngine block detection script', () => {
  it('exposes a detection script (used by search-context)', () => {
    const script = googleEngine.buildBlockDetectionScript()
    expect(typeof script).toBe('string')
    expect(script).toContain('/sorry/')
  })
})

describe('GoogleEngine.cookieSeeds', () => {
  it('seeds consent cookies for google.com and google.com.hk', () => {
    const seeds = new GoogleEngine().cookieSeeds()
    const names = seeds.map(s => s.name)
    expect(names).toContain('SOCS')
    expect(names).toContain('CONSENT')
    expect(seeds.some(s => s.url.includes('google.com.hk'))).toBe(true)
  })
})
