/**
 * Window Service - Centralized main window management
 *
 * Uses publish-subscribe pattern (consistent with artifact-cache.service.ts)
 * to notify modules when the main window changes.
 *
 * Benefits:
 * - Single source of truth for mainWindow reference
 * - Modules subscribe once, automatically get updates on window recreation
 * - Eliminates scattered setXxxMainWindow() calls in index.ts
 * - Supports renderer recovery (window recreation) seamlessly
 */

import { BrowserWindow } from 'electron'

// Callback type for window change listeners
type WindowChangeCallback = (window: BrowserWindow | null) => void

// Listener registry (same pattern as artifact-cache.service.ts)
const windowChangeListeners: WindowChangeCallback[] = []

// Current main window reference
let mainWindow: BrowserWindow | null = null

/**
 * Get the current main window
 * Returns null if window is destroyed or not created yet
 */
export function getMainWindow(): BrowserWindow | null {
  if (mainWindow && mainWindow.isDestroyed()) {
    mainWindow = null
  }
  return mainWindow
}

/**
 * Set the main window reference
 * Notifies all registered listeners of the change
 *
 * Called by:
 * - createWindow() when window is created
 * - window 'closed' event to clear reference
 * - recoverRenderer() when recreating window
 */
export function setMainWindow(window: BrowserWindow | null): void {
  const previousWindow = mainWindow
  mainWindow = window

  // Only notify if window actually changed
  if (previousWindow !== window) {
    console.log(`[WindowService] Main window ${window ? 'set' : 'cleared'}`)

    // Notify all listeners
    for (const listener of windowChangeListeners) {
      try {
        listener(window)
      } catch (error) {
        console.error('[WindowService] Listener error:', error)
      }
    }
  }
}

/**
 * Subscribe to window changes
 * Listener is called immediately if window already exists
 *
 * @param callback - Function to call when window changes
 * @returns Unsubscribe function
 *
 * Usage:
 * ```typescript
 * // In module initialization
 * onMainWindowChange((window) => {
 *   mainWindowRef = window
 * })
 * ```
 */
export function onMainWindowChange(callback: WindowChangeCallback): () => void {
  windowChangeListeners.push(callback)

  // Immediately call with current window (if exists)
  // This ensures modules get the reference even if they subscribe after window creation
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      callback(mainWindow)
    } catch (error) {
      console.error('[WindowService] Initial callback error:', error)
    }
  }

  // Return unsubscribe function
  return () => {
    const index = windowChangeListeners.indexOf(callback)
    if (index > -1) {
      windowChangeListeners.splice(index, 1)
    }
  }
}

/**
 * Send message to renderer via main window
 * Safely handles null/destroyed window
 *
 * @param channel - IPC channel name
 * @param args - Arguments to send
 * @returns true if message was sent, false otherwise
 */
export function sendToRenderer(channel: string, ...args: unknown[]): boolean {
  const window = getMainWindow()
  if (window && !window.isDestroyed()) {
    try {
      window.webContents.send(channel, ...args)
      return true
    } catch (error) {
      console.error(`[WindowService] Failed to send '${channel}':`, error)
    }
  }
  return false
}
