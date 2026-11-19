/**
 * Proxy-Aware Fetch
 *
 * Drop-in replacement for the global `fetch()` that respects system proxy
 * settings and supports all proxy protocols: HTTP, HTTPS, SOCKS4, SOCKS5.
 *
 * Architecture:
 *   proxyFetch(url, init)
 *       ↓
 *   resolveSystemProxy(url)    ← Electron session.resolveProxy() (Chromium PAC/WPAD)
 *       ↓
 *   ProxyAgent (proxy-agent)   ← auto-selects http-proxy-agent / socks-proxy-agent
 *       ↓
 *   node:https / node:http     ← streaming native Response
 *
 * Supported proxy protocols:
 *   HTTP   (PROXY / http://)   → http-proxy-agent
 *   HTTPS  (HTTPS / https://)  → https-proxy-agent
 *   SOCKS4 (SOCKS4)            → socks-proxy-agent
 *   SOCKS5 (SOCKS5 / socks://) → socks-proxy-agent
 *   DIRECT                     → plain global fetch, zero overhead
 *
 * Usage:
 *   import { proxyFetch } from '../services/proxy-fetch'
 *   const res = await proxyFetch('https://api.github.com/...', { method: 'POST', ... })
 */

import { session } from 'electron'
import https from 'node:https'
import http from 'node:http'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { ProxyAgent } from 'proxy-agent'
import { getConfig, onNetworkConfigChange } from '../foundation/config.service'
import { isHttpLoggingEnabled, logHttpRequest, logHttpResponse, logHttpResponseBody } from '../foundation/logging'
import { chromiumBypassRules, compileBypassList, effectiveProxyOnly, proxyBypassList, serverProxyUrl, type ProxySettings } from './proxy-policy'
import { proxyRequiredMessage, type ProxyRequiredReason } from '../../shared/constants/proxy-required'
import type { ProxyRouteInfo } from '../../shared/rpc/contracts/system.contract'

// ============================================================================
// Baseline transports
// ============================================================================

/**
 * The DIRECT path's fetch.
 *
 * Nothing here patches `globalThis.fetch` or `https.globalAgent`: proxying is
 * opt-in per call site. Plain `fetch()` and `node:https` in the main process
 * therefore ignore both the app proxy and the system proxy — code that must
 * honor them has to call `proxyFetch`, or take an agent from
 * `resolveProxyAgent` when it owns its own transport.
 */
const _originalFetch: typeof fetch = globalThis.fetch

// ============================================================================
// Proxy Resolution Cache
// ============================================================================

const PROXY_CACHE_TTL_MS = 30_000

interface ProxyCacheEntry {
  proxyUrl: string | null
  expiresAt: number
}

const proxyCache = new Map<string, ProxyCacheEntry>()

/**
 * Convert Chromium PAC result string to a proxy URL.
 *
 * session.resolveProxy() returns strings like:
 *   "DIRECT"
 *   "PROXY 127.0.0.1:7890"
 *   "HTTPS 127.0.0.1:7890"
 *   "SOCKS5 127.0.0.1:1080"
 *   "SOCKS5 127.0.0.1:1080;SOCKS 127.0.0.1:1080;DIRECT"  ← PAC, first wins
 */
function parseProxyString(proxyString: string): string | null {
  const entries = proxyString.split(';').map(s => s.trim()).filter(Boolean)

  for (const entry of entries) {
    if (entry === 'DIRECT') continue

    const match = entry.match(/^(\w+)\s+(.+)$/)
    if (!match) continue

    const [, type, hostPort] = match

    switch (type.toUpperCase()) {
      case 'PROXY':
        return `http://${hostPort}`
      case 'HTTPS':
        return `https://${hostPort}`
      case 'SOCKS':
      case 'SOCKS4':
        return `socks4://${hostPort}`
      case 'SOCKS5':
        return `socks5://${hostPort}`
      default:
        return `http://${hostPort}`
    }
  }

  return null // DIRECT or empty
}

