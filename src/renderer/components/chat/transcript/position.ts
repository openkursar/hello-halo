/**
 * Reading position of a transcript, expressed as "which message is at the top
 * and how far into it" rather than as a scrollTop.
 *
 * A raw scrollTop is only meaningful against the layout it was taken from.
 * Contained rows that are off-screen occupy estimated heights until they are
 * rendered again, so after a remount the same scrollTop lands on a different
 * message. A message-relative position survives that.
 */

/** `null` means "at the end", i.e. keep following new content. */
export type TranscriptPosition = { messageId: string; offset: number } | null

const MESSAGE_SELECTOR = '[data-message-id]'

/** Probe points below the viewport's top edge, for when the first lands in a gap between rows. */
const PROBE_OFFSETS = [1, 16, 48, 96]

export function captureTranscriptPosition(scroller: HTMLElement, following: boolean): TranscriptPosition {
  if (following) return null
  const box = scroller.getBoundingClientRect()
  const x = box.left + box.width / 2
  for (const dy of PROBE_OFFSETS) {
    const hit = document.elementFromPoint(x, box.top + dy)
    const row = hit && scroller.contains(hit) ? hit.closest<HTMLElement>(MESSAGE_SELECTOR) : null
    const messageId = row?.dataset.messageId
    if (row && messageId) return { messageId, offset: row.getBoundingClientRect().top - box.top }
  }
  return null
}

/**
 * scrollTop that puts `row` in the middle of `scroller` (its top, if taller
 * than the view), clamped to what the scroller can reach.
 */
function centeredTop(scroller: HTMLElement, row: HTMLElement): number {
  const box = scroller.getBoundingClientRect()
  const rect = row.getBoundingClientRect()
  const top = scroller.scrollTop + (rect.top - box.top) - Math.max(0, (box.height - rect.height) / 2)
  return Math.min(Math.max(0, top), Math.max(0, scroller.scrollHeight - scroller.clientHeight))
}

/**
 * Center `row` in `scroller`. Unlike `Element.scrollIntoView`, this never
 * scrolls ancestors — `overflow: hidden` app-shell containers are still
 * programmatically scrollable and would shift the whole layout.
 */
export function centerRowInView(scroller: HTMLElement, row: HTMLElement, behavior: ScrollBehavior = 'auto'): void {
  scroller.scrollTo({ top: centeredTop(scroller, row), behavior })
}

/** Frames spent converging on a far jump target. */
const SETTLE_FRAMES = 10

/**
 * Jump to `row` and keep it centered while the rows around it render.
 *
 * Rows between here and a far target sit at estimated heights; when the jump
 * lands they render at their real heights and the target drifts. A smooth
 * scroll aims at the estimated position and would stop short, so a far jump is
 * instant and re-aimed each frame until it holds still. A near target (already
 * measured) honors `behavior`.
 */
export function revealRowInView(scroller: HTMLElement, row: HTMLElement, behavior: ScrollBehavior = 'auto'): void {
  const distance = Math.abs(centeredTop(scroller, row) - scroller.scrollTop)
  if (behavior === 'smooth' && distance <= scroller.clientHeight) {
    centerRowInView(scroller, row, 'smooth')
    return
  }
  let frame = 0
  let steady = 0
  const step = () => {
    if (!row.isConnected) return
    const target = centeredTop(scroller, row)
    if (Math.abs(target - scroller.scrollTop) > 1) {
      scroller.scrollTop = target
      steady = 0
    } else {
      steady++
    }
    if (steady < 2 && ++frame < SETTLE_FRAMES) requestAnimationFrame(step)
  }
  step()
}

/**
 * Scroll so the recorded message sits where it was. Returns false when the
 * message is not in the DOM; the caller should then fall back to the end.
 */
export function restoreTranscriptPosition(scroller: HTMLElement, position: NonNullable<TranscriptPosition>): boolean {
  const row = scroller.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(position.messageId)}"]`)
  if (!row) return false
  const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - position.offset
  scroller.scrollTop += delta
  return true
}
