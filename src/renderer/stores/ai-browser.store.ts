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
import { followLiveSnapshot } from './live-snapshot'

// ============================================
// Types
// ============================================

export interface AIBrowserView {
  viewId: string
  url: string | null
  title: string | null
  /** Last time this conversation's active view changed. */
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
  /** Every live page an AI conversation opened itself, by view id (each has a canvas tab). */
  pages: Record<string, AIBrowserPage>
  /** Conversations whose AI is operating its browser, as main reports it (held after the last call). */
  operating: Record<string, boolean>
  releasedPages: ReadonlySet<string>

  applyActiveView: (event: AIBrowserActiveView) => void
  applyOwnedPage: (event: AIBrowserActiveView) => void
  /** Refresh known page metadata without selecting, revealing or reordering it. */
  applyPageMetadata: (viewId: string, metadata: Partial<Pick<AIBrowserView, 'url' | 'title'>>) => void
  applySnapshot: (pages: AIBrowserLivePage[], changed?: ReadonlySet<string>) => void
  /** An AI-driven view was destroyed; drop every entry pointing at it. */
  handleViewGone: (viewId: string) => void
  /** A conversation's browser context ended: it points at nothing and owns no page. */
  handleConversationReleased: (conversationId: string) => void
  setOperating: (conversationId: string, isOperating: boolean) => void
}

// ============================================
// Store
// ============================================

const pageChange = (id: string) => `page:${id}`
const selectionChange = (id: string) => `selection:${id}`
const activityChange = (id: string) => `activity:${id}`
const releaseChange = (id: string) => `release:${id}`
const destroyedChange = (id: string) => `destroyed:${id}`