/**
 * Resolve system proxy for a URL via Chromium's proxy resolution engine.
 * Results are cached per-origin with a short TTL.
 */
async function resolveSystemProxy(url: string): Promise<string | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const origin = parsed.origin
  const now = Date.now()
  const cached = proxyCache.get(origin)
  if (cached && cached.expiresAt > now) {
    return cached.proxyUrl
  }

  try {
    const proxyString = await session.defaultSession.resolveProxy(url)
    const proxyUrl = parseProxyString(proxyString)

    proxyCache.set(origin, { proxyUrl, expiresAt: now + PROXY_CACHE_TTL_MS })

    if (proxyUrl) {
      console.debug('[ProxyFetch] System proxy selected')
    }

    return proxyUrl
  } catch (err) {
    console.warn('[ProxyFetch] Failed to resolve proxy, falling back to direct:', err)
    return null
  }
}

// ============================================================================
// Agent Pool
// ============================================================================

const agentPool = new Map<string, ProxyAgent>()

function getOrCreateAgent(proxyUrl: string): ProxyAgent {
  let agent = agentPool.get(proxyUrl)
  if (!agent) {
    // proxy-agent v7: pass getProxyForUrl to force all requests through
    // the specified proxy. Passing a bare string does NOT work in v7 —
    // it falls back to env vars (HTTP_PROXY) which may be unset.
    agent = new ProxyAgent({
      getProxyForUrl: () => proxyUrl,
      keepAlive: true,
      keepAliveMsecs: 55_000,
      maxSockets: 25,
      maxFreeSockets: 10,
    })
    agentPool.set(proxyUrl, agent)
  }
  return agent
}

// ============================================================================
// App-level proxy cache (in-memory, updated via onNetworkConfigChange)
// ============================================================================

/** The Settings proxy (null = use the system proxy) and the hosts that bypass any proxy. */
interface ProxyState {
  proxy: string | null
  bypass: string[]
  goesDirect: (url: string) => boolean
  /** The only hosts that take the proxy (server mode, see effectiveProxyOnly); empty = every host. */
  proxyOnly: string[]
  /** Whether a host is on `proxyOnly`; null when the list is empty. */
  proxied: ((url: string) => boolean) | null
  /** Guarded requests (see ProxyFetchOptions) are refused instead of going direct. */
  requireProxyForOAuth: boolean
}

/**
 * Cached proxy state; undefined until first use, which reads config once.
 * Updated synchronously by onNetworkConfigChange — zero disk reads after init.
 */
let _proxyState: ProxyState | undefined

function proxyStateFrom(network: (ProxySettings & { requireProxyForOAuth?: boolean }) | undefined): ProxyState {
  const bypass = proxyBypassList(network, [process.env.NO_PROXY, process.env.no_proxy])
  const proxyOnly = effectiveProxyOnly(network?.proxyOnly)
  return {
    proxy: serverProxyUrl() || network?.proxy?.trim() || null,
    bypass,
    goesDirect: compileBypassList(bypass),
    proxyOnly,
    proxied: proxyOnly.length > 0 ? compileBypassList(proxyOnly) : null,
    requireProxyForOAuth: network?.requireProxyForOAuth === true,
  }
}

// ============================================================================
// AI Browser session proxy sync
//
// The AI Browser uses a dedicated Electron session ('persist:browser')
// separate from the default session. By default, the browser uses the
// system proxy (Electron default), NOT the Settings proxy. This avoids
// breakage when the Settings proxy only supports API traffic (common in
// China where dedicated Claude API proxies don't handle general web).
//
// When `network.browserUseProxy` is true, the Settings proxy is applied
// to the browser session via session.setProxy(). Otherwise the session
// is reset to system proxy mode.
// ============================================================================

const BROWSER_PARTITION = 'persist:browser'

