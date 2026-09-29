/**
 * The live-view store keeps one active page per conversation, so a digital
 * human's "View live feed" reveals the page of the conversation on screen and
 * never another chat's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

let activeHandler: ((e: unknown) => void) | null = null
let goneHandler: ((e: unknown) => void) | null = null
let releasedHandler: ((e: unknown) => void) | null = null
const unsub = { active: vi.fn(), gone: vi.fn(), released: vi.fn() }
const listActive = vi.fn()

vi.mock('../../../src/renderer/api', () => ({
  api: {
    onAIBrowserActiveViewChanged: (cb: (e: unknown) => void) => { activeHandler = cb; return unsub.active },
    onAIBrowserViewGone: (cb: (e: unknown) => void) => { goneHandler = cb; return unsub.gone },
    onAIBrowserConversationReleased: (cb: (e: unknown) => void) => { releasedHandler = cb; return unsub.released },
    listAIBrowserLivePages: (...args: unknown[]) => listActive(...args),
  },
}))
const closeTabsOfGoneView = vi.fn()
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: { closeTabsOfGoneView: (...a: unknown[]) => closeTabsOfGoneView(...a) } }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: vi.fn() }))
vi.mock('../../../src/renderer/stores/chat/active', () => ({ selectActiveConversationId: vi.fn() }))

const { useAIBrowserStore, selectViewOwner, isPageInUseByOthers, initAIBrowserStoreListeners } =
  await import('../../../src/renderer/stores/ai-browser.store')

const flush = () => new Promise((r) => setTimeout(r, 0))
const view = (conversationId: string | null, viewId: string, url = `https://x.test/${viewId}`, owned = true) =>
  ({ conversationId, spaceId: 'space-1', viewId, owned, url, title: viewId })
const page = (conversationId: string, viewId: string, active: boolean) => ({ ...view(conversationId, viewId), active })

describe('ai browser store', () => {
  beforeEach(() => {
    useAIBrowserStore.setState({ views: {}, pages: {}, operating: {} })
    listActive.mockReset()
    listActive.mockResolvedValue([])
  })

  it('keeps each conversation’s page separate', () => {
    const { applyActiveView } = useAIBrowserStore.getState()
    applyActiveView(view('app-chat:dh1', 'v1'))
    applyActiveView(view('conv-2', 'v2'))

    const { views } = useAIBrowserStore.getState()
    expect(views['app-chat:dh1'].viewId).toBe('v1')
    expect(views['conv-2'].viewId).toBe('v2')
  })

  it('replaces a conversation’s page when it selects another', () => {
    const { applyActiveView } = useAIBrowserStore.getState()
    applyActiveView(view('app-chat:dh1', 'v1'))
    applyActiveView(view('app-chat:dh1', 'v3'))

    expect(useAIBrowserStore.getState().views['app-chat:dh1'].viewId).toBe('v3')
  })

  it('ignores the user’s own browser, which has no conversation', () => {
    useAIBrowserStore.getState().applyActiveView(view(null, 'user-view'))
    expect(useAIBrowserStore.getState().views).toEqual({})
    expect(useAIBrowserStore.getState().pages).toEqual({})
  })

  it('keeps every page a conversation opened, not just the one it is on', () => {
    const { applyActiveView } = useAIBrowserStore.getState()
    applyActiveView(view('app-chat:dh1', 'page-a'))
    applyActiveView(view('app-chat:dh1', 'page-b'))

    const s = useAIBrowserStore.getState()
    expect(Object.keys(s.pages).sort()).toEqual(['page-a', 'page-b'])
    expect(s.pages['page-a']).toMatchObject({ conversationId: 'app-chat:dh1', spaceId: 'space-1' })
    expect(s.views['app-chat:dh1'].viewId).toBe('page-b')
  })

  it('never records a page the conversation only selected as its own', () => {
    const { applyActiveView } = useAIBrowserStore.getState()
    applyActiveView(view('conv-1', 'user-tab', 'https://user.test', false))

    const s = useAIBrowserStore.getState()
    // Still what "view live" shows for that conversation, but not a tray page it could stop.
    expect(s.views['conv-1'].viewId).toBe('user-tab')
    expect(s.pages).toEqual({})
    expect(selectViewOwner(s, 'user-tab')).toBe('conv-1')
  })

  it('keeps a shared page under the conversation that opened it', () => {
    const { applyActiveView } = useAIBrowserStore.getState()
    applyActiveView(view('conv-a', 'p'))
    applyActiveView(view('conv-b', 'p', 'https://x.test/p', false))

    const s = useAIBrowserStore.getState()
    expect(s.pages['p'].conversationId).toBe('conv-a')
    expect(isPageInUseByOthers(s, 'p')).toBe(true)
  })

  it('drops a page the conversation moved away from without touching its active view', () => {
    const { applyActiveView, handleViewGone } = useAIBrowserStore.getState()
    applyActiveView(view('app-chat:dh1', 'page-a'))
    applyActiveView(view('app-chat:dh1', 'page-b'))

    handleViewGone('page-a')

    const s = useAIBrowserStore.getState()
    expect(Object.keys(s.pages)).toEqual(['page-b'])
    expect(s.views['app-chat:dh1'].viewId).toBe('page-b')
  })

  it('drops every entry pointing at a destroyed view, and its operating flag', () => {
    const { applyActiveView, setOperating, handleViewGone } = useAIBrowserStore.getState()
    applyActiveView(view('app-chat:dh1', 'shared'))
    applyActiveView(view('conv-2', 'shared'))
    applyActiveView(view('conv-3', 'other'))
    setOperating('app-chat:dh1', true)

    handleViewGone('shared')

    const s = useAIBrowserStore.getState()
    expect(Object.keys(s.views)).toEqual(['conv-3'])
    expect(s.operating).toEqual({})
  })

  it('leaves state untouched for an unknown view', () => {
    useAIBrowserStore.getState().applyActiveView(view('conv-1', 'v1'))
    const before = useAIBrowserStore.getState()
    before.handleViewGone('nope')
    expect(useAIBrowserStore.getState().views).toBe(before.views)
  })

  it('forgets a released conversation’s pages, so the user’s surviving tab is not listed as its own', () => {
    const { applyActiveView, handleConversationReleased } = useAIBrowserStore.getState()
    applyActiveView(view('conv-a', 'p'))
    applyActiveView(view('conv-b', 'p', 'https://x.test/p', false))

    handleConversationReleased('conv-a')
    // conv-b leaves P: nothing may resurrect a row for conv-a.
    applyActiveView(view('conv-b', 'q'))

    const s = useAIBrowserStore.getState()
    expect(s.pages['p']).toBeUndefined()
    expect(s.views['conv-a']).toBeUndefined()
  })

  it('stops hiding a page once the conversation that was on it is released', () => {
    const { applyActiveView, handleConversationReleased } = useAIBrowserStore.getState()
    applyActiveView(view('conv-a', 'p'))
    applyActiveView(view('conv-b', 'p', 'https://x.test/p', false))
    expect(isPageInUseByOthers(useAIBrowserStore.getState(), 'p')).toBe(true)

    handleConversationReleased('conv-b')

    expect(isPageInUseByOthers(useAIBrowserStore.getState(), 'p')).toBe(false)
    expect(useAIBrowserStore.getState().pages['p'].conversationId).toBe('conv-a')
  })

  it('ends up where a fresh snapshot after the release would put it', () => {
    const live = useAIBrowserStore.getState()
    live.applyActiveView(view('conv-a', 'p'))
    live.applyActiveView(view('conv-b', 'q'))
    live.handleConversationReleased('conv-a')
    const afterRelease = useAIBrowserStore.getState()

    // What main would report after the release: only conv-b's page.
    useAIBrowserStore.setState({ views: {}, pages: {}, operating: {} })
    useAIBrowserStore.getState().applySnapshot([page('conv-b', 'q', true)])
    const fresh = useAIBrowserStore.getState()

    expect(Object.keys(afterRelease.pages)).toEqual(Object.keys(fresh.pages))
    expect(Object.keys(afterRelease.views)).toEqual(Object.keys(fresh.views))
  })

  it('tracks operating per conversation', () => {
    const { setOperating } = useAIBrowserStore.getState()
    setOperating('a', true)
    setOperating('b', true)
    setOperating('a', false)
    expect(useAIBrowserStore.getState().operating).toEqual({ b: true })
  })

  it('finds which conversation owns a view by identity', () => {
    useAIBrowserStore.getState().applyActiveView(view('app-chat:dh1', 'v1'))
    const state = useAIBrowserStore.getState()
    expect(selectViewOwner(state, 'v1')).toBe('app-chat:dh1')
    useAIBrowserStore.getState().applyActiveView(view('app-chat:dh1', 'v2'))
    // Still that conversation's page after it moved on: the canvas tab keeps its live badge.
    expect(selectViewOwner(useAIBrowserStore.getState(), 'v1')).toBe('app-chat:dh1')
    expect(selectViewOwner(state, 'other')).toBeNull()
    expect(selectViewOwner(state, undefined)).toBeNull()
  })
})

describe('store listeners', () => {
  beforeEach(() => {
    useAIBrowserStore.setState({ views: {}, pages: {}, operating: {} })
    listActive.mockReset()
  })

  it('applies live events and drops gone views', () => {
    listActive.mockResolvedValue([])
    const dispose = initAIBrowserStoreListeners()

    activeHandler!(view('app-chat:dh1', 'v1'))
    expect(useAIBrowserStore.getState().views['app-chat:dh1'].viewId).toBe('v1')
    goneHandler!({ viewId: 'v1' })
    expect(useAIBrowserStore.getState().views).toEqual({})
    expect(closeTabsOfGoneView).toHaveBeenCalledWith('v1')

    activeHandler!(view('app-chat:dh1', 'v2'))
    releasedHandler!({ conversationId: 'app-chat:dh1' })
    expect(useAIBrowserStore.getState().views).toEqual({})

    dispose()
    expect(unsub.released).toHaveBeenCalled()
    expect(unsub.active).toHaveBeenCalled()
    expect(unsub.gone).toHaveBeenCalled()
  })

  it('learns pages opened before the renderer started, without overriding a newer live event', async () => {
    let resolveList!: (v: unknown[]) => void
    listActive.mockReturnValue(new Promise((r) => { resolveList = r }))
    initAIBrowserStoreListeners()

    activeHandler!(view('conv-live', 'live-new'))
    resolveList([
      page('conv-live', 'live-old', true),
      page('app-chat:dh1', 'older', false),
      page('app-chat:dh1', 'earlier', true),
      { ...page('conv-user', 'user-tab', true), owned: false },
    ])
    await flush()

    const { views, pages } = useAIBrowserStore.getState()
    expect(views['conv-live'].viewId).toBe('live-new')
    expect(views['app-chat:dh1'].viewId).toBe('earlier')
    expect(Object.keys(pages).sort()).toEqual(['earlier', 'live-new', 'live-old', 'older'])
    expect(views['conv-user'].viewId).toBe('user-tab')
  })

  it('survives a failed snapshot request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    listActive.mockRejectedValue(new Error('ipc down'))
    initAIBrowserStoreListeners()
    await flush()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
