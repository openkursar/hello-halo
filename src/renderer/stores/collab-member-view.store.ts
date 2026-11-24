/**
 * Which temporary team member's work is shown in place of a conversation's chat,
 * in memory only. Held outside the chat page so the team progress canvas can open
 * a member there too.
 */

import { create } from 'zustand'

interface CollabMemberViewState {
  /** Applies only while `conversationId` is the open conversation; never carried to another. */
  view: { conversationId: string; appId: string } | null
  open: (conversationId: string, appId: string) => void
  close: () => void
}

export const useCollabMemberViewStore = create<CollabMemberViewState>()(set => ({
  view: null,
  open: (conversationId, appId) => set({ view: { conversationId, appId } }),
  close: () => set({ view: null }),
}))
