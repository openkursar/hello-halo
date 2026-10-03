/**
 * The canvas keeps hidden tabs within fixed budgets — open tabs, live browser
 * processes, hidden file content — dropping the least recently used first and
 * never anything with unsaved edits, a live terminal or an AI's browser view.
 * Dropped content and views come back when the tab is shown again.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  HIDDEN_CONTENT_BUDGET_BYTES,
  MAX_LIVE_BROWSER_VIEWS,
  MAX_OPEN_TABS,
} from '../../../../src/shared/constants/canvas-budget'
import type { TabState } from '../../../../src/renderer/services/canvas-lifecycle'

let emitPressure: (e: { level: 'normal' | 'low' | 'critical' }) => void = () => {}
const disk = new Map<string, string>()
const readArtifactContent = vi.fn(async (path: string) => ({ success: true, data: { content: disk.get(path) ?? '' } }))
const createBrowserView = vi.fn(async (_viewId: string, _url: string) => ({ success: true }))
/** When set, view destruction waits for it — to hold a budget pass mid-release. */
let destroyGate: Promise<void> | null = null
const destroyBrowserView = vi.fn(async () => {
  if (destroyGate) await destroyGate
  return { success: true }
})
function holdDestroys(): () => void {
  let open: () => void = () => {}
  destroyGate = new Promise<void>(r => { open = r })
  return () => { destroyGate = null; open() }
}

vi.mock('../../../../src/renderer/api', () => ({
  api: {
    onBrowserStateChange: () => () => {},
    onArtifactChangedBatch: () => () => {},
    onMemoryPressure: (cb: typeof emitPressure) => { emitPressure = cb; return () => {} },
    getMemoryPressure: async () => 'normal',
    readArtifactContent: (path: string) => readArtifactContent(path),
    isRemoteMode: () => false,
    createBrowserView: (...a: unknown[]) => createBrowserView(...(a as [string, string])),
    destroyBrowserView: (...a: unknown[]) => destroyBrowserView(...(a as [])),
    showBrowserView: vi.fn(async () => ({ success: true })),
    hideBrowserView: vi.fn(async () => ({ success: true })),
  },
}))
vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { canvasLifecycle } = await import('../../../../src/renderer/services/canvas-lifecycle')
const { planCanvasBudget } = await import('../../../../src/renderer/services/canvas-budget')

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) }

async function openFile(path: string, content = 'x'): Promise<string> {
  disk.set(path, content)
  const id = await canvasLifecycle.openFile(path)
  await flush()
  return id
}

beforeEach(async () => {
  destroyGate = null
  emitPressure({ level: 'normal' })
  await canvasLifecycle.closeAll()
  disk.clear()
  readArtifactContent.mockClear()
  createBrowserView.mockClear()
  destroyBrowserView.mockClear()
})

describe('open-tab limit', () => {
  it('closes the least recently used tab, never a dirty one, and says so', async () => {
    const evictions: number[] = []
    const off = canvasLifecycle.onBudgetEviction(e => evictions.push(e.closedTabs))

    const first = await openFile('/w/0.ts')
    const second = await openFile('/w/1.ts')
    canvasLifecycle.updateTabContent(first, 'unsaved')
    for (let i = 2; i < MAX_OPEN_TABS; i++) await openFile(`/w/${i}.ts`)
    expect(canvasLifecycle.getTabCount()).toBe(MAX_OPEN_TABS)

    await openFile('/w/extra.ts')
    off()

    expect(canvasLifecycle.getTabCount()).toBe(MAX_OPEN_TABS)
    expect(canvasLifecycle.getTab(first)).toBeDefined()
    expect(canvasLifecycle.getTab(second)).toBeUndefined()
    expect(evictions).toEqual([1])
  })

  it('counts recency by activation, not by opening order', async () => {
    const ids: string[] = []
    for (let i = 0; i < MAX_OPEN_TABS; i++) ids.push(await openFile(`/w/${i}.ts`))
    await canvasLifecycle.switchTab(ids[0])
    await flush()
    await openFile('/w/extra.ts')
    expect(canvasLifecycle.getTab(ids[0])).toBeDefined()
    expect(canvasLifecycle.getTab(ids[1])).toBeUndefined()
  })
})

