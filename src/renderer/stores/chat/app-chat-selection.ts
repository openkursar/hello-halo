/**
 * createAppChatSelectionSlice — digital-human selection + composer drafts for
 * the main conversation board's input.
 *
 * Deliberately separate from conversations.ts: this slice never touches the
 * space conversation index or app-chat's own JSONL/registry storage — it only
 * tracks which link (Halo vs a digital human) the input is currently pointed
 * at, plus per-conversation unsent-text drafts. Both are pure UI state.
 */
import type { ChatSlice, ChatState } from './internal'
import { createEmptySpaceState } from './internal'

export const createAppChatSelectionSlice: ChatSlice<
  'getComposerDraft' | 'setComposerDraft' | 'clearComposerDraft' | 'selectAppChatConversation' | 'clearAppChatSelection'
> = (set, get) => ({
  getComposerDraft: (conversationId) => get().composerDrafts.get(conversationId) ?? '',

  setComposerDraft: (conversationId, text) => {
    set((state) => {
      const next = new Map(state.composerDrafts)
      if (text) next.set(conversationId, text)
      else next.delete(conversationId)
      return { composerDrafts: next }
    })
  },

  clearComposerDraft: (conversationId) => {
    set((state) => {
      if (!state.composerDrafts.has(conversationId)) return state
      const next = new Map(state.composerDrafts)
      next.delete(conversationId)
      return { composerDrafts: next }
    })
  },

  selectAppChatConversation: (spaceId, appId, conversationId) => {
    set((state: ChatState) => {
      const newSpaceStates = new Map(state.spaceStates)
      const existing = newSpaceStates.get(spaceId) || createEmptySpaceState()
      newSpaceStates.set(spaceId, { ...existing, selectedAppChat: { appId, conversationId } })
      return { spaceStates: newSpaceStates }
    })
  },

  clearAppChatSelection: async (spaceId) => {
    const existing = get().spaceStates.get(spaceId)
    if (!existing?.selectedAppChat) return

    let landingConversationId = existing.currentConversationId
    if (!landingConversationId) {
      // No prior regular conversation in this space — create one (no
      // explicit "new" step, mirrors app-chat's own single-session default).
      const created = await get().createConversation(spaceId)
      landingConversationId = created?.id ?? null
    }

    set((state) => {
      const newSpaceStates = new Map(state.spaceStates)
      const latest = newSpaceStates.get(spaceId)
      if (!latest) return state
      newSpaceStates.set(spaceId, {
        ...latest,
        currentConversationId: landingConversationId,
        selectedAppChat: null,
      })
      return { spaceStates: newSpaceStates }
    })
  },
})
