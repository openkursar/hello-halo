/**
 * The shape every line inside a reply's work shares — an operation, a stretch
 * of operations, a message received while the reply ran — so they read as one
 * list whichever module draws them.
 */

/** A line that opens what it names. */
export const PROCESS_LINE = 'group/op -mx-1.5 flex w-[calc(100%+0.75rem)] min-h-[31px] items-center gap-2 rounded-[5px] px-1.5 py-[3px] text-left text-xs text-faint-foreground transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [@media(pointer:coarse)]:min-h-11'

/** The line's "View / Collapse" cue: shown on hover, keyboard focus and touch. */
export const PROCESS_CUE = 'ml-auto shrink-0 pl-1 text-[11px] opacity-0 transition-opacity group-hover/op:opacity-100 group-focus-visible/op:opacity-100 [@media(hover:none)]:opacity-100'

/** When a delivered line arrived, after the cue; a phone-width line keeps its room for who and what. */
export const PROCESS_TIME = 'hidden shrink-0 pl-1.5 text-[11px] tabular-nums sm:inline'

/** What a line opens, under its text rather than its icon on wide screens. */
export const PROCESS_DETAIL = 'mb-2 mt-0.5 min-w-0 sm:ml-[22px]'

/** Display columns a line's subject keeps before it is cut short; a wide (CJK) character takes two. */
export const PROCESS_SUBJECT_COLUMNS = 44

function columns(code: number): number {
  return code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x20000) ? 2 : 1
}

/**
 * `text` on one line, cut to `limit` display columns with an ellipsis, so lines
 * end at the same length whatever the window width. `clipped` says whether
 * anything was cut.
 */
export function clipSubject(text: string, limit = PROCESS_SUBJECT_COLUMNS): { text: string; clipped: boolean } {
  // A step's subject can be a whole tool output; only its head can reach the line.
  const head = text.length > limit * 8 ? text.slice(0, limit * 8) : text
  const line = head.replace(/\s+/g, ' ').trim()
  let used = 0
  let index = 0
  for (const char of line) {
    const width = columns(char.codePointAt(0)!)
    if (used + width > limit) return { text: `${line.slice(0, index).trimEnd()}…`, clipped: true }
    used += width
    index += char.length
  }
  return { text: line, clipped: head !== text || head.trim().includes('\n') }
}
