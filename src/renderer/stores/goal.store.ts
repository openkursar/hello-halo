/**
 * Goal Store — renderer mirror of each conversation's goal.
 *
 * The agent engine owns the goal; main relays it. This store holds what main
 * last reported per conversation: loaded on demand, updated by the
 * `agent:goal-updated` event (from the model's Goal tool or a user change on
 * any client), and re-read after each turn because events are not delivered
 * while an interrupted turn drains.
 *
 * `set` / `clear` never start a turn. To set a goal and start working toward
 * it in one step, send the message with `goal` on the sendMessage request.
 */

import { create } from 'zustand'
import { api } from '../api'
import { useEngineCapabilities, useEngineStore } from './engine.store'
import type { Goal, GoalInput, GoalUpdatedEvent } from '../../shared/types/goal'

export type { Goal, GoalInput, GoalStatus, GoalChangeSource } from '../../shared/types/goal'

export interface GoalSetResult {
  success: boolean
  error?: string
}

interface GoalState {
  /** conversationId -> goal (null: none). A missing key means not loaded yet. */
  byConversation: Map<string, Goal | null>
  /**
   * Conversations whose latest user change the model has not picked up yet.
   * Cleared by the engine's echo, or at turn end: the engine sends no echo for
   * a change that nets out to what the model last saw.
   */
  unseenByModel: Set<string>

  load: (spaceId: string, conversationId: string) => Promise<void>
  set: (spaceId: string, conversationId: string, input: GoalInput) => Promise<GoalSetResult>
  clear: (spaceId: string, conversationId: string) => Promise<GoalSetResult>
  applyUpdatedEvent: (e: GoalUpdatedEvent) => void
  markTurnEnded: (conversationId: string) => void
  /**
   * Show a user change before main confirms it. Returns a rollback that
   * restores the previous value, unless a newer change has landed since.
   * `unseen: false` for a change main applies before the turn it starts.
   */
  applyOptimistic: (conversationId: string, goal: Goal | null, options?: { unseen?: boolean }) => () => void
  /** Drop everything held for a deleted conversation. */
  forget: (conversationId: string) => void
}

/**
 * conversationId -> change counter. A load that started before a newer change
 * landed must not overwrite it with what it read.
 */
const revisions = new Map<string, number>()

/** conversationId -> reads in flight; a change landing meanwhile is kept, not dropped as untracked. */
const loading = new Map<string, number>()

function bump(conversationId: string): void {
  revisions.set(conversationId, (revisions.get(conversationId) ?? 0) + 1)
}

function goalsDisabled(): boolean {
  return useEngineStore.getState().capabilities?.features.goal === false
}

export const useGoalStore = create<GoalState>((set, get) => {
  const put = (conversationId: string, goal: Goal | null | undefined): void => {
    const next = new Map(get().byConversation)
    if (goal === undefined) next.delete(conversationId)
    else next.set(conversationId, goal)
    set({ byConversation: next })
  }

  const markUnseen = (conversationId: string, unseen: boolean): void => {
    const current = get().unseenByModel
    if (current.has(conversationId) === unseen) return
    const next = new Set(current)
    if (unseen) next.add(conversationId)
    else next.delete(conversationId)
    set({ unseenByModel: next })
  }

  const write = async (
    spaceId: string,
    conversationId: string,
    input: GoalInput | null
  ): Promise<GoalSetResult> => {
    try {
      const res = await api.setGoal(spaceId, conversationId, input)
      if (!res.success) {
        console.error('[Goal Store] set failed:', res.error)
        return { success: false, error: res.error }
      }
      bump(conversationId)
      put(conversationId, res.data ?? null)
      markUnseen(conversationId, true)
      return { success: true }
    } catch (err) {
      console.error('[Goal Store] set error:', err)
      return { success: false, error: (err as Error).message }
    }
  }

  return {
    byConversation: new Map(),
    unseenByModel: new Set(),

    load: async (spaceId, conversationId) => {
      if (goalsDisabled()) return
      const startedAt = revisions.get(conversationId) ?? 0
      loading.set(conversationId, (loading.get(conversationId) ?? 0) + 1)
      try {
        const res = await api.getGoal(spaceId, conversationId)
        if (!res.success) {
          console.error('[Goal Store] load failed:', res.error)
          return
        }
        if ((revisions.get(conversationId) ?? 0) !== startedAt) return
        put(conversationId, res.data ?? null)
      } catch (err) {
        console.error('[Goal Store] load error:', err)
      } finally {
        const left = (loading.get(conversationId) ?? 1) - 1
        if (left > 0) loading.set(conversationId, left)
        else loading.delete(conversationId)
      }
    },

    set: (spaceId, conversationId, input) => write(spaceId, conversationId, input),

    clear: (spaceId, conversationId) => write(spaceId, conversationId, null),

    applyUpdatedEvent: (e) => {
      // Only conversations this client reads; others (e.g. digital-human chats)
      // are read when opened.
      if (!get().byConversation.has(e.conversationId) && !loading.has(e.conversationId)) return
      bump(e.conversationId)
      put(e.conversationId, e.goal ?? null)
      markUnseen(e.conversationId, e.source === 'user' && !e.seenByModel)
    },

    markTurnEnded: (conversationId) => markUnseen(conversationId, false),

    applyOptimistic: (conversationId, goal, options) => {
      const previous = get().byConversation.get(conversationId)
      const wasUnseen = get().unseenByModel.has(conversationId)
      bump(conversationId)
      const revision = revisions.get(conversationId)
      put(conversationId, goal)
      markUnseen(conversationId, options?.unseen ?? true)
      return () => {
        if (revisions.get(conversationId) !== revision) return
        bump(conversationId)
        put(conversationId, previous)
        markUnseen(conversationId, wasUnseen)
      }
    },

    forget: (conversationId) => {
      revisions.delete(conversationId)
      if (get().byConversation.has(conversationId)) put(conversationId, undefined)
      markUnseen(conversationId, false)
    },
  }
})

/** Subscribe the store to main-process goal events. Returns the unsubscribe. */
export function initGoalStoreListeners(): () => void {
  const unsubUpdated = api.onAgentGoalUpdated((e) => {
    useGoalStore.getState().applyUpdatedEvent(e)
  })
  const unsubComplete = api.onAgentComplete((data) => {
    const { spaceId, conversationId } = data as { spaceId?: string; conversationId?: string }
    if (!spaceId || !conversationId) return
    const store = useGoalStore.getState()
    if (!store.byConversation.has(conversationId)) return
    store.markTurnEnded(conversationId)
    void store.load(spaceId, conversationId)
  })
  return () => {
    unsubUpdated()
    unsubComplete()
  }
}

/** Whether the running engine keeps goals. False while capabilities load. */
export function useGoalSupported(): boolean {
  return useEngineCapabilities()?.features.goal === true
}

/** The conversation's goal: undefined until loaded, null when it has none. */
export function useConversationGoal(conversationId: string | null | undefined): Goal | null | undefined {
  return useGoalStore((s) => (conversationId ? s.byConversation.get(conversationId) : undefined))
}

/** Whether the model has yet to see the user's latest change to this conversation's goal. */
export function useGoalUnseenByModel(conversationId: string | null | undefined): boolean {
  return useGoalStore((s) => (conversationId ? s.unseenByModel.has(conversationId) : false))
}
