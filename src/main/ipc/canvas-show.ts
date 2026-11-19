/**
 * Canvas show IPC — carries the AI's "bring this in front of the user" request
 * to every client and their answers back:
 *  - canvas:show-request (event) — to the desktop window and every remote client
 *  - canvas:show-reply   (request) — one client's answer (remote: POST /api/canvas/show-reply)
 *
 * The service waits for as many answers as clients this reached.
 */

import { ipcMain } from 'electron'
import { onCanvasShowRequest, expectCanvasShowReplies, receiveCanvasShowReply } from '../services/canvas-show'
import { getMainWindow } from '../foundation/window.service'
import { broadcastToAll } from '../http/websocket'

let unsubscribe: (() => void) | null = null

export function registerCanvasShowHandlers(): void {
  unsubscribe = onCanvasShowRequest(request => {
    let clients = 0
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('canvas:show-request', request)
      clients++
    }
    try {
      clients += broadcastToAll('canvas:show-request', request as unknown as Record<string, unknown>)
    } catch {
      // WS not initialized yet: no remote client to ask
    }
    expectCanvasShowReplies(request.requestId, clients)
  })

  ipcMain.handle('canvas:show-reply', (_event, reply: unknown) => ({ success: receiveCanvasShowReply(reply) }))
}

export function cleanupCanvasShowHandlers(): void {
  ipcMain.removeHandler('canvas:show-reply')
  unsubscribe?.()
  unsubscribe = null
}
