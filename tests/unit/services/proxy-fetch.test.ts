/**
 * Unit tests for proxy-fetch.ts.
 *
 * Focus:
 *   - DIRECT resolution routes to the ORIGINAL fetch (captured at import time),
 *     never re-entering proxyFetch (no infinite recursion).
 *   - Per-origin proxy cache: a second call within the TTL reuses the resolved
 *     value (resolveProxy not called again); after the TTL it re-resolves.
 *   - gzip / deflate response bodies are transparently decoded on the proxy path
 *     (makeRequest), matching global fetch/undici behavior.
 *
 * Setup notes:
 *   - electron `session.defaultSession.resolveProxy` is mocked so proxy choice
 *     is deterministic.
 *   - config.service / logging are stubbed (no disk, no side effects).
 *   - globalThis.fetch is replaced BEFORE importing the module, because the
 *     module captures `_originalFetch = globalThis.fetch` at load time. The
 *     module is therefore imported dynamically after the mocks are in place.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'

const resolveProxy = vi.fn(async () => 'DIRECT')
let networkChangeHandler: ((cfg: { proxy?: string; browserUseProxy?: boolean }) => void) | null = null

vi.mock('electron', () => ({
  session: {
    defaultSession: { resolveProxy: (url: string) => resolveProxy(url) },
    fromPartition: () => ({ setProxy: () => Promise.resolve() }),
  },
}))

vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({ network: {} }),
  onNetworkConfigChange: (h: (cfg: { proxy?: string; browserUseProxy?: boolean }) => void) => {
    networkChangeHandler = h
    return () => {}
  },
}))

vi.mock('../../../src/main/foundation/logging', () => ({
  isHttpLoggingEnabled: () => false,
  logHttpRequest: vi.fn(),
  logHttpResponse: vi.fn(),
  logHttpResponseBody: vi.fn(),
}))

// Replace global fetch BEFORE importing proxy-fetch so `_originalFetch` binds to it.
const originalFetchMock = vi.fn(async () => new Response('direct-body', { status: 200 }))
;(globalThis as { fetch: typeof fetch }).fetch = originalFetchMock as unknown as typeof fetch

// Dynamic import after mocks + global patch are in place.
const { proxyFetch, clearProxyCache } = await import('../../../src/main/services/proxy-fetch')

describe('proxyFetch — DIRECT path', () => {
  beforeEach(() => {
    resolveProxy.mockClear()
    originalFetchMock.mockClear()
    resolveProxy.mockResolvedValue('DIRECT')
    clearProxyCache()
  })

  it('routes DIRECT to the original fetch without recursion', async () => {
    const res = await proxyFetch('https://api.example.com/data')
    expect(await res.text()).toBe('direct-body')
    expect(originalFetchMock).toHaveBeenCalledTimes(1)
    // The original fetch received the same url/init — no wrapper re-entry.
    expect(originalFetchMock).toHaveBeenCalledWith('https://api.example.com/data', undefined)
  })

  it('bypasses proxy resolution for localhost (never calls resolveProxy)', async () => {
    await proxyFetch('http://localhost:1234/ping')
    expect(resolveProxy).not.toHaveBeenCalled()
    expect(originalFetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('proxyFetch — proxy resolution cache (TTL)', () => {
  beforeEach(() => {
    resolveProxy.mockClear()
    originalFetchMock.mockClear()
    resolveProxy.mockResolvedValue('DIRECT')
    clearProxyCache()
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses the cached resolution for the same origin within the 30s TTL', async () => {
    await proxyFetch('https://cache.example.com/a')
    await proxyFetch('https://cache.example.com/b')
    // Same origin, within TTL → resolveProxy called once.
    expect(resolveProxy).toHaveBeenCalledTimes(1)
  })

  it('re-resolves after the TTL expires', async () => {
    await proxyFetch('https://cache.example.com/a')
    expect(resolveProxy).toHaveBeenCalledTimes(1)

    // Advance beyond the 30s TTL.
    vi.setSystemTime(31_000)
    await proxyFetch('https://cache.example.com/b')
    expect(resolveProxy).toHaveBeenCalledTimes(2)
  })
})

describe('proxyFetch — body decompression on the proxy path', () => {
  let proxyServer: http.Server
  let proxyPort: number

  // A stand-in proxy that answers every request with a compressed body.
  // Because an app-level proxy is configured, proxyFetch dials this server via
  // ProxyAgent and runs the response through makeRequest's decode branch.
  function startProxy(encode: (buf: Buffer) => Buffer, encoding: string): Promise<void> {
    return new Promise((resolve) => {
      proxyServer = http.createServer((_req, res) => {
        const payload = encode(Buffer.from('decoded-payload'))
        res.writeHead(200, { 'content-encoding': encoding, 'content-type': 'text/plain' })
        res.end(payload)
      })
      proxyServer.listen(0, '127.0.0.1', () => {
        proxyPort = (proxyServer.address() as AddressInfo).port
        resolve()
      })
    })
  }

  afterEach(() => {
    networkChangeHandler?.({ proxy: '', browserUseProxy: false })
    clearProxyCache()
    if (proxyServer) proxyServer.close()
  })

  it('decodes a gzip response body', async () => {
    await startProxy((b) => zlib.gzipSync(b), 'gzip')
    // Point the app proxy at our stand-in server.
    networkChangeHandler?.({ proxy: `http://127.0.0.1:${proxyPort}`, browserUseProxy: false })

    const res = await proxyFetch('http://target.example.com/resource')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('decoded-payload')
    // content-encoding is stripped after decode (matches undici behavior).
    expect(res.headers.get('content-encoding')).toBeNull()
  })

  it('decodes a deflate response body', async () => {
    await startProxy((b) => zlib.deflateSync(b), 'deflate')
    networkChangeHandler?.({ proxy: `http://127.0.0.1:${proxyPort}`, browserUseProxy: false })

    const res = await proxyFetch('http://target.example.com/resource')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('decoded-payload')
    expect(res.headers.get('content-encoding')).toBeNull()
  })
})
