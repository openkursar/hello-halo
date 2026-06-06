/**
 * Overlay IPC Handlers
 *
 * Handles communication between renderer and overlay service
 *
 * NOTE: Overlay BrowserView is lazily initialized on first showChatCapsule() call
 * to avoid startup overhead. This reduces initial memory usage and speeds up app launch.
 */

import { BrowserWindow } from 'electron'
import { overlayManager } from '../services/overlay.service'
import { overlayRpc } from '../../shared/rpc/contracts/overlay.contract'
import { registerRawRpcHandlers } from './rpc'

/**
 * Register overlay IPC handlers
 */
export function registerOverlayHandlers(mainWindow: BrowserWindow | null): void {
  registerRawRpcHandlers(overlayRpc, {
    // Show chat capsule overlay (async - triggers lazy initialization on first call)
    showChatCapsuleOverlay: async () => {
      console.log('[IPC] overlay:show-chat-capsule')
      await overlayManager.showChatCapsule()
      return true
    },

    // Hide chat capsule overlay
    hideChatCapsuleOverlay: async () => {
      console.log('[IPC] overlay:hide-chat-capsule')
      overlayManager.hideChatCapsule()
      return true
    },
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
