/**
 * Differential check: streaming Markdown prepared by `createStreamingMarkdown`
 * (tail-only mending, settled blocks reused) against Streamdown's former
 * behavior, `remend` and the block lexer over the whole text on every delta.
 *
 * Streamdown renders every block on its own, so only the open tail can still
 * be incomplete. Mending the whole text instead lets inline markers in settled
 * blocks change the tail (an `_` in an earlier `snake_case` makes the tail
 * sprout a stray `_`) and can rewrite settled blocks. Two properties are
 * checked for every streaming prefix:
 *
 * - exactness: the reused blocks equal a fresh split of the rendered text
 *   (Streamdown's lexer; one block once a footnote is defined), and settled
 *   text is rendered verbatim;
 * - equivalence: the rendered text equals whole-text mending, or differs for a
 *   reason that is machine-checkable from the text. Anything else is a
 *   regression.
 */

import remend from 'remend'
import { parseMarkdownIntoBlocks } from 'streamdown'
import { splitStreamingBlocks, type StreamingMarkdown } from '../../../src/renderer/lib/streaming-markdown'

export type MendComparison =
  | 'identical'
  /** Whole-text mending rewrote blocks that were already settled. */
  | 'whole-text-rewrote-settled-blocks'
  /** Settled blocks hold inline markers whose parity leaked into the tail. */
  | 'marker-parity-from-settled-blocks'
  /** A lone list marker is its own block, so no setext-heading guard applies. */
  | 'lone-list-marker-block'
  | 'unexplained'

export interface MendCheck {
  comparison: MendComparison
  /** Reused blocks equal a fresh lex of the rendered text. */
  blocksExact: boolean
  /** Settled text is rendered verbatim and only the tail is mended. */
  settledVerbatim: boolean
}

const INLINE_MARKER = /[*_~`$[\]]/
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^[\w-]{1,200}\]:/m
const LONE_LIST_MARKER = /^\s*[-*+]\s*$/

function sameBlocks(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((block, i) => block === b[i])
}

export function checkStreamingMarkdown(content: string, result: StreamingMarkdown): MendCheck {
  const fresh = FOOTNOTE_DEFINITION.test(result.markdown) ? [result.markdown] : splitStreamingBlocks(result.markdown)
  const blocksExact = sameBlocks(result.blocks, fresh)
  const settled = content.slice(0, result.settledLength)
  const settledVerbatim = result.markdown === settled + remend(content.slice(result.settledLength))

  const whole = remend(content)
  const rawBlocks = parseMarkdownIntoBlocks(content)
  const last = rawBlocks[rawBlocks.length - 1] ?? ''

  let comparison: MendComparison
  if (whole === result.markdown) comparison = 'identical'
  else if (!whole.startsWith(settled)) comparison = 'whole-text-rewrote-settled-blocks'
  else if (INLINE_MARKER.test(settled)) comparison = 'marker-parity-from-settled-blocks'
  else if (LONE_LIST_MARKER.test(last)) comparison = 'lone-list-marker-block'
  else comparison = 'unexplained'

  return { comparison, blocksExact, settledVerbatim }
}

/** Streaming prefix lengths of a document, `stride` characters apart. */
export function streamingCuts(length: number, stride: number): number[] {
  const cuts: number[] = []
  for (let cut = stride; cut < length; cut += stride) cuts.push(cut)
  if (length > 0) cuts.push(length)
  return cuts
}
