/**
 * A conversation's browser page must be announced to the renderer under that
 * conversation's id — that is what lets a digital-human chat offer a live view
 * of its own page and no other chat's.
 *
 * Rules under test: conversation-bound contexts (space chat, digital-human chat)
 * announce; an automation run (scoped, no conversation) stays silent; a page
 * destroyed by ANY path — including its context ending — is announced gone
 * exactly once; a late client can ask for the current pages.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const states = new Map<string, { id: string; url: string; title: string }>()
const destroyedListeners = new Set<(viewId: string) => void>()

vi.mock('../../../../src/main/services/browser-view.service', () => ({
  browserViewManager: {
    getAllStates: () => [...states.values()],
    getState: (id: string) => states.get(id) ?? null,
    getWebContents: () => null,
    isRevealed: (id: string) => revealed.has(id),
    destroy: (id: string) => {
      if (!states.delete(id)) return
      for (const listener of destroyedListeners) listener(id)
    },
    onViewDestroyed: (listener: (viewId: string) => void) => {
      destroyedListeners.add(listener)
      return () => destroyedListeners.delete(listener)
    },
  },
}))
const revealed = new Set<string>()

vi.mock('../../../../src/main/services/ai-browser/download-handler', () => ({
  registerWebContentsForDownload: () => {},
  unregisterWebContentsForDownload: () => {},
}))

const active: Array<Record<string, unknown>> = []
const gone: string[] = []
const released: string[] = []
vi.mock('../../../../src/main/services/ai-browser/events', () => ({
  emitBrowserActiveView: (e: Record<string, unknown>) => { active.push(e) },
  emitBrowserViewGone: ({ viewId }: { viewId: string }) => { gone.push(viewId) },
  emitBrowserConversationReleased: ({ conversationId }: { conversationId: string }) => { released.push(conversationId) },
}))

vi.mock('../../../../src/main/services/ai-browser/snapshot', () => ({
  createAccessibilitySnapshot: vi.fn(),
  getElementBoundingBox: vi.fn(),
  scrollIntoView: vi.fn(),
  focusElement: vi.fn(),
}))

const {
  createScopedBrowserContext,
  getInteractiveBrowserContext,
  releaseInteractiveBrowserContext,
  listLivePages,
  stopLivePage,
} = await import('../../../../src/main/services/ai-browser/context')

function openTab(id: string): void {
  states.set(id, { id, url: `https://example.com/${id}`, title: `Title ${id}` })
}

describe('conversation-tagged active-view events', () => {
  beforeEach(() => {
    states.clear()
    revealed.clear()
    active.length = 0
    gone.length = 0
    releaseInteractiveBrowserContext('space-chat')
  })

  it('tags a digital-human chat page with its conversation id', () => {
    const ctx = createScopedBrowserContext({ conversationId: 'app-chat:dh1', spaceId: 'space-1' })
    openTab('view-1')
    ctx.trackView('view-1')
    ctx.setActiveViewId('view-1')

    expect(active).toEqual([
      { conversationId: 'app-chat:dh1', spaceId: 'space-1', viewId: 'view-1', owned: true, url: 'https://example.com/view-1', title: 'Title view-1' },
    ])
    ctx.destroy()
  })

  it('tags a space chat page with its conversation id', () => {
    const ctx = getInteractiveBrowserContext('space-chat', 'space-2')
    openTab('view-2')
    ctx.setActiveViewId('view-2')

    expect(active[0]).toMatchObject({ conversationId: 'space-chat', spaceId: 'space-2', viewId: 'view-2' })
  })

  it('marks a page the conversation only selected (the user’s own tab) as not its own', () => {
    const ctx = getInteractiveBrowserContext('space-chat', 'space-2')
    openTab('user-tab')
    openTab('ai-tab')
    ctx.setActiveViewId('user-tab')
    ctx.trackView('ai-tab')
    ctx.setActiveViewId('ai-tab')

    // Only a page it opened may be listed and stopped as this conversation's.
    expect(active.map((e) => [e.viewId, e.owned])).toEqual([['user-tab', false], ['ai-tab', true]])
    ctx.setActiveViewId('user-tab')
    expect(listLivePages().filter((p) => p.conversationId === 'space-chat').map((p) => [p.viewId, p.owned, p.active]).sort())
      .toEqual([['ai-tab', true, false], ['user-tab', false, true]])
  })

  it('stays silent for an automation run, which nobody can watch', () => {
    const ctx = createScopedBrowserContext()
    openTab('auto-1')
    ctx.trackView('auto-1')
    ctx.setActiveViewId('auto-1')

    expect(active).toEqual([])
    expect(ctx.hasUi).toBe(false)
    ctx.destroy()
  })

  it('does not let one chat’s page be attributed to another', () => {
    const a = createScopedBrowserContext({ conversationId: 'app-chat:a' })
    const b = createScopedBrowserContext({ conversationId: 'app-chat:b' })
    openTab('a-1')
    openTab('b-1')
    a.trackView('a-1')
    b.trackView('b-1')
    a.setActiveViewId('a-1')
    b.setActiveViewId('b-1')

    expect(active.map((e) => [e.conversationId, e.viewId])).toEqual([
      ['app-chat:a', 'a-1'],
      ['app-chat:b', 'b-1'],
    ])
    a.destroy()
    b.destroy()
  })
})

describe('a chat page going away', () => {
  beforeEach(() => {
    states.clear()
    revealed.clear()
    active.length = 0
    gone.length = 0
  })

  it('is announced when its context is destroyed (session deleted, app uninstalled)', () => {
    const ctx = createScopedBrowserContext({ conversationId: 'app-chat:dh1' })
    openTab('view-1')
    ctx.trackView('view-1')
    ctx.setActiveViewId('view-1')

    ctx.destroy()

    // Without this the renderer keeps an enabled "view live" button for a page
    // that no longer exists.
    expect(gone).toEqual(['view-1'])
    expect(states.has('view-1')).toBe(false)
  })

  it('is announced when the page is closed by any other path, and only once', () => {
    const ctx = createScopedBrowserContext({ conversationId: 'app-chat:dh1' })
    openTab('view-1')
    ctx.trackView('view-1')
    ctx.setActiveViewId('view-1')

    // The manager's destroy hook is the single funnel: an agent closing a tab,
    // the canvas closing a tab and window teardown all end up here.
    for (const listener of destroyedListeners) listener('view-1')
    for (const listener of destroyedListeners) listener('view-1')

    expect(gone).toEqual(['view-1'])
    expect(ctx.getActiveViewId()).toBeNull()
    ctx.destroy()
  })

  it('is announced for a page the chat opened earlier and moved away from', () => {
    const ctx = createScopedBrowserContext({ conversationId: 'app-chat:dh1' })
    openTab('page-a')
    openTab('page-b')
    ctx.trackView('page-a')
    ctx.setActiveViewId('page-a')
    ctx.trackView('page-b')
    ctx.setActiveViewId('page-b')

    // The user may have page A open in a canvas tab; left unannounced, that tab
    // shows a dead page once A is closed.
    for (const listener of destroyedListeners) listener('page-a')

    expect(gone).toEqual(['page-a'])
    expect(ctx.getActiveViewId()).toBe('page-b')
    ctx.destroy()
  })

  it('announces every page when a chat with several ends, each once', () => {
    const ctx = createScopedBrowserContext({ conversationId: 'app-chat:dh1' })
    openTab('page-a')
    openTab('page-b')
    ctx.trackView('page-a')
    ctx.trackView('page-b')
    ctx.setActiveViewId('page-b')

    ctx.destroy()

    expect([...gone].sort()).toEqual(['page-a', 'page-b'])
  })

  it('says nothing for a page no context with a UI held', () => {
    const ctx = createScopedBrowserContext({ conversationId: 'app-chat:dh1' })
    openTab('page-a')
    openTab('someone-else')
    ctx.trackView('page-a')

    for (const listener of destroyedListeners) listener('someone-else')

    expect(gone).toEqual([])
    ctx.destroy()
  })

  it('says nothing for an automation run’s page', () => {
    const ctx = createScopedBrowserContext()
    openTab('auto-1')
    ctx.trackView('auto-1')
    ctx.setActiveViewId('auto-1')

    ctx.destroy()

    expect(gone).toEqual([])
  })
})

describe('live-page snapshot for a late client', () => {
  beforeEach(() => {
    states.clear()
    revealed.clear()
    active.length = 0
  })

  it('lists every page a conversation holds, marks the active one, and skips silent contexts', () => {
    const dh = createScopedBrowserContext({ conversationId: 'app-chat:dh1', spaceId: 'space-1' })
    const auto = createScopedBrowserContext()
    openTab('dh-view')
    openTab('auto-view')
    openTab('dh-older')
    dh.trackView('dh-older')
    dh.trackView('dh-view')
    auto.trackView('auto-view')
    dh.setActiveViewId('dh-view')
    auto.setActiveViewId('auto-view')

    expect(listLivePages()).toEqual([
      { conversationId: 'app-chat:dh1', spaceId: 'space-1', viewId: 'dh-older', owned: true, url: 'https://example.com/dh-older', title: 'Title dh-older', active: false },
      { conversationId: 'app-chat:dh1', spaceId: 'space-1', viewId: 'dh-view', owned: true, url: 'https://example.com/dh-view', title: 'Title dh-view', active: true },
    ])
    dh.destroy()
    auto.destroy()
  })

  it('omits a context whose page is already gone', () => {
    const dh = createScopedBrowserContext({ conversationId: 'app-chat:dh1' })
    openTab('dh-view')
    dh.trackView('dh-view')
    dh.setActiveViewId('dh-view')
    states.delete('dh-view')

    expect(listLivePages()).toEqual([])
    dh.destroy()
  })
})

describe('being watched', () => {
  it('reports whether the user has one of the context’s tabs on screen', () => {
    states.clear()
    const dh = createScopedBrowserContext({ conversationId: 'app-chat:dh1' })
    openTab('dh-view')
    dh.trackView('dh-view')

    expect(dh.hasRevealedView()).toBe(false)
    revealed.add('dh-view')
    expect(dh.hasRevealedView()).toBe(true)
    dh.destroy()
  })
})

describe('stopping a page from the tray (authoritative check)', () => {
  beforeEach(() => {
    states.clear()
    gone.length = 0
    releaseInteractiveBrowserContext('chat-a')
    releaseInteractiveBrowserContext('chat-b')
  })

  it('closes a page the conversation opened and nobody else is on', () => {
    const a = getInteractiveBrowserContext('chat-a', 's1')
    openTab('p')
    a.trackView('p')
    a.setActiveViewId('p')

    expect(stopLivePage('p', 'chat-a')).toEqual({ stopped: true })
    expect(states.has('p')).toBe(false)
    expect(gone).toEqual(['p'])
  })

  it('refuses when another conversation is on the page, even if the renderer has not heard yet', () => {
    const a = getInteractiveBrowserContext('chat-a', 's1')
    const b = getInteractiveBrowserContext('chat-b', 's1')
    openTab('p')
    a.trackView('p')
    b.setActiveViewId('p')

    expect(stopLivePage('p', 'chat-a')).toEqual({ stopped: false, reason: 'in-use' })
    expect(states.has('p')).toBe(true)
    expect(b.getActiveViewId()).toBe('p')
  })

  it('refuses a page the conversation only selected (the user’s own tab)', () => {
    const a = getInteractiveBrowserContext('chat-a', 's1')
    openTab('user-tab')
    a.setActiveViewId('user-tab')

    expect(stopLivePage('user-tab', 'chat-a')).toEqual({ stopped: false, reason: 'not-owned' })
    expect(states.has('user-tab')).toBe(true)
  })

  it('refuses in the name of a conversation that does not own it', () => {
    const a = getInteractiveBrowserContext('chat-a', 's1')
    openTab('p')
    a.trackView('p')

    expect(stopLivePage('p', 'chat-b')).toEqual({ stopped: false, reason: 'not-owned' })
    expect(states.has('p')).toBe(true)
  })
})

describe('a conversation’s context ending', () => {
  beforeEach(() => {
    states.clear()
    gone.length = 0
    released.length = 0
  })

  it('is announced when a space chat releases its pages to the user', () => {
    const a = getInteractiveBrowserContext('chat-a', 's1')
    openTab('p')
    a.trackView('p')
    a.setActiveViewId('p')

    releaseInteractiveBrowserContext('chat-a')

    // The page survives as the user's, so no view-gone; without this the tray
    // kept it as chat-a's and would close the user's tab on stop.
    expect(released).toEqual(['chat-a'])
    expect(gone).toEqual([])
    expect(listLivePages().some((p) => p.conversationId === 'chat-a')).toBe(false)
  })

  it('is announced when a digital-human chat is destroyed', () => {
    const dh = createScopedBrowserContext({ conversationId: 'app-chat:dh1', spaceId: 's1' })
    dh.destroy()
    expect(released).toEqual(['app-chat:dh1'])
  })

  it('says nothing for an automation run', () => {
    createScopedBrowserContext().destroy()
    expect(released).toEqual([])
  })
})