describe('live browser views', () => {
  it('releases the least recently used hidden owned view and recreates it when shown', async () => {
    const ids: string[] = []
    for (let i = 0; i <= MAX_LIVE_BROWSER_VIEWS; i++) {
      ids.push(await canvasLifecycle.openUrl(`https://site${i}.test`))
      await flush()
    }
    const live = canvasLifecycle.getTabs().filter(t => t.browserViewId)
    expect(live).toHaveLength(MAX_LIVE_BROWSER_VIEWS)
    expect(canvasLifecycle.getTab(ids[0])!.browserViewId).toBeUndefined()
    expect(destroyBrowserView).toHaveBeenCalledTimes(1)

    createBrowserView.mockClear()
    await canvasLifecycle.switchTab(ids[0])
    await flush()
    expect(createBrowserView).toHaveBeenCalledWith(expect.any(String), 'https://site0.test')
    expect(canvasLifecycle.getTab(ids[0])!.browserViewId).toBeDefined()
  })

  it('never releases a view the AI attached', async () => {
    const ai = await canvasLifecycle.attachAIBrowserView('ai-page', 'https://ai.test')
    for (let i = 0; i <= MAX_LIVE_BROWSER_VIEWS; i++) {
      await canvasLifecycle.openUrl(`https://site${i}.test`)
      await flush()
    }
    expect(canvasLifecycle.getTab(ai)!.browserViewId).toBe('ai-page')
  })
})

describe('hidden content', () => {
  it('drops the oldest hidden text over budget and re-reads it when shown', async () => {
    const big = 'a'.repeat(HIDDEN_CONTENT_BUDGET_BYTES / 2 / 2 + 1) // just over half the budget
    const a = await openFile('/w/a.txt', big)
    const b = await openFile('/w/b.txt', big)
    await openFile('/w/c.txt', 'small')

    expect(canvasLifecycle.getTab(a)).toMatchObject({ content: undefined, contentUnloaded: true })
    expect(canvasLifecycle.getTab(b)!.content).toBe(big)

    await canvasLifecycle.switchTab(a)
    await flush()
    expect(canvasLifecycle.getTab(a)).toMatchObject({ content: big, contentUnloaded: false, isLoading: false })
  })

  it('never drops unsaved edits', async () => {
    const big = 'a'.repeat(HIDDEN_CONTENT_BUDGET_BYTES)
    const a = await openFile('/w/a.txt', big)
    canvasLifecycle.updateTabContent(a, big + '!')
    await openFile('/w/b.txt', 'small')
    expect(canvasLifecycle.getTab(a)!.content).toBe(big + '!')
  })

  it('does not re-read an unloaded tab when its file changes; it reads once when shown', async () => {
    const big = 'a'.repeat(HIDDEN_CONTENT_BUDGET_BYTES)
    const a = await openFile('/w/a.txt', big)
    await openFile('/w/b.txt', 'small')
    readArtifactContent.mockClear()
    canvasLifecycle.handleArtifactChanges({ spaceId: 's', changes: [{ type: 'change', path: '/w/a.txt', relativePath: 'a.txt' }] })
    await flush()
    expect(readArtifactContent).not.toHaveBeenCalled()
  })
})

describe('critical memory pressure', () => {
  it('drops every hidden tab content and hidden owned view, keeping the tabs', async () => {
    const file = await openFile('/w/a.ts', 'text')
    const page = await canvasLifecycle.openUrl('https://site.test')
    await flush()
    await openFile('/w/b.ts', 'active')

    emitPressure({ level: 'critical' })
    await flush()

    expect(canvasLifecycle.getTab(file)).toMatchObject({ content: undefined, contentUnloaded: true })
    expect(canvasLifecycle.getTab(page)!.browserViewId).toBeUndefined()
    expect(canvasLifecycle.getTab(page)!.url).toBe('https://site.test')
    expect(canvasLifecycle.getActiveTab()!.content).toBe('active')
    expect(canvasLifecycle.getTabCount()).toBe(3)
  })
})

