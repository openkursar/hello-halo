/**
 * Browser IPC Handlers
 *
 * Handles IPC communication for the embedded browser functionality.
 * Connects the renderer process to the BrowserView manager.
 */

import { ipcMain, BrowserWindow, Menu, shell, MenuItemConstructorOptions } from 'electron'
import { browserViewManager, type BrowserViewBounds } from '../services/browser-view.service'

/**
 * Browser context menu options from renderer
 */
interface BrowserMenuOptions {
  viewId: string
  url?: string
  zoomLevel: number
}

/**
 * Register all browser-related IPC handlers
 */
export function registerBrowserHandlers(mainWindow: BrowserWindow | null) {
  if (!mainWindow) {
    console.warn('[Browser IPC] No main window provided, skipping registration')
    return
  }

  // Initialize the BrowserView manager
  browserViewManager.initialize(mainWindow)

  // ============================================
  // Lifecycle
  // ============================================

  /**
   * Create a new BrowserView
   */
  ipcMain.handle(
    'browser:create',
    async (_event, { viewId, url }: { viewId: string; url?: string }) => {
      console.log(`[Browser IPC] >>> browser:create received - viewId: ${viewId}, url: ${url}`)
      try {
        const state = await browserViewManager.create(viewId, url)
        console.log(`[Browser IPC] <<< browser:create success`)
        return { success: true, data: state }
      } catch (error) {
        console.error('[Browser IPC] Create failed:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * Destroy a BrowserView
   */
  ipcMain.handle('browser:destroy', async (_event, { viewId }: { viewId: string }) => {
    try {
      browserViewManager.destroy(viewId)
      return { success: true }
    } catch (error) {
      console.error('[Browser IPC] Destroy failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * Show a BrowserView at specified bounds
   */
  ipcMain.handle(
    'browser:show',
    async (_event, { viewId, bounds }: { viewId: string; bounds: BrowserViewBounds }) => {
      console.log(`[Browser IPC] >>> browser:show received - viewId: ${viewId}, bounds:`, bounds)
      try {
        const result = browserViewManager.show(viewId, bounds)
        console.log(`[Browser IPC] <<< browser:show result: ${result}`)
        return { success: result }
      } catch (error) {
        console.error('[Browser IPC] Show failed:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * Hide a BrowserView
   */
  ipcMain.handle('browser:hide', async (_event, { viewId }: { viewId: string }) => {
    try {
      const result = browserViewManager.hide(viewId)
      return { success: result }
    } catch (error) {
      console.error('[Browser IPC] Hide failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * Resize a BrowserView
   */
  ipcMain.handle(
    'browser:resize',
    async (_event, { viewId, bounds }: { viewId: string; bounds: BrowserViewBounds }) => {
      try {
        const result = browserViewManager.resize(viewId, bounds)
        return { success: result }
      } catch (error) {
        console.error('[Browser IPC] Resize failed:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // ============================================
  // Navigation
  // ============================================

  /**
   * Navigate to a URL
   */
  ipcMain.handle(
    'browser:navigate',
    async (_event, { viewId, url }: { viewId: string; url: string }) => {
      try {
        const result = await browserViewManager.navigate(viewId, url)
        return { success: result }
      } catch (error) {
        console.error('[Browser IPC] Navigate failed:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * Go back in history
   */
  ipcMain.handle('browser:go-back', async (_event, { viewId }: { viewId: string }) => {
    try {
      const result = browserViewManager.goBack(viewId)
      return { success: result }
    } catch (error) {
      console.error('[Browser IPC] GoBack failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * Go forward in history
   */
  ipcMain.handle('browser:go-forward', async (_event, { viewId }: { viewId: string }) => {
    try {
      const result = browserViewManager.goForward(viewId)
      return { success: result }
    } catch (error) {
      console.error('[Browser IPC] GoForward failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * Reload the page
   */
  ipcMain.handle('browser:reload', async (_event, { viewId }: { viewId: string }) => {
    try {
      const result = browserViewManager.reload(viewId)
      return { success: result }
    } catch (error) {
      console.error('[Browser IPC] Reload failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * Stop loading
   */
  ipcMain.handle('browser:stop', async (_event, { viewId }: { viewId: string }) => {
    try {
      const result = browserViewManager.stop(viewId)
      return { success: result }
    } catch (error) {
      console.error('[Browser IPC] Stop failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // ============================================
  // State & Tools
  // ============================================

  /**
   * Get current state
   */
  ipcMain.handle('browser:get-state', async (_event, { viewId }: { viewId: string }) => {
    try {
      const state = browserViewManager.getState(viewId)
      return { success: true, data: state }
    } catch (error) {
      console.error('[Browser IPC] GetState failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * Capture screenshot
   */
  ipcMain.handle('browser:capture', async (_event, { viewId }: { viewId: string }) => {
    try {
      const dataUrl = await browserViewManager.capture(viewId)
      return { success: true, data: dataUrl }
    } catch (error) {
      console.error('[Browser IPC] Capture failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * Execute JavaScript
   */
  ipcMain.handle(
    'browser:execute-js',
    async (_event, { viewId, code }: { viewId: string; code: string }) => {
      try {
        const result = await browserViewManager.executeJS(viewId, code)
        return { success: true, data: result }
      } catch (error) {
        console.error('[Browser IPC] ExecuteJS failed:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * Set zoom level
   */
  ipcMain.handle(
    'browser:zoom',
    async (_event, { viewId, level }: { viewId: string; level: number }) => {
      try {
        const result = browserViewManager.setZoom(viewId, level)
        return { success: result }
      } catch (error) {
        console.error('[Browser IPC] Zoom failed:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * Toggle DevTools
   */
  ipcMain.handle('browser:dev-tools', async (_event, { viewId }: { viewId: string }) => {
    try {
      const result = browserViewManager.toggleDevTools(viewId)
      return { success: result }
    } catch (error) {
      console.error('[Browser IPC] DevTools toggle failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * Show native context menu for browser
   * Uses Electron Menu.popup() which renders above BrowserView
   */
  ipcMain.handle(
    'browser:show-context-menu',
    async (_event, options: BrowserMenuOptions) => {
      const { viewId, url, zoomLevel } = options

      // Build zoom submenu
      const zoomSubmenu: MenuItemConstructorOptions[] = [
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          enabled: zoomLevel < 200,
          click: () => {
            const newZoom = Math.min(200, zoomLevel + 10)
            browserViewManager.setZoom(viewId, newZoom / 100)
            mainWindow?.webContents.send('browser:zoom-changed', { viewId, zoomLevel: newZoom })
          }
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          enabled: zoomLevel > 50,
          click: () => {
            const newZoom = Math.max(50, zoomLevel - 10)
            browserViewManager.setZoom(viewId, newZoom / 100)
            mainWindow?.webContents.send('browser:zoom-changed', { viewId, zoomLevel: newZoom })
          }
        },
        {
          label: `Reset (${zoomLevel}%)`,
          accelerator: 'CmdOrCtrl+0',
          enabled: zoomLevel !== 100,
          click: () => {
            browserViewManager.setZoom(viewId, 1)
            mainWindow?.webContents.send('browser:zoom-changed', { viewId, zoomLevel: 100 })
          }
        }
      ]

      // Build main menu
      const menuTemplate: MenuItemConstructorOptions[] = [
        {
          label: 'Zoom',
          submenu: zoomSubmenu
        },
        { type: 'separator' },
        {
          label: 'Developer Tools',
          accelerator: 'F12',
          click: () => {
            browserViewManager.toggleDevTools(viewId)
          }
        }
      ]

      const menu = Menu.buildFromTemplate(menuTemplate)
      menu.popup({ window: mainWindow || undefined })

      return { success: true }
    }
  )

  /**
   * Canvas Tab context menu options from renderer
   */
  interface CanvasTabMenuOptions {
    tabId: string
    tabIndex: number
    tabTitle: string
    tabPath?: string
    tabCount: number
    hasTabsToRight: boolean
  }

  /**
   * Show native context menu for canvas tabs
   * Uses Electron Menu.popup() which renders above BrowserView
   */
  ipcMain.handle(
    'canvas:show-tab-context-menu',
    async (_event, options: CanvasTabMenuOptions) => {
      const { tabId, tabIndex, tabTitle, tabPath, tabCount, hasTabsToRight } = options
      const hasOtherTabs = tabCount > 1

      console.log('[Browser IPC] canvas:show-tab-context-menu received:', { tabId, tabIndex, tabTitle })

      // Build menu template
      const menuTemplate: MenuItemConstructorOptions[] = [
        {
          label: 'Close',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            console.log('[Browser IPC] Menu click: close tab', tabId)
            mainWindow?.webContents.send('canvas:tab-action', { action: 'close', tabId })
          }
        }
      ]

      // Close others (only if there are other tabs)
      if (hasOtherTabs) {
        menuTemplate.push({
          label: 'Close Others',
          click: () => {
            mainWindow?.webContents.send('canvas:tab-action', { action: 'closeOthers', tabId })
          }
        })
      }

      // Close to right (only if there are tabs to the right)
      if (hasTabsToRight) {
        menuTemplate.push({
          label: 'Close to the Right',
          click: () => {
            mainWindow?.webContents.send('canvas:tab-action', { action: 'closeToRight', tabId, tabIndex })
          }
        })
      }

      // Separator and copy path (if path exists)
      if (tabPath) {
        menuTemplate.push(
          { type: 'separator' },
          {
            label: 'Copy Path',
            click: () => {
              mainWindow?.webContents.send('canvas:tab-action', { action: 'copyPath', tabPath })
            }
          }
        )
      }

      // Refresh option (if path exists - for file tabs)
      if (tabPath) {
        menuTemplate.push({
          label: 'Refresh',
          click: () => {
            mainWindow?.webContents.send('canvas:tab-action', { action: 'refresh', tabId })
          }
        })
      }

      const menu = Menu.buildFromTemplate(menuTemplate)
      menu.popup({ window: mainWindow || undefined })

      return { success: true }
    }
  )

  console.log('[Browser IPC] Handlers registered')
}
