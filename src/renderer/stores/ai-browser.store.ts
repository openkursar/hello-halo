/**
 * AI Browser Store - State management for AI Browser mode
 *
 * Manages the AI Browser feature toggle and related state.
 * When AI Browser is enabled, the AI agent gains access to
 * browser control tools for web automation.
 *
 * Key features:
 * - Tracks active view ID for "View Live" functionality
 * - Listens for IPC events from main process when AI creates/selects views
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '../api'

// ============================================
// Types
// ============================================

interface AIBrowserState {
  // Current active browser view ID (if any) — the view the AI is driving.
  // This is the identity used to reveal the live view and to light the
  // "AI is operating this browser" indicator on the matching canvas tab.
  activeViewId: string | null

  // Current URL being operated on by AI
  activeUrl: string | null

  // Title of the AI's active view (from the main-process view state)
  activeTitle: string | null

  // Last time the AI's active view changed (for live-session ordering)
  lastActivityAt: number

  // Loading state for browser operations
  isOperating: boolean

  // Last error from browser operations
  lastError: string | null

  // Actions
  setActiveViewId: (viewId: string | null) => void
  setActiveUrl: (url: string | null) => void
  setOperating: (isOperating: boolean) => void
  setError: (error: string | null) => void
  /** Apply an active-view event from the main process (identity + metadata). */
  applyActiveView: (data: { viewId: string; url: string | null; title: string | null }) => void
  /** The AI's view was destroyed elsewhere; clear it if it is the active one. */
  handleViewGone: (viewId: string) => void
  reset: () => void
}

// ============================================
// Store
// ============================================

export const useAIBrowserStore = create<AIBrowserState>()(
  persist(
    (set) => ({
      // Initial state
      activeViewId: null,
      activeUrl: null,
      activeTitle: null,
      lastActivityAt: 0,
      isOperating: false,
      lastError: null,

      // Track active browser view
      setActiveViewId: (activeViewId: string | null) => {
        set({ activeViewId })
      },

      // Track active URL
      setActiveUrl: (activeUrl: string | null) => {
        set({ activeUrl })
      },

      // Track operation state
      setOperating: (isOperating: boolean) => {
        set({ isOperating })
      },

      // Set error state
      setError: (lastError: string | null) => {
        set({ lastError })
      },

      // Apply an active-view event from the main process
      applyActiveView: ({ viewId, url, title }) => {
        set(state => ({
          activeViewId: viewId,
          activeUrl: url ?? state.activeUrl,
          activeTitle: title ?? null,
          lastActivityAt: Date.now(),
        }))
      },

      // The AI's active view was destroyed elsewhere — clear if it matches
      handleViewGone: (viewId: string) => {
        set(state =>
          state.activeViewId === viewId
            ? { activeViewId: null, activeUrl: null, activeTitle: null, isOperating: false }
            : state
        )
      },

      // Reset state (e.g., on conversation change)
      reset: () => {
        set({
          activeViewId: null,
          activeUrl: null,
          activeTitle: null,
          lastActivityAt: 0,
          isOperating: false,
          lastError: null,
        })
      },
    }),
    {
      name: 'halo-ai-browser',
      // View-live state is all ephemeral; nothing to persist.
      partialize: () => ({}),
    }
  )
)

// ============================================
// Selectors
// ============================================

/**
 * Check if browser is currently operating
 */
export function useIsAIBrowserOperating(): boolean {
  return useAIBrowserStore((state) => state.isOperating)
}

/**
 * Get last error
 */
export function useAIBrowserError(): string | null {
  return useAIBrowserStore((state) => state.lastError)
}

/**
 * Get active view ID for "View Live" functionality
 */
export function useAIBrowserActiveViewId(): string | null {
  return useAIBrowserStore((state) => state.activeViewId)
}

/**
 * Get active URL being operated by AI
 */
export function useAIBrowserActiveUrl(): string | null {
  return useAIBrowserStore((state) => state.activeUrl)
}

/**
 * Get the title of the AI's active view
 */
export function useAIBrowserActiveTitle(): string | null {
  return useAIBrowserStore((state) => state.activeTitle)
}

// ============================================
// IPC Event Listeners
// ============================================

/**
 * Initialize IPC event listeners for AI Browser state sync
 * Call this during app initialization to enable real-time sync
 * between main process (BrowserContext) and renderer (this store)
 *
 * @returns Cleanup function to unsubscribe from events
 */
export function initAIBrowserStoreListeners(): () => void {
  // Active view changes: the AI created or selected a view. This is the
  // identity signal that powers "View live feed" and the operating indicator.
  const unsubActive = api.onAIBrowserActiveViewChanged((data) => {
    useAIBrowserStore.getState().applyActiveView(data)
    console.log(`[AI Browser Store] Active view updated from main: ${data.viewId}, url: ${data.url}`)
  })

  // View gone: the AI's active view was destroyed (canvas tab close / tray stop).
  const unsubGone = api.onAIBrowserViewGone((data) => {
    useAIBrowserStore.getState().handleViewGone(data.viewId)
    console.log(`[AI Browser Store] Active view gone from main: ${data.viewId}`)
  })

  return () => {
    unsubActive()
    unsubGone()
  }
}
