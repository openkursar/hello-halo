/**
 * Each space keeps its own canvas tabs. Leaving a space parks them as they are
 * — unsaved edits, running terminals, the AI's pages — and coming back shows
 * them again, with file tabs read again and unsaved edits checked against
 * disk. Only removing the space closes them.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

type BrowserStateEvent = { viewId: string; state: { isLoading: boolean; canGoBack: boolean; canGoForward: boolean; url?: string; title?: string } }

const disk = new Map<string, string>()
const readArtifactContent = vi.fn(async (path: string) =>
  disk.has(path)
    ? { success: true, data: { content: disk.get(path)!, mimeType: 'text/plain' } }
    : { success: false, error: 'ENOENT' }
)
let emitGone: (event: { viewId: string; reason: 'closed' | 'lost' }) => void = () => {}
let emitBrowserState: (event: BrowserStateEvent) => void = () => {}
const createBrowserView = vi.fn(async (_id: string, _url: string) => ({ success: true }))
const hideBrowserView = vi.fn(async (_id: string) => ({ success: true }))
const destroyBrowserView = vi.fn(async (id: string) => { emitGone({ viewId: id, reason: 'closed' }); return { success: true } })

vi.mock('../../../../src/renderer/api', () => ({
  api: {
    onBrowserStateChange: (callback: typeof emitBrowserState) => { emitBrowserState = callback; return () => {} },
    onBrowserPageGone: (callback: typeof emitGone) => { emitGone = callback; return () => {} },
    onArtifactChangedBatch: () => () => {},
    onMemoryPressure: () => () => {},
    getMemoryPressure: async () => 'normal',
    readArtifactContent: (path: string) => readArtifactContent(path),
    isRemoteMode: () => false,
    createBrowserView: (id: string, url: string) => createBrowserView(id, url),
    showBrowserView: vi.fn(async () => ({ success: true })),
    hideBrowserView: (id: string) => hideBrowserView(id),
    destroyBrowserView: (id: string) => destroyBrowserView(id),
    retainArtifactSpace: vi.fn(async () => ({ success: true, data: { recreated: false } })),
    releaseArtifactSpace: vi.fn(async () => ({ success: true })),
    emitLocalArtifactChangedBatch: vi.fn(),
  },
}))
vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { canvasLifecycle } = await import('../../../../src/renderer/services/canvas-lifecycle')

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const tabOf = (id: string) => canvasLifecycle.getTab(id)!
const shownIds = () => canvasLifecycle.getTabs().map(tab => tab.id)

const disposeOnBulkClose = vi.fn(async (_sessionId: string) => {})
const terminalPolicy = { confirmSingleClose: async () => true, disposeOnBulkClose }
let unregisterPolicy = canvasLifecycle.setTerminalClosePolicy(terminalPolicy)

async function openFile(path: string, content: string): Promise<string> {
  disk.set(path, content)
  const id = await canvasLifecycle.openFile(path)
  await flush()
  return id
}

beforeEach(async () => {
  unregisterPolicy()
  unregisterPolicy = canvasLifecycle.setTerminalClosePolicy(terminalPolicy)
  for (const spaceId of ['space-a', 'space-b']) await canvasLifecycle.forgetSpace(spaceId)
  await canvasLifecycle.enterSpace('space-a')
  disk.clear()
  readArtifactContent.mockClear()
  createBrowserView.mockReset().mockImplementation(async () => ({ success: true }))
  hideBrowserView.mockClear()
  destroyBrowserView.mockClear()
  disposeOnBulkClose.mockClear()
})

describe('switching spaces', () => {
  it('keeps each space\'s tabs, active tab and open state', async () => {
    const a = await openFile('/a/a.ts', 'a')
    const b = await openFile('/a/b.ts', 'b')
    await canvasLifecycle.switchTab(a)

    await canvasLifecycle.enterSpace('space-b')
    expect(shownIds()).toEqual([])
    expect(canvasLifecycle.getIsOpen()).toBe(false)
    const c = await openFile('/b/c.ts', 'c')

    await canvasLifecycle.enterSpace('space-a')
    expect(shownIds()).toEqual([a, b])
    expect(canvasLifecycle.getActiveTabId()).toBe(a)
    expect(canvasLifecycle.getIsOpen()).toBe(true)

    await canvasLifecycle.enterSpace('space-b')
    expect(shownIds()).toEqual([c])
  })

  it('brings a collapsed canvas back collapsed', async () => {
    await openFile('/a/a.ts', 'a')
    canvasLifecycle.setOpen(false)
    await canvasLifecycle.enterSpace('space-b')
    await openFile('/b/c.ts', 'c')

    await canvasLifecycle.enterSpace('space-a')
    expect(canvasLifecycle.getTabCount()).toBe(1)
    expect(canvasLifecycle.getIsOpen()).toBe(false)
  })

  it('reads a clean file tab again on return, not before', async () => {
    const a = await openFile('/a/a.ts', 'v1')
    const b = await openFile('/a/b.ts', 'b1')
    await canvasLifecycle.enterSpace('space-b')
    disk.set('/a/a.ts', 'v2')
    disk.set('/a/b.ts', 'b2')
    readArtifactContent.mockClear()

    await canvasLifecycle.enterSpace('space-a')
    await flush()
    // Only the tab on screen is read; the other waits until it is shown.
    expect(readArtifactContent.mock.calls.map(call => call[0])).toEqual(['/a/b.ts'])
    expect(tabOf(b).content).toBe('b2')
    expect(tabOf(a).content).toBeUndefined()
    expect(tabOf(a).isLoading).toBe(false)

    await canvasLifecycle.switchTab(a)
    await flush()
    expect(tabOf(a).content).toBe('v2')
  })

  it('reads a tab again on return when it was still loading as the space was left', async () => {
    disk.set('/a/slow.ts', 'done')
    let finish!: () => void
    readArtifactContent.mockImplementationOnce(path => new Promise(resolve => {
      finish = () => resolve({ success: true, data: { content: disk.get(path)!, mimeType: 'text/plain' } })
    }))
    const id = await canvasLifecycle.openFile('/a/slow.ts')
    await canvasLifecycle.enterSpace('space-b')
    finish()
    await flush()

    await canvasLifecycle.enterSpace('space-a')
    await flush()
    expect(tabOf(id).content).toBe('done')
    expect(tabOf(id).isLoading).toBe(false)
  })
})

describe('unsaved edits', () => {
  it('survive leaving and coming back', async () => {
    const id = await openFile('/a/a.ts', 'disk')
    canvasLifecycle.updateTabContent(id, 'mine')
    await canvasLifecycle.enterSpace('space-b')

    await canvasLifecycle.enterSpace('space-a')
    await flush()
    expect(tabOf(id)).toMatchObject({ content: 'mine', isDirty: true, savedContent: 'disk' })
    expect(tabOf(id).diskConflict).toBeFalsy()
  })

  it('ask which side to keep when the file changed on disk while away', async () => {
    const id = await openFile('/a/a.ts', 'disk')
    canvasLifecycle.updateTabContent(id, 'mine')
    await canvasLifecycle.enterSpace('space-b')
    disk.set('/a/a.ts', 'changed elsewhere')

    await canvasLifecycle.enterSpace('space-a')
    await flush()
    expect(tabOf(id)).toMatchObject({ content: 'mine', isDirty: true, diskConflict: true, savedContent: 'changed elsewhere' })
  })

  it('count as saved when the save finishes after the space was left', async () => {
    const id = await openFile('/a/a.ts', 'disk')
    canvasLifecycle.updateTabContent(id, 'mine')
    await canvasLifecycle.enterSpace('space-b')
    disk.set('/a/a.ts', 'mine')
    canvasLifecycle.markTabSaved(id, 'mine')

    await canvasLifecycle.enterSpace('space-a')
    await flush()
    expect(tabOf(id)).toMatchObject({ content: 'mine', isDirty: false })
    expect(tabOf(id).diskConflict).toBeFalsy()
  })
})

describe('terminals', () => {
  it('keep running while their space is away', async () => {
    const id = await canvasLifecycle.openTerminal('pty-1', 'zsh')
    await canvasLifecycle.enterSpace('space-b')
    expect(disposeOnBulkClose).not.toHaveBeenCalled()

    canvasLifecycle.setTerminalTitle('pty-1', 'npm run dev')
    await canvasLifecycle.enterSpace('space-a')
    expect(tabOf(id)).toMatchObject({ terminalSessionId: 'pty-1', title: 'npm run dev' })
  })

  it('end with a removed space, parked or on screen', async () => {
    await canvasLifecycle.openTerminal('pty-a', 'zsh')
    await canvasLifecycle.enterSpace('space-b')
    await canvasLifecycle.openTerminal('pty-b', 'zsh')

    await canvasLifecycle.forgetSpace('space-a')
    expect(disposeOnBulkClose.mock.calls.map(call => call[0])).toEqual(['pty-a'])

    await canvasLifecycle.forgetSpace('space-b')
    expect(disposeOnBulkClose.mock.calls.map(call => call[0])).toEqual(['pty-a', 'pty-b'])
    expect(shownIds()).toEqual([])
    expect(canvasLifecycle.getIsOpen()).toBe(false)

    await canvasLifecycle.enterSpace('space-a')
    expect(shownIds()).toEqual([])
  })

  it('of a space removed while no close policy is registered end once one is', async () => {
    await canvasLifecycle.openTerminal('pty-a', 'zsh')
    await canvasLifecycle.enterSpace('space-b')
    unregisterPolicy()

    await canvasLifecycle.forgetSpace('space-a')
    expect(disposeOnBulkClose).not.toHaveBeenCalled()

    unregisterPolicy = canvasLifecycle.setTerminalClosePolicy(terminalPolicy)
    await flush()
    expect(disposeOnBulkClose.mock.calls.map(call => call[0])).toEqual(['pty-a'])
  })
})

describe('removing the space on screen', () => {
  it('leaves nothing to bring back when its fallback is entered next', async () => {
    await openFile('/a/a.ts', 'a')
    await canvasLifecycle.forgetSpace('space-a')
    expect(shownIds()).toEqual([])

    await canvasLifecycle.enterSpace('space-b')
    await canvasLifecycle.enterSpace('space-a')
    expect(shownIds()).toEqual([])
  })
})

describe('browser pages', () => {
  it('release a canvas page while away and open it again from its url', async () => {
    const id = await canvasLifecycle.openUrl('https://owned.test')
    await flush()
    const viewId = tabOf(id).browserViewId!

    await canvasLifecycle.enterSpace('space-b')
    await flush()
    expect(destroyBrowserView).toHaveBeenCalledWith(viewId)
    createBrowserView.mockClear()

    await canvasLifecycle.enterSpace('space-a')
    await flush()
    expect(createBrowserView).toHaveBeenCalledWith(expect.any(String), 'https://owned.test')
    expect(tabOf(id).browserViewId).toBeTruthy()
    expect(tabOf(id).browserViewId).not.toBe(viewId)
  })

  it('keep a page made again when its space returns before the old one is gone', async () => {
    const id = await canvasLifecycle.openUrl('https://owned.test')
    await flush()
    const viewId = tabOf(id).browserViewId!
    let finishDestroy!: () => void
    destroyBrowserView.mockImplementationOnce(id => new Promise(resolve => {
      finishDestroy = () => { emitGone({ viewId: id, reason: 'closed' }); resolve({ success: true }) }
    }))

    await canvasLifecycle.enterSpace('space-b')
    await canvasLifecycle.enterSpace('space-a')
    await flush()
    const replacement = tabOf(id).browserViewId
    expect(replacement).toBeTruthy()
    expect(replacement).not.toBe(viewId)

    finishDestroy()
    await flush()
    expect(tabOf(id).browserViewId).toBe(replacement)
  })

  it('do not leak a page still being created when its space is left', async () => {
    let finishCreate!: () => void
    createBrowserView.mockImplementationOnce(() => new Promise(resolve => { finishCreate = () => resolve({ success: true }) }))
    const id = await canvasLifecycle.openUrl('https://slow.test')
    const viewId = createBrowserView.mock.calls[0][0]

    await canvasLifecycle.enterSpace('space-b')
    finishCreate()
    await flush()
    expect(destroyBrowserView).toHaveBeenCalledWith(viewId)

    await canvasLifecycle.enterSpace('space-a')
    await flush()
    expect(tabOf(id).browserViewId).toBeTruthy()
    expect(tabOf(id).browserViewId).not.toBe(viewId)
  })

  it('only hide an AI page while away and keep its tab current', async () => {
    const id = await canvasLifecycle.attachAIBrowserView('ai-page', 'https://ai.test', 'AI')
    await canvasLifecycle.enterSpace('space-b')
    expect(hideBrowserView).toHaveBeenCalledWith('ai-page')
    expect(destroyBrowserView).not.toHaveBeenCalled()

    emitBrowserState({ viewId: 'ai-page', state: { isLoading: false, canGoBack: true, canGoForward: false, url: 'https://ai.test/next', title: 'Next' } })
    await canvasLifecycle.enterSpace('space-a')
    expect(tabOf(id)).toMatchObject({ browserViewId: 'ai-page', url: 'https://ai.test/next', title: 'Next' })
    expect(tabOf(id).browserState?.canGoBack).toBe(true)
  })

  it('drop a parked AI page tab when its page ends', async () => {
    const file = await openFile('/a/a.ts', 'a')
    const page = await canvasLifecycle.attachAIBrowserView('ai-page', 'https://ai.test', 'AI')
    await canvasLifecycle.enterSpace('space-b')

    await canvasLifecycle.closeTabsOfGoneView('ai-page')
    await canvasLifecycle.enterSpace('space-a')
    expect(shownIds()).toEqual([file])
    expect(canvasLifecycle.getActiveTabId()).toBe(file)
    expect(canvasLifecycle.getTab(page)).toBeUndefined()
  })
})

describe('closing all tabs while the space changes', () => {
  it('leaves the entered space alone when the switch comes during the unsaved-edits question', async () => {
    await canvasLifecycle.enterSpace('space-b')
    const fileB = await openFile('/b/b.ts', 'b')
    const terminalB = await canvasLifecycle.openTerminal('pty-b', 'zsh')
    await canvasLifecycle.enterSpace('space-a')
    const goal = await canvasLifecycle.openGoal('space-a', 'c1')
    canvasLifecycle.updateTabContent(goal, '{}')
    await canvasLifecycle.openTerminal('pty-a', 'zsh')
    let answer!: (discard: boolean) => void
    const unregister = canvasLifecycle.setDirtyCloseGuard('goal', () => new Promise(resolve => { answer = resolve }))

    const closing = canvasLifecycle.closeAll({ confirmDirty: true })
    await flush()
    await canvasLifecycle.enterSpace('space-b')
    answer(true)
    await closing
    unregister()

    expect(shownIds()).toEqual([fileB, terminalB])
    expect(canvasLifecycle.getIsOpen()).toBe(true)
    expect(disposeOnBulkClose).not.toHaveBeenCalled()

    await canvasLifecycle.enterSpace('space-a')
    expect(tabOf(goal)).toMatchObject({ content: '{}', isDirty: true })
  })

  it('leaves the entered space alone when the switch comes while a page is released', async () => {
    await canvasLifecycle.enterSpace('space-b')
    const fileB = await openFile('/b/b.ts', 'b')
    await canvasLifecycle.enterSpace('space-a')
    const page = await canvasLifecycle.openUrl('https://owned.test')
    await flush()
    const terminalA = await canvasLifecycle.openTerminal('pty-a', 'zsh')
    let finishHide!: () => void
    hideBrowserView.mockImplementationOnce(() => new Promise(resolve => { finishHide = () => resolve({ success: true }) }))

    const closing = canvasLifecycle.closeAll()
    await canvasLifecycle.enterSpace('space-b')
    finishHide()
    await closing
    await flush()

    expect(shownIds()).toEqual([fileB])
    expect(canvasLifecycle.getIsOpen()).toBe(true)
    expect(disposeOnBulkClose).not.toHaveBeenCalled()

    await canvasLifecycle.enterSpace('space-a')
    expect(shownIds()).toEqual([page, terminalA])
  })
})
