import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const teamTaskKey = (teamId: string, epochId: string) => `team:${teamId}:${epochId}`

interface TeamChatPinsState {
  pinned: Record<string, string[]>
  togglePin: (spaceId: string, key: string) => void
}

export const useTeamChatPinsStore = create<TeamChatPinsState>()(persist((set) => ({
  pinned: {},
  togglePin: (spaceId, key) => set(state => {
    const current = state.pinned[spaceId] ?? []
    return { pinned: { ...state.pinned, [spaceId]: current.includes(key)
      ? current.filter(id => id !== key) : [...current, key] } }
  }),
}), { name: 'halo-team-chat-pins' }))
