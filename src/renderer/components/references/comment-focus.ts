/**
 * A pending comment gone back to for editing takes the keyboard focus in its
 * card — once that card is there: switching to its tab, loading the diff or
 * bringing a scrolled-away editor back can take a moment, so the request waits
 * and the card claims it as it mounts. Until the request ends, a card that
 * mounts again (its editor rebuilt while the view settles) takes the focus
 * back if it was lost with the old one. A request no card answers in time goes
 * to its fallback; the user clicking or typing ends it, so a late card never
 * pulls the focus away from what they moved on to.
 */

/** How long a request lasts: the card's time to mount, and the view's to settle. */
const REQUEST_MS = 5000

interface FocusRequest {
  id: string
  otherwise: () => void
  timer: ReturnType<typeof setTimeout>
  /** A card took the focus. */
  answered: boolean
}

let request: FocusRequest | null = null

function end(): FocusRequest | null {
  const current = request
  if (!current) return null
  request = null
  clearTimeout(current.timer)
  window.removeEventListener('pointerdown', userMovedOn, true)
  window.removeEventListener('keydown', userMovedOn, true)
  return current
}

function userMovedOn(): void {
  end()
}

function expire(): void {
  const current = end()
  if (current && !current.answered) current.otherwise()
}

function cardSelector(id: string): string {
  return `[data-comment-card="${CSS.escape(id)}"]`
}

/** Focuses where a comment card is written in: its text box when open for writing, else its Edit button. */
export function focusCommentIn(card: HTMLElement): void {
  card.querySelector<HTMLElement>('textarea, [data-comment-edit]')?.focus({ preventScroll: true })
}

/** Gives the focus to the card of the comment `id` now, or as soon as it mounts; `otherwise` when none does in time. */
export function requestCommentFocus(id: string, otherwise: () => void): void {
  end()
  request = { id, otherwise, timer: setTimeout(expire, REQUEST_MS), answered: false }
  window.addEventListener('pointerdown', userMovedOn, true)
  window.addEventListener('keydown', userMovedOn, true)
  const card = document.querySelector<HTMLElement>(cardSelector(id))
  if (card) {
    focusCommentIn(card)
    request.answered = true
  }
}

/** Called by a card as it mounts: true when it should take the focus (a request waits for it, or lost it with an earlier card). */
export function claimCommentFocus(id: string): boolean {
  if (request?.id !== id) return false
  if (request.answered && document.activeElement?.closest(cardSelector(id))) return false
  request.answered = true
  return true
}
