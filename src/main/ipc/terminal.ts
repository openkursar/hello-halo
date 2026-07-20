/**
 * Terminal IPC Handlers
 *
 * Bridges the AI Terminal service to the renderer:
 *  - request/response: list / create / input / resize / kill / replay
 *  - events: terminal:data (pty output) + terminal:lifecycle (created/exited/
 *    title/ai-activity), forwarded to the BrowserWindow and remote WS clients.
 *
 * User keyboard input flows renderer → terminal:input → pty.write, giving
 * full-duplex control on desktop and (via HTTP/WS) remote/mobile clients.
 */

import {
  listTerminals,
  terminalInput,
  terminalResize,
  killTerminal,
  getTerminalReplay,
  createTerminalForUser,
  onTerminalData,
  onTerminalLifecycle
} from '../services/ai-terminal'
import { getWorkingDir } from '../services/agent'
import { getMainWindow } from '../foundation/window.service'
import { broadcastToAll } from '../http/websocket'
import { terminalRpc } from '../../shared/rpc/contracts/terminal.contract'
import { registerRawRpcHandlers } from './rpc'

const subscriptions: Array<() => void> = []

export function registerTerminalHandlers(): void {
  // ============================================
  // Event Forwarding (bus → IPC + WebSocket)
  // ============================================

  // Terminal sessions are process-global (one pty registry, not bound to any
  // conversation), so their events carry a sessionId but no conversationId.
  // Route them with broadcastToAll — the conversation-scoped broadcastToWebSocket
  // would drop every event for lack of a conversationId.
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

  subscriptions.push(onTerminalData((e) => {
    forward('terminal:data', e as unknown as Record<string, unknown>)
  }))
  subscriptions.push(onTerminalLifecycle((e) => {
    forward('terminal:lifecycle', e as unknown as Record<string, unknown>)
  }))

  // ============================================
  // Request/Response
  // ============================================

  registerRawRpcHandlers(terminalRpc, {
    listTerminals: async () => {
      try {
        return { success: true, data: listTerminals() }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    },

    createTerminal: async (data: { spaceId: string; shell?: string; cwd?: string; title?: string }) => {
      try {
        const workDir = getWorkingDir(data.spaceId)
        const result = createTerminalForUser(data.spaceId, workDir, { shell: data.shell, cwd: data.cwd, title: data.title })
        return result.ok ? { success: true, data: result.info } : { success: false, error: result.error }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    },

    terminalInput: async (data: { sessionId: string; data: string }) => {
      const ok = terminalInput(data.sessionId, data.data)
      return ok ? { success: true } : { success: false, error: 'No such terminal session' }
    },

    terminalResize: async (data: { sessionId: string; cols: number; rows: number }) => {
      const ok = terminalResize(data.sessionId, data.cols, data.rows)
      return ok ? { success: true } : { success: false, error: 'No such terminal session' }
    },

    killTerminal: async (data: { sessionId: string }) => {
      const ok = killTerminal(data.sessionId)
      return ok ? { success: true } : { success: false, error: 'No such terminal session' }
    },

    getTerminalReplay: async (data: { sessionId: string }) => {
      const replay = getTerminalReplay(data.sessionId)
      return replay ? { success: true, data: replay } : { success: false, error: 'No such terminal session' }
    },
  })
}

export function cleanupTerminalHandlers(): void {
  for (const unsub of subscriptions) unsub()
  subscriptions.length = 0
}
