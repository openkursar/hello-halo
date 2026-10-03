import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import remend from 'remend'
import { parseMarkdownIntoBlocks } from 'streamdown'
import { createStreamingMarkdown, splitStreamingBlocks } from '../../../../src/renderer/lib/streaming-markdown'
import { checkStreamingMarkdown, streamingCuts } from '../../../perf/lib/streaming-mend-differential'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

function collectMarkdown(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectMarkdown(full, out)
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

const mendStreamingMarkdown = (content: string) => createStreamingMarkdown().update(content).markdown

function stream(text: string, stride: number) {
  const parser = createStreamingMarkdown()
  let result = parser.update('')
  for (const cut of streamingCuts(text.length, stride)) result = parser.update(text.slice(0, cut))
  return { parser, result }
}

describe('streaming markdown preparation', () => {
  it('closes unterminated inline markup at the tail exactly like whole-text mending', () => {
    for (const text of [
      'Intro paragraph.\n\nSome **bold',
      'Intro paragraph.\n\nA [link](https://exa',
      'Intro paragraph.\n\nRun `npm',
      'Intro paragraph.\n\n~~gone',
      'Intro paragraph.\n\n```ts\nconst a = 1\n',
      'Intro paragraph.\n\n$$\nx^2',
    ]) {
      expect(mendStreamingMarkdown(text)).toBe(remend(text))
      expect(stream(text, 3).result.markdown).toBe(remend(text))
    }
  })

  it('renders settled blocks verbatim and mends only the open tail', () => {
    const settled = 'Use `snake_case` and a lone _ everywhere.\n\n# Heading\n\nParagraph one.\n\n'
    const text = `${settled}Paragraph two.\n\nThen an unfinished **tail`
    const { result } = stream(text, 7)
    expect(result.settledLength).toBeGreaterThanOrEqual(settled.length)
    expect(result.markdown).toBe(text.slice(0, result.settledLength) + remend(text.slice(result.settledLength)))
    // Whole-text mending lets the settled `_` leak a stray closer into the tail.
    expect(remend(text)).not.toBe(result.markdown)
  })

  it('keeps list, quote and table continuations open instead of settling them', () => {
    const text = 'Intro.\n\n- item one\n\n- item two\n\n  continued\n\n> quote\n\n| a |\n|---|\n| 1 |\n'
    const { result } = stream(text, 5)
    expect(result.blocks).toEqual(parseMarkdownIntoBlocks(result.markdown))
    expect(result.settledLength).toBeLessThanOrEqual('Intro.\n\n'.length)
  })

  it('reuses blocks exactly as Streamdown would lex the rendered text', () => {
    const text = '# Title\n\nSome text with [a link](https://e.com).\n\n```js\nconst x = 1\n```\n\nMore **bold** text.\n\nTail'
    const parser = createStreamingMarkdown()
    for (const cut of streamingCuts(text.length, 3)) {
      const result = parser.update(text.slice(0, cut))
      expect(result.blocks).toEqual(parseMarkdownIntoBlocks(result.markdown))
      expect(parser.parseBlocks(result.markdown)).toBe(result.blocks)
    }
  })

  it('starts over when the text does not extend the previous content', () => {
    const parser = createStreamingMarkdown()
    parser.update('# One\n\nFirst reply paragraph.\n\nSecond paragraph.\n\nThird')
    const result = parser.update('Different **reply')
    expect(result.markdown).toBe(remend('Different **reply'))
    expect(result.settledLength).toBe(0)
  })

  it('keeps a reply whole once it defines a footnote, like Streamdown does', () => {
    const text = 'Intro.\n\nA claim[^1] here.\n\nMore text.\n\n[^1]: source'
    const { result } = stream(text, 4)
    expect(result.markdown).toBe(remend(text))
    expect(result.blocks).toEqual([result.markdown])
  })

  it('keeps splitting a reply whose `[^...]` is not a footnote (a regex in code)', () => {
    const text = 'Match it with this:\n\n```js\nconst re = /[^a-z]+/\n```\n\nThen more **text** follows.\n\nAnd a tail'
    expect(parseMarkdownIntoBlocks(text)).toHaveLength(1)
    const blocks = splitStreamingBlocks(text)
    expect(blocks.length).toBeGreaterThan(3)
    expect(blocks.join('')).toBe(text)
    expect(blocks.some(block => block.includes('/[^a-z]+/'))).toBe(true)
    const { result } = stream(text, 5)
    expect(result.settledLength).toBeGreaterThan(0)
    expect(result.blocks).toEqual(splitStreamingBlocks(result.markdown))
  })

  it('splits exactly like Streamdown when there is nothing footnote-like', () => {
    const text = '# T\n\nPara with [link](x) and **b**.\n\n- a\n- b\n\n```\ncode\n```\n'
    expect(splitStreamingBlocks(text)).toEqual(parseMarkdownIntoBlocks(text))
  })

  it('falls back to whole-text mending when the lexer normalizes line endings', () => {
    const text = 'first line\r\n\r\nsecond **bold'
    expect(mendStreamingMarkdown(text)).toBe(remend(text))
  })

  it('leaves empty content alone', () => {
    expect(mendStreamingMarkdown('')).toBe('')
  })

  it('costs the tail per delta, not the whole 20K-character reply', () => {
    const unit = 'Here is **some** text with `code` and a [link](https://example.com/a).\n\n- one\n- two\n\n'
    let text = ''
    while (text.length < 20_000) text += unit
    const cuts = streamingCuts(text.length, 40)
    const parser = createStreamingMarkdown()
    for (const cut of cuts.slice(0, -50)) parser.update(text.slice(0, cut))
    const start = performance.now()
    for (const cut of cuts.slice(-50)) parser.update(text.slice(0, cut))
    const perDelta = (performance.now() - start) / 50
    // Whole-text remend plus lexing measured ~16 ms per delta on this shape.
    expect(perDelta).toBeLessThan(2)
  })
})

describe('streaming markdown vs whole-text mending over the repository corpus', () => {
  it('reuses blocks exactly and differs from whole-text mending only for machine-checkable reasons', () => {
    const files = collectMarkdown(REPO_ROOT)
    expect(files.length).toBeGreaterThanOrEqual(50)

    const failures: string[] = []
    let updates = 0
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8').slice(0, 6_000)
      const parser = createStreamingMarkdown()
      for (const cut of streamingCuts(content.length, 211)) {
        updates++
        const prefix = content.slice(0, cut)
        const check = checkStreamingMarkdown(prefix, parser.update(prefix))
        if (!check.blocksExact || !check.settledVerbatim || check.comparison === 'unexplained') {
          failures.push(`${path.relative(REPO_ROOT, file)}@${cut} ${JSON.stringify(check)}`)
        }
      }
    }

    expect(updates).toBeGreaterThan(1_000)
    expect(failures.slice(0, 20)).toEqual([])
  }, 120_000)
})
