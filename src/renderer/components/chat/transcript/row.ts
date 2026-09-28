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

const USER_ROW = '[content-visibility:auto] [contain-intrinsic-size:auto_96px]'
const REPLY_ROW = '[content-visibility:auto] [contain-intrinsic-size:auto_240px]'

/** Containment classes for a transcript row, with a height estimate by role. */
export function transcriptRowClass(message: Pick<Message, 'role'>): string {
  return message.role === 'user' ? USER_ROW : REPLY_ROW
}
