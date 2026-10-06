/**
 * Canvas Store - Thin Proxy Layer for Canvas Lifecycle
 *
 * This store acts as a bridge between the existing codebase (that uses
 * useCanvasStore) and the new CanvasLifecycle manager. It delegates all
 * operations to canvasLifecycle while maintaining API compatibility.
 *
 * IMPORTANT: This is a transitional layer. New code should use
 * useCanvasLifecycle hooks directly. This store is kept for backward
 * compatibility with existing components.
 *
 * The actual state management is done by CanvasLifecycle singleton.
 * This store subscribes to canvasLifecycle changes and syncs state.
 */

import { create } from 'zustand'
import i18n from '../i18n'
import { useNotificationStore } from './notification.store'
import {
  canvasLifecycle,
  type TabState,
  type BrowserState,
  type ContentType,
} from '../services/canvas-lifecycle'

// Re-export types for backward compatibility
export type { BrowserState, ContentType }
export type CanvasTab = TabState

// ============================================
// Store Interface (Backward Compatible)
// ============================================

interface CanvasState {
  // State (synced from canvasLifecycle)
  isOpen: boolean
  /** Tab-list snapshot: fields outside the tab strip (content, bytes) may lag. */
  tabs: readonly TabState[]
  activeTabId: string | null
  isTransitioning: boolean

  // Maximized mode state (Canvas takes full screen, hide Header/Chat/Rail)
  isMaximized: boolean

  // Tab Actions (delegate to canvasLifecycle)
  openFile: (path: string, title?: string) => Promise<void>
  openUrl: (url: string, title?: string) => Promise<void>
  attachAIBrowserView: (viewId: string, url: string, title?: string) => Promise<string>
  openContent: (content: string, title: string, type: ContentType, language?: string) => void
  openTeam: (teamId: string, title?: string) => Promise<string>
  closeTab: (tabId: string) => void
  closeAllTabs: () => void
  switchTab: (tabId: string) => void
  switchToNextTab: () => void
  switchToPrevTab: () => void
  switchToTabIndex: (index: number) => void
  reorderTabs: (fromIndex: number, toIndex: number) => void

  // Content Actions
  refreshTab: (tabId: string) => Promise<void>
  updateTabContent: (tabId: string, content: string) => void
  saveScrollPosition: (tabId: string, position: number) => void

  // Browser Actions (kept for compatibility, but managed by canvasLifecycle)
  setBrowserViewId: (tabId: string, viewId: string) => void
  updateBrowserState: (tabId: string, state: Partial<BrowserState>) => void
  updateBrowserUrl: (tabId: string, url: string, title?: string) => void

  // Layout Actions
  setOpen: (open: boolean) => void
  toggleOpen: () => void

  // Maximized Mode Actions
  setMaximized: (maximized: boolean) => void
  toggleMaximized: () => void

  // Internal
  setTransitioning: (transitioning: boolean) => void
}

// ============================================
// Store Implementation
// ============================================

