/**
 * apps/runtime/im-channels -- Feishu Bot Scan-Auth (Device Flow)
 *
 * Provisions a Feishu (飞书) / Lark bot from the desktop client without the
 * user ever opening the Feishu developer console. Feishu exposes an
 * OAuth 2.0 Device Authorization Grant (RFC 8628) endpoint for this:
 *
 *   1. POST action=begin  -> { device_code, verification_uri_complete, ... }
 *   2. Client renders verification_uri_complete as a QR code
 *   3. User scans it in the Feishu app, reviews the pre-filled app and agrees
 *   4. POST action=poll   -> { client_id, client_secret, user_info }
 *
 * `client_id` / `client_secret` are the created app's App ID / App Secret.
 * The created app is a Feishu "智能体应用" (agent app): bot capability on,
 * messaging + card scopes granted, `im.message.receive_v1` subscribed, and
 * event delivery already set to WebSocket long connection — which is what
 * FeishuBotProvider then connects to.
 *
 * Domain handling: the same device_code may belong to a Lark (international)
 * tenant. Feishu reports that through `user_info.tenant_brand`, and the poll
 * must then continue against the Lark account host. The resolved brand is
 * returned to the caller because every later API call (long connection,
 * message send) has to target the matching domain.
 *
 * This module is intentionally pure-functional and stateless: callers own
 * cancellation via AbortSignal. The IPC / HTTP layers map a device code to an
 * AbortController and expose a cancel() entry point.
 *
 * Secrets are never logged: only `appIdPrefix` is ever emitted, and the log
 * helper drops credential-shaped keys defensively.
 */

import { gzipSync } from 'zlib'
import { proxyFetch } from '../../../services/proxy-fetch'
import { loadProductConfig } from '../../../foundation/product-config'

// ============================================
// Constants
// ============================================

/** Account host that issues device codes for Feishu (China) tenants. */
const FEISHU_ACCOUNTS_HOST = 'accounts.feishu.cn'
/** Account host for Lark (international) tenants. */
const LARK_ACCOUNTS_HOST = 'accounts.larksuite.com'
/** Device-flow endpoint path (same on both hosts). */
const REGISTRATION_PATH = '/oauth/v1/app/registration'
/** Fallback poll cadence when the server omits `interval`. */
const DEFAULT_POLL_INTERVAL_MS = 5_000
/** Fallback authorization window when the server omits `expires_in`. */
const DEFAULT_EXPIRE_MS = 10 * 60_000
/** Added to the poll interval when the server answers `slow_down`. */
const SLOW_DOWN_STEP_MS = 5_000
/** Per-request HTTPS timeout (network read). */
const HTTPS_REQUEST_TIMEOUT_MS = 15_000
/** Identifier sent in the `source` query parameter; informational only. */
const SCAN_AUTH_SOURCE = 'halo'
/** Feishu allows at most 6 avatar candidates on the creation page. */
const AVATAR_MAX_COUNT = 6

/**
 * Exactly what the bot needs to run, and nothing else.
 *
 * Why this matters more than it looks: Feishu exempts an app from admin review
 * only when all three of its conditions hold, and the binding one is "requested
 * permissions are inside the range the admin allows". The platform's default
 * agent template asks for ~35 scopes — cloud docs read/write, doc comments,
 * drive metadata, wiki nodes, app self-management — which no security-conscious
 * tenant puts on an exemption list. Asking for those means every install lands
 * in a review queue, for capabilities this provider never calls.
 *
 * The set below is derived from what feishu-bot.provider.ts actually does:
 *   - send / reply                    → im:message:send_as_bot
 *   - receive direct messages          → im:message.p2p_msg:readonly
 *   - receive group @-mentions         → im:message.group_at_msg:readonly
 *   - read an inbound message's files  → im:message:readonly
 *   - upload files, fetch resources    → im:resource
 *   - group display name               → im:chat:read
 *   - who a direct chat is with        → contact:contact.base:readonly + contact:user.base:readonly
 *   - streaming reply cards            → cardkit:card:read / :write
 *
 * The message-read scope is easy to miss and impossible to work around: the
 * receive scopes deliver the event, but downloading the image or file it
 * carries is refused without one of the message-read scopes, and Feishu offers
 * no other endpoint for a resource that arrived in someone else's message.
 *
 * Deliberately absent: reading un-mentioned group messages
 * (`im:message.group_msg`) is a sensitive scope that always triggers review, so
 * it stays a decision the user makes explicitly in the Feishu console rather
 * than something Halo asks for on their behalf.
 */
