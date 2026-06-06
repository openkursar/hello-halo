/**
 * Agent IPC Handlers
 *
 * Bridges agent service events to Electron renderer via IPC.
 * The agent service layer emits events through Emitter<T>;
 * this module subscribes and forwards them to the BrowserWindow.
 */

import {
  sendMessage,
  injectMessage,
  stopGeneration,
  getSessionState,
  ensureSessionWarm,
  testMcpConnections,
  resolveQuestion,
  onAgentEvent,
  onAgentBroadcast
} from '../services/agent'
import { getEngineCapabilities, getActiveEngine } from '../services/agent/resolved-sdk'
import { defaultCapabilitiesFor } from '../services/agent/capabilities'
import { resolveCodexPendingQuestion } from '../services/agent/codex'
import { getMainWindow } from '../foundation/window.service'
import { broadcastToWebSocket, broadcastToAll } from '../http/websocket'
import { analytics } from '../services/analytics/analytics.service'
import { AnalyticsEvents } from '../services/analytics/types'
import { agentRpc } from '../../shared/rpc/contracts/agent.contract'
import { registerRawRpcHandlers } from './rpc'

// Module-level subscription disposables (lifetime = process lifetime)
// Stored to establish correct Disposable pattern; these are never disposed
// because agent event forwarding lives as long as the Electron main process.
const eventSubscriptions: import('../platform/event').IDisposable[] = []

export function registerAgentHandlers(): void {

  // ============================================
  // Event Forwarding (Emitter → IPC + WebSocket)
  // ============================================

  // Forward conversation-scoped agent events to renderer and WebSocket
  eventSubscriptions.push(onAgentEvent((e) => {
    const eventData = { ...e.data, spaceId: e.spaceId, conversationId: e.conversationId }

    // 1. Send to Electron renderer via IPC
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(e.channel, eventData)
    }

    // 2. Broadcast to remote WebSocket clients
    try {
      broadcastToWebSocket(e.channel, eventData)
    } catch {
      // WebSocket module might not be initialized yet, ignore
    }
  }))

  // Forward global broadcast events to renderer and WebSocket
  eventSubscriptions.push(onAgentBroadcast((e) => {
    // 1. Send to Electron renderer via IPC
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(e.channel, e.data)
    }

    // 2. Broadcast to remote WebSocket clients
    try {
      broadcastToAll(e.channel, e.data)
    } catch {
      // WebSocket module might not be initialized yet, ignore
    }
  }))

  // ============================================
  // IPC Handlers
  // ============================================

  registerRawRpcHandlers(agentRpc, {
    // Send message to agent (with optional images for multi-modal, optional thinking mode)
    sendMessage: async (
      request: {
        spaceId: string
        conversationId: string
        message: string
        resumeSessionId?: string
        images?: Array<{
          id: string
          type: 'image'
          mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
          data: string
          name?: string
          size?: number
        }>
        thinkingEnabled?: boolean  // Enable extended thinking mode
      }
    ) => {
      try {
        // Telemetry: count user-sent messages (no content)
        void analytics.track(AnalyticsEvents.MESSAGE_SENT, {
          source: 'agent',
          spaceId: request.spaceId,
          hasImages: Array.isArray(request.images) && request.images.length > 0,
        })
        await sendMessage(request)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        analytics.trackErrorSurface('agent-send', err)
        return { success: false, error: err.message }
      }
    },

    // Stop generation for a specific conversation (or all if not specified)
    stopGeneration: async (conversationId?: string) => {
      try {
        stopGeneration(conversationId)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Approve/reject tool execution - no-op (all permissions auto-allowed)
    approveTool: async () => ({ success: true }),
    rejectTool: async () => ({ success: true }),

    // Get current session state for recovery after refresh
    getSessionState: async (conversationId: string) => {
      try {
        const state = getSessionState(conversationId)
        return { success: true, data: state }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Warm up V2 session - call when switching conversations to prepare for faster message sending
    ensureSessionWarm: async (spaceId: string, conversationId: string) => {
      try {
        // Async initialization, non-blocking IPC call
        ensureSessionWarm(spaceId, conversationId).catch((error: unknown) => {
          console.error('[IPC] ensureSessionWarm error:', error)
        })
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Answer a pending AskUserQuestion.
    //
    // We try the Codex elicitation bridge first (its pending map lives in the
    // codex adapter), then fall back to the CC `permission-handler` map. Order
    // matters: ids are namespaced (`codex-ask-*` vs `ask-*`) and the maps are
    // disjoint, so this is a fast lookup with no risk of cross-resolution.
    answerQuestion: async (
      data: {
        conversationId: string
        id: string
        answers: Record<string, string>
      }
    ) => {
      try {
        if (resolveCodexPendingQuestion(data.id, data.answers)) {
          return { success: true }
        }
        const resolved = resolveQuestion(data.id, data.answers)
        if (!resolved) {
          return { success: false, error: 'No pending question found for this ID' }
        }
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Returns the capability descriptor for the active engine. The renderer
    // calls this once per session and uses the returned flags to drive
    // engine-aware UI affordances (todo state machine, thinking placeholder,
    // diff fallback). Falls back to the declarative default if the engine
    // module did not export its own descriptor — guarantees the renderer
    // always gets a usable shape.
    getEngineCapabilities: async () => {
      try {
        const caps = getEngineCapabilities()
        if (caps) return { success: true, data: caps }
        const engine = getActiveEngine() ?? 'anthropic'
        return { success: true, data: defaultCapabilitiesFor(engine) }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Inject a mid-turn message into an active session.
    // Called when user sends a message while generation is in progress (Agent Team mode).
    injectMessage: async (
      data: { conversationId: string; message: string }
    ) => {
      try {
        injectMessage(data.conversationId, data.message)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error(`[IPC] agent:inject-message error:`, err)
        return { success: false, error: err.message }
      }
    },

    // Test MCP server connections
    testMcpConnections: async () => {
      try {
        const result = await testMcpConnections()
        return result
      } catch (error: unknown) {
        const err = error as Error
        analytics.trackErrorSurface('mcp-connect', err)
        return { success: false, servers: [], error: err.message }
      }
    },
  })
}
