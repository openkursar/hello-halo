import { describe, expect, it, vi } from 'vitest'
import type { TokensResult } from 'shiki'
import {
  BoundedTokenCache,
  HIGHLIGHT_MAX_CHARS,
  TOKEN_CACHE_MAX_CHARS,
  TOKEN_CACHE_MAX_ENTRIES,
  createShikiCodePlugin,
} from '../../../../src/renderer/lib/shiki-code-plugin'
import { lineChunks } from '../../../../src/renderer/lib/shiki-tokenizer'

const THEMES: [string, string] = ['github-dark', 'github-light']

function highlightAsync(
  plugin: ReturnType<typeof createShikiCodePlugin>,
  code: string,
  language = 'ts',
): Promise<TokensResult> {
  return new Promise(resolve => {
    const sync = plugin.highlight({ code, language: language as never, themes: THEMES }, result => resolve(result as TokensResult))
    if (sync) resolve(sync as TokensResult)
  })
}

describe('BoundedTokenCache', () => {
  it('evicts the least recently used entry beyond the entry bound', () => {
    const cache = new BoundedTokenCache<number>(3, 1_000)
    cache.set('a', 1, 1)
    cache.set('b', 2, 1)
    cache.set('c', 3, 1)
    expect(cache.get('a')).toBe(1)
    cache.set('d', 4, 1)
    expect(cache.size).toBe(3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(1)
  })

  it('evicts by total weight and never stores an entry heavier than the budget', () => {
    const cache = new BoundedTokenCache<string>(100, 10)
    cache.set('a', 'a', 4)
    cache.set('b', 'b', 4)
    cache.set('c', 'c', 4)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.weight).toBe(8)
    cache.set('huge', 'huge', 11)
    expect(cache.get('huge')).toBeUndefined()
    expect(cache.weight).toBe(8)
  })

  it('replacing a key re-weighs it instead of double counting', () => {
    const cache = new BoundedTokenCache<string>(10, 100)
    cache.set('a', 'x', 30)
    cache.set('a', 'y', 5)
    expect(cache.weight).toBe(5)
    expect(cache.get('a')).toBe('y')
  })
})

