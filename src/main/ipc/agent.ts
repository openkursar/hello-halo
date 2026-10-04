/**
 * Agent IPC Handlers
 *
 * Bridges agent service events to Electron renderer via IPC.
 * The agent service layer emits events through Emitter<T>;
 * this module subscribes and forwards them to the BrowserWindow.
 */

import {
  stopGeneration,
  getSessionState,
  ensureSessionWarm,
  testMcpConnections,
  probeMcpApp,
  resolveQuestion,
  listToolsets,
  openToolsetByUser,
  closeToolsetByUser,
  getConversationGoal,
  setConversationGoal,
  onAgentEvent,
  onAgentBroadcast
} from '../services/agent'
import type { GoalInput } from '../../shared/types/goal'
import type { AgentInjectRequest, AgentSendRequest } from '../../shared/types/agent-send'
import * as agentController from '../controllers/agent.controller'
import { getEngineCapabilities, getActiveEngine, getDegradedFromEngine } from '../services/agent/resolved-sdk'
import { getEngineAvailability } from '../services/agent/engine-availability'
import { defaultCapabilitiesFor } from '../services/agent/capabilities'
import { resolveCodexPendingQuestion } from '../services/agent/codex'
import { getMainWindow } from '../foundation/window.service'
import { broadcastToWebSocket, broadcastToAll } from '../http/websocket'
import { analytics } from '../services/analytics/analytics.service'
import { agentRpc } from '../../shared/rpc/contracts/agent.contract'
import { registerRawRpcHandlers } from './rpc'
import { markIntentionalStop } from '../apps/runtime'
import { ipcMain } from 'electron'
import { shouldDeliverAgentEvent } from '../../shared/agent-event-visibility'
import { clearDetailConversations, setDetailConversations } from '../services/conversation-detail'

/**
 * Conversations whose streaming detail each renderer declared it shows, keyed
 * by webContents id. A renderer that has not declared (yet, or since a reload)
 * receives status events only.
 */
const detailByRenderer = new Map<number, ReadonlySet<string>>()
const NO_DETAIL: ReadonlySet<string> = new Set()
const MAX_DECLARED_CONVERSATIONS = 200

/** Renderers whose reload/destroy is already followed (one listener pair each). */
const hookedRenderers = new Set<number>()

interface DeclaringRenderer {
  readonly id: number
  on(event: 'did-navigate', listener: () => void): unknown
  once(event: 'destroyed', listener: () => void): unknown
}

/** Record what `sender` renders in detail. Exported for tests. */
export function applyVisibilityDeclaration(sender: DeclaringRenderer, payload: unknown): void {
  const ids = Array.isArray(payload)
    ? payload.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  if (ids.length > MAX_DECLARED_CONVERSATIONS) {
    console.warn(`[Agent] Visible-conversation declaration truncated: ${ids.length} > ${MAX_DECLARED_CONVERSATIONS}`)
  }
  const id = sender.id
  if (!hookedRenderers.has(id)) {
    hookedRenderers.add(id)
    const forget = () => {
      detailByRenderer.delete(id)
      clearDetailConversations(`renderer:${id}`)
    }
    // A reload starts a fresh renderer that must declare again; the listeners
    // stay, so a reloading window never accumulates them.
    sender.on('did-navigate', forget)
    sender.once('destroyed', () => {
      hookedRenderers.delete(id)
      forget()
    })
  }
  const declared = new Set(ids.slice(0, MAX_DECLARED_CONVERSATIONS))
  detailByRenderer.set(id, declared)
  setDetailConversations(`renderer:${id}`, declared)
}

function registerVisibilityDeclaration(): void {
  ipcMain.on('agent:set-visible-conversations', (event, payload: unknown) => {
    applyVisibilityDeclaration(event.sender, payload)
  })
}

// Module-level subscription disposables (lifetime = process lifetime)
// Stored to establish correct Disposable pattern; these are never disposed
// because agent event forwarding lives as long as the Electron main process.
const eventSubscriptions: import('../platform/event').IDisposable[] = []