/**
 * Apply the app-level proxy setting to the AI Browser's Electron session.
 *
 * - When a proxy URL is provided, sets `proxyRules` on the session, with the
 *   bypass list as `proxyBypassRules`.
 * - When null/empty, resets the session to follow system proxy (`mode: 'system'`).
 *
 * This is fire-and-forget: session.setProxy() returns a Promise but
 * Chromium queues the config change internally, so subsequent requests
 * pick it up without awaiting.
 */
function applyProxyToBrowserSession(proxy: string | null, bypass: string[]): void {
  try {
    const sess = session.fromPartition(BROWSER_PARTITION)
    const config = proxy
      ? { proxyRules: proxy, proxyBypassRules: chromiumBypassRules(bypass) }
      : { mode: 'system' as const }

    sess.setProxy(config)
      .then(() => {
        console.log(
          `[ProxyFetch] Browser session (${BROWSER_PARTITION}) proxy: ${proxy ? 'configured' : 'system'}`
        )
      })
      .catch(() => console.error('[ProxyFetch] Browser session rejected proxy configuration'))
  } catch (err) {
    // session.fromPartition may throw if called before app.whenReady()
    // — safe to ignore during very early module loading.
    console.warn('[ProxyFetch] Could not access browser session for proxy setup:', err)
  }
}

onNetworkConfigChange(({ proxy, browserUseProxy, noProxy, proxyOnly, requireProxyForOAuth }) => {
  _proxyState = proxyStateFrom({ proxy, noProxy, proxyOnly, requireProxyForOAuth })
  // AI Browser only follows Settings proxy when explicitly opted-in;
  // otherwise it uses the system proxy (Electron default behavior).
  applyProxyToBrowserSession(browserUseProxy ? _proxyState.proxy : null, _proxyState.bypass)
  console.log(`[ProxyFetch] App proxy: ${_proxyState.proxy ? 'configured' : 'system'}, browser: ${browserUseProxy ? 'follows settings' : 'system'}, bypass rules: ${_proxyState.bypass.length}, proxy-only rules: ${_proxyState.proxyOnly.length}`)
})

function getProxyState(): ProxyState {
  if (_proxyState === undefined) {
    // First call: initialize from disk once, then never again
    const network = getConfig().network
    _proxyState = proxyStateFrom(network)
    // Sync to the AI Browser session so it is correct from the first page load.
    // Only apply Settings proxy when browserUseProxy is explicitly true;
    // otherwise let the browser use the system proxy (Electron default).
    const browserUseProxy = network?.browserUseProxy === true
    applyProxyToBrowserSession(browserUseProxy ? _proxyState.proxy : null, _proxyState.bypass)
  }
  return _proxyState
}

/**
 * Whether `proxyOnly` sends a request direct. A guarded request while Settings
 * requires a proxy is never excluded: the account's rule outranks the list.
 */
function excludedByProxyOnly(state: ProxyState, url: string, guarded: boolean): boolean {
  if (!state.proxied || (guarded && state.requireProxyForOAuth)) return false
  return !state.proxied(url)
}

/**
 * The proxy a request takes: none for a bypassed host or one `proxyOnly`
 * excludes, else the Settings proxy, else the system's.
 */
async function resolveProxyUrl(url: string, guarded = false): Promise<string | null> {
  const state = getProxyState()
  if (state.goesDirect(url) || excludedByProxyOnly(state, url, guarded)) return null
  return state.proxy ?? await resolveSystemProxy(url)
}

// ============================================================================
// Guarded requests
//
// An account the user asked to keep off direct routes (Settings > System >
// Proxy). Its requests take the same route as any other, but where that route
// would be direct, they are refused instead: no proxy configured, a system
// answer of DIRECT or a failed lookup, or a host on the bypass list.
// ============================================================================

/** A guarded request found no usable proxy while Settings requires one. */
export class ProxyRequiredError extends Error {
  constructor(readonly reason: ProxyRequiredReason, detail?: string) {
    super(proxyRequiredMessage(reason, detail))
    this.name = 'ProxyRequiredError'
  }
}

