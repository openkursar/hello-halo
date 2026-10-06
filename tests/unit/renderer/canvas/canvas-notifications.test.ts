/**
 * Canvas notifications are split by what changed, and tab snapshots are
 * immutable, so a subscriber re-renders only for what it shows: the tab strip
 * ignores content and page churn, the active viewer ignores other tabs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

let emitBrowserState: (data: unknown) => void = () => {}
vi.mock('../../../../src/renderer/api', () => ({
  api: {
    onBrowserPageGone: () => () => {}, onBrowserStateChange: (cb: (data: unknown) => void) => { emitBrowserState = cb; return () => {} },
    onArtifactChangedBatch: () => () => {},
    onMemoryPressure: () => () => {},
    getMemoryPressure: async () => 'normal',
    readArtifactContent: vi.fn(async () => ({ success: true, data: { content: 'text' } })),
    isRemoteMode: () => false,
    showBrowserView: vi.fn(async () => ({ success: true })),
    hideBrowserView: vi.fn(async () => ({ success: true })),
    destroyBrowserView: vi.fn(async () => ({ success: true })),
  },
}))
vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { canvasLifecycle } = await import('../../../../src/renderer/services/canvas-lifecycle')

const pageEvent = (viewId: string, state: Record<string, unknown>) =>
  emitBrowserState({ viewId, state: { isLoading: false, canGoBack: false, canGoForward: false, ...state } })

beforeEach(async () => {
  await canvasLifecycle.closeAll()
})

describe('tab snapshots', () => {
  it('are replaced on change and left alone otherwise', async () => {
    const a = await canvasLifecycle.openContent('a', 'A', 'code')
    const b = await canvasLifecycle.openContent('b', 'B', 'code')
    const aBefore = canvasLifecycle.getTab(a)
    const bBefore = canvasLifecycle.getTab(b)

    canvasLifecycle.updateTabContent(b, 'b2')

    expect(canvasLifecycle.getTab(a)).toBe(aBefore)
    expect(canvasLifecycle.getTab(b)).not.toBe(bBefore)
    expect(bBefore!.content).toBe('b')
  })

  it('share one view memory, so a remount reads the latest scroll offset', async () => {
    const id = await canvasLifecycle.openContent('a', 'A', 'code')
    const early = canvasLifecycle.getTab(id)!
    canvasLifecycle.updateTabContent(id, 'a2')
    canvasLifecycle.saveScrollPosition(id, 420)
    expect(early.view.scrollPosition).toBe(420)
    expect(canvasLifecycle.getTab(id)!.view.scrollPosition).toBe(420)
  })

  it('keep getTabs() current while the tab-strip snapshot stays put for content', async () => {
    const id = await canvasLifecycle.openContent('a', 'A', 'code')
    const strip = canvasLifecycle.getTabListSnapshot()
    canvasLifecycle.updateTabContent(id, 'edited')
    expect(canvasLifecycle.getTabs()[0].content).toBe('edited')
    // isDirty flipped, which the strip shows — so the strip moved too.
    expect(canvasLifecycle.getTabListSnapshot()).not.toBe(strip)

    const dirtyStrip = canvasLifecycle.getTabListSnapshot()
    canvasLifecycle.updateTabContent(id, 'edited again')
    expect(canvasLifecycle.getTabListSnapshot()).toBe(dirtyStrip)
  })
})

describe('the tab-list channel', () => {
  it('stays quiet while the user types into an already-dirty tab', async () => {
    const id = await canvasLifecycle.openContent('a', 'A', 'code')
    canvasLifecycle.updateTabContent(id, 'x')
    const list = vi.fn()
    const off = canvasLifecycle.onTabListChange(list)
    list.mockClear()
    for (let i = 0; i < 50; i++) canvasLifecycle.updateTabContent(id, `x${i}`)
    off()
    expect(list).not.toHaveBeenCalled()
  })

  it('ignores page churn in a hidden browser tab, but hears a new title', async () => {
    const ai = await canvasLifecycle.attachAIBrowserView('page-1', 'https://a.test', 'A')
    await canvasLifecycle.openContent('doc', 'Doc', 'markdown')
    expect(canvasLifecycle.getActiveTabId()).not.toBe(ai)

    const list = vi.fn()
    const active = vi.fn()
    const browser = vi.fn()
    const offs = [
      canvasLifecycle.onTabListChange(list),
      canvasLifecycle.onActiveTabChange(active),
      canvasLifecycle.onBrowserStateChange(browser),
    ]
    list.mockClear()
    active.mockClear()

    for (let i = 0; i < 100; i++) pageEvent('page-1', { title: 'A', favicon: `f${i}`, canGoBack: i % 2 === 0 })
    expect(list).not.toHaveBeenCalled()
    expect(active).not.toHaveBeenCalled()
    expect(browser).toHaveBeenCalledTimes(100)

    pageEvent('page-1', { title: 'A renamed' })
    expect(list).toHaveBeenCalledTimes(1)
    offs.forEach(off => off())
  })
})
