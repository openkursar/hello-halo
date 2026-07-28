/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * WebSocket Manager - Handles real-time communication with remote clients
 * Replaces IPC events for remote access
 */

import { WebSocket, WebSocketServer } from 'ws'
import { IncomingMessage } from 'http'
import { v4 as uuidv4 } from 'uuid'
import { authenticateWebSocket } from './auth/index'

interface WebSocketClient {
  id: string
  ws: WebSocket
  authenticated: boolean
  /** Socket address captured at upgrade time — feeds the auth lockout counters */
  ip: string
  subscriptions: Set<string> // conversationIds this client is subscribed to
}

// Store all connected clients
const clients = new Map<string, WebSocketClient>()

// WebSocket server instance
let wss: WebSocketServer | null = null

/**
 * Initialize WebSocket server
 */
export function initWebSocket(server: any): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const clientId = uuidv4()
    const client: WebSocketClient = {
      id: clientId,
      ws,
      authenticated: false,
      ip: req.socket.remoteAddress || 'unknown',
      subscriptions: new Set()
    }

    clients.set(clientId, client)
    console.log(`[WS] Client connected: ${clientId}`)

    // Handle messages from client
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString())
        handleClientMessage(client, message)
      } catch (error) {
        console.error('[WS] Invalid message:', error)
      }
    })

    // Handle disconnection
    ws.on('close', () => {
      clients.delete(clientId)
      releaseTerminalAttachments(clientId)
      console.log(`[WS] Client disconnected: ${clientId}`)
    })

    // Handle errors
    ws.on('error', (error) => {
      console.error(`[WS] Client error ${clientId}:`, error)
      clients.delete(clientId)
      releaseTerminalAttachments(clientId)
    })
  })

  console.log('[WS] WebSocket server initialized')
  return wss
}

/**
 * A vanished client must stop gating terminal flow control, or its unacked
 * backlog would pause a pty forever (see ai-terminal/flow-control.ts).
 */
function releaseTerminalAttachments(clientId: string): void {
  void import('../services/ai-terminal').then(({ terminalViewerDisconnected }) => {
    terminalViewerDisconnected(clientId)
  }).catch(() => { /* terminal module unavailable on this platform */ })
}

/**
 * Handle incoming message from client
 */
