/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * WebSocket Manager - Handles real-time communication with remote clients
 * Replaces IPC events for remote access
 */

import { WebSocket, WebSocketServer } from 'ws'
import { IncomingMessage } from 'http'
import { v4 as uuidv4 } from 'uuid'
import { validateToken, parseCredentialType, verifyOfficeCredential, type CredentialType } from './auth/index'
import type { OfficeScope } from '../apps/federation/index'
import { parseTeamSessionKey } from '../../shared/apps/im-keys'

// The credential a client authenticated with. Drives per-credential event
// visibility: remote-control sees everything (unchanged); office-member is
// scoped to its own office's team sessions only.
interface ClientCredential {
  type: CredentialType
  officeId?: string
  scope?: OfficeScope
  /**
   * The node identity this office-member session proved at the credential
   * handshake. The federation host asserts an inbound frame's self-reported
   * `fromNode` against this bound value to reject spoofed-origin frames
   * (a joiner can only speak as the node its credential authenticated as).
   */
  nodeId?: string
}

interface WebSocketClient {
  id: string
  ws: WebSocket
  authenticated: boolean
  subscriptions: Set<string> // conversationIds this client is subscribed to
  credential: ClientCredential | null
  /** Liveness flag for the ping/pong keepalive sweep (reset each ping). */
  isAlive: boolean
}

/**
 * Whether a conversationId belongs to the given office. Currently an office
 * maps 1:1 to a team, so officeId === teamId of the team session key.
 */
function isOfficeConversation(conversationId: string, officeId: string | undefined): boolean {
  if (!officeId) return false
  const parsed = parseTeamSessionKey(conversationId)
  return parsed !== null && parsed.teamId === officeId
}

// Store all connected clients
const clients = new Map<string, WebSocketClient>()

// WebSocket server instance
let wss: WebSocketServer | null = null

// ── Keepalive (WS-level ping/pong) ──────────────────────────────────────────
// Long-lived federation connections (joiner ↔ host) must survive NAT/firewall
// idle reaping and have dead peers detected promptly. A protocol-level ping
// every KEEPALIVE_INTERVAL_MS keeps the socket warm; a client that misses a
// pong between sweeps is terminated so its clientId frees up. Orthogonal to the
// app-level 'ping'/'pong' message and the federation presence heartbeats.
const KEEPALIVE_INTERVAL_MS = 15_000
let keepaliveTimer: ReturnType<typeof setInterval> | null = null

// ── Federation inbound seam (host side) ─────────────────────────────────────
// Incoming federation frames (from a joiner node's outbound connection) are
// routed to the runtime/federation layer via this registered handler, so this
// transport file stays decoupled from the federation module (mirrors the
// im-channels accessor pattern). The handler is set at startup by the
// FederationManager wiring; null until then (frames are dropped pre-init).
type FederationInboundHandler = (ctx: { clientId: string; officeId: string; frame: unknown }) => void
let federationInbound: FederationInboundHandler | null = null

export function setFederationInbound(handler: FederationInboundHandler | null): void {
  federationInbound = handler
}

/**
 * Send one federation frame to a specific connected client (host → joiner node).
 * The FederationManager maps a nodeId to the clientId that presented its
 * join-request. Returns false when the client is gone or not writable.
 */
export function sendFederationFrameToClient(clientId: string, frame: unknown): boolean {
  const client = clients.get(clientId)
  if (!client || client.ws.readyState !== WebSocket.OPEN) return false
  client.ws.send(JSON.stringify({ type: 'federation', payload: frame }))
  return true
}

/**
 * The node identity bound to a connected client's office-member session (proved
 * at the credential handshake; a joined node's nodeId equals its Identity.id).
 * Returns null for unknown/unauthenticated clients or non-office credentials.
 */
export function getSessionIdentity(clientId: string): string | null {
  const client = clients.get(clientId)
  if (!client || !client.authenticated) return null
  if (client.credential?.type !== 'office-member') return null
  // An empty nodeId is the unproven-placeholder identity (device-key identity
  // binding is deferred, so issuance mints `identity: ''`). Treat it as null so
  // the host anti-spoof gate stays inert until a real identity is bound; a
  // non-empty nodeId activates the gate for genuine identities.
  return client.credential.nodeId || null
}