export const BOT_MINIMUM_ADDONS = {
  // Drop the platform's default template — additive-only would keep all 35.
  preset: false,
  scopes: {
    tenant: [
      'im:message:send_as_bot',
      'im:message.p2p_msg:readonly',
      'im:message.group_at_msg:readonly',
      'im:message:readonly',
      'im:resource',
      'im:chat:read',
      // Feishu returns no name for a one-to-one chat, so the only way to label
      // a direct conversation with a person instead of an opaque id is to look
      // the sender up. Both are contacts scopes, which the platform's
      // exemption list covers, and they read only what the app's own members
      // can already see.
      'contact:contact.base:readonly',
      'contact:user.base:readonly',
      'cardkit:card:read',
      'cardkit:card:write',
    ],
  },
  events: {
    items: {
      tenant: ['im.message.receive_v1'],
    },
  },
} as const

// ============================================
// Types
// ============================================

/** Tenant brand decides which API/WS domain every later call must use. */
export type FeishuTenantBrand = 'feishu' | 'lark'

/** Result of the `begin` step. */
export interface FeishuScanAuthBeginResult {
  /** Device code — the poll key, and the session key used by callers. */
  deviceCode: string
  /** Full URL to encode into the QR code that the user scans. */
  authUrl: string
  /** Account host that issued this device code; poll must start there. */
  host: string
  /** Server-advertised poll cadence. */
  intervalMs: number
  /** Server-advertised validity window of the QR code. */
  expiresInMs: number
}

/** Credentials of the app the user just authorized into existence. */
export interface FeishuAppCredentials {
  /** App ID (`cli_…`). */
  appId: string
  /** App Secret — never logged. */
  appSecret: string
  /** Feishu vs Lark, resolved during polling. */
  tenantBrand: FeishuTenantBrand
  /** open_id of the scanning user, when the tenant returns it. */
  openId?: string
}

/**
 * Values pre-filled into the creation page. Every field is a default the user
 * can still edit before agreeing, which is why Halo presets a name but never
 * forces one.
 */
export interface FeishuScanAuthAppPreset {
  /** App name. Feishu replaces a `{user}` placeholder with the scanner's name. */
  name?: string
  /** App description. Supports the same `{user}` placeholder. */
  desc?: string
  /** 1–6 publicly reachable image URLs; the first is pre-selected. */
  avatar?: string[]
}

/** Options accepted by pollRegistration(). */
export interface FeishuPollOptions {
  /** Abort the polling loop immediately on signal abort. Required. */
  signal: AbortSignal
  /** Account host returned by beginRegistration(). */
  host: string
  /** Override the server-advertised cadence. */
  intervalMs?: number
  /** Override the server-advertised deadline. */
  timeoutMs?: number
}

/**
 * Distinct, classifiable error reasons surfaced to the IPC layer. The renderer
 * uses these to decide whether to show "retry", "scan again", or "report".
 */
export type FeishuScanAuthErrorKind =
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid-response'
  | 'expired'
  | 'denied'

