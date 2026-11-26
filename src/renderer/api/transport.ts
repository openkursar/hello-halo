/**
 * Transport Layer - Abstracts IPC vs HTTP communication
 *
 * Three modes:
 * 1. Electron  — window.halo exists → IPC
 * 2. Capacitor — Capacitor.isNativePlatform() → HTTP to user-configured server
 * 3. Remote    — neither → HTTP to window.location.origin
 */

import { ENTERPRISE_IDENTITY_CHANGED_EVENT } from '../../shared/rpc/contracts/enterprise-identity.contract'
import i18n from '../i18n'

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/** Detect if running in Electron (has window.halo via preload) */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && 'halo' in window
}

/** Detect if running inside a Capacitor native shell */
export function isCapacitor(): boolean {
  // Compile-time flag set by vite.config.mobile.ts (most reliable)
  if (typeof __CAPACITOR__ !== 'undefined' && __CAPACITOR__) return true
  // Runtime detection via Capacitor bridge injection
  if (typeof window === 'undefined') return false
  try {
    const cap = (window as any).Capacitor
    return cap?.isNativePlatform?.() === true
  } catch {
    return false
  }
}

// Declare compile-time global
declare const __CAPACITOR__: boolean | undefined

/** Detect if running as remote web client (browser tab) */
export function isRemoteClient(): boolean {
  return !isElectron() && !isCapacitor()
}

let remoteOrgSignIn = false

export function setRemoteOrgSignIn(offered: boolean): void {
  remoteOrgSignIn = offered
}

export function orgSignInOffered(): boolean {
  return isElectron() ? window.haloOrgSignIn === true : remoteOrgSignIn
}

// ---------------------------------------------------------------------------
// Server URL management (Capacitor mode)
//
// _activeServerUrl is set by server.store via setActiveServerUrl() whenever
// the active server changes (hydrate / setActive / addServer / clearActive).
// _pendingServerUrl is a temporary override during the ServerConnect flow,
// before the server entry is persisted to the store.
// ---------------------------------------------------------------------------

/** Active server URL pushed from server.store (one-way: store → transport) */
let _activeServerUrl: string | null = null

/** Temporary server URL set during the ServerConnect flow (before store persistence) */
let _pendingServerUrl: string | null = null
const serverUrlListeners = new Set<() => void>()

export function onServerUrlChange(listener: () => void): () => void {
  serverUrlListeners.add(listener)
  return () => { serverUrlListeners.delete(listener) }
}

function notifyServerUrlChange(previous: string | null): void {
  if (previous === getServerUrl()) return
  remoteOrgSignIn = false
  serverUrlListeners.forEach(listener => listener())
}

/**
 * Called by server.store whenever the active server changes.
 * This is the ONLY way transport learns about the active server URL.
 */
export function setActiveServerUrl(url: string | null): void {
  // Strip trailing slashes the same way setServerUrl does. A stored URL like
  // "http://host:3456/" would otherwise build the socket path "//ws", which the
  // server's exact `path: '/ws'` match rejects; HTTP tolerates the duplicate
  // slash, so only the WebSocket fails.
  const previous = getServerUrl()
  _activeServerUrl = url ? url.replace(/\/+$/, '') : null
  notifyServerUrlChange(previous)
  console.log(`[Transport] Active server URL: ${_activeServerUrl ?? 'none'}`)
}

/**
 * Set a temporary server URL during the ServerConnect flow.
 * Overrides _activeServerUrl until clearPendingServerUrl() is called.
 */
export function setServerUrl(url: string): void {
  const normalized = url.replace(/\/+$/, '')
  console.log(`[Transport] Pending server URL: ${normalized}`)
  const previous = getServerUrl()
  _pendingServerUrl = normalized
  notifyServerUrlChange(previous)
}

/**
 * Read the active server URL.
 * Priority: pending URL (during connect flow) > active server URL
 */
export function getServerUrl(): string | null {
  return _pendingServerUrl ?? _activeServerUrl
}

/**
 * Returns the active server URL (after hydration by server.store).
 * Hydration must be triggered by the caller (App.tsx) before this is called.
 */
export function restoreServerUrl(): string | null {
  return _activeServerUrl
}

