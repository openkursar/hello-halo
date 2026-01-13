/**
 * System IPC Handlers - Auto launch and tray settings
 */

import { ipcMain, BrowserWindow } from 'electron'
import {
  setAutoLaunch,
  getAutoLaunch,
  setMinimizeToTray,
  getMinimizeToTray
} from '../services/config.service'
import { createTray, destroyTray, hasTray, updateTrayMenu } from '../services/tray.service'

let mainWindow: BrowserWindow | null = null

export function registerSystemHandlers(window: BrowserWindow | null): void {
  mainWindow = window
  // Get auto launch status
  ipcMain.handle('system:get-auto-launch', async () => {
    try {
      const enabled = getAutoLaunch()
      return { success: true, data: enabled }
    } catch (error) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Set auto launch
  ipcMain.handle('system:set-auto-launch', async (_event, enabled: boolean) => {
    try {
      setAutoLaunch(enabled)
      return { success: true, data: enabled }
    } catch (error) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Get minimize to tray status
  ipcMain.handle('system:get-minimize-to-tray', async () => {
    try {
      const enabled = getMinimizeToTray()
      return { success: true, data: enabled }
    } catch (error) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Set minimize to tray
  ipcMain.handle('system:set-minimize-to-tray', async (_event, enabled: boolean) => {
    try {
      setMinimizeToTray(enabled)

      // Create or destroy tray based on setting
      if (enabled) {
        if (!hasTray()) {
          createTray(mainWindow)
        }
      } else {
        destroyTray()
      }

      return { success: true, data: enabled }
    } catch (error) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Set title bar overlay (Windows/Linux only)
  ipcMain.handle(
    'window:set-title-bar-overlay',
    async (_event, options: { color: string; symbolColor: string }) => {
      try {
        // Only works on Windows/Linux with titleBarOverlay enabled
        if (process.platform !== 'darwin' && mainWindow) {
          mainWindow.setTitleBarOverlay({
            color: options.color,
            symbolColor: options.symbolColor,
            height: 40
          })
        }
        return { success: true }
      } catch (error) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    }
  )

  // Maximize window
  ipcMain.handle('window:maximize', async () => {
    try {
      if (mainWindow) {
        mainWindow.maximize()
      }
      return { success: true }
    } catch (error) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Unmaximize window
  ipcMain.handle('window:unmaximize', async () => {
    try {
      if (mainWindow) {
        mainWindow.unmaximize()
      }
      return { success: true }
    } catch (error) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Check if window is maximized
  ipcMain.handle('window:is-maximized', async () => {
    try {
      const isMaximized = mainWindow?.isMaximized() ?? false
      return { success: true, data: isMaximized }
    } catch (error) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Toggle maximize
  ipcMain.handle('window:toggle-maximize', async () => {
    try {
      if (mainWindow) {
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize()
        } else {
          mainWindow.maximize()
        }
      }
      return { success: true, data: mainWindow?.isMaximized() ?? false }
    } catch (error) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Listen for maximize/unmaximize events and notify renderer
  if (mainWindow) {
    mainWindow.on('maximize', () => {
      mainWindow?.webContents.send('window:maximize-change', true)
    })
    mainWindow.on('unmaximize', () => {
      mainWindow?.webContents.send('window:maximize-change', false)
    })
  }
}
