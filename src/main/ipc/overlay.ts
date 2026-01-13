/**
 * Overlay IPC Handlers
 *
 * Handles communication between renderer and overlay service
 *
 * NOTE: Overlay BrowserView is lazily initialized on first showChatCapsule() call
 * to avoid startup overhead. This reduces initial memory usage and speeds up app launch.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { overlayManager } from '../services/overlay.service'

/**
 * Register overlay IPC handlers
 */
export function registerOverlayHandlers(mainWindow: BrowserWindow | null): void {
  // Show chat capsule overlay (async - triggers lazy initialization on first call)
  ipcMain.handle('overlay:show-chat-capsule', async () => {
    console.log('[IPC] overlay:show-chat-capsule')
    await overlayManager.showChatCapsule()
    return true
  })

  // Hide chat capsule overlay
  ipcMain.handle('overlay:hide-chat-capsule', async () => {
    console.log('[IPC] overlay:hide-chat-capsule')
    overlayManager.hideChatCapsule()
    return true
  })

  // Set main window reference (lazy initialization - does NOT create BrowserView yet)
  // The overlay BrowserView will be created on first showChatCapsule() call
  if (mainWindow) {
    overlayManager.setMainWindow(mainWindow)
  }
}

/**
 * Clean up overlay handlers
 */
export function cleanupOverlayHandlers(): void {
  overlayManager.cleanup()
}
