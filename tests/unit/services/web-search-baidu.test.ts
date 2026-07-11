/**
 * Unit tests for the Baidu web-search engine's result post-processing.
 *
 * Invariants under test:
 *   - Real destination URLs (resolved from the result's `mu` attribute during
 *     extraction) pass through unchanged and receive positions.
 *   - Non-http URLs are dropped.
 *   - Results are deduplicated by normalized URL.
 *   - Strictly-internal Baidu pages are filtered out.
 *
 * The `mu`-attribute extraction itself runs in the page DOM and is verified
 * against the live Baidu SERP during development, not here.
 */

import { describe, expect, it } from 'vitest'
import { baiduEngine } from '../../../src/main/services/web-search/engines/baidu'
import type { RawExtractionResult } from '../../../src/main/services/web-search/types'

describe('BaiduEngine.postProcess', () => {
  it('keeps resolved real URLs and assigns positions', () => {
    const raw: RawExtractionResult[] = [
      { title: 'Anthropic', url: 'https://www.anthropic.com/', snippet: 'a' },
      { title: 'ThePaper', url: 'https://www.thepaper.cn/newsDetail_forward_32443815', snippet: 'b' },
    ]
    const out = baiduEngine.postProcess(raw)
    expect(out).toHaveLength(2)
    expect(out[0].url).toBe('https://www.anthropic.com/')
    expect(out[0].position).toBe(1)
    expect(out[1].position).toBe(2)
  })

  it('still accepts baidu.com/link redirects (fallback when mu is absent)', () => {
    const raw: RawExtractionResult[] = [
      { title: 'Fallback', url: 'http://www.baidu.com/link?url=abc', snippet: '' },
    ]
    const out = baiduEngine.postProcess(raw)
    expect(out).toHaveLength(1)
    expect(out[0].url).toBe('http://www.baidu.com/link?url=abc')
  })

  it('drops non-http URLs', () => {
    const raw: RawExtractionResult[] = [
      { title: 'JS', url: 'javascript:void(0)', snippet: '' },
      { title: 'Real', url: 'https://example.com', snippet: '' },
    ]
    expect(baiduEngine.postProcess(raw).map(r => r.url)).toEqual(['https://example.com'])
  })

  it('deduplicates by normalized URL', () => {
    const raw: RawExtractionResult[] = [
      { title: 'A', url: 'https://example.com/page', snippet: '' },
      { title: 'A trailing slash', url: 'https://example.com/page/', snippet: '' },
    ]
    expect(baiduEngine.postProcess(raw)).toHaveLength(1)
  })

  it('filters strictly-internal Baidu pages', () => {
    const raw: RawExtractionResult[] = [
      { title: 'Help', url: 'https://www.baidu.com/help', snippet: '' },
      { title: 'Real', url: 'https://example.com', snippet: '' },
    ]
    expect(baiduEngine.postProcess(raw).map(r => r.url)).toEqual(['https://example.com'])
  })

  it('skips entries missing a title or URL', () => {
    const raw: RawExtractionResult[] = [
      { title: '', url: 'https://example.com', snippet: '' },
      { title: 'No url', url: '', snippet: '' },
    ]
    expect(baiduEngine.postProcess(raw)).toHaveLength(0)
  })
})
