/**
 * apps/runtime/im-channels -- WeCom Bot Scan-Auth (Device Flow)
 *
 * Implements the OAuth Device-Flow style QR-code authorization used by
 * WeCom (企业微信) to provision an Intelligent Bot (AI Bot) from a desktop
 * client without manual back-end registration.
 *
 * Flow (RFC 8628 inspired):
 *   1. Client GETs /ai/qc/generate -> server returns { scode, auth_url }
 *   2. Client renders auth_url as a QR code; user scans + approves in WeCom App
 *   3. Client polls /ai/qc/query_result?scode=... every 3s until status=success
 *   4. Server returns { bot_info: { botid, secret } }; client uses these as
 *      the long-lived credentials for the existing aibot_subscribe protocol.
 *
 * This module is intentionally pure-functional and stateless: callers own
 * cancellation via AbortSignal. The IPC layer is responsible for mapping
 * scode -> AbortController and exposing a cancel() entry point.
 *
 * Endpoints documented here are publicly accessible (HTTPS GET, no auth
 * header, no signature) and are the same endpoints used by the official
 * WeCom CLI tool. The user explicitly authorizes each bot creation by
 * scanning + tapping "Agree" in their own WeCom App — credentials are
 * returned only to the device that initiated the scode.
 *
 * No part of this file logs secrets (botId / secret are redacted before
 * any structured log line).
 */

import { request as httpsRequest } from 'https'
import { platform } from 'os'

// ============================================
// Constants
// ============================================

/** WeCom device-flow base host. */
const WECOM_QC_HOST = 'work.weixin.qq.com'
/** Default poll interval — recommended by the official CLI reference impl. */
const DEFAULT_POLL_INTERVAL_MS = 3_000
/** Default poll timeout — matches the scode TTL (5 minutes). */
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000
/** Per-request HTTPS timeout (network read). */
const HTTPS_REQUEST_TIMEOUT_MS = 15_000
/** Identifier sent in the `source` query parameter; informational only. */
const SCAN_AUTH_SOURCE = 'halo'

// ============================================
// Types
// ============================================

/** Result of /ai/qc/generate. */
export interface ScanAuthGenerateResult {
  /** Short-lived authorization code (5 minute TTL). Must be passed to pollResult(). */
  scode: string
  /** Full URL to encode into the QR code that the user scans with WeCom App. */
  authUrl: string
}

/** Result of a successful /ai/qc/query_result poll. */
export interface ScanAuthBotCredentials {
  /** Internal WeCom bot identifier — opaque token. */
  botId: string
  /** Long-lived secret used together with botId for `aibot_subscribe`. */
  secret: string
}

/** Options accepted by pollResult(). */
export interface PollOptions {
  /** Abort the polling loop immediately on signal abort. Required. */
  signal: AbortSignal
  /** Override the default 3-second cadence. */
  intervalMs?: number
  /** Override the default 5-minute deadline. */
  timeoutMs?: number
}

/**
 * Distinct, classifiable error reasons surfaced to the IPC layer. The renderer
 * uses these to decide whether to show "retry", "scan again", or "report".
 */
export type ScanAuthErrorKind =
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid-response'
  | 'expired'

export class ScanAuthError extends Error {
  readonly kind: ScanAuthErrorKind
  readonly detail?: string
  constructor(kind: ScanAuthErrorKind, message: string, detail?: string) {
    super(message)
    this.name = 'ScanAuthError'
    this.kind = kind
    this.detail = detail
  }
}

// ============================================
// Structured Logging
// ============================================

type LogLevel = 'info' | 'warn' | 'error'

function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const ts = new Date().toISOString()
  const parts: string[] = [`[WecomScanAuth]`, `ts=${ts}`, `event=${event}`]
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue
    // Redact secret-shaped values defensively. The caller is expected to redact
    // explicitly, but this is a belt-and-braces guard so we cannot leak even on
    // accidental field name reuse.
    if (k === 'botId' || k === 'secret') continue
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    parts.push(`${k}=${s.length > 200 ? s.slice(0, 200) + '...' : s}`)
  }
  const line = parts.join(' ')
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