export function registerAgentHandlers(): void {
  registerVisibilityDeclaration()

  // ============================================
  // Event Forwarding (Emitter → IPC + WebSocket)
  // ============================================

  // Forward conversation-scoped agent events to renderer and WebSocket
  eventSubscriptions.push(onAgentEvent((e) => {
    const eventData = { ...e.data, spaceId: e.spaceId, conversationId: e.conversationId }

    // 1. Send to Electron renderer via IPC — streaming detail only for
    //    conversations it declared visible, status events for all.
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      const detail = detailByRenderer.get(mainWindow.webContents.id) ?? NO_DETAIL
      if (shouldDeliverAgentEvent(e.channel, e.conversationId, detail, e.data)) {
        mainWindow.webContents.send(e.channel, eventData)
      }
    }

    // 2. Broadcast to remote WebSocket clients (same rule, per client)
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
    // Send message to agent; checked and built field by field by the controller (shared with HTTP)
    sendMessage: (request: AgentSendRequest) => agentController.sendMessage(request),

    // Stop generation for a specific conversation (or all if not specified)
    stopGeneration: async (conversationId?: string) => {
      try {
        // Marked BEFORE stopping: a team member's stop kills its CC subprocess
        // outright (see control.ts), which surfaces the same way a crash does —
        // this is the only thing that tells turn-report.ts the difference.
        if (conversationId) markIntentionalStop(conversationId)
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

    // Which engines this build can actually run, plus the engine in use and the
    // configured-but-unavailable one when startup had to degrade. Settings uses
    // it to offer only runnable engines and to explain a degradation.
    getEngineAvailability: async () => {
      try {
        return {
          success: true,
          data: {
            engines: await getEngineAvailability(),
            activeEngine: getActiveEngine(),
            degradedFrom: getDegradedFromEngine(),
          },
        }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[IPC] agent:get-engine-availability error:', err)
        return { success: false, error: err.message }
      }
    },

    // Inject a mid-turn message into an active session.
    // Called when user sends a message while generation is in progress (Agent Team mode).
    injectMessage: async (data: AgentInjectRequest) => agentController.injectMessage(data),

    // Test MCP server connections
    testMcpConnections: async () => {
      try {
        return await testMcpConnections()
      } catch (error: unknown) {
        const err = error as Error
        analytics.trackErrorSurface('mcp-connect', err)
        return { success: false, servers: [], error: err.message }
      }
    },

    // Probe a single installed MCP app (native handshake, no agent session).
    // Updates the shared status cache and broadcasts agent:mcp-status.
    probeMcpApp: async (appId: string) => {
      try {
        return await probeMcpApp(appId)
      } catch (error: unknown) {
        const err = error as Error
        analytics.trackErrorSurface('mcp-probe', err)
        return { success: false, error: err.message }
      }
    },

    // List on-demand toolsets and their open/closed state for a conversation
    listToolsets: async (data: { spaceId: string; conversationId: string }) => {
      try {
        return { success: true, data: listToolsets(data.spaceId, data.conversationId) }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // User enables a toolset from the composer's "+" menu (schedules a session rebuild)
    openToolset: async (data: { spaceId: string; conversationId: string; toolsetId: string }) => {
      try {
        const result = await openToolsetByUser(data.spaceId, data.conversationId, data.toolsetId)
        return result.ok ? { success: true } : { success: false, error: result.error }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // User closes a toolset from the UI
    closeToolset: async (data: { spaceId: string; conversationId: string; toolsetId: string }) => {
      try {
        const result = await closeToolsetByUser(data.spaceId, data.conversationId, data.toolsetId)
        return result.ok ? { success: true } : { success: false, error: result.error }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Conversation goal; data is the goal or null
    getGoal: async (data: { spaceId: string; conversationId: string }) => {
      try {
        return { success: true, data: await getConversationGoal(data.spaceId, data.conversationId) }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[IPC] agent:goal-get error:', err)
        return { success: false, error: err.message }
      }
    },

    // Set (or clear with goal: null) the goal on the user's behalf; starts no turn
    setGoal: async (data: { spaceId: string; conversationId: string; goal: GoalInput | null }) => {
      try {
        return { success: true, data: await setConversationGoal(data.spaceId, data.conversationId, data.goal) }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[IPC] agent:goal-set error:', err)
        return { success: false, error: err.message }
      }
    },
  })
}
