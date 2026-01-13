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
  // Whether AI Browser mode is enabled for current conversation
  enabled: boolean

  // Persistent preference: default state for new conversations
  defaultEnabled: boolean

  // Current active browser view ID (if any)
  activeViewId: string | null

  // Current URL being operated on by AI
  activeUrl: string | null

  // Loading state for browser operations
  isOperating: boolean

  // Last error from browser operations
  lastError: string | null

  // Actions
  setEnabled: (enabled: boolean) => void
  setDefaultEnabled: (enabled: boolean) => void
  setActiveViewId: (viewId: string | null) => void
  setActiveUrl: (url: string | null) => void
  setOperating: (isOperating: boolean) => void
  setError: (error: string | null) => void
  reset: () => void
}

// ============================================
// Store
// ============================================

export const useAIBrowserStore = create<AIBrowserState>()(
  persist(
    (set) => ({
      // Initial state
      enabled: false,
      defaultEnabled: false,
      activeViewId: null,
      activeUrl: null,
      isOperating: false,
      lastError: null,

      // Toggle AI Browser for current session
      setEnabled: (enabled: boolean) => {
        set({ enabled, lastError: null })
        console.log(`[AI Browser Store] Enabled: ${enabled}`)
      },

      // Set default preference (persisted)
      setDefaultEnabled: (defaultEnabled: boolean) => {
        set({ defaultEnabled })
        console.log(`[AI Browser Store] Default enabled: ${defaultEnabled}`)
      },

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

      // Reset state (e.g., on conversation change)
      reset: () => {
        set((state) => ({
          enabled: state.defaultEnabled,
          activeViewId: null,
          activeUrl: null,
          isOperating: false,
          lastError: null,
        }))
      },
    }),
    {
      name: 'halo-ai-browser',
      // Only persist the default preference
      partialize: (state) => ({
        defaultEnabled: state.defaultEnabled,
      }),
    }
  )
)

// ============================================
// Selectors
// ============================================

/**
 * Check if AI Browser is enabled
 */
export function useIsAIBrowserEnabled(): boolean {
  return useAIBrowserStore((state) => state.enabled)
}

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
  // Listen for active view changes from main process
  // This is triggered when AI Browser tools create or select a view
  const unsubscribe = api.onAIBrowserActiveViewChanged((data) => {
    const store = useAIBrowserStore.getState()
    store.setActiveViewId(data.viewId)
    if (data.url) {
      store.setActiveUrl(data.url)
    }
    console.log(`[AI Browser Store] Active view updated from main: ${data.viewId}, url: ${data.url}`)
  })

  return unsubscribe
}
