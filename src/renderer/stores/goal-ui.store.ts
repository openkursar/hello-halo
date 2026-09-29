/**
 * Goal UI state — how the goal surfaces look on this screen, in memory only.
 *
 * Kept apart from goal.store, which mirrors what main holds: nothing here is a
 * fact about the goal, and none of it survives a reload.
 */

import { create } from 'zustand'
import type { GoalInput } from '../../shared/types/goal'

/** How long a cleared active goal can be brought back. */
export const GOAL_UNDO_MS = 6000

export interface GoalUndoEntry {
  /** What Undo sets again. Attribution and note are not restorable. */
  previous: GoalInput
  /** Distinguishes one clear from the next, so an old timer never drops a newer entry. */
  id: number
}

interface GoalUiState {
  /** Composer draft keys whose next Send sets a goal. */
  composerGoalMode: Set<string>
  /** conversationId -> the goal just cleared from it, while Undo is offered. */
  undo: Map<string, GoalUndoEntry>

  setComposerGoalMode: (draftKey: string, on: boolean) => void
  offerUndo: (conversationId: string, previous: GoalInput) => void
  dropUndo: (conversationId: string, id?: number) => void
  /** Drop everything held for a deleted conversation. */
  forget: (conversationId: string) => void
}

let undoSeq = 0

function toggled(set: Set<string>, key: string, on: boolean): Set<string> | null {
  if (set.has(key) === on) return null
  const next = new Set(set)
  if (on) next.add(key)
  else next.delete(key)
  return next
}

export const useGoalUiStore = create<GoalUiState>((set, get) => ({
  composerGoalMode: new Set(),
  undo: new Map(),

  setComposerGoalMode: (draftKey, on) => {
    const next = toggled(get().composerGoalMode, draftKey, on)
    if (next) set({ composerGoalMode: next })
  },

  offerUndo: (conversationId, previous) => {
    const id = ++undoSeq
    const next = new Map(get().undo)
    next.set(conversationId, { previous, id })
    set({ undo: next })
    setTimeout(() => get().dropUndo(conversationId, id), GOAL_UNDO_MS)
  },

  dropUndo: (conversationId, id) => {
    const current = get().undo.get(conversationId)
    if (!current || (id !== undefined && current.id !== id)) return
    const next = new Map(get().undo)
    next.delete(conversationId)
    set({ undo: next })
  },

  forget: (conversationId) => {
    get().setComposerGoalMode(conversationId, false)
    get().dropUndo(conversationId)
  },
}))