function handleClientMessage(
  client: WebSocketClient,
  message: { type: string; payload?: any }
): void {
  switch (message.type) {
    case 'auth':
      // Validate the token before marking as authenticated. Shares the HTTP
      // login's lockout counters — see authenticateWebSocket.
      if (message.payload?.token && authenticateWebSocket(message.payload.token, client.ip)) {
        client.authenticated = true
        sendToClient(client, { type: 'auth:success' })
        console.log(`[WS] Client ${client.id} authenticated successfully`)
      } else {
        sendToClient(client, { type: 'auth:failed', error: 'Invalid token' })
        console.log(`[WS] Client ${client.id} authentication failed`)
        // Close connection after failed auth
        setTimeout(() => client.ws.close(), 100)
      }
      break

    case 'subscribe':
      // Subscribe to conversation events (requires authentication)
      if (!client.authenticated) {
        sendToClient(client, { type: 'error', error: 'Not authenticated' })
        break
      }
      if (message.payload?.conversationId) {
        client.subscriptions.add(message.payload.conversationId)
        console.log(`[WS] Client ${client.id} subscribed to ${message.payload.conversationId}`)
      }
      break

    case 'unsubscribe':
      // Unsubscribe from conversation events
      if (message.payload?.conversationId) {
        client.subscriptions.delete(message.payload.conversationId)
      }
      break

    case 'ping':
      sendToClient(client, { type: 'pong' })
      break

    case 'terminal-input':
      // Low-latency remote keyboard → pty. Authenticated clients only.
      if (!client.authenticated) {
        sendToClient(client, { type: 'error', error: 'Not authenticated' })
        break
      }
      if (message.payload?.sessionId && typeof message.payload.data === 'string') {
        void import('../services/ai-terminal').then(({ terminalInput }) => {
          terminalInput(message.payload.sessionId, message.payload.data)
        })
      }
      break

    case 'terminal-resize': {
      if (!client.authenticated) {
        sendToClient(client, { type: 'error', error: 'Not authenticated' })
        break
      }
      const cols = Number(message.payload?.cols)
      const rows = Number(message.payload?.rows)
      if (
        typeof message.payload?.sessionId === 'string' &&
        Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0
      ) {
        void import('../services/ai-terminal').then(({ terminalResize }) => {
          terminalResize(message.payload.sessionId, cols, rows)
        })
      }
      break
    }

    // Remote viewer flow control: an attached viewer's rendered-char acks gate
    // the pty's output rate (see ai-terminal/flow-control.ts). The client id is
    // the viewer id, so a dropped connection detaches everything it gated.
    case 'terminal-attach':
      if (!client.authenticated) {
        sendToClient(client, { type: 'error', error: 'Not authenticated' })
        break
      }
      if (typeof message.payload?.sessionId === 'string') {
        void import('../services/ai-terminal').then(({ terminalViewerAttach }) => {
          terminalViewerAttach(message.payload.sessionId, client.id)
        })
      }
      break

    case 'terminal-detach':
      if (!client.authenticated) break
      if (typeof message.payload?.sessionId === 'string') {
        void import('../services/ai-terminal').then(({ terminalViewerDetach }) => {
          terminalViewerDetach(message.payload.sessionId, client.id)
        })
      }
      break

    case 'terminal-ack': {
      if (!client.authenticated) break
      const charCount = Number(message.payload?.charCount)
      if (typeof message.payload?.sessionId === 'string' && Number.isFinite(charCount)) {
        void import('../services/ai-terminal').then(({ terminalViewerAck }) => {
          terminalViewerAck(message.payload.sessionId, client.id, charCount)
        })
      }
      break
    }

    default:
      console.log(`[WS] Unknown message type: ${message.type}`)
  }
}

/**
 * Send message to a specific client
 */
function sendToClient(client: WebSocketClient, message: object): void {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(message))
  }
}

/**
 * Broadcast event to all subscribed clients
 * This is called from agent.service.ts
 */
export function broadcastToWebSocket(
  channel: string,
  data: Record<string, unknown>
): void {
  const conversationId = data.conversationId
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    // This function is strictly conversation-scoped. Missing conversationId would otherwise
    // silently drop events (no client can be subscribed to "undefined").
    console.warn(`[WS] broadcastToWebSocket called without conversationId for channel: ${channel}`)
    return
  }

  for (const client of Array.from(clients.values())) {
    // Only send to authenticated clients subscribed to this conversation
    if (client.authenticated && client.subscriptions.has(conversationId)) {
      sendToClient(client, {
        type: 'event',
        channel,
        data
      })
    }
  }
}

/**
 * Broadcast to all authenticated clients (for global events)
 */
export function broadcastToAll(channel: string, data: Record<string, unknown>): void {
  for (const client of Array.from(clients.values())) {
    if (client.authenticated) {
      sendToClient(client, {
        type: 'event',
        channel,
        data
      })
    }
  }
}

/**
 * Get connected client count
 */
export function getClientCount(): number {
  return clients.size
}

/**
 * Get authenticated client count
 */
export function getAuthenticatedClientCount(): number {
  let count = 0
  for (const client of Array.from(clients.values())) {
    if (client.authenticated) count++
  }
  return count
}

/**
 * Shutdown WebSocket server
 */
export function shutdownWebSocket(): void {
  if (wss) {
    for (const client of Array.from(clients.values())) {
      client.ws.close()
    }
    clients.clear()
    wss.close()
    wss = null
    console.log('[WS] WebSocket server shutdown')
  }
}