export function isProxyRequiredError(error: unknown): error is ProxyRequiredError {
  return error instanceof ProxyRequiredError
}

export interface ProxyFetchOptions {
  /** Do not persist this request or its response in developer HTTP diagnostics. */
  privateDiagnostics?: boolean
  /** The request belongs to an account that must not connect directly when Settings requires a proxy. */
  guarded?: boolean
}

/** The proxy a guarded request takes, or throws; null when Settings does not require one. */
async function resolveGuardedProxyUrlFor(url: string, guarded: boolean): Promise<string | null> {
  const state = getProxyState()
  if (!guarded || !state.requireProxyForOAuth) return resolveProxyUrl(url)
  const proxyUrl = await resolveProxyUrl(url, true)
  if (!proxyUrl) {
    const reason = state.goesDirect(url) ? 'bypassed' : 'none'
    console.warn(`[ProxyFetch] Guarded request refused: reason=${reason} host=${URL.canParse(url) ? new URL(url).host : ''}`)
    throw new ProxyRequiredError(reason)
  }
  return proxyUrl
}

/**
 * Whether a guarded request to `url` may go out now. Returns the proxy it
 * would take (null when Settings does not require one, so any route is fine);
 * throws ProxyRequiredError when one is required and none is usable. For
 * checks before an interactive step, such as opening a sign-in page.
 */
export async function resolveGuardedProxyUrl(url: string): Promise<string | null> {
  const state = getProxyState()
  if (!state.requireProxyForOAuth) return null
  return resolveGuardedProxyUrlFor(url, true)
}

const PROXY_DIAL_ERROR_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'])

/** The proxy's `host:port` when `error` is a failure to reach it, as opposed to a failure of the upstream behind it. */
function unreachableProxy(error: unknown, proxyUrl: string): string | null {
  const { code, port, hostname, message } = (error ?? {}) as { code?: string; port?: number; hostname?: string; message?: string }
  // A SOCKS dial failure carries neither field, only the message ("connect ECONNREFUSED host:port").
  const dialCode = code ?? /^connect ([A-Z]+) /.exec(message ?? '')?.[1]
  if (!dialCode || !PROXY_DIAL_ERROR_CODES.has(dialCode)) return null
  try {
    const proxy = new URL(proxyUrl)
    const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : proxy.protocol.startsWith('socks') ? 1080 : 80)
    const named = !code && (message ?? '').endsWith(`${proxy.hostname}:${proxyPort}`)
    if (port === proxyPort || hostname === proxy.hostname || named) return `${proxy.hostname}:${proxyPort}`
  } catch {
    return null
  }
  return null
}

// ============================================================================
// Node.js HTTP request → native Response (streaming, redirect-aware)
// ============================================================================

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const result: Record<string, string> = {}
    headers.forEach((value, key) => { result[key] = value })
    return result
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers)
  }
  return headers as Record<string, string>
}

async function bodyToBuffer(body: BodyInit | null | undefined): Promise<Buffer | undefined> {
  if (body == null) return undefined
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return Buffer.from(body as ArrayBuffer)
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer())
  if (body instanceof URLSearchParams) return Buffer.from(body.toString())
  return undefined
}