export const useAIBrowserStore = create<AIBrowserState>()((set, get) => ({
  views: {},
  pages: {},
  operating: {},
  releasedPages: new Set(),

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

  applyOwnedPage: ({ conversationId, spaceId, viewId, owned, url, title }) => {
    if (!owned || !conversationId) return
    set(state => state.pages[viewId] ? state : {
      pages: { ...state.pages, [viewId]: { viewId, conversationId, spaceId, url, title, lastActivityAt: Date.now() } },
    })
  },

  applyPageMetadata: (viewId, metadata) => {
    set(state => {
      if (metadata.url === undefined && metadata.title === undefined) return state
      const update = <T extends Pick<AIBrowserView, 'url' | 'title'>>(current: T): T => {
        const url = metadata.url === undefined ? current.url : metadata.url
        const title = metadata.title === undefined ? current.title : metadata.title
        return current.url === url && current.title === title ? current : { ...current, url, title }
      }
      let pages = state.pages
      if (Object.hasOwn(pages, viewId)) {
        const page = update(pages[viewId])
        if (page !== pages[viewId]) pages = { ...pages, [viewId]: page }
      }
      let views = state.views
      for (const [conversationId, current] of Object.entries(state.views)) {
        if (current.viewId !== viewId) continue
        const view = update(current)
        if (view === current) continue
        if (views === state.views) views = { ...views }
        views[conversationId] = view
      }
      return pages === state.pages && views === state.views ? state : { pages, views }
    })
  },

  applySnapshot: (snapshot, changed = new Set()) => {
    const state = get()
    const views: AIBrowserState['views'] = {}
    const pages: AIBrowserState['pages'] = {}
    const operating: AIBrowserState['operating'] = {}
    const adopted: string[] = []
    const now = Date.now()
    for (const { conversationId, spaceId, viewId, owned, url, title, active, released, operating: isOperating } of snapshot) {
      if (changed.has(destroyedChange(viewId))) continue
      if (released && (state.pages[viewId] || state.releasedPages.has(viewId))) adopted.push(viewId)
      if (!conversationId || changed.has(releaseChange(conversationId))) continue
      const pageChanged = changed.has(pageChange(viewId))
      if (owned && !pageChanged) {
        pages[viewId] = { viewId, conversationId, spaceId, url, title, lastActivityAt: state.pages[viewId]?.lastActivityAt ?? now }
      }
      if (active && !changed.has(selectionChange(conversationId))) {
        const live = state.views[conversationId]
        const metadata = pageChanged && live?.viewId === viewId ? live : { viewId, url, title, lastActivityAt: now }
        views[conversationId] = metadata
      }
      if (isOperating && !changed.has(activityChange(conversationId))) operating[conversationId] = true
    }
    for (const [id, page] of Object.entries(state.pages)) {
      if (changed.has(pageChange(id))) pages[id] = page
    }
    for (const [id, view] of Object.entries(state.views)) {
      if (changed.has(selectionChange(id))) views[id] = view
    }
    for (const id of Object.keys(state.operating)) {
      if (changed.has(activityChange(id))) operating[id] = true
    }
    if (adopted.length > 0) canvasLifecycle.adoptPages(adopted)
    const releasedPages = new Set(adopted)
    for (const id of state.releasedPages ?? []) {
      if (changed.has(pageChange(id)) && !changed.has(destroyedChange(id))) releasedPages.add(id)
    }
    for (const id of [...Object.keys(state.pages), ...state.releasedPages]) {
      if (!pages[id] && !releasedPages.has(id)) void canvasLifecycle.closeTabsOfGoneView(id)
    }
    set({ views, pages, operating, releasedPages })
  },

  handleViewGone: (viewId) => {
    set(state => {
      const gone = Object.keys(state.views).filter(id => state.views[id].viewId === viewId)
      if (gone.length === 0 && !state.pages[viewId] && !state.releasedPages.has(viewId)) return state
      const views = { ...state.views }
      const pages = { ...state.pages }
      const releasedPages = new Set(state.releasedPages)
      delete pages[viewId]
      releasedPages.delete(viewId)
      for (const id of gone) delete views[id]
      return { views, pages, releasedPages }
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
      const releasedPages = new Set(state.releasedPages)
      for (const viewId of ownedPages) {
        delete pages[viewId]
        releasedPages.add(viewId)
      }
      return { views, operating, pages, releasedPages }
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
 * Whether a conversation other than the page's owner is currently on it.
 * Closing such a page would pull it from under them, so it is refused.
 */
export function isPageInUseByOthers(state: Pick<AIBrowserState, 'views' | 'pages'>, viewId: string): boolean {
  const owner = state.pages[viewId]?.conversationId
  return Object.entries(state.views).some(([id, view]) => id !== owner && view.viewId === viewId)
}

/** The active operator does not have to be the conversation that opened the page. */
export function selectPageOperator(state: Pick<AIBrowserState, 'views' | 'operating'>, viewId: string | undefined): string | undefined {
  if (!viewId) return undefined
  for (const conversationId of Object.keys(state.operating)) {
    if (state.operating[conversationId] && state.views[conversationId]?.viewId === viewId) return conversationId
  }
}

export function selectPageOperating(state: Pick<AIBrowserState, 'views' | 'operating'>, viewId: string | undefined): boolean {
  return selectPageOperator(state, viewId) !== undefined
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
  let snapshot: ReturnType<typeof followLiveSnapshot<AIBrowserLivePage[], string>> | undefined
  const unsubActive = api.onAIBrowserActiveViewChanged(data => {
    if (data.conversationId) snapshot?.changed(selectionChange(data.conversationId))
    if (data.owned) snapshot?.changed(pageChange(data.viewId))
    useAIBrowserStore.getState().applyActiveView(data)
  })
  const unsubOpened = api.onAIBrowserPageOpened(data => {
    snapshot?.changed(pageChange(data.viewId))
    useAIBrowserStore.getState().applyOwnedPage(data)
  })
  const unsubMetadata = api.onBrowserStateChange((data: unknown) => {
    const event = data as { viewId: string; state: Partial<Pick<AIBrowserView, 'url' | 'title'>> }
    if (useAIBrowserStore.getState().pages[event.viewId]) snapshot?.changed(pageChange(event.viewId))
    useAIBrowserStore.getState().applyPageMetadata(event.viewId, event.state)
  })
  const unsubGone = api.onAIBrowserViewGone(({ viewId }) => {
    snapshot?.changed(destroyedChange(viewId))
    const state = useAIBrowserStore.getState()
    for (const [id, view] of Object.entries(state.views)) {
      if (view.viewId === viewId) snapshot?.changed(selectionChange(id))
    }
    void canvasLifecycle.closeTabsOfGoneView(viewId)
    state.handleViewGone(viewId)
  })
  const unsubReleased = api.onAIBrowserConversationReleased(({ conversationId }) => {
    snapshot?.changed(releaseChange(conversationId))
    snapshot?.changed(selectionChange(conversationId))
    snapshot?.changed(activityChange(conversationId))
    const state = useAIBrowserStore.getState()
    const surviving = Object.values(state.pages).filter(page => page.conversationId === conversationId).map(page => page.viewId)
    for (const id of surviving) snapshot?.changed(pageChange(id))
    canvasLifecycle.adoptPages(surviving)
    state.handleConversationReleased(conversationId)
  })
  const unsubOperating = api.onAIBrowserOperating(({ conversationId, operating }) => {
    snapshot?.changed(activityChange(conversationId))
    useAIBrowserStore.getState().setOperating(conversationId, operating)
  })

  snapshot = followLiveSnapshot(api.listAIBrowserLivePages, useAIBrowserStore.getState().applySnapshot, 'AI Browser Store')
  return () => {
    snapshot?.dispose()
    unsubActive()
    unsubOpened()
    unsubMetadata()
    unsubGone()
    unsubReleased()
    unsubOperating()
  }
}
