/**
 * Decides which canvas tabs give up resources to stay within the canvas
 * budgets (shared/constants/canvas-budget.ts). Pure: the lifecycle manager
 * applies the plan.
 *
 * Never touched: the active tab, tabs with unsaved edits, terminals (a close
 * would end or prompt about a live pty) and browser views the AI attached
 * (their session outlives the tab).
 */

import type { TabState } from './canvas-lifecycle'

export interface CanvasBudgetLimits {
  maxOpenTabs: number
  maxLiveBrowserViews: number
  hiddenContentBytes: number
}

export interface CanvasBudgetPlan {
  /** Tabs to close. */
  close: string[]
  /** Owned browser views to destroy; the tab stays and recreates it when shown. */
  releaseView: string[]
  /** File tabs whose content/bytes to drop; re-read when shown. */
  unloadContent: string[]
}

/** Approximate bytes a tab's loaded content pins (UTF-16 text + raw bytes). */
export function tabContentBytes(tab: TabState): number {
  return (tab.content?.length ?? 0) * 2 + (tab.bytes?.byteLength ?? 0)
}

export function planCanvasBudget(
  tabs: readonly TabState[],
  activeTabId: string | null,
  lastActivated: ReadonlyMap<string, number>,
  limits: CanvasBudgetLimits
): CanvasBudgetPlan {
  const byRecency = (a: TabState, b: TabState) => (lastActivated.get(a.id) ?? 0) - (lastActivated.get(b.id) ?? 0)
  const hidden = tabs.filter(tab => tab.id !== activeTabId && !tab.isDirty).sort(byRecency)

  const closable = hidden.filter(tab => tab.type !== 'terminal' && tab.browserViewOwned !== false)
  const close = closable.slice(0, Math.max(0, tabs.length - limits.maxOpenTabs)).map(tab => tab.id)
  const closing = new Set(close)
  const remaining = hidden.filter(tab => !closing.has(tab.id))

  const activeTab = tabs.find(tab => tab.id === activeTabId)
  const liveViews = tabs.filter(tab => tab.browserViewId && !closing.has(tab.id)).length
  const releasable = remaining.filter(tab => tab.browserViewId && tab.browserViewOwned)
  const excessViews = liveViews - Math.max(limits.maxLiveBrowserViews, activeTab?.browserViewId ? 1 : 0)
  const releaseView = releasable.slice(0, Math.max(0, excessViews)).map(tab => tab.id)

  const unloadable = remaining.filter(tab => tab.path && !tab.browserViewId && tabContentBytes(tab) > 0)
  let held = unloadable.reduce((sum, tab) => sum + tabContentBytes(tab), 0)
  const unloadContent: string[] = []
  for (const tab of unloadable) {
    if (held <= limits.hiddenContentBytes) break
    unloadContent.push(tab.id)
    held -= tabContentBytes(tab)
  }

  return { close, releaseView, unloadContent }
}