function makeRequest(
  url: string,
  init: RequestInit | undefined,
  agent: http.Agent,
  redirectCount = 0
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) {
      reject(new Error('[ProxyFetch] Too many redirects'))
      return
    }

    const u = new URL(url)
    const isHttps = u.protocol === 'https:'

    const options: https.RequestOptions = {
      hostname: u.hostname,
      port: u.port ? parseInt(u.port) : (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: (init?.method || 'GET').toUpperCase(),
      headers: headersToRecord(init?.headers),
      agent,
    }

    const nodeReq = (isHttps ? https : http).request(options, (res) => {
      // Handle redirects
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && init?.redirect !== 'manual') {
        if (init?.redirect === 'error') {
          res.destroy()
          reject(new TypeError('[ProxyFetch] Redirect refused by request policy'))
          return
        }
        const location = res.headers['location']
        if (location) {
          res.resume() // drain and discard body
          const redirectUrl = new URL(location, url).toString()
          // 303 always converts to GET; 307/308 preserve method
          const redirectInit =
            res.statusCode === 303 && options.method !== 'GET'
              ? { ...init, method: 'GET', body: undefined }
              : init
          makeRequest(redirectUrl, redirectInit, agent, redirectCount + 1).then(resolve, reject)
          return
        }
      }

      // Build response headers
      const responseHeaders = new Headers()
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) {
          value.forEach(v => responseHeaders.append(key, v))
        } else {
          responseHeaders.set(key, value)
        }
      }

      // Auto-decompress gzip/deflate/br responses (node:http doesn't do this)
      // This makes proxied requests behave like globalThis.fetch (undici)
      const statusCode = res.statusCode ?? 200
      const nullBodyStatus = options.method === 'HEAD' || [101, 204, 205, 304].includes(statusCode)
      const contentEncoding = res.headers['content-encoding']?.toLowerCase()
      let bodySource: Readable = res
      if (!nullBodyStatus && (contentEncoding === 'gzip' || contentEncoding === 'x-gzip')) {
        bodySource = res.pipe(zlib.createGunzip())
        responseHeaders.delete('content-encoding')
        responseHeaders.delete('content-length') // length no longer valid after decompression
      } else if (!nullBodyStatus && contentEncoding === 'deflate') {
        bodySource = res.pipe(zlib.createInflate())
        responseHeaders.delete('content-encoding')
        responseHeaders.delete('content-length')
      } else if (!nullBodyStatus && contentEncoding === 'br') {
        bodySource = res.pipe(zlib.createBrotliDecompress())
        responseHeaders.delete('content-encoding')
        responseHeaders.delete('content-length')
      }

      let body: ReadableStream | null = null
      if (!nullBodyStatus) {
        if (bodySource !== res) {
          // pipe() alone neither forwards source failures nor closes the socket
          // when the consumer cancels the decoder's readable side.
          res.on('error', error => bodySource.destroy(error))
          bodySource.once('close', () => res.destroy())
        }
        body = Readable.toWeb(bodySource, {
          strategy: { highWaterMark: 64 * 1024, size: (chunk: Buffer) => chunk.byteLength },
        }) as ReadableStream<Uint8Array>
      } else {
        res.resume()
      }

      resolve(new Response(body, {
        status: statusCode,
        statusText: res.statusMessage ?? '',
        headers: responseHeaders,
      }))
    })

    nodeReq.on('error', reject)

    // Honor init.signal on this path too. The DIRECT path gets abort for free
    // from native fetch; without this, a caller that aborts a proxied request
    // keeps waiting for a socket nobody is going to close.
    const signal = init?.signal
    if (signal) {
      const onAbort = (): void => {
        nodeReq.destroy(signal.reason instanceof Error ? signal.reason : new Error('Aborted'))
      }
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
        nodeReq.on('close', () => signal.removeEventListener('abort', onAbort))
      }
    }

    // Write nothing until a socket is assigned. ProxyAgent passes the request
    // on asynchronously; on a reused keep-alive connection the HTTP-proxy agent
    // only rewrites headers not yet generated, so an earlier write reaches the
    // proxy as `POST /path` and is rejected with 400.
    nodeReq.once('socket', () => {
      bodyToBuffer(init?.body).then(buf => {
        if (buf) nodeReq.write(buf)
        nodeReq.end()
      }).catch(err => {
        nodeReq.destroy(err)
        reject(err)
      })
    })
  })
}

const MAX_RESPONSE_LOG_BYTES = 32 * 1024
const RESPONSE_LOG_TIMEOUT_MS = 2000

