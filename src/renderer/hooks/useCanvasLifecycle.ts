/**
 * React Hook for Canvas Lifecycle
 *
 * This hook bridges the imperative CanvasLifecycle manager with React's
 * declarative rendering model. It subscribes to state changes and triggers
 * re-renders when tabs, active tab, or browser state change.
 *
 * Usage:
 * ```tsx
 * const { tabs, activeTab, isOpen, openFile, closeTab } = useCanvasLifecycle()
 * ```
 */

import { useState, useEffect, useCallback } from 'react'
import {
  canvasLifecycle,
  type TabState,
  type BrowserState,
  type ContentType,
} from '../services/canvas-lifecycle'

/**
 * Main hook for Canvas lifecycle management
 * Provides reactive state and actions for tabs
 */
export function useCanvasLifecycle() {
  // Initialize with current state from canvasLifecycle (not empty)
  // This ensures we have correct state even before useEffect runs
  const [tabs, setTabs] = useState<TabState[]>(() => canvasLifecycle.getTabs())
  const [activeTabId, setActiveTabId] = useState<string | null>(() => canvasLifecycle.getActiveTabId())
  const [isOpen, setIsOpen] = useState(() => canvasLifecycle.getIsOpen())

  // Subscribe to state changes
  useEffect(() => {
    // Subscribe to all changes - callbacks will be called immediately with current state
    const unsubTabs = canvasLifecycle.onTabsChange(setTabs)
    const unsubActive = canvasLifecycle.onActiveTabChange(setActiveTabId)
    const unsubOpen = canvasLifecycle.onOpenStateChange(setIsOpen)

    return () => {
      unsubTabs()
      unsubActive()
      unsubOpen()
    }
  }, [])

  // Compute active tab
  const activeTab = activeTabId ? tabs.find(t => t.id === activeTabId) : undefined

  // Expose actions (bound to singleton)
  const openFile = useCallback(
    (path: string, title?: string) => canvasLifecycle.openFile(path, title),
    []
  )

  const openUrl = useCallback(
    (url: string, title?: string) => canvasLifecycle.openUrl(url, title),
    []
  )

  const attachAIBrowserView = useCallback(
    (viewId: string, url: string, title?: string) =>
      canvasLifecycle.attachAIBrowserView(viewId, url, title),
    []
  )

  const openContent = useCallback(
    (content: string, title: string, type: ContentType, language?: string) =>
      canvasLifecycle.openContent(content, title, type, language),
    []
  )

  const closeTab = useCallback(
    (tabId: string) => canvasLifecycle.closeTab(tabId),
    []
  )

  const closeAllTabs = useCallback(
    () => canvasLifecycle.closeAll(),
    []
  )

  const switchTab = useCallback(
    (tabId: string) => canvasLifecycle.switchTab(tabId),
    []
  )

  const switchToNextTab = useCallback(
    () => canvasLifecycle.switchToNextTab(),
    []
  )

  const switchToPrevTab = useCallback(
    () => canvasLifecycle.switchToPrevTab(),
    []
  )

  const switchToTabIndex = useCallback(
    (index: number) => canvasLifecycle.switchToTabIndex(index),
    []
  )

  const reorderTabs = useCallback(
    (fromIndex: number, toIndex: number) => canvasLifecycle.reorderTabs(fromIndex, toIndex),
    []
  )

  const refreshTab = useCallback(
    (tabId: string) => canvasLifecycle.refreshTab(tabId),
    []
  )

  const updateTabContent = useCallback(
    (tabId: string, content: string) => canvasLifecycle.updateTabContent(tabId, content),
    []
  )

  const saveScrollPosition = useCallback(
    (tabId: string, position: number) => canvasLifecycle.saveScrollPosition(tabId, position),
    []
  )

  const setOpen = useCallback(
    (open: boolean) => canvasLifecycle.setOpen(open),
    []
  )

  const toggleOpen = useCallback(
    () => canvasLifecycle.toggleOpen(),
    []
  )

  const updateBounds = useCallback(
    () => canvasLifecycle.updateActiveBounds(),
    []
  )

  const setContainerBoundsGetter = useCallback(
    (getter: () => DOMRect | null) => canvasLifecycle.setContainerBoundsGetter(getter),
    []
  )

  return {
    // State
    tabs,
    activeTabId,
    activeTab,
    isOpen,
    isTransitioning: canvasLifecycle.getIsTransitioning(),
    tabCount: tabs.length,

    // Tab Actions
    openFile,
    openUrl,
    attachAIBrowserView,
    openContent,
    closeTab,
    closeAllTabs,
    switchTab,
    switchToNextTab,
    switchToPrevTab,
    switchToTabIndex,
    reorderTabs,

    // Content Actions
    refreshTab,
    updateTabContent,
    saveScrollPosition,

    // Layout Actions
    setOpen,
    toggleOpen,

    // BrowserView Actions
    updateBounds,
    setContainerBoundsGetter,
  }
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

/**
 * Hook for just the open state (minimal re-renders)
 */
export function useCanvasIsOpen(): boolean {
  const [isOpen, setIsOpen] = useState(canvasLifecycle.getIsOpen())

  useEffect(() => {
    const unsub = canvasLifecycle.onOpenStateChange(setIsOpen)
    return unsub
  }, [])

  return isOpen
}

/**
 * Hook for just the tab count (minimal re-renders)
 */
export function useTabCount(): number {
  const [tabs, setTabs] = useState<TabState[]>(canvasLifecycle.getTabs())

  useEffect(() => {
    const unsub = canvasLifecycle.onTabsChange(setTabs)
    return unsub
  }, [])

  return tabs.length
}

/**
 * Hook for active tab only (minimal re-renders)
 */
export function useActiveTab(): TabState | undefined {
  const [tabs, setTabs] = useState<TabState[]>(canvasLifecycle.getTabs())
  const [activeTabId, setActiveTabId] = useState<string | null>(canvasLifecycle.getActiveTabId())

  useEffect(() => {
    const unsubTabs = canvasLifecycle.onTabsChange(setTabs)
    const unsubActive = canvasLifecycle.onActiveTabChange(setActiveTabId)
    return () => {
      unsubTabs()
      unsubActive()
    }
  }, [])

  return activeTabId ? tabs.find(t => t.id === activeTabId) : undefined
}

// Re-export types for convenience
export type { TabState, BrowserState, ContentType }
