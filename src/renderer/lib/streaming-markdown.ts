/**
 * Streaming Markdown preparation whose per-delta cost follows the tail, not
 * the whole reply.
 *
 * Streamdown, left alone, runs `remend` (completion of unterminated markup)
 * and its block lexer over the entire reply on every delta — quadratic on
 * link- and emphasis-dense text. Streamdown renders every block on its own,
 * so text followed by settled blocks can no longer be incomplete: only the
 * open tail is mended and re-lexed, and settled blocks are lexed once and
 * reused. The renderer passes the result with `parseIncompleteMarkdown={false}`
 * and the blocks through `parseMarkdownIntoBlocksFn`.
 *
 * Footnotes: Streamdown keeps any text containing `[^id]` as one block, since
 * a reference only links when its definition is in the same parse. A reference
 * without a definition renders as literal text either way, so here only a
 * footnote *definition* (`[^id]:` at a line start) makes the reply one block —
 * a regex like `[^a-z]` in a code sample no longer does.
 */

import remend from 'remend'
import { parseMarkdownIntoBlocks } from 'streamdown'

const FOOTNOTE_DEFINITION = /^ {0,3}\[\^[\w-]{1,200}\]:/m

/**
 * Non-blank blocks kept open at the tail. Later text can still merge into the
 * block before the last, so it is re-lexed until another block follows it.
 */
const OPEN_BLOCKS = 2

/**
 * A block starting like this may still be absorbed by the container before it
 * (list item, blockquote, indented code, table), so the open tail must not
 * start there.
 */
const MAY_CONTINUE_CONTAINER = /^[ \t>|*+\-\d]/

/**
 * Streamdown's block split, minus its whole-text fallback for footnote-like
 * references: `[^` is lexed as `[=` (same length, same character class) and
 * the blocks are cut from the original text.
 */
export function splitStreamingBlocks(text: string): string[] {
  if (!text.includes('[^')) return parseMarkdownIntoBlocks(text)
  const masked = parseMarkdownIntoBlocks(text.replaceAll('[^', '[='))
  let offset = 0
  const blocks = masked.map(block => {
    const original = text.slice(offset, offset + block.length)
    offset += block.length
    return original
  })
  return offset === text.length ? blocks : parseMarkdownIntoBlocks(text)
}

export interface StreamingMarkdown {
  /** Text to render: `content` with its open tail mended. */
  markdown: string
  /** `markdown` split into blocks (`splitStreamingBlocks`, or one block once a footnote is defined). */
  blocks: string[]
  /** Length of the settled prefix, which is rendered verbatim. */
  settledLength: number
}

export interface StreamingMarkdownParser {
  update(content: string): StreamingMarkdown
  /** For Streamdown's `parseMarkdownIntoBlocksFn`; identity is stable. */
  parseBlocks(markdown: string): string[]
}

function openTailStart(blocks: string[]): number {
  let open = 0
  for (let i = blocks.length - 1; i > 0; i--) {
    if (!blocks[i].trim()) continue
    if (++open >= OPEN_BLOCKS && !MAY_CONTINUE_CONTAINER.test(blocks[i])) return i
  }
  return 0
}

/**
 * Incremental state for one streaming renderer. Each `update` lexes only the
 * open tail; text that does not extend the previous content starts over.
 */
export function createStreamingMarkdown(): StreamingMarkdownParser {
  let source = ''
  let settled: string[] = []
  let settledLength = 0
  let hasFootnotes = false
  let latest: StreamingMarkdown = { markdown: '', blocks: [], settledLength: 0 }

  const reset = () => {
    settled = []
    settledLength = 0
    hasFootnotes = false
  }

  const update = (content: string): StreamingMarkdown => {
    if (content === source) return latest
    if (!content.startsWith(source)) reset()
    source = content

    const tail = content.slice(settledLength)
    // Definitions start a line and settled blocks end on one, so the tail
    // alone decides; once seen, the reply renders as one parse, like Streamdown.
    if (hasFootnotes || FOOTNOTE_DEFINITION.test(tail)) {
      hasFootnotes = true
      const markdown = remend(content)
      latest = { markdown, blocks: [markdown], settledLength: 0 }
      return latest
    }

    // When the lexer rewrote the source (CRLF, a trailing empty list item) its
    // block offsets are unusable; nothing settles on this update.
    const raw = splitStreamingBlocks(tail)
    const openStart = raw.join('') === tail ? openTailStart(raw) : 0
    for (let i = 0; i < openStart; i++) {
      settled.push(raw[i])
      settledLength += raw[i].length
    }

    const mendedTail = remend(content.slice(settledLength))
    latest = {
      markdown: content.slice(0, settledLength) + mendedTail,
      blocks: mendedTail ? settled.concat(splitStreamingBlocks(mendedTail)) : settled.slice(),
      settledLength,
    }
    return latest
  }

  const parseBlocks = (markdown: string): string[] =>
    markdown === latest.markdown ? latest.blocks : parseMarkdownIntoBlocks(markdown)

  return { update, parseBlocks }
}
