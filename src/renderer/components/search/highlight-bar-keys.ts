/**
 * Keys the search highlight bar answers while it shows: ↑/↓ take the same
 * steps as its buttons, Esc closes it, ⌘K / Ctrl+K edits the search. Arrows
 * and Esc stay with what has focus when it types (a caret moves in the
 * composer) or has already used the key (a menu closes).
 */

import type { ResultStep } from '../../stores/search.store'

export type HighlightBarCommand = ResultStep | 'close' | 'edit'

type KeyPress = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'defaultPrevented' | 'target'>

function isTextEntry(target: EventTarget | null): boolean {
  const element = target as Partial<Pick<HTMLElement, 'tagName' | 'isContentEditable'>> | null
  if (!element) return false
  return element.isContentEditable === true || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT'
}

/** What a key press does to the bar; null leaves the key to the page. */
export function highlightBarCommand(e: KeyPress, isMac: boolean): HighlightBarCommand | null {
  if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 'k' && !e.shiftKey) return 'edit'
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Escape') return null
  if (e.defaultPrevented || isTextEntry(e.target)) return null
  if (e.key === 'Escape') return 'close'
  // Results are newest first, so up goes back in time.
  return e.key === 'ArrowUp' ? 'earlier' : 'more-recent'
}
