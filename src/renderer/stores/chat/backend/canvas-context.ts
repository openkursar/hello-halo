/**
 * The canvas context sent with a chat message, whichever store the
 * conversation lives in.
 */
import { canvasLifecycle } from '../internal'
import type { CanvasContext } from '../internal'

/** What the user has open in the canvas, so the agent can refer to it naturally. */
export function buildCanvasContext(): CanvasContext | undefined {
  if (!canvasLifecycle.getIsOpen() || canvasLifecycle.getTabCount() === 0) return undefined

  const tabs = canvasLifecycle.getTabs()
  const activeTabId = canvasLifecycle.getActiveTabId()
  const activeTab = canvasLifecycle.getActiveTab()

  return {
    isOpen: true,
    tabCount: tabs.length,
    activeTab: activeTab ? {
      type: activeTab.type,
      title: activeTab.title,
      url: activeTab.url,
      path: activeTab.path,
      terminalSessionId: activeTab.terminalSessionId
    } : null,
    tabs: tabs.map(t => ({
      type: t.type,
      title: t.title,
      url: t.url,
      path: t.path,
      terminalSessionId: t.terminalSessionId,
      isActive: t.id === activeTabId
    }))
  }
}
