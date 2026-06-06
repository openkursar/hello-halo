/**
 * Search IPC Handlers
 *
 * Exposes search functionality to renderer process via IPC
 * Supports cancellable async search with progress updates
 *
 * Registered from the typed RPC contract (passthrough — handler bodies and
 * return shapes preserved verbatim; search:execute keeps its searchId /
 * cancellation flow, search:cancel returns void).
 */

import { BrowserWindow } from 'electron'
import { searchService } from '../services/search.service'
import { getMainWindow, onMainWindowChange } from '../foundation/window.service'
import { searchRpc } from '../../shared/rpc/contracts/search.contract'
import { registerRawRpcHandlers } from './rpc'

let mainWindow: BrowserWindow | null = null
let currentSearchId: string | null = null

/**
 * Initialize search IPC handlers
 */
export function initializeSearchHandlers(): void {
  // Subscribe to window changes
  onMainWindowChange((window) => {
    mainWindow = window
  })

  registerRawRpcHandlers(searchRpc, {
    /**
     * Execute search across conversations (channel 'search:execute').
     * Returns: { success, data: SearchResult[] } | { success:false, error }
     */
    search: async (query, scope, conversationId, spaceId) => {
      const searchId = Math.random().toString(36).slice(2)
      currentSearchId = searchId

      try {
        // Reset cancel token
        searchService.cancel()

        // Execute search with progress callback
        const results = await searchService.search(
          query,
          scope,
          conversationId,
          spaceId,
          (current, total) => {
            // Only send progress if this search is still active
            if (currentSearchId === searchId && mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('search:progress', {
                current,
                total,
                searchId
              })
            }
          }
        )

        // Return results only if this search is still active
        if (currentSearchId === searchId) {
          currentSearchId = null
          return {
            success: true,
            data: results
          }
        }

        return {
          success: false,
          error: 'Search was cancelled'
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        console.error('Search execution error:', error)

        return {
          success: false,
          error: errorMessage
        }
      }
    },

    /**
     * Cancel ongoing search (channel 'search:cancel'). Returns: void
     */
    cancelSearch: () => {
      currentSearchId = null
      searchService.cancel()

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('search:cancelled')
      }
    },
  })
}

/**
 * Cleanup search handlers (called when app closes)
 */
export function cleanupSearchHandlers(): void {
  currentSearchId = null
  searchService.cancel()
}
