/**
 * System IPC Handlers - Auto launch, window controls, and logging
 */

import { app, BrowserWindow, shell } from 'electron'
import { dirname } from 'path'
import log from 'electron-log/main.js'
import { setAutoLaunch, getAutoLaunch } from '../foundation/config.service'
import { getMainWindow, onMainWindowChange } from '../foundation/window.service'
import { systemRpc } from '../../shared/rpc/contracts/system.contract'
import { registerRawRpcHandlers } from './rpc'

let mainWindow: BrowserWindow | null = null

export function registerSystemHandlers(): void {
  // Subscribe to window changes to set up event listeners
  onMainWindowChange((window) => {
    mainWindow = window
    if (window) {
      // Listen for maximize/unmaximize events and notify renderer
      window.on('maximize', () => {
        window.webContents.send('window:maximize-change', true)
      })
      window.on('unmaximize', () => {
        window.webContents.send('window:maximize-change', false)
      })
    }
  })

  registerRawRpcHandlers(systemRpc, {
    // Get auto launch status
    getAutoLaunch: async () => {
      console.log('[Settings] system:get-auto-launch - Getting auto launch status')
      try {
        const enabled = getAutoLaunch()
        console.log('[Settings] system:get-auto-launch - Status:', enabled)
        return { success: true, data: enabled }
      } catch (error) {
        const err = error as Error
        console.error('[Settings] system:get-auto-launch - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Set auto launch
    setAutoLaunch: async (enabled: boolean) => {
      console.log('[Settings] system:set-auto-launch - Setting to:', enabled)
      try {
        setAutoLaunch(enabled)
        console.log('[Settings] system:set-auto-launch - Set successfully')
        return { success: true, data: enabled }
      } catch (error) {
        const err = error as Error
        console.error('[Settings] system:set-auto-launch - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Set title bar overlay (Windows/Linux only)
    setTitleBarOverlay: async (options: { color: string; symbolColor: string }) => {
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
    },

    // Maximize window
    maximizeWindow: async () => {
      try {
        if (mainWindow) {
          mainWindow.maximize()
        }
        return { success: true }
      } catch (error) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Unmaximize window
    unmaximizeWindow: async () => {
      try {
        if (mainWindow) {
          mainWindow.unmaximize()
        }
        return { success: true }
      } catch (error) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Check if window is maximized
    isWindowMaximized: async () => {
      try {
        const isMaximized = mainWindow?.isMaximized() ?? false
        return { success: true, data: isMaximized }
      } catch (error) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Toggle maximize
    toggleMaximizeWindow: async () => {
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
    },

    // Open log folder in system file manager
    openLogFolder: async () => {
      console.log('[Settings] system:open-log-folder - Opening log folder')
      try {
        const logFile = log.transports.file.getFile()
        const logDir = dirname(logFile.path)
        await shell.openPath(logDir)
        console.log('[Settings] system:open-log-folder - Opened:', logDir)
        return { success: true, data: logDir }
      } catch (error) {
        const err = error as Error
        console.error('[Settings] system:open-log-folder - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Relaunch the application (used after settings that require restart)
    relaunch: async () => {
      console.log('[Settings] system:relaunch - Relaunching application')
      try {
        // Use setImmediate to allow the IPC response to reach renderer before exiting
        setImmediate(() => {
          try {
            app.relaunch()
            app.exit(0)
          } catch (error) {
            console.error('[Settings] system:relaunch - Relaunch failed:', (error as Error).message)
            app.exit(1)
          }
        })
        return { success: true }
      } catch (error) {
        const err = error as Error
        console.error('[Settings] system:relaunch - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },
  })

  console.log('[Settings] System handlers registered')
}