/** Connected, authenticated office-member client ids for a given office. */
export function listOfficeClientIds(officeId: string): string[] {
  const ids: string[] = []
  for (const client of Array.from(clients.values())) {
    if (
      client.authenticated &&
      client.credential?.type === 'office-member' &&
      client.credential.officeId === officeId
    ) {
      ids.push(client.id)
    }
  }
  return ids
}

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
      subscriptions: new Set(),
      credential: null,
      isAlive: true
    }

    clients.set(clientId, client)
    console.log(`[WS] Client connected: ${clientId}`)

    // Keepalive: the peer (browser or the federation ws client) auto-replies to
    // protocol pings with a pong; mark alive so the sweep doesn't reap it.
    ws.on('pong', () => {
      client.isAlive = true
    })

    // Handle messages from client
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString())
        handleClientMessage(client, message)
      } catch (error) {
        console.error('[WS] Invalid message:', error)
      }
    })

    // Handle disconnection. Log the close code + reason so federation drops are
    // diagnosable (1006 = abnormal/no close frame → transport-level drop).
    ws.on('close', (code: number, reason: Buffer) => {
      clients.delete(clientId)
      const why = reason?.length ? reason.toString() : ''
      console.log(`[WS] Client disconnected: ${clientId} code=${code}${why ? ` reason=${why}` : ''}`)
    })

    // Handle errors
    ws.on('error', (error) => {
      console.error(`[WS] Client error ${clientId}:`, error)
      clients.delete(clientId)
    })
  })

  // Start the keepalive sweep once per server. Reap clients that missed a pong
  // since the last sweep; ping the rest. unref so it never holds the process.
  if (keepaliveTimer) clearInterval(keepaliveTimer)
  keepaliveTimer = setInterval(() => {
    for (const client of Array.from(clients.values())) {
      if (!client.isAlive) {
        console.warn(`[WS] Keepalive timeout; terminating client: ${client.id}`)
        try { client.ws.terminate() } catch { /* already gone */ }
        clients.delete(client.id)
        continue
      }
      client.isAlive = false
      try { client.ws.ping() } catch { /* will be reaped next sweep */ }
    }
  }, KEEPALIVE_INTERVAL_MS)
  if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref()

  console.log('[WS] WebSocket server initialized')
  return wss
}

/**
 * Handle incoming message from client
 */
function handleClientMessage(
  client: WebSocketClient,
  message: { type: string; payload?: any }
): void {
  switch (message.type) {
    case 'auth': {
      const token: unknown = message.payload?.token
      // An office token is verified independently from the remote-control PIN.
      if (typeof token === 'string' && parseCredentialType(token) === 'office-member') {
        const cred = verifyOfficeCredential(token)
        if (cred) {
          client.authenticated = true
          // Currently a node's id equals its office-member identity; bind it here
          // so getSessionIdentity can later assert it against inbound frames.
          client.credential = {
            type: 'office-member',
            officeId: cred.officeId,
            scope: cred.scope,
            nodeId: cred.identity,
          }
          sendToClient(client, { type: 'auth:success' })
          console.log(`[WS] Client ${client.id} authenticated (office-member)`)
          break
        }
      } else if (typeof token === 'string' && validateToken(token)) {
        client.authenticated = true
        client.credential = { type: 'remote-control' }
        sendToClient(client, { type: 'auth:success' })
        console.log(`[WS] Client ${client.id} authenticated successfully`)
        break
      }
      sendToClient(client, { type: 'auth:failed', error: 'Invalid token' })
      console.log(`[WS] Client ${client.id} authentication failed`)
      // Close connection after failed auth
      setTimeout(() => client.ws.close(), 100)
      break
    }

    case 'subscribe':
      // Subscribe to conversation events (requires authentication)
      if (!client.authenticated) {
        sendToClient(client, { type: 'error', error: 'Not authenticated' })
        break
      }
      if (message.payload?.conversationId) {
        const conversationId: string = message.payload.conversationId
        // Office-member clients may only subscribe to their own office's team
        // session keys — never an arbitrary session's agent:* stream.
        if (
          client.credential?.type === 'office-member' &&
          !isOfficeConversation(conversationId, client.credential.officeId)
        ) {
          sendToClient(client, { type: 'error', error: 'Subscription not permitted' })
          break
        }
        client.subscriptions.add(conversationId)
        console.log(`[WS] Client ${client.id} subscribed to ${conversationId}`)
      }
      break

    case 'unsubscribe':
      // Unsubscribe from conversation events
      if (message.payload?.conversationId) {
        client.subscriptions.delete(message.payload.conversationId)
      }
      break

    case 'federation':
      // Federation control/activity frames from a joiner node. Only authenticated
      // office-member clients may speak federation, and only for their own office
      // (the inbound handler + coordinator re-verify the frame's officeId).
      if (!client.authenticated || client.credential?.type !== 'office-member' || !client.credential.officeId) {
        sendToClient(client, { type: 'error', error: 'Federation not permitted' })
        break
      }
      try {
        federationInbound?.({ clientId: client.id, officeId: client.credential.officeId, frame: message.payload })
      } catch (err) {
        console.error('[WS] federation inbound handler error:', err)
      }
      break

    case 'ping':
      sendToClient(client, { type: 'pong' })
      break

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
    if (!client.authenticated || !client.subscriptions.has(conversationId)) continue
    // Defense-in-depth on top of the subscription gate: an office-member client
    // can NEVER receive an arbitrary session's stream, only its own office's
    // team sessions.
    if (
      client.credential?.type === 'office-member' &&
      !isOfficeConversation(conversationId, client.credential.officeId)
    ) {
      continue
    }
    sendToClient(client, {
      type: 'event',
      channel,
      data
    })
  }
}

/**
 * Broadcast to all authenticated clients (for global events)
 */
export function broadcastToAll(channel: string, data: Record<string, unknown>): void {
  for (const client of Array.from(clients.values())) {
    if (!client.authenticated) continue
    // Office-member clients receive only office-scoped events belonging to their
    // own office. Global events carry teamId (team:updated/blackboard/message);
    // an absent or foreign teamId is dropped — default deny.
    if (client.credential?.type === 'office-member') {
      if (data.teamId !== client.credential.officeId) continue
    }
    sendToClient(client, {
      type: 'event',
      channel,
      data
    })
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
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }
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
