/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * WebSocket Manager - Handles real-time communication with remote clients
 * Replaces IPC events for remote access
 */

import { WebSocket, WebSocketServer } from 'ws'
import { IncomingMessage } from 'http'
import { randomBytes } from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { validateToken, parseCredentialType, verifyOfficeCredential, type CredentialType } from './auth/index'
import { resolveIdentity, type AuthProof } from './identity/index'
import { getFederationStore, DEFAULT_OFFICE_SCOPE, type OfficeScope } from '../apps/federation/index'
import { getTeamStore } from '../apps/team'
import { parseTeamSessionKey } from '../../shared/apps/im-keys'

// The credential a client authenticated with. Drives per-credential event
// visibility: remote-control sees everything (unchanged); office-member is
// scoped to its own office's team sessions only.
interface ClientCredential {
  type: CredentialType
  officeId?: string
  scope?: OfficeScope
  /**
   * The node identity this office-member session PROVED at the auth handshake
   * via a device-key challenge–response (see the 'auth' case). Set only for
   * federation-node sessions; a bearer-only office session (viewer) has none
   * and is never allowed to speak federation frames. The federation host
   * asserts an inbound frame's self-reported `fromNode` against this bound
   * value to reject spoofed-origin frames (a joiner can only speak as the node
   * its session proved).
   */
  nodeId?: string
}

/**
 * One-shot auth challenge issued to a client that requested a federation-node
 * session. The nonce is signed by the client's identity key and verified via
 * the identity resolver registry; it is consumed on first use and expires so a
 * captured challenge cannot be replayed on a later connection.
 */
interface PendingChallenge {
  /** base64 nonce bytes the client must sign. */
  nonce: string
  issuedAt: number
}

/** A challenge older than this is void; the client must re-auth to get a new one. */
const CHALLENGE_TTL_MS = 60_000

interface WebSocketClient {
  id: string
  ws: WebSocket
  authenticated: boolean
  subscriptions: Set<string> // conversationIds this client is subscribed to
  credential: ClientCredential | null
  /** Outstanding federation-auth challenge, if any (one-shot, TTL-bound). */
  pendingChallenge: PendingChallenge | null
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
 * by the device-key challenge–response at auth; a joined node's nodeId equals
 * its Identity.id). Returns null for unknown/unauthenticated clients, bearer-only
 * viewer sessions, or non-office credentials — and a null here means the session
 * may never speak federation frames (enforced in the 'federation' case below).
 */
