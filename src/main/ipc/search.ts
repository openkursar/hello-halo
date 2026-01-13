/**
 * Search IPC Handlers
 *
 * Exposes search functionality to renderer process via IPC
 * Supports cancellable async search with progress updates
 */

import { ipcMain, BrowserWindow } from 'electron'
import { searchService, SearchResult } from '../services/search.service'

let mainWindow: BrowserWindow | null = null
let currentSearchId: string | null = null

/**
 * Initialize search IPC handlers
 * @param window - Main browser window for sending progress updates
 */
export function initializeSearchHandlers(window: BrowserWindow | null): void {
  mainWindow = window

  /**
   * Execute search across conversations
   * IPC Channel: 'search:execute'
   *
   * Args:
   * - query: string - Search query
   * - scope: 'conversation' | 'space' | 'global' - Search scope
   * - conversationId?: string - Current conversation ID
   * - spaceId?: string - Current space ID
   *
   * Returns: SearchResult[]
   */
  ipcMain.handle('search:execute', async (_event, query, scope, conversationId, spaceId) => {
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
  })

  /**
   * Cancel ongoing search
   * IPC Channel: 'search:cancel'
   *
   * Returns: void
   */
  ipcMain.handle('search:cancel', () => {
    currentSearchId = null
    searchService.cancel()

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('search:cancelled')
    }
  })
}

/**
 * Cleanup search handlers (called when app closes)
 */
export function cleanupSearchHandlers(): void {
  currentSearchId = null
  searchService.cancel()
}
