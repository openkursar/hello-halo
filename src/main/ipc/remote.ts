/**
 * Remote Access IPC Handlers
 * Allows renderer to control remote access features
 */

import { ipcMain, BrowserWindow } from 'electron'
import {
  enableRemoteAccess,
  disableRemoteAccess,
  enableTunnel,
  disableTunnel,
  getRemoteAccessStatus,
  generateQRCode,
  onRemoteAccessStatusChange,
  setCustomPassword,
  regeneratePassword
} from '../services/remote.service'

let mainWindow: BrowserWindow | null = null

export function registerRemoteHandlers(window: BrowserWindow | null): void {
  mainWindow = window

  // Enable remote access
  ipcMain.handle('remote:enable', async (_event, port?: number) => {
    console.log('[IPC] remote:enable called with port:', port)
    try {
      const status = await enableRemoteAccess(mainWindow, port)
      console.log('[IPC] remote:enable success:', status)
      return { success: true, data: status }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[IPC] remote:enable error:', err.message)
      return { success: false, error: err.message }
    }
  })

  // Disable remote access
  ipcMain.handle('remote:disable', async () => {
    try {
      await disableRemoteAccess()
      return { success: true }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Enable tunnel
  ipcMain.handle('remote:tunnel:enable', async () => {
    try {
      const url = await enableTunnel()
      return { success: true, data: { url } }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Disable tunnel
  ipcMain.handle('remote:tunnel:disable', async () => {
    try {
      await disableTunnel()
      return { success: true }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Get status
  ipcMain.handle('remote:status', async () => {
    try {
      const status = getRemoteAccessStatus()
      return { success: true, data: status }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Generate QR code
  ipcMain.handle('remote:qrcode', async (_event, includeToken?: boolean) => {
    try {
      const qrCode = await generateQRCode(includeToken)
      return { success: true, data: { qrCode } }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Set up status change listener
  onRemoteAccessStatusChange((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remote:status-change', status)
    }
  })

  // Set custom password
  ipcMain.handle('remote:set-password', async (_event, password: string) => {
    try {
      const result = setCustomPassword(password)
      if (result.success) {
        return { success: true, data: getRemoteAccessStatus() }
      } else {
        return { success: false, error: result.error }
      }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Regenerate random password
  ipcMain.handle('remote:regenerate-password', async () => {
    try {
      regeneratePassword()
      return { success: true, data: getRemoteAccessStatus() }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  console.log('[IPC] Remote access handlers registered')
}