/** Clear pending server URL (e.g. when cancelling connect flow). */
export function clearServerUrl(): void {
  console.log('[Transport] Pending server URL cleared')
  clearPendingServerUrl()
}

/** Clear pending URL after it has been persisted to the store. */
export function clearPendingServerUrl(): void {
  const previous = getServerUrl()
  _pendingServerUrl = null
  notifyServerUrlChange(previous)
}

// ---------------------------------------------------------------------------
// Server URL resolution
// ---------------------------------------------------------------------------

/**
 * Get the base URL for HTTP requests.
 * - Capacitor: user-configured server address
 * - Remote: current browser origin
 * - Electron: not used (IPC)
 */
export function getRemoteServerUrl(): string {
  if (isCapacitor()) {
    const url = getServerUrl()
    if (!url) {
      console.warn('[Transport] Capacitor mode but no server URL configured')
      return ''
    }
    return url
  }
  // Remote: derive the base from the directory the app is served from, so a
  // reverse-proxy path prefix (e.g. WFaaS serves the app under /fc-xxx/) is
  // preserved on API and WebSocket requests — origin alone would drop it.
  // SPA assets are already relative to this base; new URL('.', …) yields the
  // mount directory, and we strip the trailing slash so `${base}${path}`
  // (path begins with '/') composes correctly.
  return new URL('.', document.baseURI).href.replace(/\/$/, '')
}

// ---------------------------------------------------------------------------
// Auth token management
// ---------------------------------------------------------------------------

/** Get stored auth token */
export function getAuthToken(): string | null {
  try {
    return localStorage.getItem('halo_remote_token')
  } catch {
    return null
  }
}

/** Set auth token */
export function setAuthToken(token: string): void {
  try {
    localStorage.setItem('halo_remote_token', token)
  } catch { /* ignore */ }
}

