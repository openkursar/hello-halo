/** Navigation and scrolling shared by the mounted file cards. */

import { createContext, useContext } from 'react'
import type { DiffEditorHandle } from './diff-editor'
import type { LoadedDiff } from './diff-content'

export interface StackContextValue {
  /** Re-checks the all-files budget using text already read, before editors mount. */
  admitContent(key: string, diff: LoadedDiff): boolean
  /**
   * A card's editors once all of them are ready; null when the card settled
   * without one (binary, too large, failed); undefined when they went away.
   */
  registerEditors(key: string, editors: DiffEditorHandle[] | null | undefined, navigatePage?: (direction: 1 | -1, fromEdge: boolean) => boolean): void
  partPage(key: string): number
  onPartPageChange(key: string, page: number): void
  /** The stack's scroller, and how much of its top a card's sticky header covers. */
  scrollParent(): { element: HTMLElement; topInset: number } | null
}

export const StackContext = createContext<StackContextValue | null>(null)

export function useStackContext(): StackContextValue {
  const value = useContext(StackContext)
  if (!value) throw new Error('A file card must be rendered inside the diff stack')
  return value
}
