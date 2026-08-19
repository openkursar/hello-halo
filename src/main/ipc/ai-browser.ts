/**
 * AI Browser IPC — event forwarding
 *
 * Bridges the AI Browser view-lifecycle bus to the renderer and remote clients:
 *  - ai-browser:active-view-changed — the AI's active view (created/selected)
 *  - ai-browser:view-gone           — the AI's active view was destroyed
 *
 * Mirrors ipc/terminal.ts: subscribe once at startup (before any AI view
 * exists) and fan events out to the BrowserWindow and WebSocket clients. The
 * BrowserContext only emits to the bus; window/WS delivery lives here so the
 * context stays decoupled from any window reference.
 */

import { onBrowserActiveView, onBrowserViewGone } from '../services/ai-browser/events'
import { getMainWindow } from '../foundation/window.service'
import { broadcastToAll } from '../http/websocket'

const subscriptions: Array<() => void> = []

export function registerAIBrowserHandlers(): void {
  // AI browser views are process-global (one BrowserView registry, not bound to
  // a conversation), so events carry a viewId but no conversationId — route them
  // with broadcastToAll rather than the conversation-scoped WebSocket path.
  const forward = (channel: string, data: Record<string, unknown>): void => {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data)
    }
    try {
      broadcastToAll(channel, data)
    } catch {
      // WS not initialized yet — ignore
    }
  }

  subscriptions.push(onBrowserActiveView((e) => {
    forward('ai-browser:active-view-changed', e as unknown as Record<string, unknown>)
  }))
  subscriptions.push(onBrowserViewGone((e) => {
    forward('ai-browser:view-gone', e as unknown as Record<string, unknown>)
  }))
}

export function cleanupAIBrowserHandlers(): void {
  for (const unsub of subscriptions) unsub()
  subscriptions.length = 0
}
