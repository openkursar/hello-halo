/**
 * Browser and terminal tool telemetry: which surface a user opened a tool
 * from, and — once its Canvas tab closes — whether the tool was actually used.
 *
 * Only tabs opened through `trackToolOpen` are followed; tabs the AI or other
 * features open are never reported. Activity is counted from events alone:
 * page loads that start after the first one has settled for the browser, and
 * input chunks carrying an Enter for the terminal. URLs and typed text are
 * never kept. Tabs still open when the app quits are not reported.
 */

import { canvasLifecycle } from './canvas-lifecycle'
import { countBucket, trackHome } from './home-telemetry'
import { useAIBrowserStore } from '../stores/ai-browser.store'

export type ToolKind = 'browser' | 'terminal'
export type ToolOpenSurface =
  | 'more_menu' | 'mobile_menu' | 'canvas_new_tab' | 'shortcut' | 'live_session' | 'task_card'

export interface ToolSessionReport {
  tool: ToolKind
  used: boolean
  activityBucket: string
  durationBucket: string
}

export interface ToolTabSnapshot {
  isLoading: boolean
  terminalSessionId?: string
  /** A view the AI drives; loads while the AI is operating are not the user's. */
  aiDriven: boolean
}

export interface ToolSessionTracker {
  begin(tabId: string, tool: ToolKind, tab: ToolTabSnapshot): void
  syncOpenTabs(openTabIds: ReadonlySet<string>): void
  browserLoading(tabId: string, isLoading: boolean): void
  terminalInput(terminalSessionId: string, data: string): void
}

interface ToolSession {
  tool: ToolKind
  openedAt: number
  activity: number
  loading: boolean
  /** The load in flight when the tab opened is the initial page, not a navigation. */
  initialLoadDone: boolean
  aiDriven: boolean
  terminalSessionId?: string
}

const ACTIVITY_BOUNDS = [0, 1, 5, 20]

export function toolDurationBucket(ms: number): string {
  if (ms < 10_000) return '<10s'
  if (ms < 60_000) return '10s-1m'
  if (ms < 300_000) return '1-5m'
  if (ms < 1_800_000) return '5-30m'
  return '30m+'
}

export function createToolSessionTracker(deps: {
  now: () => number
  isAiDriving: () => boolean
  report: (session: ToolSessionReport) => void
}): ToolSessionTracker {
  const sessions = new Map<string, ToolSession>()

  return {
    begin(tabId, tool, tab) {
      if (sessions.has(tabId)) return
      sessions.set(tabId, {
        tool,
        openedAt: deps.now(),
        activity: 0,
        loading: tab.isLoading,
        initialLoadDone: !tab.isLoading,
        aiDriven: tab.aiDriven,
        terminalSessionId: tab.terminalSessionId,
      })
    },

    syncOpenTabs(openTabIds) {
      for (const [tabId, session] of sessions) {
        if (openTabIds.has(tabId)) continue
        sessions.delete(tabId)
        deps.report({
          tool: session.tool,
          used: session.activity > 0,
          activityBucket: countBucket(session.activity, ACTIVITY_BOUNDS),
          durationBucket: toolDurationBucket(deps.now() - session.openedAt),
        })
      }
    },

    browserLoading(tabId, isLoading) {
      const session = sessions.get(tabId)
      if (!session || session.tool !== 'browser') return
      const started = isLoading && !session.loading
      if (!isLoading && session.loading) session.initialLoadDone = true
      session.loading = isLoading
      if (started && session.initialLoadDone && !(session.aiDriven && deps.isAiDriving())) {
        session.activity++
      }
    },

    terminalInput(terminalSessionId, data) {
      if (!data.includes('\r')) return
      for (const session of sessions.values()) {
        if (session.terminalSessionId === terminalSessionId) session.activity++
      }
    },
  }
}

let tracker: ToolSessionTracker | null = null

function getTracker(): ToolSessionTracker {
  if (tracker) return tracker
  const created = createToolSessionTracker({
    now: Date.now,
    isAiDriving: () => Object.values(useAIBrowserStore.getState().operating).some(Boolean),
    report: (session) => trackHome('home.tool.session', { ...session }),
  })
  tracker = created
  canvasLifecycle.onTabListChange(tabs => created.syncOpenTabs(new Set(tabs.map(tab => tab.id))))
  canvasLifecycle.onBrowserStateChange((tabId, state) => created.browserLoading(tabId, state.isLoading))
  return created
}

/**
 * Records a user opening a tool and follows the tab it lands in. `opening`
 * resolves with that tab's id, or a falsy value when nothing opened.
 */
export function trackToolOpen(
  tool: ToolKind,
  surface: ToolOpenSurface,
  opening: Promise<string | null | undefined | void>,
): void {
  trackHome('home.tool.open', { tool, surface })
  opening.then((tabId) => {
    if (!tabId) return
    const tab = canvasLifecycle.getTab(tabId)
    if (!tab || tab.type !== tool) return
    getTracker().begin(tabId, tool, {
      isLoading: tab.isLoading,
      terminalSessionId: tab.terminalSessionId,
      aiDriven: tab.browserViewOwned === false,
    })
  }).catch((err) => {
    // Callers hand the opening over and don't await it, so this is the only
    // place its failure can surface. A tab that never opened has no session.
    console.error(`[ToolSession] Opening ${tool} failed:`, err)
  })
}

/** Fed with the user's raw terminal keystrokes; only the presence of Enter is read. */
export function noteTerminalInput(terminalSessionId: string, data: string): void {
  tracker?.terminalInput(terminalSessionId, data)
}
