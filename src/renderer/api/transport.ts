/**
 * Transport Layer - Abstracts IPC vs HTTP communication
 *
 * Three modes:
 * 1. Electron  — window.halo exists → IPC
 * 2. Capacitor — Capacitor.isNativePlatform() → HTTP to user-configured server
 * 3. Remote    — neither → HTTP to window.location.origin
 */

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

/**
 * Called by server.store whenever the active server changes.
 * This is the ONLY way transport learns about the active server URL.
 */
export function setActiveServerUrl(url: string | null): void {
  _activeServerUrl = url
  console.log(`[Transport] Active server URL: ${url ?? 'none'}`)
}

/**
 * Set a temporary server URL during the ServerConnect flow.
 * Overrides _activeServerUrl until clearPendingServerUrl() is called.
 */
export function setServerUrl(url: string): void {
  const normalized = url.replace(/\/+$/, '')
  console.log(`[Transport] Pending server URL: ${normalized}`)
  _pendingServerUrl = normalized
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
  _pendingServerUrl = null
}

/** Clear pending URL after it has been persisted to the store. */
export function clearPendingServerUrl(): void {
  _pendingServerUrl = null
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
  return window.location.origin
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
): Promise<{ success: boolean; data?: T; error?: string }> {
  const token = getAuthToken()
  const baseUrl = getRemoteServerUrl()

  if (!baseUrl) {
    return { success: false, error: 'Server URL not configured' }
  }

  const url = `${baseUrl}${path}`
  console.log(`[HTTP] ${method} ${path} - token: ${token ? 'present' : 'missing'}`)

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
      console.warn(`[HTTP] ${method} ${path} - 401 Unauthorized`)
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

    const data = await response.json()
    console.log(`[HTTP] ${method} ${path} - status: ${response.status}, success: ${data.success}`)

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
  // Works in both remote-browser and Capacitor modes
  if (isElectron()) return
  if (wsConnection?.readyState === WebSocket.OPEN) return

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
  emitWsState('connecting')

  wsConnection = new WebSocket(wsUrl)

  wsConnection.onopen = () => {
    console.log('[WS] Connected')
    wsReconnectAttempt = 0 // reset backoff on success
    emitWsState('connected')
    // Authenticate
    wsConnection?.send(JSON.stringify({ type: 'auth', payload: { token } }))
  }

  wsConnection.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data)

      if (message.type === 'auth:success') {
        console.log('[WS] Authenticated')

        // Re-subscribe to all previously subscribed conversations after reconnect
        if (_subscribedConversations.size > 0) {
          console.log(`[WS] Re-subscribing to ${_subscribedConversations.size} conversation(s)`)
          for (const convId of _subscribedConversations) {
            wsConnection?.send(JSON.stringify({ type: 'subscribe', payload: { conversationId: convId } }))
          }
        }

        // Start foreground service to keep WebSocket alive in background (Capacitor only)
        if (isCapacitor()) {
          import('./foreground-service').then(({ startForegroundService }) => {
            startForegroundService('Halo', 'Connected to desktop')
          }).catch(() => { /* plugin not available */ })
        }

        return
      }

      if (message.type === 'event') {
        // Dispatch to registered listeners
        const listeners = wsEventListeners.get(message.channel)
        if (listeners) {
          for (const callback of listeners) {
            callback(message.data)
          }
        }
      }
    } catch (error) {
      console.error('[WS] Failed to parse message:', error)
    }
  }

  wsConnection.onclose = () => {
    console.log('[WS] Disconnected')
    wsConnection = null
    emitWsState('disconnected')

    // Exponential backoff reconnection
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

  wsConnection.onerror = (error) => {
    console.error('[WS] Error:', error)
  }
}

export function disconnectWebSocket(): void {
  wsReconnectAttempt = 0
  _subscribedConversations.clear()

  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer)
    wsReconnectTimer = null
  }

  if (wsConnection) {
    wsConnection.close()
    wsConnection = null
  }

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
export function onEvent(channel: string, callback: (data: unknown) => void): () => void {
  if (isElectron()) {
    // Use IPC in Electron
    const methodMap: Record<string, keyof typeof window.halo> = {
      'agent:message': 'onAgentMessage',
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
      'remote:status-change': 'onRemoteStatusChange',
      'browser:state-change': 'onBrowserStateChange',
      'browser:zoom-changed': 'onBrowserZoomChanged',
      'canvas:tab-action': 'onCanvasTabAction',
      'ai-browser:active-view-changed': 'onAIBrowserActiveViewChanged',
      'artifact:tree-update': 'onArtifactTreeUpdate',
      'perf:snapshot': 'onPerfSnapshot',
      'perf:warning': 'onPerfWarning',
      'app:status_changed': 'onAppStatusChanged',
      'app:activity_entry:new': 'onAppActivityEntry',
      'app:escalation:new': 'onAppEscalation',
      'app:navigate': 'onAppNavigate',
      'app:im-session-updated': 'onImSessionUpdated',
      'im-channels:instance-updated': 'onImChannelInstanceUpdated',
      'notification:toast': 'onNotificationToast',
      'tlon:stats-updated': 'onTlonStatsUpdated',
      'tlon:ingest-progress': 'onTlonIngestProgress'
    }

    const method = methodMap[channel]
    if (method && typeof window.halo[method] === 'function') {
      return (window.halo[method] as (cb: (data: unknown) => void) => () => void)(callback)
    }

    return () => {}
  } else {
    // Use WebSocket in remote / Capacitor mode
    if (!wsEventListeners.has(channel)) {
      wsEventListeners.set(channel, new Set())
    }
    wsEventListeners.get(channel)!.add(callback)

    return () => {
      wsEventListeners.get(channel)?.delete(callback)
    }
  }
}