describe('budget passes that overlap', () => {
  it('re-runs once a pass ends if the limit was hit again meanwhile', async () => {
    // Hold the first view release open so a second trigger lands during the pass.
    const ids: string[] = []
    for (let i = 0; i < MAX_LIVE_BROWSER_VIEWS; i++) {
      ids.push(await canvasLifecycle.openUrl(`https://site${i}.test`))
      await flush()
    }
    const finishRelease = holdDestroys()
    ids.push(await canvasLifecycle.openUrl(`https://site${MAX_LIVE_BROWSER_VIEWS}.test`))
    await flush()
    // One more view while the first pass is still releasing.
    ids.push(await canvasLifecycle.openUrl('https://late.test'))
    await flush()
    finishRelease()
    await flush()

    const live = canvasLifecycle.getTabs().filter(t => t.browserViewId)
    expect(live).toHaveLength(MAX_LIVE_BROWSER_VIEWS)
  })
})

describe('releasing a view while the user switches to its tab', () => {
  it('never leaves the tab being shown without a view', async () => {
    const ids: string[] = []
    for (let i = 0; i < MAX_LIVE_BROWSER_VIEWS; i++) {
      ids.push(await canvasLifecycle.openUrl(`https://site${i}.test`))
      await flush()
    }
    const finishRelease = holdDestroys()
    ids.push(await canvasLifecycle.openUrl(`https://site${MAX_LIVE_BROWSER_VIEWS}.test`))
    await flush()
    // The pass is now destroying ids[0]'s view; the user clicks that tab.
    expect(destroyBrowserView).toHaveBeenCalledTimes(1)
    createBrowserView.mockClear()
    await canvasLifecycle.switchTab(ids[0])
    finishRelease()
    await flush()

    expect(canvasLifecycle.getActiveTabId()).toBe(ids[0])
    expect(createBrowserView).toHaveBeenCalledWith(expect.any(String), 'https://site0.test')
    expect(canvasLifecycle.getTab(ids[0])!.browserViewId).toBeDefined()
  })

  it('gives a recreated view a new id, so it cannot collide with the one being destroyed', async () => {
    const tabId = await canvasLifecycle.openUrl('https://a.test')
    await flush()
    const first = canvasLifecycle.getTab(tabId)!.browserViewId
    for (let i = 0; i < MAX_LIVE_BROWSER_VIEWS; i++) {
      await canvasLifecycle.openUrl(`https://site${i}.test`)
      await flush()
    }
    expect(canvasLifecycle.getTab(tabId)!.browserViewId).toBeUndefined()
    await canvasLifecycle.switchTab(tabId)
    await flush()
    const second = canvasLifecycle.getTab(tabId)!.browserViewId
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
  })
})

describe('a budget pass while the user switches tabs', () => {
  it('keeps a tab open that the user switched to while the pass was closing it', async () => {
    const page = await canvasLifecycle.openUrl('https://old.test')
    await flush()
    for (let i = 1; i < MAX_OPEN_TABS; i++) await openFile(`/w/${i}.ts`)

    const finishRelease = holdDestroys()
    await openFile('/w/extra.ts')
    expect(destroyBrowserView).toHaveBeenCalledTimes(1)
    await canvasLifecycle.switchTab(page)
    finishRelease()
    await flush()

    expect(canvasLifecycle.getTab(page)).toBeDefined()
    expect(canvasLifecycle.getActiveTabId()).toBe(page)
    expect(canvasLifecycle.getTab(page)!.browserViewId).toBeDefined()
  })

  it('does not unload the content of a tab the user switched to while the pass awaited', async () => {
    await canvasLifecycle.openUrl('https://old.test')
    await flush()
    const big = 'a'.repeat(HIDDEN_CONTENT_BUDGET_BYTES)
    const file = await openFile('/w/big.txt', big)
    for (let i = 2; i < MAX_OPEN_TABS; i++) await openFile(`/w/${i}.ts`)

    const finishRelease = holdDestroys()
    await openFile('/w/extra.ts')
    await canvasLifecycle.switchTab(file)
    finishRelease()
    await flush()

    expect(canvasLifecycle.getActiveTabId()).toBe(file)
    expect(canvasLifecycle.getTab(file)).toMatchObject({ content: big })
    expect(canvasLifecycle.getTab(file)!.contentUnloaded).toBeFalsy()
  })
})

