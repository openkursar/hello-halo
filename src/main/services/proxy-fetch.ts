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
import { ProxyAgent } from 'proxy-agent'
import { getConfig, onNetworkConfigChange } from '../foundation/config.service'
import { isHttpLoggingEnabled, logHttpRequest, logHttpResponse, logHttpResponseBody } from '../foundation/logging'

// ============================================================================
// Preserve originals before any global patching
// ============================================================================

/**
 * Original global fetch — captured before initGlobalProxy() patches globalThis.fetch.
 * Used internally in the DIRECT path to avoid infinite recursion.
 */
const _originalFetch: typeof fetch = globalThis.fetch

/** Default Node.js agents — restored when proxy is cleared */
const _defaultHttpAgent = http.globalAgent
const _defaultHttpsAgent = https.globalAgent

// ============================================================================
// Proxy Resolution Cache
// ============================================================================

const PROXY_CACHE_TTL_MS = 30_000

interface ProxyCacheEntry {
  proxyUrl: string | null
  expiresAt: number
}

const proxyCache = new Map<string, ProxyCacheEntry>()

/** Hosts that always bypass proxy */
const BYPASS_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

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

  if (BYPASS_HOSTS.has(parsed.hostname)) {
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
      console.log(`[ProxyFetch] Resolved proxy for ${origin}: ${proxyUrl}`)
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

/**
 * Cached app proxy URL from config.
 * - undefined  = not yet initialized (will read config once on first use)
 * - null       = initialized, no proxy configured (use system proxy)
 * - string     = initialized, explicit proxy URL
 *
 * Updated synchronously by onNetworkConfigChange — zero disk reads after init.
 */
let _appProxy: string | null | undefined = undefined

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
const PROXY_BYPASS_RULES = 'localhost,127.0.0.1,[::1]'

/**
 * Apply the app-level proxy setting to the AI Browser's Electron session.
 *
 * - When a proxy URL is provided, sets `proxyRules` on the session.
 * - When null/empty, resets the session to follow system proxy (`mode: 'system'`).
 * - localhost/loopback always bypasses proxy via `proxyBypassRules`.
 *
 * This is fire-and-forget: session.setProxy() returns a Promise but
 * Chromium queues the config change internally, so subsequent requests
 * pick it up without awaiting.
 */
function applyProxyToBrowserSession(proxy: string | null): void {
  try {
    const sess = session.fromPartition(BROWSER_PARTITION)
    const config = proxy
      ? { proxyRules: proxy, proxyBypassRules: PROXY_BYPASS_RULES }
      : { mode: 'system' as const }

    sess.setProxy(config)
      .then(() => {
        console.log(
          `[ProxyFetch] Browser session (${BROWSER_PARTITION}) proxy: ${proxy || 'system'}`
        )
      })
      .catch((err) => {
        console.error(`[ProxyFetch] Failed to set browser session proxy:`, err)
      })
  } catch (err) {
    // session.fromPartition may throw if called before app.whenReady()
    // — safe to ignore during very early module loading.
    console.warn('[ProxyFetch] Could not access browser session for proxy setup:', err)
  }
}

onNetworkConfigChange(({ proxy, browserUseProxy }) => {
  _appProxy = proxy?.trim() || null
  // AI Browser only follows Settings proxy when explicitly opted-in;
  // otherwise it uses the system proxy (Electron default behavior).
  applyProxyToBrowserSession(browserUseProxy ? _appProxy : null)
  console.log(`[ProxyFetch] App proxy updated: ${_appProxy || 'none (auto-detect from system)'}, browser: ${browserUseProxy ? 'follows settings' : 'system'}`)
})

function getAppProxy(): string | null {
  if (_appProxy === undefined) {
    // First call: initialize from disk once, then never again
    const network = getConfig().network
    _appProxy = network?.proxy?.trim() || null
    // Sync to the AI Browser session so it is correct from the first page load.
    // Only apply Settings proxy when browserUseProxy is explicitly true;
    // otherwise let the browser use the system proxy (Electron default).
    const browserUseProxy = network?.browserUseProxy === true
    applyProxyToBrowserSession(browserUseProxy ? _appProxy : null)
  }
  return _appProxy
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
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
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
      const contentEncoding = res.headers['content-encoding']?.toLowerCase()
      let bodySource: NodeJS.ReadableStream = res
      if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') {
        bodySource = res.pipe(zlib.createGunzip())
        responseHeaders.delete('content-encoding')
        responseHeaders.delete('content-length') // length no longer valid after decompression
      } else if (contentEncoding === 'deflate') {
        bodySource = res.pipe(zlib.createInflate())
        responseHeaders.delete('content-encoding')
        responseHeaders.delete('content-length')
      } else if (contentEncoding === 'br') {
        bodySource = res.pipe(zlib.createBrotliDecompress())
        responseHeaders.delete('content-encoding')
        responseHeaders.delete('content-length')
      }

      const statusCode = res.statusCode ?? 200
      // 101, 204, 205, 304 are null body statuses per Fetch spec —
      // Response constructor throws if body is non-null for these.
      const nullBodyStatus = [101, 204, 205, 304].includes(statusCode)

      let body: ReadableStream | null = null
      if (!nullBodyStatus) {
        // Stream response body so SSE / large responses work correctly
        body = new ReadableStream({
          start(controller) {
            bodySource.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
            bodySource.on('end', () => controller.close())
            bodySource.on('error', (err) => controller.error(err))
          },
          cancel() {
            res.destroy()
          },
        })
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

    // Write request body
    if (init?.body != null) {
      bodyToBuffer(init.body).then(buf => {
        if (buf) nodeReq.write(buf)
        nodeReq.end()
      }).catch(err => {
        nodeReq.destroy(err)
        reject(err)
      })
    } else {
      nodeReq.end()
    }
  })
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
 * localhost / 127.0.0.1 always bypasses proxy regardless of setting.
 */
export async function proxyFetch(
  url: string | URL,
  init?: RequestInit
): Promise<Response> {
  const urlStr = typeof url === 'string' ? url : url.toString()

  // App-level proxy (in-memory cache, zero disk reads after first call)
  const appProxy = getAppProxy()

  let proxyUrl: string | null
  if (appProxy) {
    // Manual proxy configured — still respect localhost bypass
    const hostname = (() => {
      try { return new URL(urlStr).hostname } catch { return '' }
    })()
    proxyUrl = BYPASS_HOSTS.has(hostname) ? null : appProxy
  } else {
    // Auto-detect from Chromium's proxy resolution engine
    proxyUrl = await resolveSystemProxy(urlStr)
  }

  const method = (init?.method || 'GET').toUpperCase()
  const logging = isHttpLoggingEnabled()

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
    console.log(`[ProxyFetch] DIRECT ${method} ${urlStr}`)
    response = await _originalFetch(url, init)
  } else {
    console.log(`[ProxyFetch] VIA ${proxyUrl} → ${method} ${urlStr}`)
    const agent = getOrCreateAgent(proxyUrl)
    response = await makeRequest(urlStr, init, agent)
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

    // Fire-and-forget: clone response and read body asynchronously.
    // Does not block the return — consumer gets the response immediately.
    // For SSE streams, logs the full concatenated body when stream ends.
    const cloned = response.clone()
    cloned.text()
      .then(body => logHttpResponseBody(method, urlStr, body))
      .catch(() => { /* non-fatal — body may be unreadable */ })
  }

  return response
}

/**
 * Clear proxy resolution cache.
 * Call when network conditions may have changed (e.g., system wake from sleep).
 */
export function clearProxyCache(): void {
  proxyCache.clear()
}
