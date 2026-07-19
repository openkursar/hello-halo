/**
 * Tests for pre-publish spec enrichment.
 *
 * The derivation logic MUST stay in sync with the Go implementation in
 * digital-human-protocol/server/internal/spec/spec.go (DeriveSlug).
 */

import { describe, it, expect } from 'vitest'
import { deriveSlug, enrichSpecForPublish } from '../../../src/main/store/publish/spec-enrich'
import type { AppSpec } from '../../../src/main/apps/spec/schema'

function fakeSpec(overrides: Partial<AppSpec> = {}): AppSpec {
  return {
    spec_version: '1',
    name: 'HN Daily',
    version: '1.0.0',
    author: 'tester',
    description: 'd',
    type: 'automation',
    system_prompt: 'p',
    subscriptions: [],
    ...overrides,
  } as AppSpec
}

describe('deriveSlug', () => {
  const cases: Array<[string, string]> = [
    ['hn-daily', 'hn-daily'],
    ['HN Daily', 'hn-daily'],
    ['  My  App  ', 'my-app'],
    ['Foo!!! Bar???', 'foo-bar'],
    ['Already-Slug', 'already-slug'],
    ['foo--bar', 'foo-bar'],
    ['---weird---', 'weird'],
    ['v2.1 release', 'v2-1-release'],
    ['中文名', 'zhong-wen-ming'],
    ['中文 mixed Name', 'zhong-wen-mixed-name'],
    ['会议室自动预订数字人', 'hui-yi-shi-zi-dong-yu-ding-shu-zi-ren'],
  ]
  for (const [input, want] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(want)}`, () => {
      expect(deriveSlug(input)).toBe(want)
    })
  }
})

describe('enrichSpecForPublish', () => {
  it('re-scopes existing scoped slug under authorOverride', () => {
    const spec = fakeSpec({ store: { slug: 'old-author/hn-daily', tags: [] } })
    const out = enrichSpecForPublish(spec, 'fly')
    expect(out.store?.slug).toBe('fly/hn-daily')
    expect(out.author).toBe('fly')
  })

  it('preserves scoped slug when author matches', () => {
    const spec = fakeSpec({ store: { slug: 'tester/hn-daily', tags: [] } })
    const out = enrichSpecForPublish(spec)
    expect(out.store?.slug).toBe('tester/hn-daily')
  })

  it('derives scoped slug from author + name when missing', () => {
    const spec = fakeSpec({ name: 'HN Daily', author: 'fly' })
    const out = enrichSpecForPublish(spec)
    expect(out.store?.slug).toBe('fly/hn-daily')
  })

  it('scopes flat slug under author', () => {
    const spec = fakeSpec({
      name: 'My App',
      author: 'fly',
      store: { slug: 'my-app', tags: ['news'], category: 'tools' },
    } as Partial<AppSpec>)
    const out = enrichSpecForPublish(spec)
    expect(out.store?.slug).toBe('fly/my-app')
    expect(out.store?.tags).toEqual(['news'])
    expect(out.store?.category).toBe('tools')
  })

  it('treats whitespace-only slug as missing', () => {
    const spec = fakeSpec({ name: 'HN Daily', author: 'fly', store: { slug: '   ', tags: [] } })
    const out = enrichSpecForPublish(spec)
    expect(out.store?.slug).toBe('fly/hn-daily')
  })

  it('derives slug from pure-CJK name via pinyin', () => {
    const spec = fakeSpec({ name: '中文名', author: 'fly' })
    const out = enrichSpecForPublish(spec)
    expect(out.store?.slug).toBe('fly/zhong-wen-ming')
  })

  it('uses authorOverride over spec.author', () => {
    const spec = fakeSpec({ name: 'My App', author: 'old' })
    const out = enrichSpecForPublish(spec, 'newauthor')
    expect(out.store?.slug).toBe('newauthor/my-app')
    expect(out.author).toBe('newauthor')
  })

  it('throws when author is missing', () => {
    const spec = fakeSpec({ author: '' })
    expect(() => enrichSpecForPublish(spec)).toThrow('Author is required')
  })

  it('does not mutate the input spec', () => {
    const spec = fakeSpec({ name: 'HN Daily', author: 'fly' })
    enrichSpecForPublish(spec)
    expect(spec.store).toBeUndefined()
  })
})