describe('creating a tab\'s browser view', () => {
  it('creates exactly one view when the tab is shown twice while it is being created', async () => {
    let finishCreate: () => void = () => {}
    createBrowserView.mockImplementationOnce(() => new Promise(r => { finishCreate = () => r({ success: true }) }))
    const other = await canvasLifecycle.openContent('x', 'X', 'code')
    const tabId = await canvasLifecycle.openUrl('https://a.test')
    await canvasLifecycle.switchTab(other)
    await canvasLifecycle.switchTab(tabId)
    finishCreate()
    await flush()

    expect(createBrowserView).toHaveBeenCalledTimes(1)
    expect(destroyBrowserView).not.toHaveBeenCalled()
    expect(canvasLifecycle.getTab(tabId)!.browserViewId).toBe(createBrowserView.mock.calls[0][0])
  })

  it('destroys a view whose creation finishes after its tab was closed', async () => {
    let finishCreate: () => void = () => {}
    createBrowserView.mockImplementationOnce(() => new Promise(r => { finishCreate = () => r({ success: true }) }))
    const tabId = await canvasLifecycle.openUrl('https://a.test')
    await canvasLifecycle.closeTab(tabId)
    finishCreate()
    await flush()

    const viewId = createBrowserView.mock.calls[0][0]
    expect(destroyBrowserView).toHaveBeenCalledWith(viewId)
  })

  it('destroys a surplus view if the tab got another one meanwhile', async () => {
    let finishCreate: () => void = () => {}
    createBrowserView.mockImplementationOnce(() => new Promise(r => { finishCreate = () => r({ success: true }) }))
    const tabId = await canvasLifecycle.openUrl('https://a.test')
    // Force a second, independent creation to win the race.
    ;(canvasLifecycle as unknown as { creatingViews: Map<string, unknown> }).creatingViews.delete(tabId)
    await (canvasLifecycle as unknown as { createBrowserView(id: string, url: string): Promise<void> }).createBrowserView(tabId, 'https://a.test')
    const winner = canvasLifecycle.getTab(tabId)!.browserViewId
    finishCreate()
    await flush()

    const loser = createBrowserView.mock.calls[0][0]
    expect(loser).not.toBe(winner)
    expect(destroyBrowserView).toHaveBeenCalledWith(loser)
    expect(canvasLifecycle.getTab(tabId)!.browserViewId).toBe(winner)
  })
})

describe('planCanvasBudget', () => {
  const tab = (id: string, extra: Partial<TabState> = {}): TabState =>
    ({ id, type: 'code', title: id, isDirty: false, isLoading: false, view: {}, ...extra }) as TabState
  const limits = { maxOpenTabs: 2, maxLiveBrowserViews: 1, hiddenContentBytes: 0 }

  it('leaves terminals, dirty tabs and the active tab open even over the limit', () => {
    const tabs = [tab('t', { type: 'terminal' }), tab('d', { isDirty: true }), tab('a'), tab('x')]
    const plan = planCanvasBudget(tabs, 'a', new Map(), limits)
    expect(plan.close).toEqual(['x'])
  })

  it('keeps the active view even when the view limit is zero', () => {
    const tabs = [tab('a', { type: 'browser', browserViewId: 'v', browserViewOwned: true })]
    expect(planCanvasBudget(tabs, 'a', new Map(), { ...limits, maxLiveBrowserViews: 0 }).releaseView).toEqual([])
  })

  it('only unloads what can be re-read from disk', () => {
    const tabs = [tab('active'), tab('generated', { content: 'x' }), tab('file', { path: '/f', content: 'x' })]
    expect(planCanvasBudget(tabs, 'active', new Map(), limits).unloadContent).toEqual(['file'])
  })
})
