/**
 * Toolsets Store — renderer mirror of the backend toolset broker.
 *
 * The main process is the single source of truth: this store reflects the
 * open/closed state per conversation and drives open/close through the API.
 * AI-initiated changes arrive via the `toolsets:changed` event and update the
 * same state, so the UI (menu switches + activation pills) always matches
 * reality regardless of who flipped a toolset.
 */

import { create } from 'zustand'
import { api } from '../api'

export interface ToolsetStatus {
  id: string
  displayName: string
  summary: string
  open: boolean
}

export interface ToolsetsChangedEvent {
  conversationId: string
  spaceId: string
  toolsetId?: string
  action?: 'open' | 'close'
  openedBy?: 'user' | 'ai' | 'restore'
  open: string[]
}

export interface ToolsetsRequestedEvent {
  conversationId: string
  spaceId: string
  toolsetId: string
  displayName?: string
}

interface ToolsetsState {
  /** conversationId -> statuses */
  byConversation: Map<string, ToolsetStatus[]>
  /** conversationId -> toolsetIds the AI asked the user to enable (highlights the
   * matching switch in the Tools menu until the user acts). */
  aiRequested: Map<string, Set<string>>
  /** conversationId -> pending "open the Tools menu" one-shot (bumped on a new
   * request, cleared by consumeRequestSignal once the menu has opened, so a
   * remount never re-opens it). */
  requestSignal: Map<string, number>
  loading: boolean

  refresh: (spaceId: string, conversationId: string) => Promise<void>
  open: (spaceId: string, conversationId: string, toolsetId: string) => Promise<void>
  close: (spaceId: string, conversationId: string, toolsetId: string) => Promise<void>
  getStatuses: (conversationId: string) => ToolsetStatus[]
  consumeRequestHighlight: (conversationId: string, toolsetId: string) => void
  consumeRequestSignal: (conversationId: string) => void
  applyChangedEvent: (e: ToolsetsChangedEvent) => void
  applyRequestedEvent: (e: ToolsetsRequestedEvent) => void
}

export const useToolsetsStore = create<ToolsetsState>((set, get) => ({
  byConversation: new Map(),
  aiRequested: new Map(),
  requestSignal: new Map(),
  loading: false,

  refresh: async (spaceId, conversationId) => {
    set({ loading: true })
    try {
      const res = await api.listToolsets(spaceId, conversationId)
      if (res.success && Array.isArray(res.data)) {
        const next = new Map(get().byConversation)
        next.set(conversationId, res.data as ToolsetStatus[])
        set({ byConversation: next })
      }
    } catch (err) {
      console.error('[Toolsets Store] refresh failed:', err)
    } finally {
      set({ loading: false })
    }
  },

  open: async (spaceId, conversationId, toolsetId) => {
    // Optimistic: reflect immediately; event/refresh reconciles on failure.
    setOpenLocal(set, get, conversationId, toolsetId, true)
    try {
      const res = await api.openToolset(spaceId, conversationId, toolsetId)
      if (!res.success) {
        console.error('[Toolsets Store] open failed:', res.error)
        await get().refresh(spaceId, conversationId)
      }
    } catch (err) {
      console.error('[Toolsets Store] open error:', err)
      await get().refresh(spaceId, conversationId)
    }
  },

  close: async (spaceId, conversationId, toolsetId) => {
    setOpenLocal(set, get, conversationId, toolsetId, false)
    try {
      const res = await api.closeToolset(spaceId, conversationId, toolsetId)
      if (!res.success) {
        console.error('[Toolsets Store] close failed:', res.error)
        await get().refresh(spaceId, conversationId)
      }
    } catch (err) {
      console.error('[Toolsets Store] close error:', err)
      await get().refresh(spaceId, conversationId)
    }
  },

  getStatuses: (conversationId) => get().byConversation.get(conversationId) ?? [],

  consumeRequestHighlight: (conversationId, toolsetId) => {
    const map = get().aiRequested
    const set0 = map.get(conversationId)
    if (!set0 || !set0.has(toolsetId)) return
    const next = new Map(map)
    const nextSet = new Set(set0)
    nextSet.delete(toolsetId)
    next.set(conversationId, nextSet)
    set({ aiRequested: next })
  },

  consumeRequestSignal: (conversationId) => {
    if (!get().requestSignal.has(conversationId)) return
    const next = new Map(get().requestSignal)
    next.delete(conversationId)
    set({ requestSignal: next })
  },

  applyChangedEvent: (e) => {
    const { conversationId, toolsetId, action, open } = e
    const statuses = get().byConversation.get(conversationId)
    // Reconcile statuses against the authoritative open[] set.
    if (statuses) {
      const openSet = new Set(open)
      const next = new Map(get().byConversation)
      next.set(conversationId, statuses.map(s => ({ ...s, open: openSet.has(s.id) })))
      set({ byConversation: next })
    }
    // Enabling a requested toolset fulfills the request — clear its highlight.
    if (action === 'open' && toolsetId) {
      get().consumeRequestHighlight(conversationId, toolsetId)
    }
  },

  applyRequestedEvent: (e) => {
    const { conversationId, toolsetId } = e
    // Highlight the requested toolset's switch.
    const reqMap = get().aiRequested
    const nextSet = new Set(reqMap.get(conversationId) ?? [])
    nextSet.add(toolsetId)
    const nextReq = new Map(reqMap)
    nextReq.set(conversationId, nextSet)
    // Bump the open signal so ToolsetControls opens the Tools menu.
    const sigMap = get().requestSignal
    const nextSig = new Map(sigMap)
    nextSig.set(conversationId, (sigMap.get(conversationId) ?? 0) + 1)
    set({ aiRequested: nextReq, requestSignal: nextSig })
  }
}))

function setOpenLocal(
  set: (partial: Partial<ToolsetsState>) => void,
  get: () => ToolsetsState,
  conversationId: string,
  toolsetId: string,
  open: boolean
): void {
  const statuses = get().byConversation.get(conversationId)
  if (!statuses) return
  const next = new Map(get().byConversation)
  next.set(conversationId, statuses.map(s => (s.id === toolsetId ? { ...s, open } : s)))
  set({ byConversation: next })
}