export function getSessionIdentity(clientId: string): string | null {
  const client = clients.get(clientId)
  if (!client || !client.authenticated) return null
  if (client.credential?.type !== 'office-member') return null
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
      pendingChallenge: null,
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
 * Consume the client's pending challenge (one-shot, TTL-bound) and resolve the
 * presented proof to an identity. Returns null on any failure: no outstanding
 * challenge, expired challenge, proof not signed over THIS challenge, or an
 * unresolvable/invalid proof. The challenge is cleared unconditionally so a
 * failed attempt can never retry against the same nonce.
 */
function consumeChallengeAndResolve(
  client: WebSocketClient,
  proof: unknown
): { id: string; displayName: string } | null {
  const challenge = client.pendingChallenge
  client.pendingChallenge = null
  if (!challenge) return null
  if (Date.now() - challenge.issuedAt > CHALLENGE_TTL_MS) return null
  if (typeof proof !== 'object' || proof === null) return null
  const p = proof as Record<string, unknown>
  // The proof must be over the nonce THIS connection issued — a signature over
  // any other bytes (e.g. a captured older challenge) is rejected before crypto.
  if (p.challenge !== challenge.nonce) return null
  return resolveIdentity(p as unknown as AuthProof)
}

/**
 * Roster re-entry admission check. A proven identity qualifies only when it is
 * ALREADY an admitted node of the office in the local ledger (fail-closed: no
 * ledger, no row → refused; this path never performs a first admission). The
 * session's scope is the invite overlay persisted on a member row this identity
 * brought in, falling back to the default-open overlay for pre-scope rows.
 */
function resolveReentrySession(
  officeId: string,
  identityId: string
): { scope: OfficeScope } | null {
  const node = getFederationStore()?.getNode(officeId, identityId)
  if (!node) return null
  const member = getTeamStore()
    ?.listMembersByTeam(officeId)
    .find((m) => m.memberIdentity === identityId && m.scopeJson)
  if (member?.scopeJson) {
    try {
      return { scope: JSON.parse(member.scopeJson) as OfficeScope }
    } catch {
      /* fall through to the default overlay */
    }
  }
  return { scope: DEFAULT_OFFICE_SCOPE }
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
          const wantsFederation = message.payload?.federation === true
          const proof: unknown = message.payload?.proof

          if (wantsFederation && !proof) {
            // Federation-node session leg 1: the invite token is a shareable
            // bearer and proves nothing about WHO presents it, so a node session
            // must additionally prove its portable identity. Issue a one-shot
            // nonce; the client answers with a device-key signature over it.
            client.pendingChallenge = {
              nonce: randomBytes(32).toString('base64'),
              issuedAt: Date.now(),
            }
            sendToClient(client, {
              type: 'auth:challenge',
              payload: { nonce: client.pendingChallenge.nonce },
            })
            console.log(`[WS] Client ${client.id} federation auth: challenge issued`)
            break
          }

          if (wantsFederation && proof) {
            // Leg 2: verify the signed challenge through the identity-resolver
            // registry (device-key today; SSO/internet resolvers plug in later).
            const identity = consumeChallengeAndResolve(client, proof)
            if (!identity) {
              sendToClient(client, { type: 'auth:failed', error: 'Invalid identity proof' })
              console.warn(`[WS] Client ${client.id} federation auth: proof rejected`)
              setTimeout(() => client.ws.close(), 100)
              break
            }
            client.authenticated = true
            client.credential = {
              type: 'office-member',
              officeId: cred.officeId,
              scope: cred.scope,
              nodeId: identity.id,
            }
            sendToClient(client, { type: 'auth:success' })
            console.log(`[WS] Client ${client.id} authenticated (office node ${identity.id})`)
            break
          }

          // Bearer-only office session (viewer): may subscribe to its office's
          // events and read via the scoped HTTP routes, but holds NO proven node
          // identity — it can never speak federation frames (gated below).
          client.authenticated = true
          client.credential = {
            type: 'office-member',
            officeId: cred.officeId,
            scope: cred.scope,
          }
          sendToClient(client, { type: 'auth:success' })
          console.log(`[WS] Client ${client.id} authenticated (office viewer)`)
          break
        }
      } else if (typeof token === 'string' && validateToken(token)) {
        client.authenticated = true
        client.credential = { type: 'remote-control' }
        sendToClient(client, { type: 'auth:success' })
        console.log(`[WS] Client ${client.id} authenticated successfully`)
        break
      }
      // Roster re-entry (federation only). A node whose invite token can no
      // longer be verified HERE — it was signed by a lost creator's key, e.g. a
      // survivor dialing a newly-elected authority — is re-admitted when its
      // PROVEN identity is already an admitted node of the office in the local
      // ledger. Never a first admission: an identity with no node row is refused.
      if (
        message.payload?.federation === true &&
        typeof message.payload?.officeId === 'string' &&
        message.payload.officeId
      ) {
        const reentryOfficeId: string = message.payload.officeId
        const proof: unknown = message.payload?.proof
        if (!proof) {
          client.pendingChallenge = {
            nonce: randomBytes(32).toString('base64'),
            issuedAt: Date.now(),
          }
          sendToClient(client, {
            type: 'auth:challenge',
            payload: { nonce: client.pendingChallenge.nonce },
          })
          console.log(`[WS] Client ${client.id} roster re-entry: challenge issued office=${reentryOfficeId}`)
          break
        }
        const identity = consumeChallengeAndResolve(client, proof)
        const admitted = identity ? resolveReentrySession(reentryOfficeId, identity.id) : null
        if (!identity || !admitted) {
          sendToClient(client, { type: 'auth:failed', error: 'Invalid identity proof' })
          console.warn(`[WS] Client ${client.id} roster re-entry rejected office=${reentryOfficeId}`)
          setTimeout(() => client.ws.close(), 100)
          break
        }
        client.authenticated = true
        client.credential = {
          type: 'office-member',
          officeId: reentryOfficeId,
          scope: admitted.scope,
          nodeId: identity.id,
        }
        sendToClient(client, { type: 'auth:success' })
        console.log(`[WS] Client ${client.id} re-admitted (office node ${identity.id})`)
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
      // office-member sessions with a PROVEN node identity may speak federation
      // (bearer-only viewers cannot — the invite link alone must never let its
      // holder inject frames), and only for their own office (the inbound handler
      // + coordinator re-verify the frame's officeId).
      if (
        !client.authenticated ||
        client.credential?.type !== 'office-member' ||
        !client.credential.officeId ||
        !client.credential.nodeId
      ) {
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
