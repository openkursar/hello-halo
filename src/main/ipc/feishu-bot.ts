/**
 * Feishu Bot IPC Handlers
 *
 * Exposes the one flow that is unique to this brand: the QR-code device flow
 * that creates a Feishu app (App ID + App Secret) from inside Halo, so the user
 * never has to visit the Feishu developer console. Generic channel lifecycle
 * (status / reconnect / reload / binding) stays in ipc/im-channels.ts.
 *
 * Split into three calls so the renderer can render its own QR code and own the
 * dialog lifecycle:
 *
 *   start   -> { deviceCode, authUrl, expiresInMs }  : main allocates the session
 *   poll    -> { appId, appSecret, tenantBrand }     : long-poll until approval
 *   cancel  -> ()                                    : abort the active poll
 *   create-assistant -> { appId, appName }            : install default automation
 *
 * The session map is keyed by device code. Each entry owns one AbortController
 * plus the begin-step parameters (issuing host and server-advertised cadence /
 * deadline) that the poll must reuse.
 */

import { getAppManager } from '../apps/manager'
import { getImChannelManager } from '../apps/runtime'
import { readFeishuReachability } from '../apps/runtime/im-channels/feishu-bot.provider'
import { buildFeishuAssistantSpec } from '../apps/runtime/im-channels/feishu-bot-default-spec'
import {
  beginRegistration,
  pollRegistration,
  FeishuScanAuthError,
  type FeishuScanAuthErrorKind,
} from '../apps/runtime/im-channels/feishu-bot-scan-auth'
import { feishuBotRpc } from '../../shared/rpc/contracts/feishu-bot.contract'
import { registerRawRpcHandlers } from './rpc'
import { analytics } from '../services/analytics/analytics.service'
import { AnalyticsEvents } from '../services/analytics/types'
import { deriveErrorCode } from '../services/analytics/error-code'

/** Telemetry channel tag for every event emitted from this brand's setup flow. */
const BIND_CHANNEL = 'feishu-bot'

/** Default space ID used when installing the auto-created assistant. */
const DEFAULT_SCAN_AUTH_SPACE_ID = 'halo-temp'

interface ScanSession {
  abort: AbortController
  host: string
  intervalMs: number
  expiresInMs: number
  startedAt: number
}

/**
 * Active poll sessions keyed by device code. Sessions self-clean once the poll
 * resolves, rejects, or is aborted, so a device code is single-use for polling.
 */
const activeSessions = new Map<string, ScanSession>()

/** Normalize a thrown value into the renderer-facing error payload. */
function errorPayload(err: unknown): { success: false; error: string; kind?: FeishuScanAuthErrorKind } {
  if (err instanceof FeishuScanAuthError) {
    return { success: false, error: err.message, kind: err.kind }
  }
  return { success: false, error: err instanceof Error ? err.message : String(err) }
}

export function registerFeishuBotHandlers(): void {
  registerRawRpcHandlers(feishuBotRpc, {
    /**
     * Whether a bot can actually be reached, beyond the link being up.
     * Brand-specific because the distinction is: a Feishu app that is still
     * awaiting release connects normally and receives nothing.
     */
    feishuBotReachability: async (instanceId: string) => {
      const manager = getImChannelManager()
      if (!manager) return { success: false, error: 'ImChannelManager not initialized' }
      const reachability = readFeishuReachability(manager.getInstance(instanceId))
      if (!reachability) return { success: false, error: 'No running Feishu instance with that id' }
      return { success: true, data: reachability }
    },

    // ── Scan-Auth: start (allocate device code + QR URL) ─────────────────
    feishuBotScanAuthStart: async () => {
      try {
        const begun = await beginRegistration()
        const existing = activeSessions.get(begun.deviceCode)
        if (existing) existing.abort.abort()
        activeSessions.set(begun.deviceCode, {
          abort: new AbortController(),
          host: begun.host,
          intervalMs: begun.intervalMs,
          expiresInMs: begun.expiresInMs,
          startedAt: Date.now(),
        })
        void analytics.track(AnalyticsEvents.IM_BIND_QR_REQUEST, {
          channel: BIND_CHANNEL,
          result: 'success',
        })
        return {
          success: true,
          data: {
            deviceCode: begun.deviceCode,
            authUrl: begun.authUrl,
            expiresInMs: begun.expiresInMs,
          },
        }
      } catch (err) {
        void analytics.track(AnalyticsEvents.IM_BIND_QR_REQUEST, {
          channel: BIND_CHANNEL,
          result: 'fail',
          errorCode: deriveErrorCode(err),
        })
        return errorPayload(err)
      }
    },

    // ── Scan-Auth: poll (long-poll until the user approves) ──────────────
    feishuBotScanAuthPoll: async (deviceCode: string) => {
      if (typeof deviceCode !== 'string' || !deviceCode) {
        return errorPayload(new FeishuScanAuthError('invalid-response', 'Missing device code'))
      }
      const session = activeSessions.get(deviceCode)
      if (!session) {
        return errorPayload(
          new FeishuScanAuthError('expired', 'No active scan session for this device code'),
        )
      }
      try {
        const creds = await pollRegistration(deviceCode, {
          signal: session.abort.signal,
          host: session.host,
          intervalMs: session.intervalMs,
          timeoutMs: session.expiresInMs,
        })
        void analytics.track(AnalyticsEvents.IM_BIND_RESULT, {
          channel: BIND_CHANNEL,
          result: 'success',
        })
        return { success: true, data: creds }
      } catch (err) {
        // A user-driven cancel aborts this poll; the cancel handler already
        // reported that outcome, so don't also count it as a failure.
        if (!session.abort.signal.aborted) {
          void analytics.track(AnalyticsEvents.IM_BIND_RESULT, {
            channel: BIND_CHANNEL,
            result: err instanceof FeishuScanAuthError && err.kind === 'expired' ? 'expired' : 'fail',
            errorCode: err instanceof FeishuScanAuthError ? err.kind : deriveErrorCode(err),
          })
        }
        return errorPayload(err)
      } finally {
        activeSessions.delete(deviceCode)
      }
    },

    // ── Scan-Auth: cancel (abort an active poll) ─────────────────────────
    feishuBotScanAuthCancel: async (deviceCode: string) => {
      if (typeof deviceCode !== 'string' || !deviceCode) {
        return { success: true } // No-op: nothing to cancel
      }
      const session = activeSessions.get(deviceCode)
      if (session) {
        session.abort.abort()
        activeSessions.delete(deviceCode)
        void analytics.track(AnalyticsEvents.IM_BIND_RESULT, {
          channel: BIND_CHANNEL,
          result: 'cancelled',
        })
      }
      return { success: true }
    },

    // ── Scan-Auth: create the auto-bound default assistant ───────────────
    feishuBotScanAuthCreateAssistant: async (input: { appIdSuffix: string }) => {
      try {
        const manager = getAppManager()
        if (!manager) {
          return { success: false, error: 'AppManager not initialized' }
        }
        const suffix = (input?.appIdSuffix ?? '').slice(0, 8) || 'bot'
        const spec = buildFeishuAssistantSpec(suffix)
        const appId = await manager.install(DEFAULT_SCAN_AUTH_SPACE_ID, spec)
        console.log(`[FeishuBot] scan-auth assistant created: appId=${appId}, nameSuffix=${suffix}`)
        return { success: true, data: { appId, appName: spec.name } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[FeishuBot] scan-auth create-assistant error:', err.message)
        return { success: false, error: err.message }
      }
    },
  })

  console.log('[FeishuBot] IPC handlers registered (scan-auth)')
}