async function logResponsePreview(response: Response, method: string, url: string): Promise<void> {
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || ''
  const textual = contentType.startsWith('text/') || /\b(?:json|xml)$/.test(contentType)
    || contentType === 'application/x-www-form-urlencoded'
  const declaredBytes = Number(response.headers.get('content-length'))
  if (!response.body || !textual || contentType === 'text/event-stream' || declaredBytes > MAX_RESPONSE_LOG_BYTES) {
    logHttpResponseBody(method, url, '[Body omitted: binary, streaming, or larger than the diagnostic limit]')
    return
  }

  const reader = response.clone().body!.getReader()
  let timedOut = false
  let complete = false
  let receivedBytes = 0
  const chunks: Uint8Array[] = []
  const cancel = () => {
    // A tee branch's cancellation promise waits for the real consumer; never
    // await it or diagnostics could outlive a long-running response.
    void reader.cancel().catch(() => logHttpResponseBody(method, url, '[Diagnostic preview cancellation failed]'))
  }
  const timeout = setTimeout(() => { timedOut = true; cancel() }, RESPONSE_LOG_TIMEOUT_MS)
  timeout.unref()
  try {
    while (receivedBytes < MAX_RESPONSE_LOG_BYTES) {
      const next = await reader.read()
      if (next.done) { complete = !timedOut; break }
      const slice = next.value.subarray(0, MAX_RESPONSE_LOG_BYTES - receivedBytes)
      chunks.push(slice)
      receivedBytes += slice.byteLength
    }
    const suffix = complete ? '' : timedOut ? '\n[Preview stopped after 2 seconds]' : '\n[Preview truncated at 32 KiB]'
    logHttpResponseBody(method, url, Buffer.concat(chunks, receivedBytes).toString('utf8') + suffix)
  } catch {
    logHttpResponseBody(method, url, '[Diagnostic preview unavailable: response stream failed]')
  } finally {
    clearTimeout(timeout)
    if (!complete && !timedOut) cancel()
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Proxy-aware fetch — same signature as global `fetch()`.
 *
 * Priority order:
 *   1. App-level proxy (Settings > System > Proxy) — highest priority
 *   2. System proxy (Chromium PAC/WPAD via session.resolveProxy)
 *   3. Direct fetch — no proxy configured
 *
 * Supports HTTP, HTTPS, SOCKS4, SOCKS5 proxies.
 * Local addresses and the hosts in the bypass list (proxy-policy) go direct
 * regardless of either proxy.
 *
 * A `guarded` request is never direct while Settings requires a proxy: it
 * throws ProxyRequiredError where the route above would have been direct, and
 * when the proxy itself cannot be reached.
 */
export async function proxyFetch(
  url: string | URL,
  init?: RequestInit,
  options?: ProxyFetchOptions
): Promise<Response> {
  const urlStr = typeof url === 'string' ? url : url.toString()
  const guarded = options?.guarded === true
  const proxyUrl = await resolveGuardedProxyUrlFor(urlStr, guarded)

  const method = (init?.method || 'GET').toUpperCase()
  const logging = !options?.privateDiagnostics && isHttpLoggingEnabled()

  // Developer HTTP logging — no-op when disabled (isHttpLoggingEnabled is O(1))
  if (logging) {
    logHttpRequest({
      method,
      url: urlStr,
      headers: headersToRecord(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
  }

  const startTime = logging ? Date.now() : 0
  let response: Response

  if (!proxyUrl) {
    // Per-request line is high-volume (every outbound fetch, incl. telemetry/analytics).
    // Keep it at debug so it is suppressed in normal production (file level=info) and
    // only surfaces when Developer Mode raises the level to debug. Important requests
    // (LLM/upstream) are already traced at info by their own handlers.
    if (!options?.privateDiagnostics) console.debug(`[ProxyFetch] DIRECT ${method} ${urlStr}`)
    response = await _originalFetch(url, init)
  } else {
    if (!options?.privateDiagnostics) console.debug(`[ProxyFetch] PROXIED ${method} ${urlStr}`)
    const agent = getOrCreateAgent(proxyUrl)
    try {
      response = await makeRequest(urlStr, init, agent)
    } catch (error) {
      const unreachable = guarded && getProxyState().requireProxyForOAuth ? unreachableProxy(error, proxyUrl) : null
      if (unreachable) throw new ProxyRequiredError('unreachable', unreachable)
      throw error
    }
  }

  // Log response summary (status, duration)
  if (logging) {
    const durationMs = Date.now() - startTime
    const resHeaders: Record<string, string> = {}
    response.headers.forEach((v, k) => { resHeaders[k] = v })

    logHttpResponse({
      method,
      url: urlStr,
      status: response.status,
      statusText: response.statusText,
      durationMs,
      headers: resHeaders,
    })

    void logResponsePreview(response, method, urlStr)
      .catch(() => logHttpResponseBody(method, urlStr, '[Diagnostic preview unavailable: body could not be opened]'))
  }

  return response
}

/**
 * Resolve the proxy agent that `proxyFetch` would use for `url`, for callers
 * that cannot go through fetch at all.
 *
 * The case this exists for is a third-party SDK that owns its own transport —
 * a WebSocket dial, or an HTTP client with its own connection pool. Such an SDK
 * usually accepts an `agent`, and handing it this one keeps it on the same
 * route as every other outbound request in the app: app-level proxy first,
 * then Chromium's system resolution, then direct.
 *
 * A plain-http request through it must write nothing before it has a socket,
 * as makeRequest does: otherwise a reused connection sends it to an HTTP proxy
 * without the full URL, and the proxy answers 400.
 *
 * Returns undefined for a direct route, which is also what an `agent` option
 * expects to mean "use the default".
 */
export async function resolveProxyAgent(url: string): Promise<ProxyAgent | undefined> {
  const proxyUrl = await resolveProxyUrl(url)
  return proxyUrl ? getOrCreateAgent(proxyUrl) : undefined
}

/**
 * Like `resolveProxyAgent`, but a private agent for one long-lived connection
 * that its owner may abandon mid-handshake. Aborting `signal` destroys every
 * socket the agent opened — including one to a proxy that accepted the TCP
 * connection and never answered CONNECT, which a pooled agent can never reach
 * and so keeps open for as long as the proxy does.
 *
 * SOCKS proxies ignore the signal; their sockets close the ordinary way.
 */
export async function resolveProxyDialAgent(url: string, signal: AbortSignal): Promise<ProxyAgent | undefined> {
  const proxyUrl = await resolveProxyUrl(url)
  if (!proxyUrl) return undefined
  return new ProxyAgent({
    getProxyForUrl: () => proxyUrl,
    keepAlive: true,
    maxFreeSockets: 2,
    signal,
  })
}

/**
 * How a request to `url` would leave now, for showing the user. The address
 * is host and port only; proxy credentials never leave this module.
 */
export async function describeProxyRoute(url: string): Promise<ProxyRouteInfo> {
  const state = getProxyState()
  const { proxy, goesDirect } = state
  // The accounts this describes are the guarded ones.
  if (goesDirect(url) || excludedByProxyOnly(state, url, true)) return { kind: 'direct', listed: true }
  const via = proxy ? 'settings' : 'system'
  const proxyUrl = proxy ?? await resolveSystemProxy(url)
  if (!proxyUrl) return { kind: 'direct', listed: false }
  try {
    const { host } = new URL(proxyUrl)
    return { kind: 'proxy', via, address: host }
  } catch {
    return { kind: 'direct', listed: false }
  }
}

/**
 * Clear proxy resolution cache.
 * Call when network conditions may have changed (e.g., system wake from sleep).
 */
export function clearProxyCache(): void {
  proxyCache.clear()
}