/** Clear auth token */
export function clearAuthToken(): void {
  try {
    localStorage.removeItem('halo_remote_token')
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// HTTP Transport
// ---------------------------------------------------------------------------

/**
 * HTTP Transport - Makes API calls to remote server.
 * Used by both Capacitor and Remote browser modes.
 */
export async function httpRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  body?: Record<string, unknown>
): Promise<{ success: boolean; data?: T; error?: string; code?: string }> {
  const token = getAuthToken()
  const baseUrl = getRemoteServerUrl()

  if (!baseUrl) {
    return { success: false, error: 'Server URL not configured' }
  }

  const url = `${baseUrl}${path}`

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })

    // Handle 401 - token expired or invalid
    if (response.status === 401) {
      console.warn(`[HTTP] ${method} ${path.split('?')[0]} - 401 Unauthorized`)
      // A request from the last connection cannot sign out the current one.
      if (baseUrl !== getRemoteServerUrl() || token !== getAuthToken()) return { success: false, error: 'Unauthorized' }
      clearAuthToken()

      if (isCapacitor()) {
        // In Capacitor: dispatch DOM event so App.tsx can navigate to ServerConnect
        // Do NOT reload — there is no server-rendered login page
        window.dispatchEvent(new CustomEvent('halo:auth-expired'))
      } else {
        // Remote browser: reload → server shows login page
        document.cookie = 'halo_authenticated=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
        window.location.reload()
      }

      return { success: false, error: 'Token expired, please login again' }
    }

    // Proxies can also return an HTML 413; preserve domain JSON errors when supplied.
    if (response.status === 413) {
      console.warn(`[HTTP] ${method} ${path} - 413 Payload Too Large`)
      const data = response.headers.get('content-type')?.includes('application/json')
        ? await response.json().catch(() => null)
        : null
      if (data?.success === false && data.code !== 'PAYLOAD_TOO_LARGE') return data
      return {
        success: false,
        code: 'PAYLOAD_TOO_LARGE',
        error: i18n.t('Request is too large. Reduce the attachment size or shorten the text.'),
      }
    }

    // A proxy or SPA fallback can answer an API path with HTML. Parsing that as
    // JSON throws a SyntaxError that says nothing about the cause.
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
    if (contentType !== 'application/json' && !/^application\/[^\s/;]+\+json$/.test(contentType)) {
      console.warn(`[HTTP] ${method} ${path.split('?')[0]} - expected JSON, received ${contentType || 'no content type'} (HTTP ${response.status})`)
      return {
        success: false,
        error: i18n.t('The server returned a non-JSON response (HTTP {{status}}). Check the server deployment and reverse proxy configuration.', { status: response.status }),
      }
    }

    const data = await response.json()

    if (!response.ok) {
      console.warn(`[HTTP] ${method} ${path} - error:`, data.error)
    }

    return data
  } catch (error) {
    console.error(`[HTTP] ${method} ${path} - exception:`, error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Network error'
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket with exponential backoff
// ---------------------------------------------------------------------------

let wsConnection: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
let wsReconnectAttempt = 0
const WS_BACKOFF_BASE_MS = 1000
const WS_BACKOFF_MAX_MS = 30000
const wsEventListeners = new Map<string, Set<(data: unknown) => void>>()

/** Track subscribed conversationIds so we can re-subscribe after reconnect */
const _subscribedConversations = new Set<string>()

/** WebSocket connection state event (for UI reconnection banner) */
export type WsConnectionState = 'connected' | 'disconnected' | 'connecting'

const wsStateListeners = new Set<(state: WsConnectionState) => void>()
let wsBrowserLive = false
let wsBrowserCredentials = false
let authenticatedSocket: WebSocket | null = null
const wsAuthenticatedListeners = new Set<(isCurrent: () => boolean) => void>()

export function supportsBrowserLive(): boolean {
  return wsBrowserLive
}

export function supportsBrowserCredentials(): boolean {
  return wsBrowserCredentials
}

/** Recover missed data only when the new socket can already receive live events. */
export function onWsAuthenticated(callback: (isCurrent: () => boolean) => void): () => void {
  wsAuthenticatedListeners.add(callback)
  if (authenticatedSocket && wsConnection === authenticatedSocket) notifyWsAuthenticated(authenticatedSocket, callback)
  return () => { wsAuthenticatedListeners.delete(callback) }
}

function notifyWsAuthenticated(socket: WebSocket, callback: (isCurrent: () => boolean) => void): void {
  try {
    callback(() => socket === wsConnection && socket === authenticatedSocket)
  } catch (error) {
    console.warn('[WS] Authenticated connection listener failed', error)
  }
}

/** Subscribe to WebSocket connection state changes */
export function onWsStateChange(cb: (state: WsConnectionState) => void): () => void {
  wsStateListeners.add(cb)
  return () => { wsStateListeners.delete(cb) }
}

function emitWsState(state: WsConnectionState) {
  for (const cb of wsStateListeners) {
    try { cb(state) } catch { /* ignore */ }
  }
}

export function connectWebSocket(): void {
  if (isElectron()) return
  if (wsConnection && wsConnection.readyState <= WebSocket.OPEN) return

  const token = getAuthToken()
  if (!token) {
    console.warn('[WS] No auth token, cannot connect')
    return
  }

  const baseUrl = getRemoteServerUrl()
  if (!baseUrl) {
    console.warn('[WS] No server URL configured, cannot connect')
    return
  }

  const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`
  console.log(`[WS] Connecting to: ${wsUrl} (attempt: ${wsReconnectAttempt})`)
  wsBrowserLive = false
  wsBrowserCredentials = false
  const connection = new WebSocket(wsUrl)
  wsConnection = connection
  emitWsState('connecting')

  connection.onopen = () => {
    if (wsConnection === connection) connection.send(JSON.stringify({ type: 'auth', payload: { token } }))
  }

  connection.onmessage = (event) => {
    if (wsConnection !== connection) return
    try {
      const message = JSON.parse(event.data)

      if (message.type === 'auth:success') {
        console.log('[WS] Authenticated')
        wsReconnectAttempt = 0
        wsBrowserLive = message.payload?.browserLive === true
        // Older servers advertised both capabilities through browserLive.
        wsBrowserCredentials = wsBrowserLive && (message.payload?.browserCredentials ?? true) === true
        for (const convId of _subscribedConversations) {
          connection.send(JSON.stringify({ type: 'subscribe', payload: { conversationId: convId } }))
        }
        emitWsState('connected')
        if (authenticatedSocket !== connection) {
          authenticatedSocket = connection
          for (const listener of wsAuthenticatedListeners) notifyWsAuthenticated(connection, listener)
        }

        if (isCapacitor()) {
          import('./foreground-service').then(({ startForegroundService }) => {
            if (wsConnection === connection) startForegroundService('Halo', 'Connected to desktop')
          }).catch(() => { /* plugin not available */ })
        }
        return
      }

      if (message.type === 'event') {
        const listeners = wsEventListeners.get(message.channel)
        if (listeners) for (const callback of listeners) callback(message.data)
      }
    } catch (error) {
      console.error('[WS] Failed to parse message:', error)
    }
  }

  connection.onclose = () => {
    if (authenticatedSocket === connection) authenticatedSocket = null
    if (wsConnection !== connection) return
    console.log('[WS] Disconnected')
    wsConnection = null
    wsBrowserLive = false
    wsBrowserCredentials = false
    emitWsState('disconnected')

    if (!isElectron() && getAuthToken()) {
      wsReconnectAttempt++
      const delay = Math.min(
        WS_BACKOFF_BASE_MS * Math.pow(2, wsReconnectAttempt - 1),
        WS_BACKOFF_MAX_MS
      )
      console.log(`[WS] Reconnecting in ${delay}ms (attempt: ${wsReconnectAttempt})`)
      wsReconnectTimer = setTimeout(connectWebSocket, delay)
    }
  }

  connection.onerror = (error) => {
    if (wsConnection === connection) console.error('[WS] Error:', error)
  }
}

export function disconnectWebSocket(): void {
  wsReconnectAttempt = 0
  _subscribedConversations.clear()

  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer)
    wsReconnectTimer = null
  }

  const connection = wsConnection
  wsConnection = null
  wsBrowserLive = false
  wsBrowserCredentials = false
  connection?.close()
  emitWsState('disconnected')

  // Stop foreground service when intentionally disconnecting (Capacitor only)
  if (isCapacitor()) {
    import('./foreground-service').then(({ stopForegroundService }) => {
      stopForegroundService()
    }).catch(() => { /* plugin not available */ })
  }
}

export function subscribeToConversation(conversationId: string): void {
  // Always track locally so we can re-subscribe after reconnect
  _subscribedConversations.add(conversationId)

  if (wsConnection?.readyState === WebSocket.OPEN) {
    wsConnection.send(
      JSON.stringify({
        type: 'subscribe',
        payload: { conversationId }
      })
    )
  }
}

export function unsubscribeFromConversation(conversationId: string): void {
  _subscribedConversations.delete(conversationId)

  if (wsConnection?.readyState === WebSocket.OPEN) {
    wsConnection.send(
      JSON.stringify({
        type: 'unsubscribe',
        payload: { conversationId }
      })
    )
  }
}

/**
 * Send a raw message over the active WebSocket (remote/Capacitor only).
 * Returns true if the message was sent. Used for low-latency terminal input so
 * remote keyboard takeover does not incur an HTTP round-trip per keystroke.
 */
export function sendWsMessage(type: string, payload: unknown): boolean {
  if (wsConnection?.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({ type, payload }))
    return true
  }
  return false
}

/**
 * Force immediate WebSocket reconnection (skip backoff timer).
 * Used when the app returns to foreground and needs to recover immediately.
 */
export function forceReconnectWebSocket(): void {
  if (isElectron()) return
  if (wsConnection?.readyState === WebSocket.OPEN) return // already connected

  // Clear any pending backoff timer
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer)
    wsReconnectTimer = null
  }

  // Reset backoff counter for immediate reconnect
  wsReconnectAttempt = 0
  connectWebSocket()
}

// ---------------------------------------------------------------------------
// Event listener registry
// ---------------------------------------------------------------------------

/**
 * Register event listener (works for IPC, WebSocket, or Capacitor WS)
 */
// Generic in the payload so a slice can declare the shape its consumers get
// (see artifactApi.onArtifactChangedBatch) instead of casting at the call site; the
// channel is stringly-typed either way, so `T` is the declaration, not a proof.
export function onEvent<T = unknown>(channel: string, callback: (data: T) => void): () => void {
  const listener = callback as (data: unknown) => void
  if (isElectron()) {
    // Use IPC in Electron
    const methodMap: Record<string, keyof typeof window.halo> = {
      'agent:message': 'onAgentMessage',
      'agent:input-arrived': 'onAgentInputArrived',
      'agent:input-stopped': 'onAgentInputStopped',
      'agent:tool-call': 'onAgentToolCall',
      'agent:tool-result': 'onAgentToolResult',
      'agent:error': 'onAgentError',
      'agent:complete': 'onAgentComplete',
      'agent:thought': 'onAgentThought',
      'agent:thought-delta': 'onAgentThoughtDelta',
      'agent:mcp-status': 'onAgentMcpStatus',
      'agent:compact': 'onAgentCompact',
      'agent:ask-question': 'onAgentAskQuestion',
      'agent:session-info': 'onAgentSessionInfo',
      'agent:turn-start': 'onAgentTurnStart',
      'agent:goal-updated': 'onAgentGoalUpdated',
      'agent:api-retry': 'onAgentApiRetry',
      'toolsets:changed': 'onToolsetsChanged',
      'toolsets:requested': 'onToolsetsRequested',
      'terminal:data': 'onTerminalData',
      'terminal:lifecycle': 'onTerminalLifecycle',
      'remote:status-change': 'onRemoteStatusChange',
      'credential:decrypt-failed': 'onCredentialDecryptFailed',
      'ai-sources:catalog-changed': 'onModelCatalogChanged',
      [ENTERPRISE_IDENTITY_CHANGED_EVENT]: 'onEnterpriseIdentityChanged',
      'subagent-models:changed': 'onSubagentModelsChanged',
      'ai-sources:group-route': 'onAIGroupRoute',
      'browser:state-change': 'onBrowserStateChange',
      'browser:page-gone': 'onBrowserPageGone',
      'browser:tab-opened': 'onBrowserTabOpened',
      'browser:zoom-changed': 'onBrowserZoomChanged',
      'canvas:tab-action': 'onCanvasTabAction',
      'canvas:show-request': 'onCanvasShowRequest',
      'ai-browser:active-view-changed': 'onAIBrowserActiveViewChanged',
      'ai-browser:page-opened': 'onAIBrowserPageOpened',
      'ai-browser:view-gone': 'onAIBrowserViewGone',
      'ai-browser:conversation-released': 'onAIBrowserConversationReleased',
      'ai-browser:operating': 'onAIBrowserOperating',
      'artifact:tree-update': 'onArtifactTreeUpdate',
      'artifact:changed-batch': 'onArtifactChangedBatch',
      'perf:snapshot': 'onPerfSnapshot',
      'perf:warning': 'onPerfWarning',
      'app:status_changed': 'onAppStatusChanged',
      'app:list_changed': 'onAppListChanged',
      'app:activity_entry:new': 'onAppActivityEntry',
      'app:escalation:new': 'onAppEscalation',
      'app:escalation:resolved': 'onAppEscalationResolved',
      'app:navigate': 'onAppNavigate',
      'app:im-session-updated': 'onImSessionUpdated',
      'im-channels:instance-updated': 'onImChannelInstanceUpdated',
      'team:updated': 'onTeamUpdated',
      'team:blackboard': 'onTeamBlackboard',
      'team:message': 'onTeamMessage',
      'team:presence': 'onTeamPresence',
      'team:office-status': 'onTeamOfficeStatus',
      'team:invite-link': 'onTeamInviteLink',
      'team:member-history': 'onTeamMemberHistory',
      'notification:toast': 'onNotificationToast',
      'app:memory-pressure': 'onMemoryPressure',
      'tlon:stats-updated': 'onTlonStatsUpdated',
      'tlon:ingest-progress': 'onTlonIngestProgress',
      'store:sync-status-changed': 'onStoreSyncStatusChanged',
      'store:upgrade-available': 'onStoreUpgradeAvailable',
      'task:state_changed': 'onTaskStateChanged',
    }

    const method = methodMap[channel]
    if (method && typeof window.halo[method] === 'function') {
      return (window.halo[method] as (cb: (data: unknown) => void) => () => void)(listener)
    }

    return () => {}
  } else {
    // Use WebSocket in remote / Capacitor mode
    if (!wsEventListeners.has(channel)) {
      wsEventListeners.set(channel, new Set())
    }
    wsEventListeners.get(channel)!.add(listener)

    return () => {
      wsEventListeners.get(channel)?.delete(listener)
    }
  }
}
