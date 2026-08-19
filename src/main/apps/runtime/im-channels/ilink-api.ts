/**
 * iLink API — Shared utilities for the WeChat iLink Bot integration.
 *
 * Used by:
 *   - weixin-ilink.provider.ts  (long-poll + send)
 *   - ilink-media.ts            (CDN download / upload)
 *   - ipc/weixin-ilink.ts       (QR auth flow IPC handlers)
 *   - controllers/weixin-ilink.controller.ts (save-token / disconnect)
 *   - http/routes/index.ts      (QR auth HTTP routes)
 *
 * Centralises the iLink API constants and low-level HTTP helpers so that
 * protocol changes (headers, base URL, version) only need to be made here.
 */

import https from 'https'
import http from 'http'
import type { IncomingHttpHeaders } from 'http'
import { URL } from 'url'

// ============================================
// Constants
// ============================================

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const CHANNEL_VERSION = '1.0.2'

/** errcode / ret value that signals a session expiry requiring re-auth */
export const SESSION_EXPIRED_CODE = -14

// ============================================
// Helpers
// ============================================

/**
 * Generate a random uint32 value encoded as base64 string.
 * Required by iLink API for the X-WECHAT-UIN header.
 */
export function randomUint32Base64(): string {
  const n = Math.floor(Math.random() * 4294967296)
  return Buffer.from(String(n)).toString('base64')
}

/**
 * Build the standard iLink authentication headers.
 * The Authorization header is included only when a bot_token is supplied.
 */
export function buildAuthHeaders(botToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomUint32Base64(),
  }
  if (botToken) {
    headers['Authorization'] = `Bearer ${botToken}`
  }
  return headers
}

/**
 * Check whether a response signals session expiry.
 * iLink uses -14 in both `ret` and `errcode` fields.
 */
export function isSessionExpired(ret: number, errcode?: number): boolean {
  return ret === SESSION_EXPIRED_CODE || errcode === SESSION_EXPIRED_CODE
}

/** Raw HTTP(S) response — headers are needed by the CDN upload flow. */
export interface IlinkRawResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

export interface IlinkRequestOptions {
  method: 'GET' | 'POST'
  url: string
  headers?: Record<string, string>
  body?: Buffer | string
  /** Cancels a request in flight (e.g. the 35 s long-poll on stop()). */
  signal?: AbortSignal
  /** Abort once the response body grows past this size. */
  maxBytes?: number
  /** Abort when the socket makes no progress for this long. */
  timeoutMs?: number
  /**
   * Abort this long after the request starts, whatever the socket is doing.
   * `timeoutMs` alone cannot bound a slow-drip response that trickles bytes
   * just often enough to keep looking alive.
   */
  deadlineMs?: number
}

/**
 * Perform an HTTP(S) request and return the raw response.
 * Used directly for binary transfers (CDN media download / upload);
 * {@link fetchJson} builds on it for the JSON API endpoints.
 */
export function fetchBinary(options: IlinkRequestOptions): Promise<IlinkRawResponse> {
  const { method, url, headers = {}, body, signal, maxBytes, timeoutMs, deadlineMs } = options

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }

    const parsedUrl = new URL(url)
    const isHttps = parsedUrl.protocol === 'https:'
    const transport = isHttps ? https : http

    const reqHeaders: Record<string, string> = { ...headers }
    if (body !== undefined) {
      reqHeaders['Content-Length'] = Buffer.byteLength(body).toString()
    }

    const requestOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: reqHeaders,
    }

    let deadlineTimer: ReturnType<typeof setTimeout> | null = null

    /** Release both timers so neither outlives the request on a pooled socket. */
    function clearTimers(): void {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer)
        deadlineTimer = null
      }
      // Without a socket there is no timer to clear, and setTimeout would only
      // queue a 'socket' listener on a request that will never get one.
      if (timeoutMs !== undefined && req.socket) req.setTimeout(0)
    }

    const req = transport.request(requestOptions, (res) => {
      const chunks: Buffer[] = []
      let received = 0
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (maxBytes !== undefined && received > maxBytes) {
          req.destroy(new Error(`Response exceeds ${maxBytes} bytes`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        clearTimers()
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      })
      res.on('error', reject)
    })

    req.on('error', reject)
    req.on('close', clearTimers)

    if (timeoutMs !== undefined) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms`))
      })
    }

    if (deadlineMs !== undefined) {
      deadlineTimer = setTimeout(() => {
        req.destroy(new Error(`Request exceeded the ${deadlineMs}ms deadline`))
      }, deadlineMs)
    }

    if (signal) {
      const onAbort = () => req.destroy(new Error('Aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      req.on('close', () => signal.removeEventListener('abort', onAbort))
    }

    if (body !== undefined) req.write(body)
    req.end()
  })
}

/**
 * Perform an HTTP(S) request and return the parsed JSON response.
 * Supports GET and POST methods. Throws on network or parse errors.
 *
 * @param signal - Optional AbortSignal for cancelling long-running requests
 *                 (e.g., the 35 s long-poll in the provider).
 */
export async function fetchJson<T>(
  method: 'GET' | 'POST',
  urlStr: string,
  headers: Record<string, string>,
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const res = await fetchBinary({
    method,
    url: urlStr,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })

  const raw = res.body.toString('utf8')
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`Invalid JSON response: ${raw.slice(0, 200)}`)
  }
}
