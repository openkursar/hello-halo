/**
 * Where a long user message folds. Decided from the text alone — its line
 * breaks and how wide its characters are — never by measuring the page, which
 * would force off-screen rows to render (see transcript/DESIGN.md).
 */

/** About this many lines of the bubble stay visible while folded. */
const PREVIEW_ROWS = 20
/** Only a message clearly longer than its preview folds. */
const FOLD_OVER_ROWS = 24
/** Characters per bubble line assumed for wrapping; a wide (CJK) character counts twice. */
const ROW_WIDTH = 80

// East Asian wide and full-width characters, and emoji: each takes two columns.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u

export interface UserMessageFold {
  /** What stays visible while folded. */
  preview: string
  /** Lines in the whole message, by its line breaks. */
  lineCount: number
}

/** Width of `line` in columns, counted no further than `limit`. */
function widthOf(line: string, limit: number): number {
  let width = 0
  for (const char of line) {
    width += WIDE.test(char) ? 2 : 1
    if (width > limit) break
  }
  return width
}

/** UTF-16 offset in `line` where `columns` columns are used up. */
function offsetAtWidth(line: string, columns: number): number {
  let width = 0
  let offset = 0
  for (const char of line) {
    width += WIDE.test(char) ? 2 : 1
    if (width > columns) break
    offset += char.length
  }
  return offset
}

/** How `text` folds, or null when it is short enough to show whole. */
export function foldUserMessage(text: string): UserMessageFold | null {
  const lines = text.split('\n')
  let rows = 0
  let start = 0
  let previewEnd = -1
  for (const line of lines) {
    const lineRows = Math.max(1, Math.ceil(widthOf(line, (FOLD_OVER_ROWS + 1) * ROW_WIDTH) / ROW_WIDTH))
    if (previewEnd < 0 && rows + lineRows > PREVIEW_ROWS) {
      previewEnd = start + offsetAtWidth(line, (PREVIEW_ROWS - rows) * ROW_WIDTH)
    }
    rows += lineRows
    if (rows > FOLD_OVER_ROWS) {
      return { preview: text.slice(0, previewEnd).trimEnd(), lineCount: lines.length }
    }
    start += line.length + 1
  }
  return null
}
