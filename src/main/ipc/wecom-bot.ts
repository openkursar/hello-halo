/**
 * WeCom Bot IPC Handlers
 *
 * Two responsibilities:
 *
 *   1. Legacy compat status / reconnect APIs — delegate to ImChannelManager.
 *      (Most consumers should use 'im-channels:*' instead.)
 *
 *   2. WeCom-specific scan-authorization flow — the QR-code device-flow
 *      that provisions a fresh bot (botid + secret) without manual back-end
 *      registration. This is the only brand-specific flow that lives here;
 *      generic channel lifecycle remains in ipc/im-channels.ts.
 *
 * The scan-auth flow is intentionally split into three IPC calls so the
 * renderer can render its own QR code (the qrcode library is already
 * bundled for the WeChat iLink flow) and own the Dialog lifecycle:
 *
 *   start   -> { scode, authUrl }                  : main allocates AbortController
 *   poll    -> { botId, secret }                   : long-poll until user approves
 *   cancel  -> ()                                  : abort the active poll
 *   create-assistant -> { appId, appName }         : install default automation
 *
 * The poll handler is shared safely across multiple Dialogs via the scode
 * as a session key. Each scode owns one AbortController; cancel() aborts it.
 */

import { getImChannelManager } from '../apps/runtime'
import { getAppManager } from '../apps/manager'
import { buildDefaultAssistantSpec } from '../apps/runtime/im-channels/wecom-bot-default-spec'
import {
  generateScode,
  pollResult,
  ScanAuthError,
  type ScanAuthErrorKind,
} from '../apps/runtime/im-channels/wecom-bot-scan-auth'
import { wecomBotRpc } from '../../shared/rpc/contracts/wecom-bot.contract'
import { registerRawRpcHandlers } from './rpc'

// ============================================
// Scan-Auth Session State
// ============================================

/**
 * Active poll sessions keyed by scode. Each entry tracks the AbortController
 * so cancel/start-fresh can interrupt the long-poll without leaking sockets.
 *
 * Sessions self-clean once the poll resolves, rejects, or is aborted.
 */
const activeSessions = new Map<string, { abort: AbortController; startedAt: number }>()

/** Default space ID used when installing the auto-created assistant. */
const DEFAULT_SCAN_AUTH_SPACE_ID = 'halo-temp'

// ============================================
// Helper: surface ScanAuthError shape to renderer
// ============================================

function errorPayload(err: unknown): { success: false; error: string; kind?: ScanAuthErrorKind } {
  if (err instanceof ScanAuthError) {
    return { success: false, error: err.message, kind: err.kind }
  }
  return { success: false, error: err instanceof Error ? err.message : String(err) }
}

// ============================================
// Handler Registration
// ============================================

export function registerWecomBotHandlers(): void {
  registerRawRpcHandlers(wecomBotRpc, {
    // ── Legacy: aggregate status across all wecom-bot instances ──────────
    getWecomBotStatus: async () => {
      try {
        const manager = getImChannelManager()
        if (!manager) {
          return { success: true, data: { configured: false, enabled: false, connected: false } }
        }
        const statuses = manager.getAllStatuses().filter(s => s.type === 'wecom-bot')
        const anyConnected = statuses.some(s => s.connected)
        const anyEnabled = statuses.some(s => s.enabled)
        const anyConfigured = statuses.length > 0
        return {
          success: true,
          data: { configured: anyConfigured, enabled: anyEnabled, connected: anyConnected },
        }
      } catch (error: unknown) {
        return { success: false, error: (error as Error).message }
      }
    },

    // ── Legacy: reconnect all wecom-bot instances ────────────────────────
    reconnectWecomBot: async () => {
      try {
        const manager = getImChannelManager()
        if (!manager) {
          return { success: false, error: 'ImChannelManager not initialized' }
        }
        const statuses = manager.getAllStatuses().filter(s => s.type === 'wecom-bot')
        for (const s of statuses) {
          manager.reconnectInstance(s.id)
        }
        return { success: true }
      } catch (error: unknown) {
        return { success: false, error: (error as Error).message }
      }
    },

    // ── Scan-Auth: start (allocate scode) ────────────────────────────────
    wecomBotScanAuthStart: async () => {
      try {
        const { scode, authUrl } = await generateScode()
        // Replace any session for the same scode (extremely unlikely, but safe).
        const existing = activeSessions.get(scode)
        if (existing) existing.abort.abort()
        activeSessions.set(scode, { abort: new AbortController(), startedAt: Date.now() })
        return { success: true, data: { scode, authUrl } }
      } catch (err) {
        return errorPayload(err)
      }
    },

    // ── Scan-Auth: poll (long-poll until user approves) ──────────────────
    wecomBotScanAuthPoll: async (scode: string) => {
      if (typeof scode !== 'string' || !scode) {
        return errorPayload(new ScanAuthError('invalid-response', 'Missing scode'))
      }
      const session = activeSessions.get(scode)
      if (!session) {
        return errorPayload(new ScanAuthError('expired', 'No active scan session for this scode'))
      }
      try {
        const creds = await pollResult(scode, { signal: session.abort.signal })
        return { success: true, data: creds }
      } catch (err) {
        return errorPayload(err)
      } finally {
        activeSessions.delete(scode)
      }
    },

    // ── Scan-Auth: cancel (abort an active poll) ─────────────────────────
    wecomBotScanAuthCancel: async (scode: string) => {
      if (typeof scode !== 'string' || !scode) {
        return { success: true } // No-op: nothing to cancel
      }
      const session = activeSessions.get(scode)
      if (session) {
        session.abort.abort()
        activeSessions.delete(scode)
      }
      return { success: true }
    },

    // ── Scan-Auth: create the auto-bound default assistant ───────────────
    wecomBotScanAuthCreateAssistant: async (input: { botIdPrefix: string }) => {
      try {
        const manager = getAppManager()
        if (!manager) {
          return { success: false, error: 'AppManager not initialized' }
        }
        const prefix = (input?.botIdPrefix ?? '').slice(0, 8) || 'bot'
        const spec = buildDefaultAssistantSpec(prefix)
        const appId = await manager.install(DEFAULT_SCAN_AUTH_SPACE_ID, spec)
        console.log(`[WecomBot] scan-auth assistant created: appId=${appId}, namePrefix=${prefix}`)
        return { success: true, data: { appId, appName: spec.name } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[WecomBot] scan-auth create-assistant error:', err.message)
        return { success: false, error: err.message }
      }
    },
  })

  console.log('[WecomBot] IPC handlers registered (legacy compat + scan-auth)')
}
