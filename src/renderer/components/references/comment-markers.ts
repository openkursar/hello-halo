/**
 * Opening a pending comment in the reference layer's floating card: beside its
 * marker in the margin of rendered text, beside terminal output gone back to,
 * at the top of a place whose passage is gone, or — when the place itself
 * cannot be shown (a closed terminal, a deleted message or file, a file that
 * cannot be opened) — beside the composer's comments chip. A comment can be
 * read, edited and deleted in every case.
 */

import { findReference, useComposerReferencesStore } from '../../stores/composer-references.store'
import { viewComment, type SelectionRect } from './selection'

/** How long a marker (or the composer's chip) may take to appear after the place scrolled into view. */
const MARKER_WAIT_MS = 700
const MARGIN = 8

export const COMMENT_MARKER_ATTRIBUTE = 'data-comment-marker'
/** On the composer's comments chip; its value is the composer's draft key. */
export const COMPOSER_COMMENTS_ATTRIBUTE = 'data-composer-comments'

function visibleRect(selector: string): SelectionRect | null {
  const element = document.querySelector(selector)
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return rect.width === 0 && rect.height === 0 ? null : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

/** Opens the pending comment `id` in the floating card at `rect`, taking the focus. */
export function openCommentCard(id: string, rect: SelectionRect): void {
  viewComment({ id, rect, focus: true })
}

/** Opens the comment `id` beside its marker, or at `fallback` when no marker shows in time; it takes the focus. */
export function showCommentAt(id: string, fallback: () => SelectionRect | null): void {
  const deadline = Date.now() + MARKER_WAIT_MS
  const attempt = () => {
    const rect = visibleRect(`[${COMMENT_MARKER_ATTRIBUTE}="${CSS.escape(id)}"]`)
    if (rect) {
      openCommentCard(id, rect)
      return
    }
    if (Date.now() < deadline) {
      requestAnimationFrame(attempt)
      return
    }
    const at = fallback()
    if (at) openCommentCard(id, at)
  }
  attempt()
}

/** Opens the comment `id` at the top of `place`: the place is there, the passage in it is not. */
export function openCommentCardAtTopOf(id: string, place: Element): void {
  const box = place.getBoundingClientRect()
  const top = Math.min(Math.max(box.top, MARGIN), window.innerHeight - MARGIN)
  openCommentCard(id, { left: box.left, right: box.right, top, bottom: top })
}

/**
 * Opens the comment `id` beside the comments chip of the composer holding it —
 * for a comment whose place cannot be shown. A composer out of sight (a
 * maximized canvas, a phone) is brought back first; with no chip to be found,
 * the card opens at the bottom of the window.
 */
export function openCommentCardAtComposer(id: string): void {
  const { drafts, target } = useComposerReferencesStore.getState()
  const owner = findReference(drafts, id)
  if (!owner) return
  if (target && !target.visible) target.reveal()
  const deadline = Date.now() + MARKER_WAIT_MS
  const attempt = () => {
    const rect = visibleRect(`[${COMPOSER_COMMENTS_ATTRIBUTE}="${CSS.escape(owner.key)}"]`)
    if (rect) {
      openCommentCard(id, rect)
      return
    }
    if (Date.now() < deadline) {
      requestAnimationFrame(attempt)
      return
    }
    const bottom = window.innerHeight - MARGIN
    openCommentCard(id, { left: MARGIN, right: MARGIN, top: bottom, bottom })
  }
  attempt()
}