// ============================================
// Platform Code Mapping
// ============================================

/**
 * Map Node's `os.platform()` to the integer the WeCom server expects in the
 * `plat` query parameter. Values are taken from the official CLI source:
 *   1 = darwin (macOS)
 *   2 = win32  (Windows)
 *   3 = linux
 *   0 = anything else (treated as "other" by the server)
 */
export function getPlatCode(): number {
  switch (platform()) {
    case 'darwin': return 1
    case 'win32':  return 2
    case 'linux':  return 3
    default:       return 0
  }
}

// ============================================
// HTTPS GET Helper (AbortSignal-aware)
// ============================================

/**
 * Perform an HTTPS GET and return the parsed JSON body.
 *
 * - Respects the supplied AbortSignal, destroying the underlying request and
 *   rejecting with kind=cancelled when aborted.
 * - Enforces a request-level read timeout independent of the polling deadline.
 * - Surfaces non-2xx responses with their status code and a short body sample.
 */
function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ScanAuthError('cancelled', 'Aborted before request'))
      return
    }

    // The abort listener must be removed on every terminal path: this helper is
    // called once per polling tick against a single long-lived signal, so a
    // listener that survives normal completion would accumulate across the
    // whole auth window.
    let onAbort: (() => void) | undefined
    const cleanup = (): void => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
    }

    const req = httpsRequest(
      {
        host: WECOM_QC_HOST,
        path,
        method: 'GET',
        timeout: HTTPS_REQUEST_TIMEOUT_MS,
        headers: {
          // The official CLI sends no special headers. We add User-Agent for
          // server-side telemetry hygiene (helps WeCom distinguish clients).
          'User-Agent': 'Halo/1.0 (WeCom Scan Auth)',
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          cleanup()
          const raw = Buffer.concat(chunks).toString('utf-8')
          const status = res.statusCode ?? 0
          if (status < 200 || status >= 300) {
            reject(new ScanAuthError(
              'http',
              `HTTP ${status} from WeCom`,
              raw.slice(0, 300),
            ))
            return
          }
          try {
            resolve(JSON.parse(raw) as T)
          } catch {
            reject(new ScanAuthError(
              'invalid-response',
              'Failed to parse JSON response',
              raw.slice(0, 300),
            ))
          }
        })
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error('Request read timeout'))
    })

    req.on('error', (err) => {
      cleanup()
      if (signal?.aborted) {
        reject(new ScanAuthError('cancelled', 'Aborted during request'))
      } else {
        reject(new ScanAuthError('network', err.message))
      }
    })

    if (signal) {
      onAbort = () => {
        req.destroy(new Error('Aborted'))
      }
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort)
      }
    }

    req.end()
  })
}

// ============================================
// Generate scode + auth URL
// ============================================

interface GenerateRawResponse {
  data?: {
    scode?: string
    auth_url?: string
  }
}

/**
 * Request a fresh authorization code (`scode`) + `auth_url` from WeCom.
 *
 * Returns a string pair that the renderer encodes into a QR code. The user
 * then opens the QR code in their WeCom App and explicitly approves the
 * bot creation. The scode has a 5-minute TTL — after that, callers must
 * regenerate.
 */
export async function generateScode(): Promise<ScanAuthGenerateResult> {
  const plat = getPlatCode()
  const path = `/ai/qc/generate?source=${encodeURIComponent(SCAN_AUTH_SOURCE)}&plat=${plat}`
  logEvent('info', 'generate_start', { plat })

  const body = await getJson<GenerateRawResponse>(path)
  const scode = body?.data?.scode
  const authUrl = body?.data?.auth_url

  if (!scode || !authUrl) {
    logEvent('error', 'generate_invalid', { hasScode: Boolean(scode), hasAuthUrl: Boolean(authUrl) })
    throw new ScanAuthError(
      'invalid-response',
      'WeCom did not return scode/auth_url',
    )
  }

  logEvent('info', 'generate_ok', { scodeLen: scode.length, authUrlHost: safeHost(authUrl) })
  return { scode, authUrl }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid'
  }
}