describe('createShikiCodePlugin', () => {
  it('highlights a completed block with both themes, one token line per source line', async () => {
    const plugin = createShikiCodePlugin({ themes: ['github-dark', 'github-light'] })
    const code = 'const a: number = 1\nexport function f() {\n  return a\n}'
    const result = await highlightAsync(plugin, code)
    expect(result.tokens).toHaveLength(code.split('\n').length)
    expect(result.tokens.flat().map(t => t.content).join('')).toBe(code.replace(/\n/g, ''))
    expect(result.tokens.flat().some(t => t.htmlStyle && '--shiki-dark' in t.htmlStyle)).toBe(true)
    // Once the grammar is loaded the same block is served from the cache.
    expect(plugin.highlight({ code, language: 'ts' as never, themes: THEMES })).toBe(result)
  })

  it('changes only colors against the monochrome streaming render, so completing a reply does not shift layout', async () => {
    const plugin = createShikiCodePlugin({ themes: ['github-dark', 'github-light'] })
    const code = 'function f(a) {\n\n  return a * 2 // double\n}'
    const result = await highlightAsync(plugin, code, 'js')
    // Streamdown's plain render is one span per line holding the line text.
    const plainLines = code.split('\n')
    expect(result.tokens.map(line => line.map(t => t.content).join(''))).toEqual(plainLines)
    const declarations = (result.rootStyle || '').split(';').map(d => d.split(':')[0].trim()).filter(Boolean)
    for (const property of declarations) expect(property).toMatch(/^(--|color$|background-color$)/)
    for (const token of result.tokens.flat()) {
      for (const property of Object.keys(token.htmlStyle ?? {})) {
        expect(property).toMatch(/^(--|color$|background-color$|font-style$|font-weight$|text-decoration$)/)
      }
    }
  })

  it('resolves aliases and falls back to plain text for unknown languages', async () => {
    const plugin = createShikiCodePlugin({ themes: ['github-dark', 'github-light'] })
    expect(plugin.supportsLanguage('js' as never)).toBe(true)
    expect(plugin.supportsLanguage('not-a-language' as never)).toBe(false)
    const result = await highlightAsync(plugin, 'hello\nworld', 'not-a-language')
    expect(result.tokens.map(line => line.map(t => t.content).join(''))).toEqual(['hello', 'world'])
  })

  it('keeps its token cache within the entry bound across many completed blocks', async () => {
    const plugin = createShikiCodePlugin({ themes: ['github-dark', 'github-light'], maxEntries: 20 })
    await highlightAsync(plugin, 'const warm = 0')
    for (let i = 0; i < 60; i++) {
      await highlightAsync(plugin, `const value${i} = ${i}`)
    }
    expect(plugin.cache.size).toBe(20)
  })

  it('keeps its token cache within the source-length bound', async () => {
    const plugin = createShikiCodePlugin({ themes: ['github-dark', 'github-light'], maxChars: 2_000 })
    const block = (i: number) => `// block ${i}\n` + 'const x = 1\n'.repeat(40)
    for (let i = 0; i < 20; i++) await highlightAsync(plugin, block(i))
    expect(plugin.cache.weight).toBeLessThanOrEqual(2_000)
    expect(plugin.cache.size).toBeGreaterThan(0)
  })

  it('defaults to 300 completed blocks and a bounded source budget', () => {
    expect(TOKEN_CACHE_MAX_ENTRIES).toBe(300)
    expect(TOKEN_CACHE_MAX_CHARS).toBeLessThanOrEqual(256 * 1024)
  })

  it('never tokenizes on the caller\'s stack, even once the grammar is loaded', async () => {
    const plugin = createShikiCodePlugin({ themes: ['github-dark', 'github-light'] })
    await highlightAsync(plugin, 'const warm = 0')
    let delivered = false
    const sync = plugin.highlight({ code: 'const fresh = 1', language: 'ts' as never, themes: THEMES }, () => { delivered = true })
    expect(sync).toBeNull()
    expect(delivered).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    await vi.waitFor(() => expect(delivered).toBe(true))
  })

  it('tokenizes a burst of blocks across several event-loop turns', async () => {
    const plugin = createShikiCodePlugin({ themes: ['github-dark', 'github-light'] })
    await highlightAsync(plugin, 'const warm = 0')
    let turns = 0
    let counting = true
    const tick = () => { if (counting) { turns++; setTimeout(tick, 0) } }
    setTimeout(tick, 0)
    const block = (i: number) => `// block ${i}\n` + 'export function f(a: number) { return a * 2 }\n'.repeat(60)
    await Promise.all(Array.from({ length: 40 }, (_, i) => highlightAsync(plugin, block(i))))
    counting = false
    expect(turns).toBeGreaterThan(2)
  })

  it('tokenizes a long block in chunks with exactly the tokens of one whole-block call', async () => {
    const { createHighlighter } = await import('shiki')
    const code = Array.from({ length: 90 }, (_, i) => i % 7 === 0 ? `/* comment ${i}` : i % 7 === 3 ? `end ${i} */` : `const s${i} = \`t\${${i}}\` // ${i}`).join('\n')
    expect(lineChunks(code).length).toBeGreaterThan(3)
    expect(lineChunks(code).join('\n')).toBe(code)
    const plugin = createShikiCodePlugin({ themes: ['github-dark', 'github-light'] })
    const chunked = await highlightAsync(plugin, code)
    const reference = (await createHighlighter({ themes: ['github-dark', 'github-light'], langs: ['ts'] }))
      .codeToTokens(code, { lang: 'ts', themes: { light: 'github-dark', dark: 'github-light' } })
    const shape = (r: TokensResult) => r.tokens.map(line => line.map(t => [t.content, t.color, t.htmlStyle]))
    expect(shape(chunked)).toEqual(shape(reference))
  })

  it('cuts chunks on line boundaries and by size for very long lines', () => {
    expect(lineChunks('a\nb')).toEqual(['a\nb'])
    const long = Array.from({ length: 3 }, () => 'x'.repeat(1500)).join('\n')
    expect(lineChunks(long)).toHaveLength(3)
  })

  it('hands blocks to the injected tokenizer (the worker in the app) and caches its answer', async () => {
    const requests: string[] = []
    const answer = { tokens: [[{ content: 'x', offset: 0 }]] } as unknown as TokensResult
    const plugin = createShikiCodePlugin({
      themes: ['github-dark', 'github-light'],
      tokenizer: { tokenize: async (request) => { requests.push(`${request.lang}:${request.code}`); return answer } },
    })
    expect(await highlightAsync(plugin, 'x', 'js')).toBe(answer)
    expect(requests).toEqual(['javascript:x'])
    expect(plugin.highlight({ code: 'x', language: 'js' as never, themes: THEMES })).toBe(answer)
  })

  it('leaves an oversize block plain', () => {
    const plugin = createShikiCodePlugin({ themes: ['github-dark', 'github-light'] })
    let delivered = false
    expect(plugin.highlight({ code: 'x'.repeat(HIGHLIGHT_MAX_CHARS + 1), language: 'ts' as never, themes: THEMES }, () => { delivered = true })).toBeNull()
    expect(delivered).toBe(false)
  })

  it('delivers one tokenization to every renderer waiting on the same block', async () => {
    const plugin = createShikiCodePlugin({ themes: ['github-dark', 'github-light'] })
    const code = 'let shared = true'
    const results = await Promise.all([highlightAsync(plugin, code), highlightAsync(plugin, code)])
    expect(results[0]).toBe(results[1])
  })
})
