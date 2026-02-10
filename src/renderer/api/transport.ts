/**
 * Transport Layer - Abstracts IPC vs HTTP communication
 * Automatically selects the appropriate transport based on environment
 */

// Detect if running in Electron (has window.halo via preload)
export function isElectron(): boolean {
  return typeof window !== 'undefined' && 'halo' in window
}

// Detect if running as remote web client
export function isRemoteClient(): boolean {
  return !isElectron()
}

// Get the remote server URL (for remote clients)
export function getRemoteServerUrl(): string {
  // In remote mode, use the current origin
  return window.location.origin
}

// Get stored auth token
export function getAuthToken(): string | null {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem('halo_remote_token')
  }
  return null
}

// Set auth token
export function setAuthToken(token: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('halo_remote_token', token)
  }
}

// Clear auth token
export function clearAuthToken(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('halo_remote_token')
  }
}

/**
 * HTTP Transport - Makes API calls to remote server
 */
export async function httpRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>
): Promise<{ success: boolean; data?: T; error?: string }> {
  const token = getAuthToken()
  const url = `${getRemoteServerUrl()}${path}`

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

    // Handle 401 - token expired or invalid, redirect to login
    if (response.status === 401) {
      console.warn(`[HTTP] ${method} ${path} - 401 Unauthorized, clearing token and redirecting to login`)
      clearAuthToken()
      // Clear the auth cookie
      document.cookie = 'halo_authenticated=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
      // Reload page - server will show login page
      window.location.reload()
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

/**
 * WebSocket connection for real-time events (remote mode)
 */
let wsConnection: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
const wsEventListeners = new Map<string, Set<(data: unknown) => void>>()

export function connectWebSocket(): void {
  if (!isRemoteClient()) return
  if (wsConnection?.readyState === WebSocket.OPEN) return

  const token = getAuthToken()
  if (!token) {
    console.warn('[WS] No auth token, cannot connect')
    return
  }

  const wsUrl = `${getRemoteServerUrl().replace('http', 'ws')}/ws`
  console.log('[WS] Connecting to:', wsUrl)

  wsConnection = new WebSocket(wsUrl)

  wsConnection.onopen = () => {
    console.log('[WS] Connected')
    // Authenticate
    wsConnection?.send(JSON.stringify({ type: 'auth', payload: { token } }))
  }

  wsConnection.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data)

      if (message.type === 'auth:success') {
        console.log('[WS] Authenticated')
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

    // Attempt to reconnect after 3 seconds
    if (isRemoteClient() && getAuthToken()) {
      wsReconnectTimer = setTimeout(connectWebSocket, 3000)
    }
  }

  wsConnection.onerror = (error) => {
    console.error('[WS] Error:', error)
  }
}

export function disconnectWebSocket(): void {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer)
    wsReconnectTimer = null
  }

  if (wsConnection) {
    wsConnection.close()
    wsConnection = null
  }
}

export function subscribeToConversation(conversationId: string): void {
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
 * Register event listener (works for both IPC and WebSocket)
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
      'remote:status-change': 'onRemoteStatusChange',
      'browser:state-change': 'onBrowserStateChange',
      'browser:zoom-changed': 'onBrowserZoomChanged',
      'canvas:tab-action': 'onCanvasTabAction',
      'ai-browser:active-view-changed': 'onAIBrowserActiveViewChanged',
      'artifact:tree-update': 'onArtifactTreeUpdate',
      'perf:snapshot': 'onPerfSnapshot',
      'perf:warning': 'onPerfWarning'
    }

    const method = methodMap[channel]
    if (method && typeof window.halo[method] === 'function') {
      return (window.halo[method] as (cb: (data: unknown) => void) => () => void)(callback)
    }

    return () => {}
  } else {
    // Use WebSocket in remote mode
    if (!wsEventListeners.has(channel)) {
      wsEventListeners.set(channel, new Set())
    }
    wsEventListeners.get(channel)!.add(callback)

    return () => {
      wsEventListeners.get(channel)?.delete(callback)
    }
  }
}
