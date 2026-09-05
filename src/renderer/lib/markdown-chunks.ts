/**
 * Splits a markdown document into independently renderable chunks.
 *
 * A viewer can then mount a viewport's worth of chunks instead of the whole
 * document. The split is deliberately conservative: a boundary is only placed
 * where the text on either side still parses to the same thing it did as part
 * of the whole document. Concretely that means never inside a fenced code
 * block or an unclosed HTML block/comment, never at a line that starts
 * indented (so nested list items and indented code blocks stay whole), and
 * only at a blank line — so a table's header stays with its rows. An ordered
 * list split across a boundary keeps its start number, but not its
 * tight/loose formatting or its single-`<ol>` grouping.
 *
 * A document containing a footnote *definition* is never split: footnote
 * numbering and back-links only resolve within a single render pass, and a
 * definition (always line-anchored) is the only form worth bailing out for —
 * a bare reference with no definition already renders as literal text with
 * nothing cross-block to protect.
 *
 * A document that offers no safe boundary (one enormous table, a single line)
 * comes back as one chunk. Rendering it whole is slow, but it is the only
 * answer that is still correct.
 */

/** Opening or closing fence: up to 3 spaces of indent, then 3+ backticks or tildes. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
/** ATX heading — the boundary we prefer, since it starts a new section. */
const HEADING_RE = /^ {0,3}#{1,6}\s/
/** A footnote *definition* `[^label]:`, anchored to the start of a line (up to
 *  3 spaces of indent). Deliberately narrower than "any `[^...]`" — that also
 *  matches ordinary regex character classes like `[^a-z]`, which are common
 *  enough in this codebase's own docs to false-positive on nearly every long
 *  technical file. */
const FOOTNOTE_RE = /^ {0,3}\[\^[\w-]{1,200}\]:/m
/** A line that starts indented can't be a safe boundary — it's either a
 *  continuation of a list item or an indented code block, not a new one. */
const INDENTED_START_RE = /^\s/

/**
 * Block-level HTML open/close tags, inspired by streamdown's own chunk
 * boundary guard (`Ve` in `streamdown/dist/chunk-LPQFK2AO.js`), which pushes
 * onto its stack only when `c.type === "html" && c.block` — i.e. only for a
 * token its own tokenizer has already classified as block-level HTML. A
 * paragraph containing inline HTML (`` `<Star className=…` ``) is a
 * `paragraph` token there and never enters the stack.
 *
 * We don't have a tokenizer, only line regexes, so we can't reproduce that
 * classification — this is NOT the same trade-off streamdown makes, it is a
 * strictly leakier approximation. Anchoring the match to the start of the
 * line (CommonMark HTML blocks require this too) and excluding a tag that
 * closes itself on the same line cuts the false-positive rate a lot, but
 * real documents still trip it (a pasted JS stack trace's `<anonymous>`, a
 * `<script src="…" defer />` reference in prose).
 *
 * None of the four sticky states below (this stack, the fence, the comment,
 * the raw-text close) is ever timed out. A false positive here can only cost
 * performance — the rest of a misdetected document stays one big,
 * unvirtualized chunk — never correctness. An earlier version force-closed a
 * stuck state after a character budget to recover virtualization on
 * documents with an isolated unclosed fence; it was removed because the
 * bail-out itself was a correctness hazard: forcing a fence closed makes
 * whatever follows it (until the real end of that code block, per
 * CommonMark) get parsed as live markdown instead of literal code text, so a
 * `<details>` sitting inside that "still open" fence would render as a real,
 * expanded element. One invariant with no exceptions — a stuck state means a
 * bigger chunk, never a wrong one — is easier to keep correct than a
 * budgeted one with a carve-out for "this state is safe to force, that one
 * isn't."
 */
/**
 * Known boundary, deliberately left alone: this is a line-level
 * approximation, so it sees at most one opening and one closing tag per
 * line. A line carrying two block-level tag events miscounts the depth —
 * `</div><div class="b">` pops without pushing (net -1), and
 * `<div class="a"><div class="b">` pushes once instead of twice (net +1).
 * Either way an outer container can look closed early and get split open.
 *
 * Tracking it properly means scanning tags inline, i.e. writing half a
 * tokenizer — and in this file every past round of "just one more rule
 * here" became the next round's bug. A sweep of all 4,426 markdown files in
 * the repo found zero real occurrences outside fenced code blocks, where
 * the fence guard wins first anyway.
 */
const HTML_OPEN_RE = /^ {0,3}<(\w+)([\s/>]|$)/
const HTML_CLOSE_RE = /<\/(\w+)>/
const HTML_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
])
/** CommonMark HTML block type 1 — raw text elements that end only at their
 *  own closing tag (may contain blank lines that would otherwise look like
 *  a safe boundary). */
