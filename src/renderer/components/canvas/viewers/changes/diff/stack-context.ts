/**
 * What the diff stack shares with its cards: the editor slots, one visibility
 * observer and one size observer for all cards, the heights they measured,
 * where cards report their editors (for navigation and reveals), and the
 * scroller their editors scroll places into view on.
 */

import { createContext, useContext } from 'react'
import type { DiffEditorHandle } from './diff-editor'
import type { EditorSlots } from './editor-slots'

export interface StackContextValue {
  slots: EditorSlots
  /** Reports `element` entering and leaving the viewport; returns the stop function. */
  observe(element: HTMLElement, onVisible: (visible: boolean) => void): () => void
  /** Records `element`'s height under `key` while it lives; returns the stop function. */
  measure(element: HTMLElement, key: string): () => void
  heights: Map<string, number>
  /**
   * A card's editors once all of them are ready; null when the card settled
   * without one (binary, too large, failed); undefined when they went away.
   */
  registerEditors(key: string, editors: DiffEditorHandle[] | null | undefined): void
  /** The stack's scroller, and how much of its top a card's sticky header covers. */
  scrollParent(): { element: HTMLElement; topInset: number } | null
}

export const StackContext = createContext<StackContextValue | null>(null)

export function useStackContext(): StackContextValue {
  const value = useContext(StackContext)
  if (!value) throw new Error('A file card must be rendered inside the diff stack')
  return value
}
