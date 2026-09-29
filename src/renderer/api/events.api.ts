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
  isElectron,
  onEvent,
  onWsStateChange,
  restoreServerUrl,
  sendWsMessage,
  setServerUrl,
  subscribeToConversation,
  unsubscribeFromConversation,
} from './_shared'
import { enqueueReport } from './analytics-batch'
import type { GoalUpdatedEvent } from '../../shared/types/goal'
import type { ApiRetryEvent } from '../../shared/types/api-retry'

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
  onAgentGoalUpdated: (callback: (data: GoalUpdatedEvent) => void) =>
    onEvent<GoalUpdatedEvent>('agent:goal-updated', callback),
  onAgentApiRetry: (callback: (data: ApiRetryEvent) => void) =>
    onEvent<ApiRetryEvent>('agent:api-retry', callback),
  onToolsetsChanged: (callback: (data: unknown) => void) =>
    onEvent('toolsets:changed', callback),
  onToolsetsRequested: (callback: (data: unknown) => void) =>
    onEvent('toolsets:requested', callback),
  onTerminalData: (callback: (data: unknown) => void) =>
    onEvent('terminal:data', callback),
  onTerminalLifecycle: (callback: (data: unknown) => void) =>
    onEvent('terminal:lifecycle', callback),
  onRemoteStatusChange: (callback: (data: unknown) => void) =>
    onEvent('remote:status-change', callback),
  onCredentialDecryptFailed: (callback: (data: unknown) => void) =>
    onEvent('credential:decrypt-failed', callback),

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
  sendWsMessage,

  // ===== Telemetry (fire-and-forget) =====
  /**
   * Report a telemetry event. Fire-and-forget — never awaited, never throws.
   *
   * Transport:
   *   - In Electron mode, uses the IPC `analytics:report` channel; the main
   *     process batches upstream. The IPC call is deferred to an idle moment
   *     via `requestIdleCallback` (2s timeout so a busy CPU can't starve it),
   *     falling back to `setTimeout(0)` where rIC is missing.
   *   - In HTTP mode (Capacitor/remote), joins a batch POSTed to
   *     `/api/analytics/report` (see `analytics-batch.ts`). Enqueueing is a
   *     cheap array push, done synchronously so an event reported during
   *     unload is queued before the page-hide flush.
   */
  trackEvent: (event: string, properties?: Record<string, unknown>): void => {
    if (!isElectron()) {
      try {
        enqueueReport({ event, properties })
      } catch {
        // Telemetry must never break the app
      }
      return
    }
    const send = (): void => {
      try {
        window.halo.trackEvent(event, properties)
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