export const useCanvasStore = create<CanvasState>((set, get) => {
  // Subscribe to canvasLifecycle state changes synchronously
  // canvasLifecycle is auto-initialized on module load, ensuring IPC listeners
  // are ready before any React components mount
  canvasLifecycle.onTabListChange((tabs) => {
    set({ tabs })
  })

  canvasLifecycle.onActiveTabChange((activeTabId) => {
    set({ activeTabId })
  })

  canvasLifecycle.onOpenStateChange((isOpen) => {
    set({ isOpen })
  })

  canvasLifecycle.onBudgetEviction(({ closedTabs, limit }) => {
    useNotificationStore.getState().show({
      title: i18n.t('Closed {{count}} least recently used tab(s)', { count: closedTabs }),
      body: i18n.t('The canvas keeps up to {{limit}} tabs open. Tabs with unsaved changes are never closed.', { limit }),
      variant: 'default',
      duration: 5000,
    })
  })

  return {
    // Initial state - synchronized from canvasLifecycle singleton
    isOpen: canvasLifecycle.getIsOpen(),
    tabs: canvasLifecycle.getTabs(),
    activeTabId: canvasLifecycle.getActiveTabId(),
    isTransitioning: canvasLifecycle.getIsTransitioning(),

    // Maximized mode - local state (not in canvasLifecycle)
    isMaximized: false,

    // ============================================
    // Tab Actions (delegate to canvasLifecycle)
    // ============================================

    openFile: async (path: string, title?: string) => {
      await canvasLifecycle.openFile(path, title)
    },

    openUrl: async (url: string, title?: string) => {
      await canvasLifecycle.openUrl(url, title)
    },

    attachAIBrowserView: (viewId: string, url: string, title?: string) =>
      canvasLifecycle.attachAIBrowserView(viewId, url, title),

    openContent: (content: string, title: string, type: ContentType, language?: string) => {
      canvasLifecycle.openContent(content, title, type, language)
    },

    openTeam: (teamId: string, title?: string) => canvasLifecycle.openTeam(teamId, title),

    closeTab: (tabId: string) => {
      canvasLifecycle.closeTab(tabId)
    },

    closeAllTabs: () => {
      canvasLifecycle.closeAll({ confirmDirty: true })
    },

    switchTab: (tabId: string) => {
      canvasLifecycle.switchTab(tabId)
    },

    switchToNextTab: () => {
      canvasLifecycle.switchToNextTab()
    },

    switchToPrevTab: () => {
      canvasLifecycle.switchToPrevTab()
    },

    switchToTabIndex: (index: number) => {
      canvasLifecycle.switchToTabIndex(index)
    },

    reorderTabs: (fromIndex: number, toIndex: number) => {
      canvasLifecycle.reorderTabs(fromIndex, toIndex)
    },

    // ============================================
    // Content Actions
    // ============================================

    refreshTab: async (tabId: string) => {
      await canvasLifecycle.refreshTab(tabId)
    },

    updateTabContent: (tabId: string, content: string) => {
      canvasLifecycle.updateTabContent(tabId, content)
    },

    saveScrollPosition: (tabId: string, position: number) => {
      canvasLifecycle.saveScrollPosition(tabId, position)
    },

    // ============================================
    // Browser Actions (no-ops, managed by canvasLifecycle)
    // ============================================

    setBrowserViewId: (_tabId: string, _viewId: string) => {
      // No-op: browser page lifecycle is managed by canvasLifecycle
      console.warn('[canvas.store] setBrowserViewId is deprecated, managed by canvasLifecycle')
    },

    updateBrowserState: (_tabId: string, _state: Partial<BrowserState>) => {
      // No-op: Browser state updates come from canvasLifecycle via IPC
      console.warn('[canvas.store] updateBrowserState is deprecated, managed by canvasLifecycle')
    },

    updateBrowserUrl: (_tabId: string, _url: string, _title?: string) => {
      // No-op: URL updates come from canvasLifecycle via IPC
      console.warn('[canvas.store] updateBrowserUrl is deprecated, managed by canvasLifecycle')
    },

    // ============================================
    // Layout Actions
    // ============================================

    setOpen: (open: boolean) => {
      canvasLifecycle.setOpen(open)
    },

    toggleOpen: () => {
      canvasLifecycle.toggleOpen()
    },

    // ============================================
    // Maximized Mode Actions
    // ============================================

    setMaximized: (maximized: boolean) => {
      // When maximizing, ensure canvas is open
      if (maximized && !get().isOpen) {
        canvasLifecycle.setOpen(true)
      }
      // When exiting maximized, keep canvas open
      set({ isMaximized: maximized })
    },

    toggleMaximized: () => {
      const { isMaximized, isOpen } = get()
      if (!isMaximized && !isOpen) {
        canvasLifecycle.setOpen(true)
      }
      set({ isMaximized: !isMaximized })
    },

    setTransitioning: (transitioning: boolean) => {
      set({ isTransitioning: transitioning })
    },
  }
})

// ============================================
// Selectors (Backward Compatible)
// ============================================

/**
 * Selector: Is canvas open?
 */
export function useCanvasIsOpen(): boolean {
  return useCanvasStore(state => state.isOpen)
}

/**
 * Selector: Is transitioning?
 */
export function useIsTransitioning(): boolean {
  return useCanvasStore(state => state.isTransitioning)
}

/**
 * Selector: Is canvas maximized?
 */
export function useCanvasIsMaximized(): boolean {
  return useCanvasStore(state => state.isMaximized)
}
