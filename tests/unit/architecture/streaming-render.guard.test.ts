/**
 * Streaming render cost must follow the delta, not the accumulated reply, and
 * module-level render caches must be bounded.
 *
 * - `@streamdown/code` keeps every highlighted string in a module-level Map
 *   forever; code highlighting goes through `lib/shiki-code-plugin.ts`.
 * - A streaming reply renders only through `MarkdownRenderer`, which mends and
 *   lexes the open tail itself (`lib/streaming-markdown.ts`) and never hands
 *   the code highlighter to a streaming Streamdown.
 */

import { describe, expect, it } from 'vitest'
import { findMatches, formatMatches, listSourceFiles, readSource } from './lib/source-scan'

const RENDERER = 'src/renderer/components/chat/MarkdownRenderer.tsx'

describe('streaming render guard', () => {
  const sources = listSourceFiles('src')

  it('never imports the unbounded @streamdown/code highlighter', () => {
    const matches = findMatches(sources, /from ['"]@streamdown\/code['"]|import\(['"]@streamdown\/code['"]\)/)
    expect(formatMatches(matches)).toBe('')
  })

  it('renders streaming Markdown only through MarkdownRenderer', () => {
    // Streamdown defaults to streaming mode, so every other use must say static.
    const notStatic = findMatches(sources.filter(file => file !== RENDERER), /<Streamdown\b/).filter(match => {
      const element = readSource(match.file).split('\n').slice(match.line - 1, match.line + 4).join(' ')
      return !/mode=["']static["']/.test(element)
    })
    expect(formatMatches(notStatic)).toBe('')
  })

  it('MarkdownRenderer mends the tail itself and withholds the code plugin while streaming', () => {
    const source = readSource(RENDERER)
    expect(source).toMatch(/parseIncompleteMarkdown=\{false\}/)
    expect(source).toMatch(/parseMarkdownIntoBlocksFn=\{streaming \? streamingParser\.parseBlocks : undefined\}/)
    expect(source).toMatch(/if \(codePlugin && !streaming\) config\.code = codePlugin/)
  })

  it('components beside the live turn are memoized, so a token re-renders only the turn', () => {
    for (const [file, name] of [
      ['src/renderer/components/chat/MarkdownRenderer.tsx', 'MarkdownRenderer'],
      ['src/renderer/components/chat/ThoughtProcess.tsx', 'ThoughtProcess'],
      ['src/renderer/components/chat/InputArea.tsx', 'InputArea'],
    ]) {
      expect(readSource(file)).toMatch(new RegExp(`export const ${name} = memo\\(function ${name}\\(`))
    }
  })

  it('the code highlighter keeps its token cache bounded', () => {
    const source = readSource('src/renderer/lib/shiki-code-plugin.ts')
    expect(source).toMatch(/new BoundedTokenCache<TokensResult>/)
    expect(source).not.toMatch(/^const \w+ = new Map<string, TokensResult>/m)
  })
})
