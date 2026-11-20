/**
 * Closing the AI's tab really ends its work, and says so first; the user's own
 * terminal ends with its tab as before; what cannot be ended stays open and the
 * user is told why. These are the decisions behind the two close questions.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ electron: true }))
const killTerminal = vi.fn(async (_id: string): Promise<{ success: boolean; code?: string; error?: string }> => ({ success: true }))
const stopAIBrowserPage = vi.fn(async (_viewId: string, _conversationId: string): Promise<{ stopped: boolean; reason?: 'not-owned' | 'in-use' }> => ({ stopped: true }))

vi.mock('../../../src/renderer/api', () => ({
  api: {
    killTerminal: (id: string) => killTerminal(id),
    stopAIBrowserPage: (viewId: string, conversationId: string) => stopAIBrowserPage(viewId, conversationId),
  },
}))
vi.mock('../../../src/renderer/api/transport', () => ({ isElectron: () => env.electron }))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: { setTerminalTitle: vi.fn(), openTerminal: vi.fn() } }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: vi.fn() }))
vi.mock('../../../src/renderer/stores/chat/active', () => ({ selectActiveConversationId: vi.fn() }))
vi.mock('../../../src/renderer/stores/notification.store', () => ({ useNotificationStore: { getState: () => ({ show: vi.fn() }) } }))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

const { useTerminalStore } = await import('../../../src/renderer/stores/terminal.store')
const { useAIBrowserStore } = await import('../../../src/renderer/stores/ai-browser.store')
const {
  closesAIWork, isOwnRunningTerminal, isOperatingNow, endAIWork, createCloseDecisions,
} = await import('../../../src/renderer/services/ai-work-close')

type Tab = Parameters<typeof closesAIWork>[0]

const terminalInfo = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: id, shell: 'zsh', cwd: '/', cols: 80, rows: 24, owner: 'user', aiTouched: false,
  state: 'running', exitCode: null, lastActivityAt: 1, createdAt: 1, spaceId: 'space-1', ...extra,
})
const terminalTab = (id: string, aiWork = false): Tab => ({ id: `tab-${id}`, type: 'terminal', title: id, terminalSessionId: id, aiWork })
const pageTab = (viewId: string, aiWork = true): Tab => ({ id: `tab-${viewId}`, type: 'browser', title: viewId, browserViewId: viewId, aiWork })

function setTerminals(...infos: ReturnType<typeof terminalInfo>[]) {
  useTerminalStore.setState({ sessions: new Map(infos.map(info => [info.id, info as never])), operating: new Set(), operators: new Map() })
}
function setPage(viewId: string, conversationId = 'conv-1') {
  useAIBrowserStore.setState({
    pages: { [viewId]: { viewId, conversationId, spaceId: 'space-1', url: null, title: null, lastActivityAt: 1 } },
    views: { [conversationId]: { viewId, url: null, title: null, lastActivityAt: 1 } },
    operating: {},
  })
}

beforeEach(() => {
  env.electron = true
  killTerminal.mockClear().mockResolvedValue({ success: true })
  stopAIBrowserPage.mockClear().mockResolvedValue({ stopped: true })
  setTerminals()
  useAIBrowserStore.setState({ pages: {}, views: {}, operating: {} })
})

describe('what counts as the AI\'s work when closing', () => {
  it('is any tab carrying the mark, and a running terminal the AI touched even without one', () => {
    setTerminals(terminalInfo('mine'), terminalInfo('used', { aiTouched: true }), terminalInfo('over', { aiTouched: true, state: 'exited' }))
    expect(closesAIWork(terminalTab('mine'))).toBe(false)
    expect(closesAIWork(terminalTab('used'))).toBe(true)
    expect(closesAIWork(terminalTab('mine', true))).toBe(true)
    expect(closesAIWork(terminalTab('over'))).toBe(false)
    expect(closesAIWork(pageTab('p1'))).toBe(true)
    expect(closesAIWork({ id: 'f', type: 'code', title: 'a.ts' })).toBe(false)
  })

  it('treats only a running terminal the AI never touched as the user\'s own', () => {
    setTerminals(terminalInfo('mine'), terminalInfo('used', { aiTouched: true }), terminalInfo('over', { state: 'exited' }))
    expect(isOwnRunningTerminal(terminalTab('mine'))).toBe(true)
    expect(isOwnRunningTerminal(terminalTab('used'))).toBe(false)
    expect(isOwnRunningTerminal(terminalTab('over'))).toBe(false)
    expect(isOwnRunningTerminal(terminalTab('unknown'))).toBe(false)
  })

  it('knows whether the AI is operating it at this moment, for the wording of the question', () => {
    setTerminals(terminalInfo('used', { aiTouched: true }))
    useTerminalStore.setState({ operating: new Set(['used']) })
    expect(isOperatingNow(terminalTab('used', true))).toBe(true)
    useTerminalStore.setState({ operating: new Set() })
    expect(isOperatingNow(terminalTab('used', true))).toBe(false)

    setPage('p1')
    expect(isOperatingNow(pageTab('p1'))).toBe(false)
    useAIBrowserStore.setState({ operating: { 'conv-1': true } })
    expect(isOperatingNow(pageTab('p1'))).toBe(true)
  })
})

describe('ending the AI\'s work', () => {
  it('ends a terminal for real', async () => {
    setTerminals(terminalInfo('used', { aiTouched: true }))
    expect(await endAIWork(terminalTab('used', true))).toEqual({ ended: true })
    expect(killTerminal).toHaveBeenCalledWith('used')
  })

  it('reports a terminal that could not be ended, so its tab stays', async () => {
    setTerminals(terminalInfo('used', { aiTouched: true }))
    killTerminal.mockResolvedValue({ success: false, error: 'busy' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await endAIWork(terminalTab('used', true), { silent: true })).toEqual({ ended: false, reason: 'failed' })
  })

  it('counts a terminal that is already gone as ended', async () => {
    killTerminal.mockResolvedValue({ success: false, code: 'TERMINAL_NOT_FOUND' })
    expect(await endAIWork(terminalTab('gone', true))).toEqual({ ended: true })
  })

  it('ends the AI\'s page through the main process, naming the conversation that opened it', async () => {
    setPage('p1', 'conv-9')
    expect(await endAIWork(pageTab('p1'))).toEqual({ ended: true })
    expect(stopAIBrowserPage).toHaveBeenCalledWith('p1', 'conv-9')
  })

  it('leaves a page another conversation is on, without asking main', async () => {
    setPage('p1', 'conv-1')
    useAIBrowserStore.setState(state => ({ views: { ...state.views, 'conv-2': { viewId: 'p1', url: null, title: null, lastActivityAt: 1 } } }))
    expect(await endAIWork(pageTab('p1'))).toEqual({ ended: false, reason: 'in-use' })
    expect(stopAIBrowserPage).not.toHaveBeenCalled()
  })

  it('passes on main\'s refusal, and treats a page that already ended as done', async () => {
    setPage('p1')
    stopAIBrowserPage.mockResolvedValue({ stopped: false, reason: 'in-use' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await endAIWork(pageTab('p1'))).toEqual({ ended: false, reason: 'in-use' })
    expect(await endAIWork(pageTab('never-known'))).toEqual({ ended: true })
  })

  it('reports a page whose ending failed instead of throwing', async () => {
    setPage('p1')
    stopAIBrowserPage.mockRejectedValue(new Error('ipc down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await endAIWork(pageTab('p1'))).toEqual({ ended: false, reason: 'failed' })
  })
})

function questions(overrides: { confirmOne?: (tab: Tab, operating: boolean) => Promise<boolean>; confirmEndAll?: (tabs: readonly Tab[]) => Promise<boolean> } = {}) {
  return {
    confirmOne: vi.fn(overrides.confirmOne ?? (async () => true)),
    confirmEndAll: vi.fn(overrides.confirmEndAll ?? (async () => true)),
    reportNotEnded: vi.fn(),
  }
}

describe('closing one tab', () => {
  it('asks once about the AI\'s terminal, then ends it and closes the tab', async () => {
    setTerminals(terminalInfo('used', { aiTouched: true }))
    const asked = questions()
    const policy = createCloseDecisions(asked)
    expect(await policy.closeOne(terminalTab('used', true) as never)).toBe(true)
    expect(asked.confirmOne).toHaveBeenCalledTimes(1)
    expect(killTerminal).toHaveBeenCalledWith('used')
  })

  it('keeps the tab and the process when the user cancels', async () => {
    setTerminals(terminalInfo('used', { aiTouched: true }))
    const policy = createCloseDecisions(questions({ confirmOne: async () => false }))
    expect(await policy.closeOne(terminalTab('used', true) as never)).toBe(false)
    expect(killTerminal).not.toHaveBeenCalled()
  })

  it('tells the question whether the AI is operating the page right now', async () => {
    setPage('p1')
    useAIBrowserStore.setState({ operating: { 'conv-1': true } })
    const asked = questions()
    await createCloseDecisions(asked).closeOne(pageTab('p1') as never)
    expect(asked.confirmOne).toHaveBeenCalledWith(expect.objectContaining({ id: 'tab-p1' }), true)
  })

  it('keeps the tab and says why when the page could not be ended', async () => {
    setPage('p1')
    stopAIBrowserPage.mockResolvedValue({ stopped: false, reason: 'in-use' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const asked = questions()
    expect(await createCloseDecisions(asked).closeOne(pageTab('p1') as never)).toBe(false)
    expect(asked.reportNotEnded).toHaveBeenCalledWith([{ ended: false, reason: 'in-use' }])
  })

  it('never closes the AI\'s page on a client that cannot end it, and does not ask', async () => {
    env.electron = false
    setPage('p1')
    const asked = questions()
    expect(await createCloseDecisions(asked).closeOne(pageTab('p1') as never)).toBe(false)
    expect(asked.confirmOne).not.toHaveBeenCalled()
    expect(stopAIBrowserPage).not.toHaveBeenCalled()
  })

  it('ends the user\'s own terminal with its tab, unasked', async () => {
    setTerminals(terminalInfo('mine'))
    const asked = questions()
    expect(await createCloseDecisions(asked).closeOne(terminalTab('mine') as never)).toBe(true)
    expect(asked.confirmOne).not.toHaveBeenCalled()
    expect(killTerminal).toHaveBeenCalledWith('mine')
  })

  it('closes any other tab without a question', async () => {
    const asked = questions()
    expect(await createCloseDecisions(asked).closeOne({ id: 'f', type: 'code', title: 'a.ts' } as never)).toBe(true)
    expect(asked.confirmOne).not.toHaveBeenCalled()
  })
})

describe('closing several tabs', () => {
  const file = { id: 'f', type: 'code', title: 'a.ts' } as never

  it('closes the user\'s tabs and quietly keeps the AI\'s work among them', async () => {
    setTerminals(terminalInfo('t1', { aiTouched: true }), terminalInfo('mine'))
    setPage('p1')
    const asked = questions()
    const decision = await createCloseDecisions(asked).closeMany([file, terminalTab('t1', true), pageTab('p1'), terminalTab('mine')] as never)
    expect(decision).toEqual({ keep: new Set(['tab-t1', 'tab-p1']) })
    expect(asked.confirmEndAll).not.toHaveBeenCalled()
    expect(killTerminal.mock.calls.map(call => call[0])).toEqual(['mine'])
    expect(stopAIBrowserPage).not.toHaveBeenCalled()
  })

  it('does not ask when the AI\'s work is not among them', async () => {
    const asked = questions()
    expect(await createCloseDecisions(asked).closeMany([file])).toEqual({ keep: new Set() })
    expect(asked.confirmEndAll).not.toHaveBeenCalled()
  })

  it('asks once, listing them, when the AI\'s work is all that is closing', async () => {
    setTerminals(terminalInfo('t1', { aiTouched: true }), terminalInfo('t2', { aiTouched: true }))
    setPage('p1')
    const asked = questions()
    await createCloseDecisions(asked).closeMany([terminalTab('t1', true), terminalTab('t2', true), pageTab('p1')] as never)
    expect(asked.confirmEndAll).toHaveBeenCalledTimes(1)
    expect((asked.confirmEndAll.mock.calls[0] as unknown as [Tab[]])[0].map(tab => tab.id)).toEqual(['tab-t1', 'tab-t2', 'tab-p1'])
  })

  it('then ends all of it when told to', async () => {
    setTerminals(terminalInfo('t1', { aiTouched: true }))
    setPage('p1')
    const decision = await createCloseDecisions(questions()).closeMany([terminalTab('t1', true), pageTab('p1')] as never)
    expect(decision).toEqual({ keep: new Set() })
    expect(killTerminal).toHaveBeenCalledWith('t1')
    expect(stopAIBrowserPage).toHaveBeenCalledWith('p1', 'conv-1')
  })

  it('or cancels the whole close, ending nothing', async () => {
    setTerminals(terminalInfo('t1', { aiTouched: true }))
    const decision = await createCloseDecisions(questions({ confirmEndAll: async () => false })).closeMany([terminalTab('t1', true)] as never)
    expect(decision).toBeNull()
    expect(killTerminal).not.toHaveBeenCalled()
  })

  it('keeps whatever could not be ended and reports it', async () => {
    setTerminals(terminalInfo('t1', { aiTouched: true }))
    setPage('p1')
    stopAIBrowserPage.mockResolvedValue({ stopped: false, reason: 'in-use' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const asked = questions()
    const decision = await createCloseDecisions(asked).closeMany([terminalTab('t1', true), pageTab('p1')] as never)
    expect(decision).toEqual({ keep: new Set(['tab-p1']) })
    expect(asked.reportNotEnded).toHaveBeenCalledTimes(1)
  })

  it('only offers what this client can end, and keeps the AI\'s page it cannot', async () => {
    env.electron = false
    setTerminals(terminalInfo('t1', { aiTouched: true }))
    setPage('p1')
    const asked = questions()
    const decision = await createCloseDecisions(asked).closeMany([terminalTab('t1', true), pageTab('p1')] as never)
    expect((asked.confirmEndAll.mock.calls[0] as unknown as [Tab[]])[0].map(tab => tab.id)).toEqual(['tab-t1'])
    expect(decision).toEqual({ keep: new Set(['tab-p1']) })
  })

  it('asks nothing when only pages this client cannot end are closing: they are simply kept', async () => {
    env.electron = false
    setPage('p1')
    const asked = questions()
    const decision = await createCloseDecisions(asked).closeMany([pageTab('p1')] as never)
    expect(asked.confirmEndAll).not.toHaveBeenCalled()
    expect(decision).toEqual({ keep: new Set(['tab-p1']) })
  })
})

describe('a removed space', () => {
  it('ends the terminals of its tabs without asking', async () => {
    setTerminals(terminalInfo('t1', { aiTouched: true }), terminalInfo('mine'))
    const asked = questions()
    await createCloseDecisions(asked).endRemoved([terminalTab('t1', true), terminalTab('mine'), pageTab('p1')] as never)
    expect(killTerminal.mock.calls.map(call => call[0]).sort()).toEqual(['mine', 't1'])
    expect(asked.confirmOne).not.toHaveBeenCalled()
    expect(asked.confirmEndAll).not.toHaveBeenCalled()
  })
})
