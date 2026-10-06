/**
 * AI Browser IPC — event forwarding
 *
 * Bridges the AI Browser view-lifecycle bus to the renderer and remote clients:
 *  - ai-browser:active-view-changed — a conversation's active view (created/selected)
 *  - ai-browser:view-gone           — an AI-driven view was destroyed
 *  - ai-browser:conversation-released — a conversation's context ended; it holds no page
 *  - ai-browser:list-live-pages     — request: every page a conversation holds,
 *                                     for a renderer that missed the live events
 *  - ai-browser:stop-page           — request: tray stop, refused unless the page is
 *                                     the named conversation's alone
 *
 * Mirrors ipc/terminal.ts: subscribe once at startup (before any AI view
 * exists) and fan events out to the BrowserWindow and WebSocket clients. The
 * BrowserContext only emits to the bus; window/WS delivery lives here so the
 * context stays decoupled from any window reference.
 */

import { ipcMain } from 'electron'
import { onBrowserActiveView, onBrowserViewGone, onBrowserConversationReleased, listLivePages, stopLivePage } from '../services/ai-browser'
import { getMainWindow } from '../foundation/window.service'
import { broadcastToAll } from '../http/websocket'

const subscriptions: Array<() => void> = []

export function registerAIBrowserHandlers(): void {
  // The browser page registry is process-global; events carry the owning
  // conversationId in their payload and the renderer filters on it, so they go
  // out with broadcastToAll rather than the conversation-scoped WebSocket path.
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
  subscriptions.push(onBrowserConversationReleased((e) => {
    forward('ai-browser:conversation-released', e as unknown as Record<string, unknown>)
  }))

  ipcMain.handle('ai-browser:list-live-pages', () => ({
    success: true,
    data: listLivePages(),
  }))
  ipcMain.handle('ai-browser:stop-page', (_event, { viewId, conversationId }: { viewId: string; conversationId: string }) => ({
    success: true,
    data: stopLivePage(viewId, conversationId),
  }))
}

export function cleanupAIBrowserHandlers(): void {
  ipcMain.removeHandler('ai-browser:list-live-pages')
  ipcMain.removeHandler('ai-browser:stop-page')
  for (const unsub of subscriptions) unsub()
  subscriptions.length = 0
}
