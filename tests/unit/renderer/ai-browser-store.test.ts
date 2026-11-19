/**
 * The live-view store keeps one active page per conversation, so a digital
 * human's "View live feed" reveals the page of the conversation on screen and
 * never another chat's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let activeHandler: ((e: unknown) => void) | null = null
let openedHandler: ((e: unknown) => void) | null = null
let reconnect: ((current: () => boolean) => void) | null = null
const mode = vi.hoisted(() => ({ electron: true }))
vi.mock('../../../src/renderer/api/transport', () => ({
  isElectron: () => mode.electron,
  onWsAuthenticated: (callback: typeof reconnect) => { reconnect = callback; return () => { reconnect = null } },
}))
let goneHandler: ((e: unknown) => void) | null = null
let releasedHandler: ((e: unknown) => void) | null = null
let metadataHandler: ((e: unknown) => void) | null = null
let operatingHandler: ((e: unknown) => void) | null = null
let credentialHandler: ((e: unknown) => void) | null = null
let credentialResolvedHandler: ((e: unknown) => void) | null = null
let wsStateHandler: ((state: string) => void) | null = null
const unsub = {
  active: vi.fn(), opened: vi.fn(), gone: vi.fn(), released: vi.fn(), metadata: vi.fn(), operating: vi.fn(),
  credential: vi.fn(), credentialResolved: vi.fn(), ws: vi.fn(),
}
const listActive = vi.fn()
const listCredentials = vi.fn()
let remote = false
let browserLive = false

vi.mock('../../../src/renderer/api', () => ({
  api: {
    onAIBrowserActiveViewChanged: (cb: (e: unknown) => void) => { activeHandler = cb; return unsub.active },
    onAIBrowserPageOpened: (cb: (e: unknown) => void) => { openedHandler = cb; return unsub.opened },
    onAIBrowserViewGone: (cb: (e: unknown) => void) => { goneHandler = cb; return unsub.gone },
    onAIBrowserConversationReleased: (cb: (e: unknown) => void) => { releasedHandler = cb; return unsub.released },
    onAIBrowserOperating: (cb: (e: unknown) => void) => { operatingHandler = cb; return unsub.operating },
    onBrowserStateChange: (cb: (e: unknown) => void) => { metadataHandler = cb; return unsub.metadata },
    onAIBrowserCredentialRequest: (cb: (e: unknown) => void) => { credentialHandler = cb; return unsub.credential },
    onAIBrowserCredentialResolved: (cb: (e: unknown) => void) => { credentialResolvedHandler = cb; return unsub.credentialResolved },
    isRemoteMode: () => remote,
    supportsBrowserLive: () => browserLive,
    supportsBrowserCredentials: () => browserLive,
    listAIBrowserLivePages: (...args: unknown[]) => listActive(...args),
    listAIBrowserCredentialRequests: (...args: unknown[]) => listCredentials(...args),
    onWsStateChange: (cb: (state: string) => void) => { wsStateHandler = cb; return unsub.ws },
  },
}))
const closeTabsOfGoneView = vi.fn()
const attachBrowserView = vi.fn()
const setCanvasOpen = vi.fn()
const adoptPages = vi.fn()
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: {
  closeTabsOfGoneView: (...a: unknown[]) => closeTabsOfGoneView(...a),
  adoptPages: (...a: unknown[]) => adoptPages(...a),
  attachAIBrowserView: (...a: unknown[]) => attachBrowserView(...a),
  setOpen: (...a: unknown[]) => setCanvasOpen(...a),
} }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: vi.fn() }))
vi.mock('../../../src/renderer/stores/chat/active', () => ({ selectActiveConversationId: vi.fn() }))

const { useAIBrowserStore, selectViewOwner, selectPageOperating, isPageInUseByOthers, initAIBrowserStoreListeners } =
  await import('../../../src/renderer/stores/ai-browser.store')

const flush = () => new Promise((r) => setTimeout(r, 0))
const view = (conversationId: string | null, viewId: string, url = `https://x.test/${viewId}`, owned = true) =>
  ({ conversationId, spaceId: 'space-1', viewId, owned, url, title: viewId })
const page = (conversationId: string, viewId: string, active: boolean) => ({ ...view(conversationId, viewId), active })
const credentialRequest = (requestId: string) => ({
  requestId,
  conversationId: 'conv-1',
  spaceId: 'space-1',
  viewId: 'v1',
  origin: 'https://login.test',
  title: 'Sign in',
  fields: [{ uid: 'snap_1_2', label: 'Verification code' }],
  purpose: 'the page is asking for the code from your authenticator',
  expiresAt: Date.now() + 60_000,
})

describe('ai browser store', () => {
  beforeEach(() => {
    useAIBrowserStore.setState({ views: {}, pages: {}, operating: {}, credentialRequests: {} })
    listActive.mockReset()
    listActive.mockResolvedValue([])
    listCredentials.mockReset()
    listCredentials.mockResolvedValue([])
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

  it('updates a re-announced page’s title without resetting when it was picked', () => {
    vi.useFakeTimers()
    try {
      const { applyActiveView } = useAIBrowserStore.getState()
      vi.setSystemTime(1_000)
      applyActiveView({ ...view('conv-1', 'v1'), title: 'New Tab' })
      vi.setSystemTime(60_000)
      applyActiveView({ ...view('conv-1', 'v1'), title: 'Example Domain' })

      const s = useAIBrowserStore.getState()
      expect(s.views['conv-1']).toMatchObject({ title: 'Example Domain', lastActivityAt: 1_000 })
      expect(s.pages['v1']).toMatchObject({ title: 'Example Domain', lastActivityAt: 1_000 })

      applyActiveView(view('conv-1', 'v2'))
      expect(useAIBrowserStore.getState().views['conv-1'].lastActivityAt).toBe(60_000)
    } finally {
      vi.useRealTimers()
    }
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

  it('drops every entry pointing at a destroyed view, which then no longer reads as operated', () => {
    const { applyActiveView, setOperating, handleViewGone } = useAIBrowserStore.getState()
    applyActiveView(view('app-chat:dh1', 'shared'))
    applyActiveView(view('conv-2', 'shared', 'https://x.test/shared', false))
    applyActiveView(view('conv-3', 'other'))
    setOperating('app-chat:dh1', true)
    expect(selectPageOperating(useAIBrowserStore.getState(), 'shared')).toBe(true)

    handleViewGone('shared')

    const s = useAIBrowserStore.getState()
    expect(Object.keys(s.views)).toEqual(['conv-3'])
    expect(selectPageOperating(s, 'shared')).toBe(false)
    // Whether the conversation is operating is main's to end, not a page's going away.
    expect(s.operating).toEqual({ 'app-chat:dh1': true })
  })

  it('reads the page worked on, even if the operator did not open it', () => {
    const { applyActiveView, setOperating } = useAIBrowserStore.getState()
    applyActiveView(view('owner', 'shared'))
    applyActiveView(view('other', 'shared', undefined, false))
    setOperating('other', true)
    const state = useAIBrowserStore.getState()
    expect(state.pages.shared.conversationId).toBe('owner')
    expect(selectPageOperating(state, 'shared')).toBe(true)
    expect(isPageInUseByOthers(state, 'shared')).toBe(true)
  })

  it('reads a page as operated only while an AI acts on that very page', () => {
    const { applyActiveView, setOperating } = useAIBrowserStore.getState()
    applyActiveView(view('conv-1', 'page-a'))
    applyActiveView(view('conv-1', 'page-b'))
    setOperating('conv-1', true)

    const s = useAIBrowserStore.getState()
    expect(selectPageOperating(s, 'page-b')).toBe(true)
    expect(selectPageOperating(s, 'page-a')).toBe(false)
    expect(selectPageOperating(s, undefined)).toBe(false)
    expect(selectPageOperating(s, 'unknown')).toBe(false)

    setOperating('conv-1', false)
    expect(selectPageOperating(useAIBrowserStore.getState(), 'page-b')).toBe(false)
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
  afterEach(() => { remote = false; browserLive = false })

  beforeEach(() => {
    useAIBrowserStore.setState({ views: {}, pages: {}, operating: {}, releasedPages: new Set(), remoteLive: false, credentialRequests: {} })
    listActive.mockReset()
    listCredentials.mockReset()
    listCredentials.mockResolvedValue([])
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
    // Its page outlives it as the user's own: the tab takes the page over.
    expect(adoptPages).toHaveBeenCalledWith(['v2'])

    dispose()
    expect(unsub.released).toHaveBeenCalled()
    expect(unsub.active).toHaveBeenCalled()
    expect(unsub.gone).toHaveBeenCalled()
    expect(unsub.operating).toHaveBeenCalled()
    expect(listCredentials).not.toHaveBeenCalled()
  })

  it('follows main on whether a conversation\'s AI is operating its browser', () => {
    listActive.mockResolvedValue([])
    initAIBrowserStoreListeners()
    operatingHandler!({ conversationId: 'conv-1', operating: true })
    expect(useAIBrowserStore.getState().operating).toEqual({ 'conv-1': true })
    operatingHandler!({ conversationId: 'conv-1', operating: false })
    expect(useAIBrowserStore.getState().operating).toEqual({})
  })

  it('learns who is operating from the snapshot a late renderer asks for', async () => {
    listActive.mockResolvedValue([{ ...page('conv-1', 'p1', true), operating: true }, page('conv-2', 'p2', true)])
    initAIBrowserStoreListeners()
    await flush()
    expect(useAIBrowserStore.getState().operating).toEqual({ 'conv-1': true })
  })

  it('keeps AI pages for every remote client, follows whether its server streams them, and catches up after a drop', async () => {
    remote = true
    mode.electron = false
    listActive.mockResolvedValue([])
    const dispose = initAIBrowserStoreListeners()
    try {
      expect(listActive).not.toHaveBeenCalled()
      // A desktop's remote client lists the AI's pages as tabs it cannot display.
      wsStateHandler!('connected')
      reconnect!(() => true)
      await flush()
      activeHandler!(view('conv-1', 'desktop-page'))
      expect(useAIBrowserStore.getState().remoteLive).toBe(false)
      expect(Object.keys(useAIBrowserStore.getState().pages)).toEqual(['desktop-page'])
      expect(listCredentials).not.toHaveBeenCalled()

      listActive.mockResolvedValue([page('app-chat:dh1', 'v1', true)])
      browserLive = true
      wsStateHandler!('connected')
      reconnect!(() => true)
      await flush()
      expect(useAIBrowserStore.getState().remoteLive).toBe(true)
      expect(useAIBrowserStore.getState().views['app-chat:dh1'].viewId).toBe('v1')
      expect(Object.keys(useAIBrowserStore.getState().pages)).toEqual(['v1'])
      expect(listCredentials).toHaveBeenCalledTimes(1)

      browserLive = false
      wsStateHandler!('disconnected')
      expect(useAIBrowserStore.getState().remoteLive).toBe(false)
      // The tabs outlive a dropped connection; the next authentication reconciles them.
      expect(Object.keys(useAIBrowserStore.getState().pages)).toEqual(['v1'])
    } finally {
      dispose()
      mode.electron = true
    }
  })

  it('holds a page’s request for a code until it is answered somewhere', async () => {
    remote = browserLive = true
    listActive.mockResolvedValue([])
    // Already waiting when this client connected: the prompt must still appear.
    listCredentials.mockResolvedValue([credentialRequest('req-old')])
    const dispose = initAIBrowserStoreListeners()
    await flush()

    credentialHandler!(credentialRequest('req-new'))
    expect(Object.keys(useAIBrowserStore.getState().credentialRequests).sort()).toEqual(['req-new', 'req-old'])

    // Answered on another client, or expired: this one stops asking.
    credentialResolvedHandler!({ requestId: 'req-old', outcome: 'provided' })
    expect(Object.keys(useAIBrowserStore.getState().credentialRequests)).toEqual(['req-new'])
    dispose()
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

  it('adds an owned child without changing the active page', () => {
    listActive.mockResolvedValue([])
    const dispose = initAIBrowserStoreListeners()
    activeHandler!(view('owner', 'parent'))
    openedHandler!({ ...view('owner', 'child'), openerViewId: 'parent' })
    expect(useAIBrowserStore.getState().views.owner.viewId).toBe('parent')
    expect(Object.keys(useAIBrowserStore.getState().pages)).toEqual(['parent', 'child'])
    dispose()
  })

  it('reconciles removals and missed new pages after authentication without resurrecting a page destroyed during the read', async () => {
    mode.electron = false
    listActive.mockResolvedValueOnce([
      { ...page('owner', 'old', true), operating: true },
      page('another', 'surviving', true),
    ])
    const dispose = initAIBrowserStoreListeners()
    try {
      expect(listActive).not.toHaveBeenCalled()
      reconnect!(() => true)
      await flush()
      expect(Object.keys(useAIBrowserStore.getState().pages)).toEqual(['old', 'surviving'])
      let resolve!: (snapshot: unknown[]) => void
      listActive.mockReturnValueOnce(new Promise(done => { resolve = done }))
      reconnect!(() => true)
      goneHandler!({ viewId: 'too-late' })
      activeHandler!(view('owner', 'newer'))
      operatingHandler!({ conversationId: 'owner', operating: false })
      resolve([
        page('new-chat', 'too-late', true),
        page('owner', 'new', true),
        { ...view(null, 'surviving', undefined, false), active: false, released: true },
      ])
      await flush()
      const state = useAIBrowserStore.getState()
      expect(Object.keys(state.pages).sort()).toEqual(['new', 'newer'])
      expect(state.views.owner.viewId).toBe('newer')
      expect(state.views['new-chat']).toBeUndefined()
      expect(state.operating).toEqual({})
      expect(adoptPages).toHaveBeenLastCalledWith(['surviving'])
      expect(closeTabsOfGoneView).toHaveBeenCalledWith('old')
    } finally {
      dispose()
      mode.electron = true
    }
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
