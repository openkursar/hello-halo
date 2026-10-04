/**
 * React bindings for the Canvas lifecycle manager.
 *
 * Each hook subscribes to exactly one kind of change, so a component re-renders
 * only for what it shows:
 * - `useTabList()` — the tab strip: tabs added/removed/reordered, titles,
 *   dirty/loading/error flags. Not content, not browser page churn.
 * - `useActiveTab()` — the one tab being viewed, including its content.
 * - `useActiveTabId()`, `useCanvasIsOpen()`, `useTabCount()` — single values.
 * - `useBrowserState(tabId)` — one browser tab's navigation state.
 * - `useCanvasActions()` — stable action functions; never re-renders.
 */

import { useState, useEffect, useSyncExternalStore } from 'react'
import {
  canvasLifecycle,
  type TabState,
  type BrowserState,
  type ContentType,
  type ChangesSource,
  type RevealTarget,
  type OpenFileOptions,
} from '../services/canvas-lifecycle'

const subscribeTabList = (onChange: () => void) => canvasLifecycle.onTabListChange(onChange)
const subscribeActiveTabId = (onChange: () => void) => canvasLifecycle.onActiveTabChange(onChange)
const subscribeOpenState = (onChange: () => void) => canvasLifecycle.onOpenStateChange(onChange)
const subscribeActiveTab = (onChange: () => void) => {
  const offActive = canvasLifecycle.onActiveTabChange(onChange)
  const offTab = canvasLifecycle.onTabChange(onChange)
  const offList = canvasLifecycle.onTabListChange(onChange)
  return () => {
    offActive()
    offTab()
    offList()
  }
}

const getTabList = () => canvasLifecycle.getTabListSnapshot()
const getActiveTabId = () => canvasLifecycle.getActiveTabId()
const getActiveTab = () => canvasLifecycle.getActiveTab()
const getIsOpen = () => canvasLifecycle.getIsOpen()
const getTabCount = () => canvasLifecycle.getTabCount()

/** Tabs in display order; a new array only when the list itself changes. */
export function useTabList(): readonly TabState[] {
  return useSyncExternalStore(subscribeTabList, getTabList)
}

/** The tab being viewed; a new object only when that tab changes. */
export function useActiveTab(): TabState | undefined {
  return useSyncExternalStore(subscribeActiveTab, getActiveTab)
}

export function useActiveTabId(): string | null {
  return useSyncExternalStore(subscribeActiveTabId, getActiveTabId)
}

export function useCanvasIsOpen(): boolean {
  return useSyncExternalStore(subscribeOpenState, getIsOpen)
}

export function useTabCount(): number {
  return useSyncExternalStore(subscribeTabList, getTabCount)
}

const canvasActions = {
  openFile: (path: string, titleOrOptions?: string | OpenFileOptions) => canvasLifecycle.openFile(path, titleOrOptions),
  openUrl: (url: string, title?: string) => canvasLifecycle.openUrl(url, title),
  attachAIBrowserView: (viewId: string, url: string, title?: string) =>
    canvasLifecycle.attachAIBrowserView(viewId, url, title),
  openContent: (content: string, title: string, type: ContentType, language?: string) =>
    canvasLifecycle.openContent(content, title, type, language),
  openTerminal: (sessionId: string, title?: string) => canvasLifecycle.openTerminal(sessionId, title),
  openTeam: (teamId: string, title?: string) => canvasLifecycle.openTeam(teamId, title),
  openChanges: (source: ChangesSource, options?: { reveal?: RevealTarget }) => canvasLifecycle.openChanges(source, options),
  setTabTitle: (tabId: string, title: string) => canvasLifecycle.setTabTitle(tabId, title),
  /** How tabs of `type` reload on the tab bar's Refresh; returns the unregister function. */
  setRefreshHandler: (type: ContentType, handler: (tab: TabState) => Promise<void>) =>
    canvasLifecycle.setRefreshHandler(type, handler),
  closeTab: (tabId: string) => canvasLifecycle.closeTab(tabId),
  closeAllTabs: () => canvasLifecycle.closeAll({ confirmDirty: true }),
  switchTab: (tabId: string) => canvasLifecycle.switchTab(tabId),
  switchToNextTab: () => canvasLifecycle.switchToNextTab(),
  switchToPrevTab: () => canvasLifecycle.switchToPrevTab(),
  switchToTabIndex: (index: number) => canvasLifecycle.switchToTabIndex(index),
  reorderTabs: (fromIndex: number, toIndex: number) => canvasLifecycle.reorderTabs(fromIndex, toIndex),
  refreshTab: (tabId: string) => canvasLifecycle.refreshTab(tabId),
  updateTabContent: (tabId: string, content: string) => canvasLifecycle.updateTabContent(tabId, content),
  markTabSaved: (tabId: string, content?: string) => canvasLifecycle.markTabSaved(tabId, content),
  revertTabContent: (tabId: string) => canvasLifecycle.revertTabContent(tabId),
  resolveDiskConflict: (tabId: string, keep: 'disk' | 'mine') => canvasLifecycle.resolveDiskConflict(tabId, keep),
  saveScrollPosition: (tabId: string, position: number) => canvasLifecycle.saveScrollPosition(tabId, position),
  toggleEditMode: (tabId: string) => canvasLifecycle.toggleEditMode(tabId),
  setEditMode: (tabId: string, editMode: boolean) => canvasLifecycle.setEditMode(tabId, editMode),
  /** The viewer handled the tab's reveal request `seq`. */
  consumeReveal: (tabId: string, seq: number) => canvasLifecycle.consumeReveal(tabId, seq),
  setOpen: (open: boolean) => canvasLifecycle.setOpen(open),
  toggleOpen: () => canvasLifecycle.toggleOpen(),
  // Native browser view placement, driven by the viewer that owns the container.
  setContainerBoundsGetter: (getter: () => DOMRect | null) => canvasLifecycle.setContainerBoundsGetter(getter),
  ensureActiveBrowserViewShown: () => canvasLifecycle.ensureActiveBrowserViewShown(),
  updateActiveBounds: () => canvasLifecycle.updateActiveBounds(),
  retryBlockedBrowserView: (tabId: string) => canvasLifecycle.retryBlockedBrowserView(tabId),
} as const

export type CanvasActions = typeof canvasActions

/** Canvas actions. The same object on every call — safe in deps, never re-renders. */
export function useCanvasActions(): CanvasActions {
  return canvasActions
}

/**
 * Hook for browser state of a specific tab
 * Subscribes to browser state changes for efficient updates
 */
export function useBrowserState(tabId: string | undefined) {
  const [browserState, setBrowserState] = useState<BrowserState>({
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
  })

  useEffect(() => {
    if (!tabId) return

    // Get initial state from tab
    const tab = canvasLifecycle.getTab(tabId)
    if (tab?.browserState) {
      setBrowserState(tab.browserState)
    }

    // Subscribe to changes
    const unsub = canvasLifecycle.onBrowserStateChange((id, state) => {
      if (id === tabId) {
        setBrowserState(state)
      }
    })

    return unsub
  }, [tabId])

  return browserState
}

// Re-export types for convenience
export type { TabState, BrowserState, ContentType }
