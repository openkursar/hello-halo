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

const resolveProxy = vi.fn(async (_url: string) => 'DIRECT')
const setProxy = vi.fn(async () => {})
type NetworkChange = { proxy?: string; browserUseProxy?: boolean; noProxy?: string }
let networkChangeHandler: ((cfg: NetworkChange) => void) | null = null

vi.mock('electron', () => ({
  session: {
    defaultSession: { resolveProxy: (url: string) => resolveProxy(url) },
    fromPartition: () => ({ setProxy }),
  },
}))

vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({ network: {} }),
  onNetworkConfigChange: (h: (cfg: NetworkChange) => void) => {
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
const { proxyFetch, clearProxyCache, resolveProxyAgent } = await import('../../../src/main/services/proxy-fetch')

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

describe('proxyFetch — keep-alive connections through an HTTP proxy', () => {
  // Answers the way Clash/mihomo's HTTP inbound does: a request carrying the
  // full target URL is forwarded (here: echoed), one carrying only a path gets
  // an empty 400 and a closed connection.
  let proxyServer: http.Server
  const received: Array<{ connection: number | undefined; target: string; body: string }> = []

  beforeEach(async () => {
    received.length = 0
    let connectionCount = 0
    const connectionOf = new WeakMap<object, number>()
    proxyServer = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const target = req.url ?? ''
        const body = Buffer.concat(chunks).toString()
        received.push({ connection: connectionOf.get(req.socket), target, body })
        if (!/^https?:\/\//.test(target)) {
          res.writeHead(400, { connection: 'close' }).end()
          return
        }
        res.writeHead(200, { 'content-type': 'text/plain' }).end(body)
      })
    })
    proxyServer.on('connection', (socket) => connectionOf.set(socket, ++connectionCount))
    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve))
    const { port } = proxyServer.address() as AddressInfo
    networkChangeHandler?.({ proxy: `http://127.0.0.1:${port}`, browserUseProxy: false })
  })

  afterEach(() => {
    networkChangeHandler?.({ proxy: '', browserUseProxy: false })
    proxyServer.closeAllConnections()
    proxyServer.close()
  })

  it('sends requests on a reused connection with the full target URL', async () => {
    const chat = 'http://gateway.example.com/v1/chat/completions'
    const models = 'http://gateway.example.com/v1/models'

    for (const body of ['{"turn":1}', '{"turn":2}']) {
      const res = await proxyFetch(chat, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(body)
    }
    const res = await proxyFetch(models)
    expect(res.status).toBe(200)
    await res.text()

    expect(received).toEqual([
      { connection: 1, target: chat, body: '{"turn":1}' },
      { connection: 1, target: chat, body: '{"turn":2}' },
      { connection: 1, target: models, body: '' },
    ])
  })
})

describe('proxyFetch — hosts listed to bypass the proxy', () => {
  // Nothing listens here: a request routed through it would fail.
  const deadProxy = 'http://127.0.0.1:9'

  beforeEach(() => {
    delete process.env.NO_PROXY
    delete process.env.no_proxy
    resolveProxy.mockClear()
    originalFetchMock.mockClear()
    setProxy.mockClear()
    clearProxyCache()
  })
  afterEach(() => {
    networkChangeHandler?.({ proxy: '', browserUseProxy: false, noProxy: '' })
  })

  it('sends a listed host direct while the Settings proxy is on', async () => {
    networkChangeHandler?.({ proxy: deadProxy, browserUseProxy: false, noProxy: '.weixin.qq.com' })

    const res = await proxyFetch('https://qyapi.weixin.qq.com/cgi-bin/gettoken')

    expect(await res.text()).toBe('direct-body')
    expect(originalFetchMock).toHaveBeenCalledTimes(1)
    expect(await resolveProxyAgent('https://qyapi.weixin.qq.com/')).toBeUndefined()
    expect(await resolveProxyAgent('https://api.anthropic.com/')).toBeDefined()
  })

  it('sends a listed host direct without asking the system proxy', async () => {
    networkChangeHandler?.({ proxy: '', browserUseProxy: false, noProxy: 'docs.example.com' })

    await proxyFetch('https://docs.example.com/page')

    expect(resolveProxy).not.toHaveBeenCalled()
    expect(originalFetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives the AI Browser the same list when it follows the Settings proxy', () => {
    networkChangeHandler?.({ proxy: deadProxy, browserUseProxy: true, noProxy: '.weixin.qq.com' })

    expect(setProxy).toHaveBeenLastCalledWith({
      proxyRules: deadProxy,
      proxyBypassRules: 'localhost,127.0.0.1,[::1],.weixin.qq.com',
    })
  })

  it('keeps an inherited IP range for requests and for the AI Browser', async () => {
    process.env.NO_PROXY = '10.0.0.0/8'
    networkChangeHandler?.({ proxy: deadProxy, browserUseProxy: true, noProxy: '' })

    const res = await proxyFetch('http://10.1.2.3:8080/status')

    expect(await res.text()).toBe('direct-body')
    expect(setProxy).toHaveBeenLastCalledWith({
      proxyRules: deadProxy,
      proxyBypassRules: 'localhost,127.0.0.1,[::1],10.0.0.0/8',
    })
  })
})
