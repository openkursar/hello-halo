/**
 * The AI's terminals and pages are ordinary canvas tabs: added quietly (the
 * canvas does not open, the tab being looked at does not change), marked while
 * their work is live, never counted against the user's tab limit, and closed
 * through one policy that asks before ending the AI's work.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MAX_OPEN_TABS } from '../../../../src/shared/constants/canvas-budget'
import type { AIWorkItem, CanvasClosePolicy, TabState } from '../../../../src/renderer/services/canvas-lifecycle'

const hideBrowserView = vi.fn(async (_id: string) => ({ success: true }))
const destroyBrowserView = vi.fn(async (_id: string) => ({ success: true }))
vi.mock('../../../../src/renderer/api', () => ({
  api: {
    onBrowserTabOpened: () => () => {},
    onBrowserPageGone: () => () => {},
    onBrowserStateChange: () => () => {},
    onArtifactChangedBatch: () => () => {},
    onMemoryPressure: () => () => {},
    getMemoryPressure: async () => 'normal',
    isRemoteMode: () => false,
    readArtifactContent: vi.fn(async () => ({ success: true, data: { content: 'x' } })),
    gitDiscoverRepository: vi.fn(async () => ({ success: true, data: null })),
    retainArtifactSpace: vi.fn(async () => ({ success: true, data: { recreated: false } })),
    releaseArtifactSpace: vi.fn(async () => ({ success: true })),
    createBrowserView: vi.fn(async () => ({ success: true })),
    showBrowserView: vi.fn(async () => ({ success: true })),
    hideBrowserView: (id: string) => hideBrowserView(id),
    destroyBrowserView: (id: string) => destroyBrowserView(id),
    emitLocalArtifactChangedBatch: vi.fn(),
  },
}))
vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { canvasLifecycle } = await import('../../../../src/renderer/services/canvas-lifecycle')
const { planCanvasBudget } = await import('../../../../src/renderer/services/canvas-budget')

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) }
const terminalWork = (id: string, at = 1): AIWorkItem => ({ kind: 'terminal', sessionId: id, title: `term ${id}`, activityAt: at })
const pageWork = (id: string, at = 1): AIWorkItem => ({ kind: 'page', viewId: id, url: `https://${id}.test/`, title: `page ${id}`, activityAt: at })
const work = (spaceId: string, ...items: AIWorkItem[]) => new Map([[spaceId, items]])
const titles = () => canvasLifecycle.getTabs().map(tab => tab.title)
const byTitle = (title: string) => canvasLifecycle.getTabs().find(tab => tab.title === title)!

const allowAll: CanvasClosePolicy = {
  closeOne: async () => true,
  closeMany: async () => ({ keep: new Set() }),
  endRemoved: async () => {},
}
let unregister = canvasLifecycle.setClosePolicy(allowAll)

async function openFile(path: string): Promise<string> {
  const id = await canvasLifecycle.openFile(path)
  await flush()
  return id
}

beforeEach(async () => {
  unregister()
  unregister = canvasLifecycle.setClosePolicy(allowAll)
  canvasLifecycle.syncAIWork(new Map())
  for (const spaceId of ['space-a', 'space-b', 'space-gone']) await canvasLifecycle.forgetSpace(spaceId)
  // Entering a space makes it a space again; 'space-gone' stays removed until a test says otherwise.
  await canvasLifecycle.enterSpace('space-b')
  await canvasLifecycle.enterSpace('space-a')
  hideBrowserView.mockClear()
  destroyBrowserView.mockClear()
})

describe('adding the AI\'s work', () => {
  it('adds a tab at the end without opening the canvas or changing what is shown', async () => {
    const file = await openFile('/a/a.ts')
    canvasLifecycle.setOpen(false)
    const opened = vi.fn()
    const off = canvasLifecycle.onOpenStateChange(opened)
    opened.mockClear()

    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1'), pageWork('p1')))

    off()
    expect(titles()).toEqual(['a.ts', 'term t1', 'page p1'])
    expect(canvasLifecycle.getIsOpen()).toBe(false)
    expect(opened).not.toHaveBeenCalled()
    expect(canvasLifecycle.getActiveTabId()).toBe(file)
    expect(canvasLifecycle.getTabs().filter(tab => tab.aiWork)).toHaveLength(2)
  })

  it('does not switch away from the tab being looked at, nor scroll it out of view', async () => {
    const file = await openFile('/a/a.ts')
    const activations: Array<string | null> = []
    const off = canvasLifecycle.onActiveTabChange(id => activations.push(id))
    activations.length = 0

    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1')))
    await flush()

    off()
    expect(activations).toEqual([])
    expect(canvasLifecycle.getActiveTabId()).toBe(file)
  })

  it('names a page after itself, with no prefix, and a terminal after its title', () => {
    canvasLifecycle.syncAIWork(work('space-a', pageWork('p1'), { kind: 'page', viewId: 'p2', url: 'https://docs.example.com/x', title: null, activityAt: 1 }))
    expect(titles()).toEqual(['page p1', 'docs.example.com'])
    expect(titles().some(title => /🤖/.test(title))).toBe(false)
  })

  it('shows nothing and holds no view until the tab is looked at', () => {
    canvasLifecycle.syncAIWork(work('space-a', pageWork('p1')))
    expect(canvasLifecycle.getTabs()[0]).toMatchObject({ browserViewId: 'p1', browserViewOwned: false })
    expect(hideBrowserView).not.toHaveBeenCalled()
    expect(destroyBrowserView).not.toHaveBeenCalled()
  })

  it('adds each piece of work once, however often it is reported', () => {
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1'), pageWork('p1')))
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1', 5), pageWork('p1', 5)))
    expect(canvasLifecycle.getTabs()).toHaveLength(2)
  })

  it('only marks a terminal the user already has a tab for', async () => {
    const own = await canvasLifecycle.openTerminal('t1', 'zsh')
    expect(canvasLifecycle.getTab(own)?.aiWork).toBeUndefined()

    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1')))

    expect(canvasLifecycle.getTabs()).toHaveLength(1)
    expect(canvasLifecycle.getTab(own)).toMatchObject({ title: 'zsh', aiWork: true })
  })

  it('only marks a page whose tab the user already opened from its card', async () => {
    const own = await canvasLifecycle.attachAIBrowserView('p1', 'https://p1.test', 'Mine')
    canvasLifecycle.syncAIWork(work('space-a', pageWork('p1')))
    expect(canvasLifecycle.getTabs()).toHaveLength(1)
    expect(canvasLifecycle.getTab(own)).toMatchObject({ title: 'Mine', aiWork: true })
  })

  it('adds the tab to the space it belongs to when that space is not on screen', async () => {
    const file = await openFile('/a/a.ts')
    canvasLifecycle.syncAIWork(work('space-b', terminalWork('t-b')))
    expect(titles()).toEqual(['a.ts'])
    expect(canvasLifecycle.getActiveTabId()).toBe(file)

    await canvasLifecycle.enterSpace('space-b')
    expect(titles()).toEqual(['term t-b'])
    expect(canvasLifecycle.getIsOpen()).toBe(false)
  })

  it('opens a collapsed canvas on the tab the user looked at last, else the AI\'s most recent work', async () => {
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('old', 10), pageWork('recent', 20)))
    expect(canvasLifecycle.getActiveTabId()).toBeNull()

    canvasLifecycle.setOpen(true)
    await flush()
    expect(canvasLifecycle.getIsOpen()).toBe(true)
    expect(canvasLifecycle.getActiveTab()?.title).toBe('page recent')

    await canvasLifecycle.switchTab(byTitle('term old').id)
    canvasLifecycle.setOpen(false)
    canvasLifecycle.setOpen(true)
    expect(canvasLifecycle.getActiveTab()?.title).toBe('term old')
  })

  it('adds nothing for a space that was removed', async () => {
    await canvasLifecycle.forgetSpace('space-gone')
    canvasLifecycle.syncAIWork(work('space-gone', terminalWork('t1')))
    await canvasLifecycle.enterSpace('space-b')
    await canvasLifecycle.enterSpace('space-gone')
    expect(canvasLifecycle.getTabs()).toEqual([])
  })
})

describe('when the work ends', () => {
  it('takes the mark off a tab someone looked at, and keeps it', async () => {
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1')))
    const id = byTitle('term t1').id
    await canvasLifecycle.switchTab(id)

    canvasLifecycle.syncAIWork(new Map())

    expect(canvasLifecycle.getTab(id)).toMatchObject({ title: 'term t1' })
    expect(canvasLifecycle.getTab(id)?.aiWork).toBeUndefined()
  })

  it('removes a terminal tab nobody ever looked at', async () => {
    const file = await openFile('/a/a.ts')
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1')))
    canvasLifecycle.syncAIWork(new Map())
    expect(titles()).toEqual(['a.ts'])
    expect(canvasLifecycle.getActiveTabId()).toBe(file)
  })

  it('leaves no tab, and so no handle, when the only tab was one nobody looked at', () => {
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1')))
    canvasLifecycle.syncAIWork(new Map())
    expect(canvasLifecycle.getTabCount()).toBe(0)
    expect(canvasLifecycle.getIsOpen()).toBe(false)
  })

  it('counts a tab as looked at once the canvas opened on it', async () => {
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1')))
    canvasLifecycle.setOpen(true)
    await flush()
    canvasLifecycle.syncAIWork(new Map())
    expect(canvasLifecycle.getTabCount()).toBe(1)
    expect(canvasLifecycle.getTabs()[0].aiWork).toBeUndefined()
  })

  it('removes a page tab when the AI closes the page', async () => {
    const file = await openFile('/a/a.ts')
    canvasLifecycle.syncAIWork(work('space-a', pageWork('p1')))
    await canvasLifecycle.closeTabsOfGoneView('p1')
    expect(titles()).toEqual(['a.ts'])
    expect(canvasLifecycle.getActiveTabId()).toBe(file)
    expect(destroyBrowserView).not.toHaveBeenCalled()
  })

  it('hands a page to the user\'s own tabs when its conversation ends and the page stays open', async () => {
    canvasLifecycle.syncAIWork(work('space-a', pageWork('p1')))
    canvasLifecycle.adoptPages(['p1'])
    expect(canvasLifecycle.getTabs()[0]).toMatchObject({ browserViewId: 'p1', browserViewOwned: true })
    expect(canvasLifecycle.getTabs()[0].aiWork).toBeUndefined()
  })
})

describe('the limits on the user\'s tabs', () => {
  const tab = (id: string, extra: Partial<TabState> = {}): TabState => ({
    id, type: 'code', title: id, path: `/${id}`, isDirty: false, isLoading: false, view: {}, ...extra,
  })
  const limits = { maxOpenTabs: MAX_OPEN_TABS, maxLiveBrowserViews: 6, hiddenContentBytes: 1 << 30 }

  it('do not count the AI\'s tabs, so they never push the user\'s out', () => {
    const own = Array.from({ length: MAX_OPEN_TABS }, (_, i) => tab(`own-${i}`))
    const ai = Array.from({ length: 5 }, (_, i) => tab(`ai-${i}`, { type: 'browser', path: undefined, browserViewId: `v${i}`, browserViewOwned: false, aiWork: true }))
    const recency = new Map([...own, ...ai].map((t, i) => [t.id, i]))

    expect(planCanvasBudget([...own, ...ai], own[0].id, recency, limits).close).toEqual([])
    recency.set('one-more', 1000)
    expect(planCanvasBudget([...own, tab('one-more'), ...ai], own[0].id, recency, limits).close).toEqual(['own-1'])
  })

  it('do not count the AI\'s pages among the live pages, which only the user\'s own tabs hold', () => {
    const ai = Array.from({ length: 10 }, (_, i) => tab(`ai-${i}`, { type: 'browser', path: undefined, browserViewId: `v${i}`, browserViewOwned: false, aiWork: true }))
    const plan = planCanvasBudget(ai, null, new Map(), limits)
    expect(plan).toEqual({ close: [], releaseView: [], unloadContent: [] })
  })

  it('leave ten of the AI\'s tabs alone when the user\'s own are at the limit', async () => {
    for (let i = 0; i < MAX_OPEN_TABS; i++) await canvasLifecycle.openContent(`c${i}`, `own ${i}`, 'text')
    canvasLifecycle.syncAIWork(work('space-a', ...Array.from({ length: 10 }, (_, i) => terminalWork(`t${i}`))))
    await flush()
    expect(canvasLifecycle.getTabs().filter(t => !t.aiWork)).toHaveLength(MAX_OPEN_TABS)
    expect(canvasLifecycle.getTabs().filter(t => t.aiWork)).toHaveLength(10)
  })
})

describe('closing one tab', () => {
  it('goes through the policy, and the tab stays when the user says no', async () => {
    const closeOne = vi.fn(async () => false)
    unregister()
    unregister = canvasLifecycle.setClosePolicy({ ...allowAll, closeOne })
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1')))
    const id = byTitle('term t1').id

    await canvasLifecycle.closeTab(id)
    expect(closeOne).toHaveBeenCalledTimes(1)
    expect(canvasLifecycle.getTab(id)).toBeDefined()

    closeOne.mockResolvedValueOnce(true)
    await canvasLifecycle.closeTab(id)
    expect(canvasLifecycle.getTab(id)).toBeUndefined()
  })

  it('releases a closed page tab\'s view without destroying it itself: ending it is the policy\'s decision', async () => {
    canvasLifecycle.syncAIWork(work('space-a', pageWork('p1')))
    await canvasLifecycle.switchTab(byTitle('page p1').id)
    await canvasLifecycle.closeTab(byTitle('page p1').id)
    expect(hideBrowserView).toHaveBeenCalledWith('p1')
    expect(destroyBrowserView).not.toHaveBeenCalled()
  })

  it('closes without asking when no policy is registered', async () => {
    unregister()
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1')))
    await canvasLifecycle.closeTab(byTitle('term t1').id)
    expect(canvasLifecycle.getTabCount()).toBe(0)
  })
})

describe('closing several tabs', () => {
  it('asks the policy once, with every tab being closed', async () => {
    const closeMany = vi.fn(async () => ({ keep: new Set<string>() }))
    unregister()
    unregister = canvasLifecycle.setClosePolicy({ ...allowAll, closeMany })
    await openFile('/a/a.ts')
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1'), pageWork('p1')))

    await canvasLifecycle.closeAll()

    expect(closeMany).toHaveBeenCalledTimes(1)
    expect((closeMany.mock.calls[0] as unknown as [TabState[]])[0].map(tab => tab.title)).toEqual(['a.ts', 'term t1', 'page p1'])
  })

  it('"close canvas" with the AI\'s tabs kept leaves only those, collapsed behind the handle', async () => {
    await openFile('/a/a.ts')
    await openFile('/a/b.ts')
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1'), pageWork('p1')))
    const keep = new Set([byTitle('term t1').id, byTitle('page p1').id])
    unregister()
    unregister = canvasLifecycle.setClosePolicy({ ...allowAll, closeMany: async () => ({ keep }) })

    await canvasLifecycle.closeAll({ confirmDirty: true })

    expect(titles()).toEqual(['term t1', 'page p1'])
    expect(canvasLifecycle.getTabCount()).toBe(2)
    expect(canvasLifecycle.getIsOpen()).toBe(false)
  })

  it('"close others" keeps the canvas open and shows a remaining tab', async () => {
    const own = await openFile('/a/a.ts')
    await openFile('/a/b.ts')
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1')))
    const ai = byTitle('term t1').id
    const keepAi = new Set([ai])
    unregister()
    unregister = canvasLifecycle.setClosePolicy({ ...allowAll, closeMany: async () => ({ keep: keepAi }) })
    await canvasLifecycle.switchTab(own)

    await canvasLifecycle.closeTabs(canvasLifecycle.getTabs().filter(tab => tab.id !== own).map(tab => tab.id))

    expect(titles()).toEqual(['a.ts', 'term t1'])
    expect(canvasLifecycle.getIsOpen()).toBe(true)
    expect(canvasLifecycle.getActiveTabId()).toBe(own)
  })

  it('"close others" moves to a remaining tab when the shown one is closed', async () => {
    await openFile('/a/a.ts')
    const shown = await openFile('/a/b.ts')
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1')))
    const ai = byTitle('term t1').id
    await canvasLifecycle.switchTab(ai)
    await canvasLifecycle.switchTab(shown)

    await canvasLifecycle.closeTabs([shown])

    expect(canvasLifecycle.getActiveTabId()).toBe(ai)
  })

  it('"close all" ends everything: the canvas collapses and no tab is left', async () => {
    await openFile('/a/a.ts')
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1')))
    await canvasLifecycle.closeAll({ confirmDirty: true })
    expect(canvasLifecycle.getTabCount()).toBe(0)
    expect(canvasLifecycle.getIsOpen()).toBe(false)
  })

  it('cancelling leaves every tab exactly as it was', async () => {
    await openFile('/a/a.ts')
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1')))
    unregister()
    unregister = canvasLifecycle.setClosePolicy({ ...allowAll, closeMany: async () => null })

    await canvasLifecycle.closeAll({ confirmDirty: true })

    expect(titles()).toEqual(['a.ts', 'term t1'])
    expect(canvasLifecycle.getIsOpen()).toBe(true)
  })
})

describe('quietly ensuring a tab for something the AI shows', () => {
  it('finds the tab the AI\'s work already has instead of adding another', () => {
    canvasLifecycle.syncAIWork(work('space-a', terminalWork('t1')))
    const existing = byTitle('term t1').id
    expect(canvasLifecycle.ensureAIWorkTab('space-a', terminalWork('t1'))).toBe(existing)
    expect(canvasLifecycle.getTabCount()).toBe(1)
  })

  it('adds a tab for a terminal the AI has not worked in yet, without opening anything', () => {
    const id = canvasLifecycle.ensureAIWorkTab('space-a', terminalWork('t9'))
    expect(id).toBeTruthy()
    expect(canvasLifecycle.getTab(id!)).toMatchObject({ type: 'terminal', aiWork: true })
    expect(canvasLifecycle.getIsOpen()).toBe(false)
    expect(canvasLifecycle.getActiveTabId()).toBeNull()
  })

  it('adds a file as an ordinary tab, unmarked and unread until it is shown', async () => {
    const id = canvasLifecycle.ensureFileTab('space-a', '/a/report.md')!
    expect(canvasLifecycle.getTab(id)).toMatchObject({ type: 'markdown', title: 'report.md', path: '/a/report.md', contentUnloaded: true })
    expect(canvasLifecycle.getTab(id)?.aiWork).toBeUndefined()
    expect(canvasLifecycle.getIsOpen()).toBe(false)
    expect(canvasLifecycle.ensureFileTab('space-a', '/a/report.md')).toBe(id)
    expect(canvasLifecycle.getTabCount()).toBe(1)

    await canvasLifecycle.switchTab(id)
    await flush()
    expect(canvasLifecycle.getTab(id)?.content).toBe('x')
  })

  it('keeps a requested file at the limit only when it can be presented in the foreground', async () => {
    for (let i = 0; i < MAX_OPEN_TABS; i++) await canvasLifecycle.openContent(`c${i}`, `own ${i}`, 'text')
    await flush()
    canvasLifecycle.setOpen(false)
    expect(canvasLifecycle.ensureFileTab('space-a', '/a/report.md')).toBeNull()
    expect(canvasLifecycle.getTabCount()).toBe(MAX_OPEN_TABS)
    const id = canvasLifecycle.ensureFileTab('space-a', '/a/report.md', true)
    expect(id).toBeTruthy()
    await canvasLifecycle.switchTab(id!, { open: true })
    await flush()
    expect(canvasLifecycle.getIsOpen()).toBe(true)
    expect(canvasLifecycle.getActiveTab()).toMatchObject({ id, content: 'x' })
    expect(canvasLifecycle.getTabCount()).toBe(MAX_OPEN_TABS)
    expect(titles()).not.toContain('own 0')
  })

  it('never opens the next workspace when the previous guest hides late', async () => {
    await canvasLifecycle.attachAIBrowserView('outgoing', 'https://p1.test')
    canvasLifecycle.setOpen(false)
    let finishHide!: (result: { success: boolean }) => void
    hideBrowserView.mockImplementationOnce(() => new Promise(resolve => { finishHide = resolve }))
    const id = canvasLifecycle.ensureFileTab('space-a', '/a/report.md', true)!
    const revealing = canvasLifecycle.switchTab(id, { open: true })
    await canvasLifecycle.enterSpace('space-b')
    finishHide({ success: true })
    await revealing
    expect(canvasLifecycle.getCurrentSpaceId()).toBe('space-b')
    expect(canvasLifecycle.getIsOpen()).toBe(false)
    expect(canvasLifecycle.hasSpaceTab('space-a', id)).toBe(true)
  })

  it('destroys a page adopted in a parked space only when that space is removed', async () => {
    canvasLifecycle.syncAIWork(work('space-a', pageWork('p1')))
    await canvasLifecycle.enterSpace('space-b')
    canvasLifecycle.adoptPages(['p1'])
    expect(destroyBrowserView).not.toHaveBeenCalled()
    await canvasLifecycle.forgetSpace('space-a')
    expect(destroyBrowserView.mock.calls).toEqual([['p1']])
  })

  it('refuses a removed space', async () => {
    await canvasLifecycle.forgetSpace('space-gone')
    expect(canvasLifecycle.ensureFileTab('space-gone', '/a/x.md')).toBeNull()
    expect(canvasLifecycle.ensureAIWorkTab('space-gone', terminalWork('t1'))).toBeNull()
  })
})
