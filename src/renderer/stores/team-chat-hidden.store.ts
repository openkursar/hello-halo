import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** `waiting`: whether a question was waiting on the user when the task was removed. */
export interface HiddenTeamChat { waiting: boolean }
type HiddenByKey = Record<string, HiddenTeamChat>

/**
 * A removed task comes back when a new question awaits the user. A question
 * that was already waiting at removal does not count; once it has been
 * answered, the next one does.
 */
export function reconcileHidden(hidden: HiddenByKey, waitingNow: ReadonlyMap<string, boolean>): HiddenByKey {
  let next: HiddenByKey | undefined
  for (const [key, entry] of Object.entries(hidden)) {
    const waiting = waitingNow.get(key)
    if (waiting === undefined || waiting === entry.waiting) continue
    next ??= { ...hidden }
    if (waiting) delete next[key]
    else next[key] = { waiting: false }
  }
  return next ?? hidden
}

interface TeamChatHiddenState {
  hidden: Record<string, HiddenByKey>
  hide: (spaceId: string, key: string, waiting: boolean) => void
  restore: (spaceId: string, key: string) => void
  /** Put every task of one team removed from this space's list back. */
  restoreTeam: (spaceId: string, teamId: string) => void
  reconcile: (spaceId: string, waitingNow: ReadonlyMap<string, boolean>) => void
}

/** Tasks the user removed from the homepage list; the team's own pages are unaffected. */
export const useTeamChatHiddenStore = create<TeamChatHiddenState>()(persist((set) => ({
  hidden: {},
  hide: (spaceId, key, waiting) => set(state => ({
    hidden: { ...state.hidden, [spaceId]: { ...state.hidden[spaceId], [key]: { waiting } } },
  })),
  restore: (spaceId, key) => set(state => {
    const current = state.hidden[spaceId]
    if (!current?.[key]) return state
    const { [key]: _removed, ...rest } = current
    return { hidden: { ...state.hidden, [spaceId]: rest } }
  }),
  restoreTeam: (spaceId, teamId) => set(state => {
    const current = state.hidden[spaceId]
    const prefix = `team:${teamId}:`
    if (!current || !Object.keys(current).some(key => key.startsWith(prefix))) return state
    return { hidden: { ...state.hidden, [spaceId]: Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix))) } }
  }),
  reconcile: (spaceId, waitingNow) => set(state => {
    const current = state.hidden[spaceId]
    if (!current) return state
    const next = reconcileHidden(current, waitingNow)
    return next === current ? state : { hidden: { ...state.hidden, [spaceId]: next } }
  }),
}), { name: 'halo-team-chat-hidden' }))