// ============================================
// Poll for scan result
// ============================================

interface QueryRawResponse {
  status?: string
  data?: {
    status?: string
    bot_info?: {
      botid?: string
      secret?: string
    }
  }
}

/**
 * Long-polling loop. Resolves with bot credentials when the user approves on
 * their phone, rejects with a classified ScanAuthError otherwise.
 *
 * The promise also surfaces these terminal conditions:
 *   - signal.aborted               -> ScanAuthError('cancelled')
 *   - elapsed >= timeoutMs         -> ScanAuthError('timeout')
 *   - server status == 'expired'   -> ScanAuthError('expired')
 *
 * Network-level transient failures (status >= 500, ECONNRESET, etc.) are
 * swallowed for one retry tick to keep flaky links from killing an
 * otherwise-valid scan session.
 */
export async function pollResult(
  scode: string,
  opts: PollOptions,
): Promise<ScanAuthBotCredentials> {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const startedAt = Date.now()
  let lastStatus = ''
  let consecutiveErrors = 0

  logEvent('info', 'poll_start', { scodeLen: scode.length, intervalMs, timeoutMs })

  // First tick fires after `intervalMs` so the user has time to scan; if the
  // server is unusually fast, this still resolves on the second iteration.
  while (true) {
    if (opts.signal.aborted) {
      logEvent('info', 'poll_cancelled', { elapsedMs: Date.now() - startedAt })
      throw new ScanAuthError('cancelled', 'Polling cancelled by caller')
    }
    if (Date.now() - startedAt >= timeoutMs) {
      logEvent('warn', 'poll_timeout', { elapsedMs: Date.now() - startedAt })
      throw new ScanAuthError('timeout', 'QR code expired (5 minute limit)')
    }

    await sleepWithAbort(intervalMs, opts.signal)

    let body: QueryRawResponse
    try {
      const path = `/ai/qc/query_result?scode=${encodeURIComponent(scode)}`
      body = await getJson<QueryRawResponse>(path, opts.signal)
      consecutiveErrors = 0
    } catch (err) {
      if (err instanceof ScanAuthError && err.kind === 'cancelled') throw err
      consecutiveErrors += 1
      // Be tolerant of transient network blips — only give up after 3 in a row.
      logEvent('warn', 'poll_tick_error', {
        consecutive: consecutiveErrors,
        kind: err instanceof ScanAuthError ? err.kind : 'unknown',
        message: err instanceof Error ? err.message : String(err),
      })
      if (consecutiveErrors >= 3) {
        throw err
      }
      continue
    }

    // The server has historically used both top-level and nested `status`
    // fields; tolerate either shape for forward-compat.
    const status = body?.data?.status ?? body?.status ?? ''
    if (status !== lastStatus) {
      logEvent('info', 'poll_status_change', { status })
      lastStatus = status
    }

    if (status === 'success') {
      const botId = body?.data?.bot_info?.botid
      const secret = body?.data?.bot_info?.secret
      if (!botId || !secret) {
        logEvent('error', 'poll_success_missing_credentials')
        throw new ScanAuthError(
          'invalid-response',
          'WeCom returned success without bot credentials',
        )
      }
      logEvent('info', 'poll_success', {
        elapsedMs: Date.now() - startedAt,
        botIdPrefix: botId.slice(0, 8),
      })
      return { botId, secret }
    }
    if (status === 'expired') {
      logEvent('warn', 'poll_expired', { elapsedMs: Date.now() - startedAt })
      throw new ScanAuthError('expired', 'Authorization code expired')
    }
    // Any other status ('init', 'pending', '', unknown) keeps polling.
  }
}

/**
 * Promise-based sleep that resolves early on signal abort.
 * Centralised so the polling loop stays readable.
 */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new ScanAuthError('cancelled', 'Aborted during sleep'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ScanAuthError('cancelled', 'Aborted during sleep'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
