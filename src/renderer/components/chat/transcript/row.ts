/**
 * Row containment for transcript rows.
 *
 * `content-visibility: auto` lets the browser skip style, layout and paint for
 * rows far from the viewport while they stay in the DOM (find-in-page,
 * selection and accessibility keep working). A skipped row occupies its
 * `contain-intrinsic-size`; the `auto` keyword makes that the row's last
 * rendered height once it has been on screen, so only a never-seen row uses
 * the estimate.
 *
 * Consequences every row's content must respect:
 * - Paint is clipped to the row. Anything that has to escape it (tooltips,
 *   menus, modals) must be portaled to `document.body`.
 * - The row is the containing block for `position: fixed` descendants.
 * - Margins do not collapse through the row.
 */

import type { Message } from '../../../types'

// Class strings are literal so Tailwind sees them; heights mirror ROW_ESTIMATES.
const USER_ROW = '[content-visibility:auto] [contain-intrinsic-size:auto_96px]'
const SHORT_REPLY_ROW = '[content-visibility:auto] [contain-intrinsic-size:auto_240px]'
const MEDIUM_REPLY_ROW = '[content-visibility:auto] [contain-intrinsic-size:auto_600px]'
const LONG_REPLY_ROW = '[content-visibility:auto] [contain-intrinsic-size:auto_1000px]'

/**
 * Height estimates in px for a row that has never rendered, by role and reply
 * length (a 1.4K-character reply with code measured 600–1200 px, so a single
 * 240 px guess was 3–5× short).
 */
const ROW_ESTIMATES = { user: 96, short: 240, medium: 600, long: 1000 } as const
const SHORT_REPLY_CHARS = 500
const MEDIUM_REPLY_CHARS = 3000

type RowMessage = Pick<Message, 'role'> & { content?: string }

function tier(message: RowMessage): keyof typeof ROW_ESTIMATES {
  if (message.role === 'user') return 'user'
  const length = message.content?.length ?? 0
  return length < SHORT_REPLY_CHARS ? 'short' : length < MEDIUM_REPLY_CHARS ? 'medium' : 'long'
}

const ROW_CLASSES = { user: USER_ROW, short: SHORT_REPLY_ROW, medium: MEDIUM_REPLY_ROW, long: LONG_REPLY_ROW } as const

/** Containment classes for a transcript row, with a height estimate by role and length. */
export function transcriptRowClass(message: RowMessage): string {
  return ROW_CLASSES[tier(message)]
}

/** The same estimate in px, for a placeholder of a row that never rendered. */
export function estimatedRowHeight(message: RowMessage): number {
  return ROW_ESTIMATES[tier(message)]
}
