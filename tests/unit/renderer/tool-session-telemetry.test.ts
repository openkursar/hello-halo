/**
 * Browser/terminal tool telemetry: open events, and the per-tab session
 * reported when a user-opened tab closes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolSessionReport } from '../../../src/renderer/services/tool-session-telemetry'

const trackEvent = vi.fn()

vi.mock('../../../src/renderer/api', () => ({ api: { trackEvent } }))
vi.mock('../../../src/renderer/api/transport', () => ({
  isElectron: () => true,
  isCapacitor: () => false,
}))

type Tab = { id: string; type: string; isLoading: boolean; terminalSessionId?: string; browserViewOwned?: boolean }

const canvas = vi.hoisted(() => {
  const state = {
    tabs: new Map<string, Tab>(),
    tabsListeners: new Set<(tabs: Tab[]) => void>(),
    browserListeners: new Set<(tabId: string, s: { isLoading: boolean }) => void>(),
  }
  return {
    state,
    lifecycle: {
      getTab: (id: string) => state.tabs.get(id),
      onTabsChange: (cb: (tabs: Tab[]) => void) => {
        state.tabsListeners.add(cb)
        cb([...state.tabs.values()])
        return () => state.tabsListeners.delete(cb)
      },
      onBrowserStateChange: (cb: (tabId: string, s: { isLoading: boolean }) => void) => {
        state.browserListeners.add(cb)
        return () => state.browserListeners.delete(cb)
      },
    },
  }
})

vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: canvas.lifecycle }))
vi.mock('../../../src/renderer/stores/ai-browser.store', () => ({
  useAIBrowserStore: { getState: () => ({ isOperating: false }) },
}))

const tools = await import('../../../src/renderer/services/tool-session-telemetry')

function emitted(event: string) {
  return trackEvent.mock.calls.filter(([name]) => name === event).map(([, props]) => props)
}

function setTabs(tabs: Tab[]) {
  canvas.state.tabs = new Map(tabs.map(tab => [tab.id, tab]))
  for (const cb of canvas.state.tabsListeners) cb(tabs)
}

describe('tool session tracker', () => {
  let now = 0
  let aiDriving = false
  const reports: ToolSessionReport[] = []
  const tracker = () => tools.createToolSessionTracker({
    now: () => now,
    isAiDriving: () => aiDriving,
    report: (r) => reports.push(r),
  })

  beforeEach(() => {
    now = 0
    aiDriving = false
    reports.length = 0
  })

  it('counts browser loads after the initial page as activity', () => {
    const t = tracker()
    t.begin('tab-1', 'browser', { isLoading: true, aiDriven: false })
    t.browserLoading('tab-1', true)
    t.browserLoading('tab-1', false)
    t.browserLoading('tab-1', true)
    t.browserLoading('tab-1', true)
    t.browserLoading('tab-1', false)
    t.browserLoading('tab-1', true)
    now = 90_000
    t.syncOpenTabs(new Set())

    expect(reports).toEqual([{ tool: 'browser', used: true, activityBucket: '2-5', durationBucket: '1-5m' }])
  })

  it('reports an untouched tab as unused, once', () => {
    const t = tracker()
    t.begin('tab-1', 'browser', { isLoading: false, aiDriven: false })
    now = 5_000
    t.syncOpenTabs(new Set())
    t.syncOpenTabs(new Set())

    expect(reports).toEqual([{ tool: 'browser', used: false, activityBucket: '0', durationBucket: '<10s' }])
  })

  it('ignores loads of an AI-driven view while the AI is operating', () => {
    const t = tracker()
    t.begin('tab-1', 'browser', { isLoading: false, aiDriven: true })
    aiDriving = true
    t.browserLoading('tab-1', true)
    t.browserLoading('tab-1', false)
    aiDriving = false
    t.browserLoading('tab-1', true)
    t.syncOpenTabs(new Set())

    expect(reports[0]).toMatchObject({ used: true, activityBucket: '1' })
  })

  it('counts terminal input chunks carrying Enter for the matching session only', () => {
    const t = tracker()
    t.begin('tab-1', 'terminal', { isLoading: false, terminalSessionId: 'pty-1', aiDriven: false })
    t.terminalInput('pty-1', 'l')
    t.terminalInput('pty-1', 's')
    t.terminalInput('pty-1', '\r')
    t.terminalInput('pty-2', '\r')
    t.terminalInput('pty-1', 'echo a\recho b\r')
    now = 40 * 60_000
    t.syncOpenTabs(new Set())

    expect(reports).toEqual([{ tool: 'terminal', used: true, activityBucket: '2-5', durationBucket: '30m+' }])
  })

  it('keeps following a tab that stays open', () => {
    const t = tracker()
    t.begin('tab-1', 'terminal', { isLoading: false, terminalSessionId: 'pty-1', aiDriven: false })
    t.syncOpenTabs(new Set(['tab-1']))
    expect(reports).toEqual([])
  })
})

describe('trackToolOpen', () => {
  beforeEach(() => {
    trackEvent.mockClear()
    setTabs([])
  })

  it('emits the open immediately and reports the session when its tab closes', async () => {
    const opening = Promise.resolve('tab-9').then((id) => {
      setTabs([{ id, type: 'terminal', isLoading: false, terminalSessionId: 'pty-9' }])
      return id
    })
    tools.trackToolOpen('terminal', 'more_menu', opening)
    expect(emitted('home.tool.open')).toEqual([{ tool: 'terminal', surface: 'more_menu', shell: 'wide' }])

    await opening
    await Promise.resolve()
    tools.noteTerminalInput('pty-9', '\r')
    setTabs([])

    expect(emitted('home.tool.session')).toEqual([
      { tool: 'terminal', used: true, activityBucket: '1', durationBucket: '<10s', shell: 'wide' },
    ])
  })

  it('follows no tab when nothing opened', async () => {
    const opening = Promise.resolve(null)
    tools.trackToolOpen('browser', 'shortcut', opening)
    await opening
    await Promise.resolve()
    setTabs([])

    expect(emitted('home.tool.open')).toHaveLength(1)
    expect(emitted('home.tool.session')).toEqual([])
  })
})
