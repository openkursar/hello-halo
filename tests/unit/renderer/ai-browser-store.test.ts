/**
 * The live-view store keeps one active page per conversation, so a digital
 * human's "View live feed" reveals the page of the conversation on screen and
 * never another chat's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

let activeHandler: ((e: unknown) => void) | null = null
let goneHandler: ((e: unknown) => void) | null = null
let releasedHandler: ((e: unknown) => void) | null = null
let metadataHandler: ((e: unknown) => void) | null = null
const unsub = { active: vi.fn(), gone: vi.fn(), released: vi.fn(), metadata: vi.fn() }
const listActive = vi.fn()

vi.mock('../../../src/renderer/api', () => ({
  api: {
    onAIBrowserActiveViewChanged: (cb: (e: unknown) => void) => { activeHandler = cb; return unsub.active },
    onAIBrowserViewGone: (cb: (e: unknown) => void) => { goneHandler = cb; return unsub.gone },
    onAIBrowserConversationReleased: (cb: (e: unknown) => void) => { releasedHandler = cb; return unsub.released },
    onBrowserStateChange: (cb: (e: unknown) => void) => { metadataHandler = cb; return unsub.metadata },
    listAIBrowserLivePages: (...args: unknown[]) => listActive(...args),
  },
}))
const closeTabsOfGoneView = vi.fn()
const attachBrowserView = vi.fn()
const setCanvasOpen = vi.fn()
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: {
  closeTabsOfGoneView: (...a: unknown[]) => closeTabsOfGoneView(...a),
  attachAIBrowserView: (...a: unknown[]) => attachBrowserView(...a),
  setOpen: (...a: unknown[]) => setCanvasOpen(...a),
} }))
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

describe('browser page metadata', () => {
  beforeEach(() => {
    useAIBrowserStore.setState({ views: {}, pages: {}, operating: {} })
    metadataHandler = null
    listActive.mockReset()
    listActive.mockResolvedValue([])
    for (const stop of Object.values(unsub)) stop.mockClear()
    attachBrowserView.mockClear()
    setCanvasOpen.mockClear()
  })

  it('updates both loaded page titles without selecting an inactive page or changing activity and operating state', () => {
    const dispose = initAIBrowserStoreListeners()
    activeHandler!({ ...view('owner', 'control'), title: 'New Tab' })
    activeHandler!({ ...view('owner', 'target'), title: 'New Tab' })
    useAIBrowserStore.getState().setOperating('owner', true)
    const before = useAIBrowserStore.getState()
    metadataHandler?.({ viewId: 'control', state: { title: 'Loaded control', url: 'http://127.0.0.1/control' } })
    const inactive = useAIBrowserStore.getState()
    expect(inactive.pages.control).toEqual({ ...before.pages.control, title: 'Loaded control', url: 'http://127.0.0.1/control' })
    expect(inactive.views).toBe(before.views)
    expect(inactive.pages.target).toBe(before.pages.target)
    expect(inactive.operating).toBe(before.operating)
    metadataHandler?.({ viewId: 'target', state: { title: 'Loaded target', url: 'http://127.0.0.1/target' } })
    const after = useAIBrowserStore.getState()
    expect(after.pages.target).toEqual({ ...before.pages.target, title: 'Loaded target', url: 'http://127.0.0.1/target' })
    expect(after.views.owner).toEqual({ ...before.views.owner, title: 'Loaded target', url: 'http://127.0.0.1/target' })
    expect(after.pages.control).toBe(inactive.pages.control)
    expect(attachBrowserView).not.toHaveBeenCalled()
    expect(setCanvasOpen).not.toHaveBeenCalled()
    dispose()
    expect(unsub.metadata).toHaveBeenCalledTimes(1)
  })

  it('updates every existing reference to a shared page while preserving ownership and unrelated views', () => {
    const dispose = initAIBrowserStoreListeners()
    activeHandler!(view('owner', 'shared'))
    activeHandler!(view('viewer', 'shared', 'https://x.test/shared', false))
    activeHandler!(view('other', 'unrelated'))
    const before = useAIBrowserStore.getState()
    metadataHandler?.({ viewId: 'shared', state: { title: 'Asynchronous title' } })
    const after = useAIBrowserStore.getState()
    expect(after.pages.shared).toEqual({ ...before.pages.shared, title: 'Asynchronous title' })
    expect(after.views.owner).toEqual({ ...before.views.owner, title: 'Asynchronous title' })
    expect(after.views.viewer).toEqual({ ...before.views.viewer, title: 'Asynchronous title' })
    expect(after.views.other).toBe(before.views.other)
    expect(after.pages.unrelated).toBe(before.pages.unrelated)
    expect(after.operating).toBe(before.operating)
    dispose()
  })

  it('keeps selected user pages unowned while updating their existing references', () => {
    const dispose = initAIBrowserStoreListeners()
    activeHandler!(view('viewer', 'user-page', 'https://x.test/user-page', false))
    const before = useAIBrowserStore.getState()
    metadataHandler?.({ viewId: 'user-page', state: { title: 'Selected page title' } })
    const after = useAIBrowserStore.getState()
    expect(after.pages).toBe(before.pages)
    expect(after.views.viewer).toEqual({ ...before.views.viewer, title: 'Selected page title' })
    dispose()
  })

  it('preserves the state object for unchanged metadata, unrelated state fields and unknown or released pages', () => {
    const dispose = initAIBrowserStoreListeners()
    activeHandler!(view('owner', 'target'))
    const before = useAIBrowserStore.getState()
    for (const event of [
      { viewId: 'target', state: { title: 'target', url: 'https://x.test/target' } },
      { viewId: 'target', state: { isLoading: true, favicon: 'data:image/png;base64,fixture' } },
      ...['unknown', '__proto__', 'constructor', 'toString'].map(viewId => ({ viewId, state: { title: 'Never owned', url: 'https://x.test/unowned' } })),
    ]) {
      metadataHandler?.(event)
      expect(useAIBrowserStore.getState()).toBe(before)
    }
    goneHandler!({ viewId: 'target' })
    const gone = useAIBrowserStore.getState()
    metadataHandler?.({ viewId: 'target', state: { title: 'Late title' } })
    expect(useAIBrowserStore.getState()).toBe(gone)
    activeHandler!(view('owner', 'replacement'))
    releasedHandler!({ conversationId: 'owner' })
    const released = useAIBrowserStore.getState()
    metadataHandler?.({ viewId: 'replacement', state: { title: 'Late released title' } })
    expect(useAIBrowserStore.getState()).toBe(released)
    dispose()
  })

  it('allows an empty title without clearing an omitted URL or changing activity time', () => {
    const dispose = initAIBrowserStoreListeners()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      activeHandler!(view('owner', 'target'))
      now.mockReturnValue(2000)
      const before = useAIBrowserStore.getState()
      metadataHandler?.({ viewId: 'target', state: { title: '' } })
      const after = useAIBrowserStore.getState()
      expect(after.pages.target).toEqual({ ...before.pages.target, title: '' })
      expect(after.views.owner).toEqual({ ...before.views.owner, title: '' })
      expect(after.pages.target.lastActivityAt).toBe(1000)
      expect(after.views.owner.lastActivityAt).toBe(1000)
    } finally { now.mockRestore(); dispose() }
  })

  it('subscribes before taking the initial snapshot and retains newer metadata when that snapshot resolves', async () => {
    let resolveList!: (value: unknown[]) => void
    listActive.mockImplementation(() => {
      expect(metadataHandler).toBeTypeOf('function')
      return new Promise(resolve => { resolveList = resolve })
    })
    const dispose = initAIBrowserStoreListeners()
    activeHandler!(view('owner', 'target'))
    metadataHandler?.({ viewId: 'target', state: { title: 'Newest title' } })
    resolveList([{ ...page('owner', 'target', true), title: 'Old snapshot title' }])
    await flush()
    expect(useAIBrowserStore.getState().pages.target.title).toBe('Newest title')
    expect(useAIBrowserStore.getState().views.owner.title).toBe('Newest title')
    dispose()
  })
})
