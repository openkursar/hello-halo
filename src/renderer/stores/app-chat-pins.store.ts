/**
 * App-Chat Pin Store
 *
 * Digital-human chat sessions (conversationId starting with "app-chat:") have
 * no space conversation-index entry, so they carry no `starred` field the way
 * a regular ConversationMeta does — there is nowhere backend-side to persist a
 * pin. Pinning is therefore a pure frontend, per-space local preference,
 * mirroring the effect of `starred` (both feed the same Pinned group in
 * ConversationList) without touching the space conversation store or the
 * app's own JSONL storage.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AppChatPinsState {
  /** spaceId -> pinned app-chat conversationIds */
  pinned: Record<string, string[]>
  isAppChatPinned: (spaceId: string, conversationId: string) => boolean
  toggleAppChatPin: (spaceId: string, conversationId: string) => void
}

export const useAppChatPinsStore = create<AppChatPinsState>()(
  persist(
    (set, get) => ({
      pinned: {},

      isAppChatPinned: (spaceId, conversationId) =>
        (get().pinned[spaceId] ?? []).includes(conversationId),

      toggleAppChatPin: (spaceId, conversationId) =>
        set((state) => {
          const current = state.pinned[spaceId] ?? []
          const next = current.includes(conversationId)
            ? current.filter((id) => id !== conversationId)
            : [...current, conversationId]
          return { pinned: { ...state.pinned, [spaceId]: next } }
        }),
    }),
    { name: 'halo-app-chat-pins' }
  )
)
