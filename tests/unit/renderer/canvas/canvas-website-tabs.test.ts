import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserTabOpened } from '../../../../src/shared/types/browser-host'
import { MAX_LIVE_BROWSER_VIEWS } from '../../../../src/shared/constants/canvas-budget'

let emitTabOpened: (event: BrowserTabOpened) => void = () => {}
let emitState: (event: unknown) => void = () => {}
const createBrowserView = vi.fn(async (_id: string, _url: string) => ({ success: true }))
const navigateBrowserView = vi.fn(async (_id: string, _url: string) => ({ success: true }))
const showBrowserView = vi.fn(async (_id: string, _bounds: unknown) => ({ success: true }))
const destroyBrowserView = vi.fn(async (_id: string) => ({ success: true }))

vi.mock('../../../../src/renderer/api', () => ({ api: {
  onBrowserTabOpened: (callback: typeof emitTabOpened) => { emitTabOpened = callback; return () => {} },
  onBrowserStateChange: (callback: typeof emitState) => { emitState = callback; return () => {} },
  onBrowserPageGone: () => () => {},
  onArtifactChangedBatch: () => () => {},
  onMemoryPressure: () => () => {},
  getMemoryPressure: async () => 'normal',
  isRemoteMode: () => false,
  createBrowserView: (id: string, url: string) => createBrowserView(id, url),
  navigateBrowserView: (id: string, url: string) => navigateBrowserView(id, url),
  showBrowserView: (id: string, bounds: unknown) => showBrowserView(id, bounds),
  hideBrowserView: vi.fn(async () => ({ success: true })),
  destroyBrowserView: (id: string) => destroyBrowserView(id),
} }))
vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { canvasLifecycle } = await import('../../../../src/renderer/services/canvas-lifecycle')
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const childTab = () => canvasLifecycle.getTabs().find(tab => tab.browserViewId === 'website-child')!
const event = (openerViewId: string, overrides: Partial<BrowserTabOpened> = {}): BrowserTabOpened => ({
  viewId: 'website-child', openerViewId, url: 'https://child.test/callback', title: 'Sign in', background: false, ...overrides,
})

beforeEach(async () => {
  for (const spaceId of ['website-a', 'website-b']) await canvasLifecycle.forgetSpace(spaceId)
  await canvasLifecycle.enterSpace('website-a')
  await canvasLifecycle.closeAll()
  createBrowserView.mockClear()
  navigateBrowserView.mockClear()
  showBrowserView.mockClear()
  destroyBrowserView.mockClear()
})

