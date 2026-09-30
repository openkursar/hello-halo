/**
 * AI Browser Store - live-view state for AI-driven browser pages
 *
 * Each conversation (space chat or digital-human chat) drives its own active
 * page. The main process announces it with the owning conversationId; this
 * store keeps one entry per conversation, and every consumer reads the entry of
 * the conversation on screen — so "View live feed" always reveals the page the
 * visible conversation is driving, never another one's.
 */

import { create } from 'zustand'
import { api } from '../api'
import { canvasLifecycle } from '../services/canvas-lifecycle'
import { useChatStore, selectActiveConversationId } from './chat.store'
import type { AIBrowserActiveView, AIBrowserLivePage } from '../../shared/types/ai-browser'

// ============================================
// Types
// ============================================

export interface AIBrowserView {
  viewId: string
  url: string | null
  title: string | null
  /** Last time this conversation's active view changed (live-session ordering). */
  lastActivityAt: number
}

/** A page some AI conversation holds, whether or not it is the one it acts on. */
export interface AIBrowserPage {
  viewId: string
  conversationId: string
  spaceId: string | null
  url: string | null
  title: string | null
  lastActivityAt: number
}

interface AIBrowserState {
  /** Active view per conversation id. */
  views: Record<string, AIBrowserView>
  /** Every live page an AI conversation opened itself, by view id (the tray lists these). */
  pages: Record<string, AIBrowserPage>
  /** Conversations whose browser card has a step running right now. */
  operating: Record<string, boolean>

  /** Apply an active-view event from the main process. */
  applyActiveView: (event: AIBrowserActiveView) => void
  /** Seed from the main process's snapshot; anything already known is newer and kept. */
  applySnapshot: (pages: AIBrowserLivePage[]) => void
  /** An AI-driven view was destroyed; drop every entry pointing at it. */
  handleViewGone: (viewId: string) => void
  /** A conversation's browser context ended: it points at nothing and owns no page. */
  handleConversationReleased: (conversationId: string) => void
  setOperating: (conversationId: string, isOperating: boolean) => void
}

// ============================================
// Store
// ============================================

export const useAIBrowserStore = create<AIBrowserState>()((set) => ({
  views: {},
  pages: {},
  operating: {},

  applyActiveView: ({ conversationId, spaceId, viewId, owned, url, title }) => {
    // The user's own singleton browser has no conversation and no live-view entry.
    if (!conversationId) return
    const lastActivityAt = Date.now()
    set(state => ({
      views: { ...state.views, [conversationId]: { viewId, url, title, lastActivityAt } },
      // A page it only selected stays whoever opened it (the user, another conversation).
      pages: owned
        ? { ...state.pages, [viewId]: { viewId, conversationId, spaceId, url, title, lastActivityAt } }
        : state.pages,
    }))
  },

  applySnapshot: (snapshot) => {
    set(state => {
      const views = { ...state.views }
      const pages = { ...state.pages }
      const now = Date.now()
      for (const { conversationId, spaceId, viewId, owned, url, title, active } of snapshot) {
        if (!conversationId) continue
        if (owned && !pages[viewId]) pages[viewId] = { viewId, conversationId, spaceId, url, title, lastActivityAt: now }
        if (active && !views[conversationId]) views[conversationId] = { viewId, url, title, lastActivityAt: now }
      }
      return { views, pages }
    })
  },

  handleViewGone: (viewId) => {
    set(state => {
      const gone = Object.keys(state.views).filter(id => state.views[id].viewId === viewId)
      if (gone.length === 0 && !state.pages[viewId]) return state
      const views = { ...state.views }
      const operating = { ...state.operating }
      const pages = { ...state.pages }
      delete pages[viewId]
      for (const id of gone) {
        delete views[id]
        delete operating[id]
      }
      return { views, operating, pages }
    })
  },

  handleConversationReleased: (conversationId) => {
    set(state => {
      const ownedPages = Object.keys(state.pages).filter(viewId => state.pages[viewId].conversationId === conversationId)
      if (ownedPages.length === 0 && !state.views[conversationId] && !state.operating[conversationId]) return state
      const views = { ...state.views }
      const operating = { ...state.operating }
      const pages = { ...state.pages }
      delete views[conversationId]
      delete operating[conversationId]
      for (const viewId of ownedPages) delete pages[viewId]
      return { views, operating, pages }
    })
  },

  setOperating: (conversationId, isOperating) => {
    set(state => {
      if (!!state.operating[conversationId] === isOperating) return state
      const operating = { ...state.operating }
      if (isOperating) operating[conversationId] = true
      else delete operating[conversationId]
      return { operating }
    })
  },
}))

// ============================================
// Selectors
// ============================================

/** The active view of the conversation on screen. */
export function useActiveConversationBrowserView(): AIBrowserView | null {
  const conversationId = useChatStore(selectActiveConversationId)
  return useAIBrowserStore(state => (conversationId ? state.views[conversationId] ?? null : null))
}

/**
 * Whether a conversation other than the page's owner is currently on it. Such a
 * page is not the tray's to stop: closing it would pull it from under them.
 */
export function isPageInUseByOthers(state: Pick<AIBrowserState, 'views' | 'pages'>, viewId: string): boolean {
  const owner = state.pages[viewId]?.conversationId
  return Object.entries(state.views).some(([id, view]) => id !== owner && view.viewId === viewId)
}

/** The conversation holding page `viewId` (identity by view, never by URL). */
export function selectViewOwner(state: AIBrowserState, viewId: string | undefined): string | null {
  if (!viewId) return null
  if (state.pages[viewId]) return state.pages[viewId].conversationId
  for (const [conversationId, view] of Object.entries(state.views)) {
    if (view.viewId === viewId) return conversationId
  }
  return null
}

// ============================================
// IPC Event Listeners
// ============================================

/**
 * Subscribe to AI Browser lifecycle events and seed the store with the pages
 * that already exist (an event only fires on change, so a reloaded renderer
 * would otherwise never learn about a page the AI opened earlier).
 *
 * @returns Cleanup function to unsubscribe from events
 */
export function initAIBrowserStoreListeners(): () => void {
  const unsubActive = api.onAIBrowserActiveViewChanged((data) => {
    useAIBrowserStore.getState().applyActiveView(data)
  })

  const unsubGone = api.onAIBrowserViewGone((data) => {
    useAIBrowserStore.getState().handleViewGone(data.viewId)
    // Its session ended (chat deleted, app uninstalled, tray stop): a tab left
    // pointing at it would show an empty page.
    void canvasLifecycle.closeTabsOfGoneView(data.viewId)
  })

  const unsubReleased = api.onAIBrowserConversationReleased((data) => {
    useAIBrowserStore.getState().handleConversationReleased(data.conversationId)
  })

  let disposed = false
  api.listAIBrowserLivePages()
    .then((pages) => {
      if (!disposed) useAIBrowserStore.getState().applySnapshot(pages)
    })
    .catch((error) => console.warn('[AI Browser Store] Failed to load live pages:', error))

  return () => {
    disposed = true
    unsubActive()
    unsubGone()
    unsubReleased()
  }
}
