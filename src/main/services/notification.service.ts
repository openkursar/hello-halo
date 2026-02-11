/**
 * Notification Service - System notifications for task completion
 *
 * Sends Electron Notification when:
 * - A task completes and the window is not focused
 * - Notification is enabled in config (notifications.taskComplete)
 *
 * Clicking the notification focuses the app window.
 */

import { Notification } from 'electron'
import { getConfig } from './config.service'
import { getMainWindow } from './window.service'

/**
 * Send a system notification when a task completes.
 * Only fires if:
 * 1. Notifications are enabled in config
 * 2. The main window is not currently focused
 * 3. The Electron Notification API is supported
 */
export function notifyTaskComplete(conversationTitle: string): void {
  // Skip if notifications aren't supported
  if (!Notification.isSupported()) return

  const mainWindow = getMainWindow()

  // Skip if window is focused - user is already looking at the app
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return

  // Check config preference
  try {
    const config = getConfig()
    if (!config.notifications?.taskComplete) return
  } catch {
    // Config not available, skip silently
    return
  }

  try {
    const notification = new Notification({
      title: 'Halo',
      body: `Task complete: ${conversationTitle}`,
      silent: false
    })

    notification.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
    })

    notification.show()
  } catch (error) {
    console.error('[Notification] Failed to show notification:', error)
  }
}
