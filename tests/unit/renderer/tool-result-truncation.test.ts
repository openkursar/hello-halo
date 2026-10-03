import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { countLines, truncateToLines } from '../../../src/renderer/components/chat/tool-result/detection'
import { HIGHLIGHT_MAX_CHARS, splitForHighlight } from '../../../src/renderer/components/chat/tool-result/bounded-highlight'
import { MarkdownResultViewer } from '../../../src/renderer/components/chat/tool-result/MarkdownResultViewer'
import { PlainTextViewer } from '../../../src/renderer/components/chat/tool-result/PlainTextViewer'
import { CodeResultViewer } from '../../../src/renderer/components/chat/tool-result/CodeResultViewer'
import { JsonResultViewer } from '../../../src/renderer/components/chat/tool-result/JsonResultViewer'
import { PREVIEW_MAX_CHARS } from '../../../src/renderer/components/chat/tool-result/detection'
import i18n from '../../../src/renderer/i18n'

function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n')
}

describe('truncateToLines', () => {
  it('keeps the first lines exactly as a split/join would', () => {
    const text = lines(100)
    const result = truncateToLines(text, 40)
    expect(result).toEqual({ content: text.split('\n').slice(0, 40).join('\n'), totalLines: 100, truncated: true })
  })

  it('returns short content untouched', () => {
    expect(truncateToLines('a\nb', 5)).toEqual({ content: 'a\nb', totalLines: 2, truncated: false })
    expect(truncateToLines('', 5)).toEqual({ content: '', totalLines: 1, truncated: false })
    expect(truncateToLines(lines(5), 5).truncated).toBe(false)
  })

  it('caps one enormous line by characters', () => {
    const minified = 'x'.repeat(200_000)
    const result = truncateToLines(minified, 40, 8_000)
    expect(result.content).toHaveLength(8_000)
    expect(result.totalLines).toBe(1)
    expect(result.truncated).toBe(true)
  })

  it('counts lines without allocating a line array', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('one')).toBe(1)
    expect(countLines('a\nb\n')).toBe(3)
  })
})

describe('splitForHighlight', () => {
  it('highlights everything under the budget', () => {
    expect(splitForHighlight('const a = 1', HIGHLIGHT_MAX_CHARS)).toEqual({ head: 'const a = 1', tail: '' })
  })

  it('cuts a large output on a line boundary and loses nothing', () => {
    const code = lines(20_000, 'const value =')
    const { head, tail } = splitForHighlight(code, HIGHLIGHT_MAX_CHARS)
    expect(head.length).toBeLessThanOrEqual(HIGHLIGHT_MAX_CHARS)
    expect(tail.startsWith('\n')).toBe(true)
    expect(head + tail).toBe(code)
  })
})

describe('MarkdownResultViewer', () => {
  it('renders only the preview of a large output while collapsed', () => {
    const output = Array.from({ length: 5_000 }, (_, i) => `- item **${i}** with [a link](https://example.com/${i})`).join('\n')
    const html = renderToStaticMarkup(createElement(MarkdownResultViewer, { output, isError: false }))
    expect(html).toContain('item <strong')
    expect(html).toContain('>39<')
    expect(html).not.toContain('>40<')
    expect(html).not.toContain('>4999<')
  })
})

describe('collapsed previews of one enormous line', () => {
  const line = 'q'.repeat(500_000)
  const rendered = (html: string) => (html.match(/q+/g) ?? []).reduce((n, run) => n + run.length, 0)

  for (const [name, element] of [
    ['plain text', () => createElement(PlainTextViewer, { output: line, isError: false })],
    ['code', () => createElement(CodeResultViewer, { output: line, isError: false, language: 'text' })],
    ['JSON', () => createElement(JsonResultViewer, { output: JSON.stringify({ blob: line }), isError: false })],
  ] as const) {
    it(`${name}: renders at most the character cap and offers to expand`, () => {
      const html = renderToStaticMarkup(element())
      expect(rendered(html)).toBeLessThanOrEqual(PREVIEW_MAX_CHARS)
      expect(rendered(html)).toBeGreaterThan(0)
      // The label follows the app language, so compare with its translation.
      expect(html).toContain(i18n.t('Expand all'))
    })
  }
})
