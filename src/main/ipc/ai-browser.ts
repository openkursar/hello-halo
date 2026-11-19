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
 *  - ai-browser:credential-request  — a page waits on text the model must not hold
 *  - ai-browser:credential-resolved — that wait ended; open prompts must close
 *  - ai-browser:list-credential-requests / :submit-credential / :decline-credential
 *                                     — the user's answer, carrying values the
 *                                     model never sees
 *
 * Mirrors ipc/terminal.ts: subscribe once at startup (before any AI view
 * exists) and fan events out to the BrowserWindow and WebSocket clients. The
 * BrowserContext only emits to the bus; window/WS delivery lives here so the
 * context stays decoupled from any window reference.
 */

import { ipcMain } from 'electron'
import {
  onBrowserActiveView,
  onBrowserViewGone,
  onBrowserConversationReleased,
  onBrowserCredentialRequest,
  onBrowserCredentialResolved,
  listLivePages,
  stopLivePage,
  listPendingCredentialRequests,
  submitCredential,
  declineCredential,
} from '../services/ai-browser'
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
  subscriptions.push(onBrowserCredentialRequest((e) => {
    forward('ai-browser:credential-request', e as unknown as Record<string, unknown>)
  }))
  subscriptions.push(onBrowserCredentialResolved((e) => {
    forward('ai-browser:credential-resolved', e as unknown as Record<string, unknown>)
  }))

  ipcMain.handle('ai-browser:list-live-pages', () => ({
    success: true,
    data: listLivePages(),
  }))
  ipcMain.handle('ai-browser:stop-page', (_event, { viewId, conversationId }: { viewId: string; conversationId: string }) => ({
    success: true,
    data: stopLivePage(viewId, conversationId),
  }))

  // The values travel one way: into the page the request named. Nothing here
  // returns them, so a client cannot read back what another client typed.
  ipcMain.handle('ai-browser:list-credential-requests', () => ({
    success: true,
    data: listPendingCredentialRequests(),
  }))
  ipcMain.handle('ai-browser:submit-credential', (_event, { requestId, values }: { requestId: string; values: Record<string, string> }) => {
    const result = submitCredential(requestId, values)
    return result.accepted ? { success: true } : { success: false, error: result.error }
  })
  ipcMain.handle('ai-browser:decline-credential', (_event, { requestId }: { requestId: string }) => {
    const result = declineCredential(requestId)
    return result.accepted ? { success: true } : { success: false, error: result.error }
  })
}

export function cleanupAIBrowserHandlers(): void {
  ipcMain.removeHandler('ai-browser:list-live-pages')
  ipcMain.removeHandler('ai-browser:stop-page')
  ipcMain.removeHandler('ai-browser:list-credential-requests')
  ipcMain.removeHandler('ai-browser:submit-credential')
  ipcMain.removeHandler('ai-browser:decline-credential')
  for (const unsub of subscriptions) unsub()
  subscriptions.length = 0
}