describe('website-created canvas tabs', () => {
  it('adopts and presents the existing guest without creating or navigating it again', async () => {
    await canvasLifecycle.attachAIBrowserView('ai-opener', 'https://opener.test')
    showBrowserView.mockClear()
    emitTabOpened(event('ai-opener'))
    await flush()

    expect(childTab()).toMatchObject({ type: 'browser', title: 'Sign in', url: 'https://child.test/callback', browserViewOwned: true })
    expect(canvasLifecycle.getActiveTabId()).toBe(childTab().id)
    expect(canvasLifecycle.getIsOpen()).toBe(true)
    expect(createBrowserView).not.toHaveBeenCalled()
    expect(navigateBrowserView).not.toHaveBeenCalled()
  })

  it.each(['background', 'inactive opener', 'collapsed canvas'] as const)('does not steal selection for %s', async mode => {
    const opener = await canvasLifecycle.attachAIBrowserView('ai-opener', 'https://opener.test')
    const selected = mode === 'inactive opener' ? await canvasLifecycle.openContent('note', 'Note', 'text') : opener
    if (mode === 'collapsed canvas') canvasLifecycle.setOpen(false)
    showBrowserView.mockClear()
    emitTabOpened(event('ai-opener', { background: mode === 'background' }))
    await flush()

    expect(childTab()).toBeDefined()
    expect(canvasLifecycle.getActiveTabId()).toBe(selected)
    expect(canvasLifecycle.getIsOpen()).toBe(mode !== 'collapsed canvas')
    expect(showBrowserView).not.toHaveBeenCalled()
    expect(createBrowserView).not.toHaveBeenCalled()
    expect(navigateBrowserView).not.toHaveBeenCalled()
  })

  it.each(['absent', 'closed', 'different space'] as const)('destroys an incoming guest whose opener is %s', async mode => {
    if (mode !== 'absent') {
      const opener = await canvasLifecycle.attachAIBrowserView('ai-opener', 'https://opener.test')
      if (mode === 'closed') await canvasLifecycle.closeTab(opener)
      else await canvasLifecycle.enterSpace('website-b')
    }
    destroyBrowserView.mockClear()
    emitTabOpened(event('ai-opener'))
    await flush()

    expect(childTab()).toBeUndefined()
    expect(destroyBrowserView).toHaveBeenCalledOnce()
    expect(destroyBrowserView).toHaveBeenCalledWith('website-child')
    expect(createBrowserView).not.toHaveBeenCalled()
  })

  it('destroys the owned child on close but never destroys its borrowed AI opener', async () => {
    const opener = await canvasLifecycle.attachAIBrowserView('ai-opener', 'https://opener.test')
    emitTabOpened(event('ai-opener'))
    await flush()
    const child = childTab().id
    await canvasLifecycle.closeTab(opener)
    expect(destroyBrowserView).not.toHaveBeenCalled()
    expect(canvasLifecycle.getTab(child)?.browserViewId).toBe('website-child')

    await canvasLifecycle.closeTab(child)
    expect(destroyBrowserView).toHaveBeenCalledOnce()
    expect(destroyBrowserView).toHaveBeenCalledWith('website-child')
    expect(createBrowserView).not.toHaveBeenCalled()
  })

  it('keeps borrowed website children alive across budgets, space parking and tab close', async () => {
    await canvasLifecycle.attachAIBrowserView('ai-opener', 'https://opener.test')
    for (let i = 0; i <= MAX_LIVE_BROWSER_VIEWS; i++) {
      emitTabOpened(event('ai-opener', { viewId: `borrowed-child-${i}`, borrowed: true, background: true }))
      await flush()
    }
    expect(canvasLifecycle.getTabs().filter(tab => tab.browserViewId)).toHaveLength(MAX_LIVE_BROWSER_VIEWS + 2)
    expect(canvasLifecycle.getTabs().filter(tab => tab.browserViewId?.startsWith('borrowed-child')).every(tab => tab.browserViewOwned === false)).toBe(true)
    await canvasLifecycle.enterSpace('website-b')
    await canvasLifecycle.enterSpace('website-a')
    const child = canvasLifecycle.getTabs().find(tab => tab.browserViewId === 'borrowed-child-0')!
    await canvasLifecycle.closeTab(child.id)
    expect(destroyBrowserView).not.toHaveBeenCalled()
    expect(createBrowserView).not.toHaveBeenCalled()
    expect(navigateBrowserView).not.toHaveBeenCalled()
  })

  it('does not destroy a borrowed child when its opener is no longer shown', async () => {
    emitTabOpened(event('missing-opener', { borrowed: true }))
    await flush()
    expect(childTab()).toBeUndefined()
    expect(destroyBrowserView).not.toHaveBeenCalled()
  })

  it('maps popup policy feedback without replacing or blocking the opener and clears it on later state', async () => {
    const opener = await canvasLifecycle.attachAIBrowserView('ai-opener', 'https://opener.test')
    const state = { isLoading: false, canGoBack: true, canGoForward: false, blockedPopupHost: 'denied.test', blockedPopupSequence: 1 }
    emitState({ viewId: 'ai-opener', state })
    expect(canvasLifecycle.getTab(opener)).toMatchObject({ url: 'https://opener.test', browserViewId: 'ai-opener', browserState: state })
    expect(canvasLifecycle.getTab(opener)?.browserState?.blockedByPolicy).toBeUndefined()
    expect(canvasLifecycle.getTab(opener)?.error).toBeUndefined()
    emitState({ viewId: 'ai-opener', state: { ...state, blockedPopupSequence: 2 } })
    expect(canvasLifecycle.getTab(opener)?.browserState?.blockedPopupSequence).toBe(2)
    emitState({ viewId: 'ai-opener', state: { isLoading: true, canGoBack: true, canGoForward: false } })
    expect(canvasLifecycle.getTab(opener)?.browserState?.blockedPopupHost).toBeUndefined()
    expect(destroyBrowserView).not.toHaveBeenCalled()
    expect(navigateBrowserView).not.toHaveBeenCalled()
  })

  it('ignores duplicate events for the same guest', async () => {
    await canvasLifecycle.attachAIBrowserView('ai-opener', 'https://opener.test')
    emitTabOpened(event('ai-opener'))
    emitTabOpened(event('ai-opener'))
    await flush()
    expect(canvasLifecycle.getTabs().filter(tab => tab.browserViewId === 'website-child')).toHaveLength(1)
    expect(canvasLifecycle.getTabCount()).toBe(2)
    expect(destroyBrowserView).not.toHaveBeenCalled()
    expect(createBrowserView).not.toHaveBeenCalled()
  })

  it('applies the existing live-view budget to background website tabs', async () => {
    const opener = await canvasLifecycle.attachAIBrowserView('ai-opener', 'https://opener.test')
    for (let i = 0; i <= MAX_LIVE_BROWSER_VIEWS; i++) {
      emitTabOpened(event('ai-opener', { viewId: `website-child-${i}`, background: true }))
      await flush()
    }
    expect(canvasLifecycle.getTabs().filter(tab => tab.browserViewId)).toHaveLength(MAX_LIVE_BROWSER_VIEWS)
    expect(canvasLifecycle.getActiveTabId()).toBe(opener)
    expect(canvasLifecycle.getTab(opener)?.browserViewId).toBe('ai-opener')
    expect(destroyBrowserView).toHaveBeenCalled()
    expect(createBrowserView).not.toHaveBeenCalled()
  })
})
