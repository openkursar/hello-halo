/**
 * createAppChatSelectionSlice — digital-human selection + composer drafts for
 * the main conversation board's input.
 *
 * Deliberately separate from conversations.ts: this slice never touches the
 * space conversation index or app-chat's own JSONL/registry storage — it
 * tracks which link (Halo vs a digital human) the input is currently pointed
 * at, hands a newly selected digital-human conversation to its backend to open,
 * keeps per-conversation unsent-text drafts, and (on selection) moves the
 * task-panel read state the way regular conversations do.
 */
import type { ChatSlice, ChatState } from './internal'
import { createEmptySpaceState } from './internal'
import { openOnce } from './backend'
import { readTransition } from './task-read'

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
    let persistRead: (() => void) | undefined
    set((state: ChatState) => {
      const newSpaceStates = new Map(state.spaceStates)
      const existing = newSpaceStates.get(spaceId) || createEmptySpaceState()
      newSpaceStates.set(spaceId, { ...existing, selectedAppChat: { appId, conversationId } })
      // Same read lifecycle as a regular conversation; the task panel names
      // digital-human items itself, so no title is kept here.
      const read = readTransition(state, conversationId, { spaceId, title: '' })
      persistRead = read?.persist
      return { spaceStates: newSpaceStates, ...read?.patch }
    })
    persistRead?.()
    get().cleanupPulseReadAt()
    // Show what is cached now; the read (and a running turn) follow.
    void openOnce({ set, get }, { spaceId, conversationId })
      .catch((error) => console.error('[ChatStore] Failed to open digital-human conversation:', error))
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