const HTML_RAW_TEXT_TAGS = new Set(['pre', 'script', 'style', 'textarea'])

/**
 * Whether the tag `HTML_OPEN_RE` matched at `openIndex` in `line` closes
 * itself on this same line (`<foo ... />`) — judged by the character right
 * before *that tag's own* `>`, not by how the line happens to end (a
 * block-level open tag can be followed later on the same line by an
 * unrelated self-closed tag, e.g. `<div align="center"><img src="…"/>`, the
 * standard GitHub README header form). Shared by every place that decides
 * whether to push a new tag onto the stack, so they can't drift apart —
 * two near-identical copies of this check is exactly how the last two
 * rounds of bugs here got introduced.
 */
function isSelfClosingAt(line: string, openIndex: number): boolean {
  const tagEnd = line.indexOf('>', openIndex)
  return tagEnd > 0 && line[tagEnd - 1] === '/'
}

export interface MarkdownChunkOptions {
  /** Below this size a chunk keeps growing even past a heading. */
  minChars?: number
  /** Past this size the next blank line ends the chunk, heading or not. */
  maxChars?: number
}

const DEFAULT_MIN_CHARS = 4000
const DEFAULT_MAX_CHARS = 16000

export function splitMarkdownIntoChunks(
  content: string,
  options: MarkdownChunkOptions = {}
): string[] {
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS

  if (!content) return []

  // A document with a footnote definition is never split: numbering and
  // back-links only resolve within a single render pass, and there's no
  // boundary we could pick that keeps that resolution working once we've
  // already broken the document into independent pieces.
  if (FOOTNOTE_RE.test(content)) return [content]

  const lines = content.split('\n')
  const chunks: string[] = []
  let current: string[] = []
  let size = 0
  let openFence: string | null = null
  let inComment = false
  let rawTextClose: RegExp | null = null
  const htmlStack: string[] = []
  let prevWasBlank = false

  const flush = () => {
    if (current.length === 0) return
    chunks.push(current.join('\n'))
    current = []
    size = 0
  }

  for (const line of lines) {
    const fence = FENCE_RE.exec(line)
    if (openFence) {
      // Only a fence of the same character and at least the same length closes.
      if (fence && fence[1][0] === openFence[0] && fence[1].length >= openFence.length) {
        openFence = null
      }
    } else if (inComment) {
      if (line.includes('-->')) inComment = false
    } else if (rawTextClose) {
      if (rawTextClose.test(line)) rawTextClose = null
    } else if (htmlStack.length > 0) {
      // Closing the top of the stack and opening a new (nested) tag are
      // independent questions — checking only the first meant a line like
      // `</div>` closing an *inner* div was mistaken for closing the outer
      // one, popping the stack early and leaving the real outer tag's own
      // close to fall through unmatched, splitting it open.
      const close = HTML_CLOSE_RE.exec(line)
      if (close && htmlStack[htmlStack.length - 1] === close[1]) htmlStack.pop()

      const open = HTML_OPEN_RE.exec(line)
      const openTagLower = open?.[1].toLowerCase()
      if (
        open &&
        openTagLower &&
        !isSelfClosingAt(line, open.index) &&
        !HTML_VOID_TAGS.has(openTagLower) &&
        !line.includes(`</${open[1]}>`)
      ) {
        htmlStack.push(open[1])
      }
    } else if (fence) {
      openFence = fence[1]
    } else {
      const commentStart = line.indexOf('<!--')
      const open = HTML_OPEN_RE.exec(line)
      const openTagLower = open?.[1].toLowerCase()
      const selfClosing = open ? isSelfClosingAt(line, open.index) : false

      if (commentStart !== -1 && !line.slice(commentStart + 4).includes('-->')) {
        inComment = true
      } else if (open && openTagLower && !selfClosing && HTML_RAW_TEXT_TAGS.has(openTagLower)) {
        const closeRe = new RegExp(`</${openTagLower}>`, 'i')
        if (!closeRe.test(line)) {
          rawTextClose = closeRe
        }
      } else if (
        open &&
        openTagLower &&
        !selfClosing &&
        !HTML_VOID_TAGS.has(openTagLower) &&
        !line.includes(`</${open[1]}>`)
      ) {
        htmlStack.push(open[1])
      } else if (prevWasBlank && size > 0 && !INDENTED_START_RE.test(line)) {
        const atHeading = HEADING_RE.test(line)
        if ((atHeading && size >= minChars) || size >= maxChars) {
          flush()
        }
      }
    }

    current.push(line)
    size += line.length + 1
    prevWasBlank = !openFence && !inComment && !rawTextClose && htmlStack.length === 0 && line.trim() === ''
  }

  flush()
  return chunks
}
