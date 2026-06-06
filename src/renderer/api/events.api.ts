/**
 * eventsApi — events domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  clearPendingServerUrl,
  clearServerUrl,
  connectWebSocket,
  disconnectWebSocket,
  forceReconnectWebSocket,
  getServerUrl,
  httpRequest,
  isElectron,
  onEvent,
  onWsStateChange,
  restoreServerUrl,
  setServerUrl,
  subscribeToConversation,
  unsubscribeFromConversation,
} from './_shared'

export const eventsApi = {
  // ===== Event Listeners =====
  onAgentMessage: (callback: (data: unknown) => void) =>
    onEvent('agent:message', callback),
  onAgentToolCall: (callback: (data: unknown) => void) =>
    onEvent('agent:tool-call', callback),
  onAgentToolResult: (callback: (data: unknown) => void) =>
    onEvent('agent:tool-result', callback),
  onAgentError: (callback: (data: unknown) => void) =>
    onEvent('agent:error', callback),
  onAgentComplete: (callback: (data: unknown) => void) =>
    onEvent('agent:complete', callback),
  onAgentThought: (callback: (data: unknown) => void) =>
    onEvent('agent:thought', callback),
  onAgentThoughtDelta: (callback: (data: unknown) => void) =>
    onEvent('agent:thought-delta', callback),
  onAgentMcpStatus: (callback: (data: unknown) => void) =>
    onEvent('agent:mcp-status', callback),
  onAgentCompact: (callback: (data: unknown) => void) =>
    onEvent('agent:compact', callback),
  onAgentAskQuestion: (callback: (data: unknown) => void) =>
    onEvent('agent:ask-question', callback),
  onAgentSessionInfo: (callback: (data: unknown) => void) =>
    onEvent('agent:session-info', callback),
  onAgentTurnStart: (callback: (data: unknown) => void) =>
    onEvent('agent:turn-start', callback),
  onRemoteStatusChange: (callback: (data: unknown) => void) =>
    onEvent('remote:status-change', callback),

  // ===== Server URL Management (Capacitor) =====
  setServerUrl,
  getServerUrl,
  restoreServerUrl,
  clearServerUrl,
  clearPendingServerUrl,

  // ===== WebSocket Control =====
  connectWebSocket,
  disconnectWebSocket,
  forceReconnectWebSocket,
  subscribeToConversation,
  unsubscribeFromConversation,
  onWsStateChange,
  onEvent,

  // ===== Telemetry (fire-and-forget) =====
  /**
   * Report a telemetry event. Fire-and-forget — never awaited, never throws.
   *
   * Scheduling:
   *   - The transport call is deferred to an idle moment via
   *     `requestIdleCallback` (with a 2s timeout so a constantly busy CPU
   *     can't starve telemetry indefinitely).
   *   - On environments without rIC support (older Electron, test runners,
   *     older browsers) we fall back to `setTimeout(0)`, which still yields
   *     to pending UI work without introducing a queue.
   *   - Each event is scheduled independently; there is no renderer-side
   *     queue. Batching is handled exclusively in the main process.
   *
   * Transport:
   *   - In Electron mode, uses the IPC `analytics:report` channel.
   *   - In HTTP mode (Capacitor/remote), POSTs to `/api/analytics/report`.
   */
  trackEvent: (event: string, properties?: Record<string, unknown>): void => {
    const send = (): void => {
      try {
        if (isElectron()) {
          window.halo.trackEvent(event, properties)
        } else {
          // HTTP fire-and-forget: no need to await or handle errors
          void httpRequest('POST', '/api/analytics/report', { event, properties })
        }
      } catch {
        // Telemetry must never break the app
      }
    }

    type IdleRequester = (cb: () => void, opts?: { timeout: number }) => number
    const ric = (globalThis as unknown as { requestIdleCallback?: IdleRequester })
      .requestIdleCallback

    if (typeof ric === 'function') {
      try {
        ric(send, { timeout: 2000 })
        return
      } catch {
        // Fall through to setTimeout fallback
      }
    }
    setTimeout(send, 0)
  },
}
