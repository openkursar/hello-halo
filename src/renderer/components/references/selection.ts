/**
 * The selection on offer — what the floating bar would turn into a card.
 *
 * One at a time for the whole window: adapters offer a selection and withdraw
 * it, and the reference layer shows the bar (or the comment box) for it. An
 * adapter offers only while a composer sits beside the content (`canOffer`),
 * so a page without one does no work at all.
 */

import { create } from 'zustand'
import { useComposerReferencesStore, type ReferenceDraft } from '../../stores/composer-references.store'

export interface SelectionRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface OfferedSelection {
  /** The adapter instance that offered it; only that instance withdraws it. */
  owner: object
  draft: ReferenceDraft
  /** Where the selection is on screen; the bar sits under it. */
  rect: SelectionRect
  /** Collapses the selection once it became a card, so the bar does not return for it. */
  collapse?: () => void
  /**
   * Gives keyboard focus back to the content when the comment box closes;
   * `restoreSelection` (a cancelled comment) also selects the text again
   * where focus alone would not keep it.
   */
  refocus?: (restoreSelection: boolean) => void
  /**
   * Starts a comment in the content itself (an editor writes it in a card
   * under the lines); without it, the floating comment box is used.
   */
  comment?: () => void
}

/** A pending comment opened from its marker in rendered text or a terminal, shown in a floating card. */
export interface ViewedComment {
  id: string
  rect: SelectionRect
  /** Takes the keyboard focus (gone back to from the composer, to edit it). */
  focus?: boolean
}

interface SelectionState {
  offered: OfferedSelection | null
  /** The comment box is open for this selection. */
  commenting: OfferedSelection | null
  viewing: ViewedComment | null
}

export const useSelectionStore = create<SelectionState>(() => ({ offered: null, commenting: null, viewing: null }))

/** How long a selection must hold still before the bar appears. */
export const SELECTION_SETTLE_MS = 120

/** Whether a selection could become a card here: a composer sits beside the content. */
export function canOffer(): boolean {
  return useComposerReferencesStore.getState().target !== null
}

export function offerSelection(owner: object, offered: Omit<OfferedSelection, 'owner'> | null): void {
  const state = useSelectionStore.getState()
  // The comment box keeps the selection it was opened for.
  if (state.commenting) return
  if (offered) {
    useSelectionStore.setState({ offered: { ...offered, owner } })
  } else if (state.offered?.owner === owner) {
    useSelectionStore.setState({ offered: null })
  }
}

/** Hides the bar; the text stays selected. */
export function dismissOffer(): void {
  if (useSelectionStore.getState().offered) useSelectionStore.setState({ offered: null })
}

/** Starts a comment on the offered selection: in the content when it can hold one, else in the comment box. */
export function openComment(): void {
  const { offered } = useSelectionStore.getState()
  if (!offered) return
  if (offered.comment) {
    useSelectionStore.setState({ offered: null })
    offered.comment()
    return
  }
  useSelectionStore.setState({ offered: null, commenting: offered })
}

export function viewComment(viewed: ViewedComment | null): void {
  useSelectionStore.setState({ viewing: viewed })
}

export function closeComment(): void {
  if (useSelectionStore.getState().commenting) useSelectionStore.setState({ commenting: null })
}

// Pointer state, so a selection is offered when the drag ends rather than at
// every step of it. Tracked by the reference layer while it is mounted.
let pointerDown = false
const releaseWaiters = new Set<() => void>()

export function setPointerDown(down: boolean): void {
  pointerDown = down
  if (down || releaseWaiters.size === 0) return
  const waiters = [...releaseWaiters]
  releaseWaiters.clear()
  for (const waiter of waiters) waiter()
}

/** Runs `fn` now, or when the pointer is released if a drag is in progress. Returns a canceller. */
export function afterPointerRelease(fn: () => void): () => void {
  if (!pointerDown) {
    fn()
    return () => {}
  }
  releaseWaiters.add(fn)
  return () => releaseWaiters.delete(fn)
}

/** True for a keyboard event meaning "add the selection to the chat": ⌘L on a Mac, Ctrl+L elsewhere. */
export function isAddShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  if (event.altKey || event.shiftKey || (event.key !== 'l' && event.key !== 'L')) return false
  return IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC')

/** The add shortcut as the user's keyboard shows it. */
export const ADD_SHORTCUT_LABEL = IS_MAC ? '⌘L' : 'Ctrl+L'