export class FeishuScanAuthError extends Error {
  readonly kind: FeishuScanAuthErrorKind
  readonly detail?: string
  constructor(kind: FeishuScanAuthErrorKind, message: string, detail?: string) {
    super(message)
    this.name = 'FeishuScanAuthError'
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
  const parts: string[] = ['[FeishuScanAuth]', `ts=${ts}`, `event=${event}`]
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue
    // Redact credential-shaped values defensively. Callers are expected to
    // redact explicitly; this guard means an accidental field-name reuse
    // still cannot leak a secret into the log.
    if (k === 'appSecret' || k === 'appId' || k === 'deviceCode' || k === 'clientSecret') continue
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    parts.push(`${k}=${s.length > 200 ? s.slice(0, 200) + '...' : s}`)
  }
  const line = parts.join(' ')
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

// ============================================
// HTTPS POST Helper (AbortSignal-aware)
// ============================================

/**
 * Raw shape of a registration response. Both success and RFC-8628 error bodies
 * come back on this endpoint; errors arrive with HTTP 400, so a non-2xx status
 * carrying a parsable body is data, not a transport failure.
 */
interface RegistrationRawResponse {
  device_code?: string
  verification_uri_complete?: string
  interval?: number
  expires_in?: number
  client_id?: string
  client_secret?: string
  user_info?: {
    open_id?: string
    tenant_brand?: string
  }
  error?: string
  error_description?: string
}

/**
 * POST form-encoded params to the registration endpoint and return the parsed
 * body.
 *
 * Goes through `proxyFetch`, not a raw request: on a machine whose route to
 * Feishu is a proxy (common in corporate networks, and the default for many
 * mainland setups), a direct socket simply hangs until the read timeout, and
 * the user sees "setup failed" with nothing to act on. proxyFetch applies the
 * same precedence as every other outbound call in Halo — app-level proxy,
 * then Chromium's system resolution, then direct.
 *
 * - Respects the supplied AbortSignal, plus its own per-request deadline so one
 *   unresponsive request cannot stall the polling loop.
 * - Treats a 4xx body that parses as JSON as a protocol answer (RFC 8628
 *   returns `authorization_pending` / `slow_down` with HTTP 400).
 */
async function postRegistration(
  host: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<RegistrationRawResponse> {
  if (signal?.aborted) {
    throw new FeishuScanAuthError('cancelled', 'Aborted before request')
  }

  // One controller combining the caller's signal with this request's deadline,
  // so whichever fires first releases the socket.
  const controller = new AbortController()
  const onCallerAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, HTTPS_REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await proxyFetch(`https://${host}${REGISTRATION_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Halo (Feishu Scan Auth)',
        Accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    })
  } catch (err) {
    if (signal?.aborted) {
      throw new FeishuScanAuthError('cancelled', 'Aborted during request')
    }
    if (timedOut) {
      throw new FeishuScanAuthError(
        'network',
        `No response from ${host} within ${HTTPS_REQUEST_TIMEOUT_MS / 1000}s`,
        'If this machine reaches the internet through a proxy, set it in Settings > System > Proxy.',
      )
    }
    // `fetch failed` on its own names nothing: the actionable part (ECONNREFUSED,
    // a TLS failure, the proxy refusing CONNECT) lives in the cause.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined
    throw new FeishuScanAuthError(
      'network',
      `Cannot reach ${host}: ${cause ?? (err instanceof Error ? err.message : String(err))}`,
      'If this machine reaches the internet through a proxy, set it in Settings > System > Proxy.',
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
  }

  const raw = await response.text()
  try {
    // A parsable body is the protocol's answer regardless of status:
    // pending/slow_down/expired_token all arrive as HTTP 400.
    return JSON.parse(raw) as RegistrationRawResponse
  } catch {
    if (!response.ok) {
      throw new FeishuScanAuthError(
        'http',
        `HTTP ${response.status} from Feishu`,
        raw.slice(0, 300),
      )
    }
    throw new FeishuScanAuthError(
      'invalid-response',
      'Failed to parse JSON response',
      raw.slice(0, 300),
    )
  }
}

// ============================================
// Begin: device code + QR URL
// ============================================

/**
 * Build the default creation-page prefill.
 *
 * Only a name and description are preset. No avatar: Feishu accepts avatars as
 * publicly reachable URLs only, and Halo is a local-first desktop app with no
 * hosted asset to point at — the user picks an icon on the creation page
 * instead. `{user}` is expanded server-side to the scanning user's name.
 */
export function buildDefaultAppPreset(): FeishuScanAuthAppPreset {
  let productName = 'Halo'
  try {
    productName = loadProductConfig().name || productName
  } catch {
    // Product config is unavailable in some test harnesses; the literal is a
    // safe default because this value is only a UI prefill.
  }
  return {
    name: productName,
    desc: `${productName} AI assistant`,
  }
}

/**
 * Start a device-flow registration.
 *
 * Returns the device code (the poll/cancel key) plus the URL to render as a QR
 * code. The QR code carries `createOnly=true`: the landing page then only
 * offers creating a new app, which keeps a mis-tap from re-pointing an existing
 * production app's event subscription at this machine.
 */
export async function beginRegistration(
  preset: FeishuScanAuthAppPreset = buildDefaultAppPreset(),
): Promise<FeishuScanAuthBeginResult> {
  logEvent('info', 'begin_start', { host: FEISHU_ACCOUNTS_HOST })

  const body = await postRegistration(FEISHU_ACCOUNTS_HOST, {
    action: 'begin',
    // The app archetype Feishu provisions for AI agents: bot capability,
    // messaging/card scopes, im.message.receive_v1, long-connection delivery.
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  })

  if (body.error) {
    logEvent('error', 'begin_rejected', { error: body.error, description: body.error_description })
    throw new FeishuScanAuthError(
      'invalid-response',
      body.error_description || `Feishu rejected the request (${body.error})`,
    )
  }

  const deviceCode = body.device_code
  const verificationUri = body.verification_uri_complete
  if (!deviceCode || !verificationUri) {
    logEvent('error', 'begin_invalid', {
      hasDeviceCode: Boolean(deviceCode),
      hasVerificationUri: Boolean(verificationUri),
    })
    throw new FeishuScanAuthError(
      'invalid-response',
      'Feishu did not return device_code/verification_uri_complete',
    )
  }

  const authUrl = decorateAuthUrl(verificationUri, preset)
  const intervalMs = Math.max(1_000, (body.interval ?? DEFAULT_POLL_INTERVAL_MS / 1000) * 1000)
  const expiresInMs = Math.max(30_000, (body.expires_in ?? DEFAULT_EXPIRE_MS / 1000) * 1000)

  logEvent('info', 'begin_ok', {
    authUrlHost: safeHost(authUrl),
    intervalMs,
    expiresInMs,
    presetName: preset.name,
    requestedScopes: BOT_MINIMUM_ADDONS.scopes.tenant.length,
  })

  return { deviceCode, authUrl, host: FEISHU_ACCOUNTS_HOST, intervalMs, expiresInMs }
}

/**
 * Hosts a verification URI is allowed to point at. The URI comes from a TLS
 * response we initiated ourselves, but it is rendered as a QR code the user is
 * told to scan — defense in depth demands we never encode anything but an
 * official Feishu/Lark account page, even if the response was tampered with.
 */
const ALLOWED_VERIFICATION_HOSTS: ReadonlySet<string> = new Set([
  FEISHU_ACCOUNTS_HOST,
  LARK_ACCOUNTS_HOST,
])

/**
 * Append Halo's identification, the creation-page prefill and the requested
 * permission set to the URL the server issued. `tp` / `from` are page-behavior
 * flags; `source` is telemetry.
 *
 * Refuses (rather than passes through) a verification URI that is not an
 * https URL on an official account host: a failed setup is strictly better
 * than a QR code that sends the user to an attacker-chosen page.
 */
function decorateAuthUrl(verificationUri: string, preset: FeishuScanAuthAppPreset): string {
  let url: URL
  try {
    url = new URL(verificationUri)
  } catch {
    logEvent('error', 'begin_bad_verification_uri', { reason: 'unparsable' })
    throw new FeishuScanAuthError(
      'invalid-response',
      'Feishu returned an unusable verification URL',
    )
  }
  if (url.protocol !== 'https:' || !ALLOWED_VERIFICATION_HOSTS.has(url.host)) {
    logEvent('error', 'begin_bad_verification_uri', {
      reason: 'disallowed',
      scheme: url.protocol,
      host: url.host,
    })
    throw new FeishuScanAuthError(
      'invalid-response',
      'Feishu returned a verification URL outside the official Feishu/Lark domains',
    )
  }
  url.searchParams.set('from', 'sdk')
  url.searchParams.set('tp', 'sdk')
  url.searchParams.set('source', SCAN_AUTH_SOURCE)
  url.searchParams.set('createOnly', 'true')
  url.searchParams.set('addons', encodeAddons(BOT_MINIMUM_ADDONS))
  if (preset.name) url.searchParams.set('name', preset.name)
  if (preset.desc) url.searchParams.set('desc', preset.desc)
  for (const avatar of (preset.avatar ?? []).slice(0, AVATAR_MAX_COUNT)) {
    if (avatar) url.searchParams.append('avatar', avatar)
  }
  return url.toString()
}

/**
 * Encode the requested app configuration into the `addons` query parameter.
 *
 * The pipeline is fixed by the platform:
 * `JSON → gzip → base64 → URL-safe ('+'→'-', '/'→'_') → strip '=' padding`.
 * The result is already URL-safe, so it needs no further escaping.
 *
 * The confirmation page discards the whole payload on any shape mismatch, and
 * the platform gates this parameter behind a rollout flag — in a tenant where
 * it is not enabled the page simply falls back to the default template. Both
 * failure modes are silent by design, which is why `begin_ok` logs the scope
 * count that was asked for: it is the only way to tell afterwards whether a
 * review was triggered by our request or by the fallback.
 */
function encodeAddons(addons: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(addons), 'utf8'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid'
  }
}

// ============================================
// Poll for the authorized app credentials
// ============================================

/**
 * Long-polling loop. Resolves with the created app's credentials once the user
 * agrees in the Feishu client, rejects with a classified error otherwise.
 *
 * Terminal conditions:
 *   - signal.aborted                -> kind=cancelled
 *   - elapsed >= timeoutMs          -> kind=timeout
 *   - server `expired_token`        -> kind=expired
 *   - server `access_denied`        -> kind=denied
 *
 * `slow_down` widens the cadence as the protocol requires. Transient network
 * failures are tolerated for two consecutive ticks so a flaky link does not
 * kill an otherwise-valid scan session.
 */
export async function pollRegistration(
  deviceCode: string,
  opts: FeishuPollOptions,
): Promise<FeishuAppCredentials> {
  let intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXPIRE_MS
  const startedAt = Date.now()
  let host = opts.host || FEISHU_ACCOUNTS_HOST
  let brand: FeishuTenantBrand = 'feishu'
  let domainSwitched = false
  let consecutiveErrors = 0

  logEvent('info', 'poll_start', { host, intervalMs, timeoutMs })

  // First tick fires after `intervalMs` so the user has time to scan.
  for (;;) {
    if (opts.signal.aborted) {
      logEvent('info', 'poll_cancelled', { elapsedMs: Date.now() - startedAt })
      throw new FeishuScanAuthError('cancelled', 'Polling cancelled by caller')
    }
    if (Date.now() - startedAt >= timeoutMs) {
      logEvent('warn', 'poll_timeout', { elapsedMs: Date.now() - startedAt })
      throw new FeishuScanAuthError('timeout', 'QR code expired')
    }

    await sleepWithAbort(intervalMs, opts.signal)

    let body: RegistrationRawResponse
    try {
      body = await postRegistration(host, { action: 'poll', device_code: deviceCode }, opts.signal)
      consecutiveErrors = 0
    } catch (err) {
      if (err instanceof FeishuScanAuthError && err.kind === 'cancelled') throw err
      consecutiveErrors += 1
      // Be tolerant of transient network blips — only give up after 3 in a row.
      logEvent('warn', 'poll_tick_error', {
        consecutive: consecutiveErrors,
        kind: err instanceof FeishuScanAuthError ? err.kind : 'unknown',
        message: err instanceof Error ? err.message : String(err),
      })
      if (consecutiveErrors >= 3) throw err
      continue
    }

    // A Lark tenant answers on the Lark account host only. Switch once and keep
    // the brand: every later API/WS call has to target the same domain.
    if (body.user_info?.tenant_brand === 'lark' && !domainSwitched) {
      host = LARK_ACCOUNTS_HOST
      brand = 'lark'
      domainSwitched = true
      logEvent('info', 'poll_domain_switched', { host })
      continue
    }

    if (body.client_id && body.client_secret) {
      if (body.user_info?.tenant_brand === 'lark') brand = 'lark'
      logEvent('info', 'poll_success', {
        elapsedMs: Date.now() - startedAt,
        appIdPrefix: body.client_id.slice(0, 12),
        tenantBrand: brand,
        hasOpenId: Boolean(body.user_info?.open_id),
      })
      return {
        appId: body.client_id,
        appSecret: body.client_secret,
        tenantBrand: brand,
        ...(body.user_info?.open_id ? { openId: body.user_info.open_id } : {}),
      }
    }

    switch (body.error) {
      case 'authorization_pending':
        // Expected while the user has not finished scanning/confirming.
        break
      case 'slow_down':
        intervalMs += SLOW_DOWN_STEP_MS
        logEvent('info', 'poll_slow_down', { intervalMs })
        break
      case 'access_denied':
        logEvent('warn', 'poll_denied', { elapsedMs: Date.now() - startedAt })
        throw new FeishuScanAuthError(
          'denied',
          body.error_description || 'Authorization was declined in Feishu',
        )
      case 'expired_token':
        logEvent('warn', 'poll_expired', { elapsedMs: Date.now() - startedAt })
        throw new FeishuScanAuthError('expired', 'Authorization code expired')
      default:
        if (body.error) {
          logEvent('error', 'poll_error', { error: body.error, description: body.error_description })
          throw new FeishuScanAuthError(
            'invalid-response',
            body.error_description || `Feishu returned ${body.error}`,
          )
        }
        // No credentials and no error: keep polling (forward-compatible).
        break
    }
  }
}

/**
 * Promise-based sleep that rejects early on signal abort.
 * Centralised so the polling loop stays readable.
 */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new FeishuScanAuthError('cancelled', 'Aborted during sleep'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new FeishuScanAuthError('cancelled', 'Aborted during sleep'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
