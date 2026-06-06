/**
 * Notification Service — System + In-App notifications
 *
 * Dual delivery strategy:
 * 1. OS-level Electron Notification (banner + Notification Center) — when window NOT focused
 * 2. In-app toast via IPC `notification:toast` — when window IS focused
 *
 * External channel notifications (email, webhook, etc.) are now AI-driven via
 * the notify_channel tool in halo-notify MCP server, not system-triggered here.
 *
 * This ensures the user always sees the notification regardless of window state.
 *
 * Specific triggers:
 * - Task completion (config-gated, background only)
 * - Automation app events (escalation, milestone, output)
 * - Automation app completion with output.notify.system enabled
 */

import { Notification } from 'electron'
import { getConfig } from '../foundation/config.service'
import { getMainWindow, sendToRenderer } from '../foundation/window.service'
import { broadcastToAll } from '../http/websocket'

// ── Helpers ────────────────────────────────────────────

/**
 * Check if the main window is currently focused.
 */
function isWindowFocused(): boolean {
  const mainWindow = getMainWindow()
  return !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused())
}

/**
 * Send an in-app toast to the renderer process.
 * The renderer's NotificationToast component picks this up via the notification store.
 */
function sendInAppToast(
  title: string,
  body: string,
  options?: { appId?: string; variant?: 'default' | 'success' | 'warning' | 'error'; duration?: number }
): void {
  const payload = {
    title,
    body,
    variant: options?.variant ?? 'default',
    duration: options?.duration ?? 0,
    appId: options?.appId,
  }

  // 1. Send to Electron renderer via IPC (desktop)
  const sent = sendToRenderer('notification:toast', payload)
  console.log(`[Notification] In-app toast sent=${sent}: title="${title}"`)

  // 2. Broadcast to remote/mobile WebSocket clients
  try {
    broadcastToAll('notification:toast', payload as unknown as Record<string, unknown>)
  } catch {
    // WebSocket module might not be initialized yet, ignore
  }
}

// ── Public API ─────────────────────────────────────────

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

  // Skip if window is focused - user is already looking at the app
  if (isWindowFocused()) return

  // Check config preference
  try {
    const config = getConfig()
    if (!config.notifications?.taskComplete) return
  } catch {
    // Config not available, skip silently
    return
  }

  try {
    const mainWindow = getMainWindow()
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

/**
 * Options for app event notifications.
 */
interface AppNotificationOptions {
  /** App ID — enables deep navigation to the App's Activity Thread on click */
  appId?: string
  /** Skip system/in-app notification (when output.notify.system === false) */
  skipSystem?: boolean
}

/**
 * Send a notification for an automation app event.
 *
 * Delivery strategy:
 * - System notification: OS-level (unfocused) or in-app toast (focused)
 *
 * When `appId` is provided:
 * - OS notification click → navigates to the App's Activity Thread
 * - In-app toast includes appId for the renderer to handle navigation
 *
 * @param title   - Notification title (typically the app name)
 * @param body    - Notification body text
 * @param options - Optional: appId, skipSystem
 */
export function notifyAppEvent(title: string, body: string, options?: AppNotificationOptions): void {
  console.log(`[Notification] notifyAppEvent called: title="${title}", appId=${options?.appId}`)

  // ── 1. System / In-App notification ──
  if (!options?.skipSystem) {
    const focused = isWindowFocused()
    console.log(`[Notification] mainWindow focused=${focused}`)

    if (focused) {
      // Window is focused — macOS suppresses OS notifications for foreground apps.
      // Send an in-app toast instead so the user always sees it.
      sendInAppToast(title, body, { appId: options?.appId, variant: 'default' })
    } else if (!Notification.isSupported()) {
      console.warn('[Notification] Notification.isSupported() = false — falling back to in-app toast')
      sendInAppToast(title, body, { appId: options?.appId, variant: 'default' })
    } else {
      try {
        const mainWindow = getMainWindow()

        const notification = new Notification({
          title,
          body,
          silent: false,
        })

        notification.on('click', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.focus()

            // Deep navigation: tell the renderer to open this App's Activity Thread
            if (options?.appId) {
              sendToRenderer('app:navigate', { appId: options.appId })
            }
          }
        })

        notification.show()
        console.log(`[Notification] OS notification.show() called`)
      } catch (error) {
        console.error('[Notification] Failed to show app event notification:', error)
        // Fallback to in-app toast if OS notification fails
        sendInAppToast(title, body, { appId: options?.appId, variant: 'default' })
      }
    }
  }
}
