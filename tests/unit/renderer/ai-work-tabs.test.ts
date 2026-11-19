/**
 * The AI's live work, by space: a running terminal it used, and every page one
 * of its conversations opened. Each client works this out from its own mirrors
 * of main, so ending it anywhere removes the tab everywhere.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ electron: true }))
const syncAIWork = vi.fn()
const updateAIPageMetadata = vi.fn()
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/api/transport', () => ({ isElectron: () => env.electron }))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({
  canvasLifecycle: { setTerminalTitle: vi.fn(), openTerminal: vi.fn(), syncAIWork: (...a: unknown[]) => syncAIWork(...a), closeTabsOfGoneView: vi.fn(), adoptPages: vi.fn(), updateAIPageMetadata: (...a: unknown[]) => updateAIPageMetadata(...a) },
}))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: vi.fn() }))
vi.mock('../../../src/renderer/stores/chat/active', () => ({ selectActiveConversationId: vi.fn() }))

const { useTerminalStore } = await import('../../../src/renderer/stores/terminal.store')
const { useAIBrowserStore } = await import('../../../src/renderer/stores/ai-browser.store')
const { collectAIWork, startAIWorkTabs, canEndOnThisClient } = await import('../../../src/renderer/services/ai-work-tabs')

const info = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `title ${id}`, shell: 'zsh', cwd: '/', cols: 80, rows: 24, owner: 'user' as const, aiTouched: true,
  state: 'running' as const, exitCode: null, lastActivityAt: 10, createdAt: 1, spaceId: 'space-1', ...extra,
})
const page = (viewId: string, spaceId: string | null = 'space-1') => ({ viewId, conversationId: 'conv-1', spaceId, url: `https://${viewId}.test`, title: viewId, lastActivityAt: 20 })

beforeEach(() => {
  env.electron = true
  syncAIWork.mockClear()
  useTerminalStore.setState({ sessions: new Map(), operating: new Set(), operators: new Map() })
  useAIBrowserStore.setState({ pages: {}, views: {}, operating: {} })
})

describe('collecting the AI\'s work', () => {
  it('is the running terminals the AI used and the pages it opened, grouped by space', () => {
    const sessions = new Map([
      ['t1', info('t1')],
      ['t2', info('t2', { spaceId: 'space-2' })],
    ])
    const work = collectAIWork(sessions as never, { p1: page('p1'), p2: page('p2', 'space-2') })
    expect([...work.keys()].sort()).toEqual(['space-1', 'space-2'])
    expect(work.get('space-1')).toEqual([
      { kind: 'terminal', sessionId: 't1', title: 'title t1', activityAt: 10 },
      { kind: 'page', viewId: 'p1', url: 'https://p1.test', title: 'p1', activityAt: 20 },
    ])
  })

  it('leaves out a terminal the AI never used, one that ended, and anything with no space', () => {
    const sessions = new Map([
      ['mine', info('mine', { aiTouched: false })],
      ['over', info('over', { state: 'exited' })],
      ['nowhere', info('nowhere', { spaceId: undefined })],
    ])
    expect(collectAIWork(sessions as never, { p: page('p', null) }).size).toBe(0)
  })
})

describe('keeping the canvas in line', () => {
  it('syncs once at the start and again when the terminals or pages change, not for other changes', () => {
    const stop = startAIWorkTabs()
    expect(syncAIWork).toHaveBeenCalledTimes(1)

    useTerminalStore.setState({ sessions: new Map([['t1', info('t1') as never]]) })
    expect(syncAIWork).toHaveBeenCalledTimes(2)
    expect(syncAIWork.mock.calls[1][0].get('space-1')).toHaveLength(1)

    useAIBrowserStore.setState({ pages: { p1: page('p1', 'space-2') } })
    expect(syncAIWork).toHaveBeenCalledTimes(3)
    expect(syncAIWork.mock.calls[2][1]).toEqual(new Set(['space-2']))
    useAIBrowserStore.getState().applyPageMetadata('p1', { title: 'Updated page' })
    useTerminalStore.getState().applyLifecycle({ sessionId: 't1', type: 'title', info: info('t1', { title: 'New terminal title' }) })
    expect(updateAIPageMetadata).toHaveBeenCalledWith('space-2', 'p1', 'https://p1.test', 'Updated page')
    expect(syncAIWork).toHaveBeenCalledTimes(3)

    // Whether the AI is operating something changes often and is none of this module's business.
    useTerminalStore.setState({ operating: new Set(['t1']) })
    useAIBrowserStore.setState({ operating: { 'conv-1': true } })
    expect(syncAIWork).toHaveBeenCalledTimes(3)

    stop()
    useTerminalStore.setState({ sessions: new Map() })
    expect(syncAIWork).toHaveBeenCalledTimes(3)
  })
})

describe('closing what the AI runs', () => {
  it('is possible on the desktop for everything', () => {
    expect(canEndOnThisClient({ aiWork: true, type: 'browser' })).toBe(true)
    expect(canEndOnThisClient({ aiWork: true, type: 'terminal' })).toBe(true)
  })

  it('is impossible for the AI\'s page on a remote client, which holds no browser pages', () => {
    env.electron = false
    expect(canEndOnThisClient({ aiWork: true, type: 'browser' })).toBe(false)
    expect(canEndOnThisClient({ aiWork: true, type: 'terminal' })).toBe(true)
    expect(canEndOnThisClient({ aiWork: false, type: 'browser' })).toBe(true)
  })
})
