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
const httpLogging = vi.hoisted(() => ({ enabled: false, responseBody: vi.fn() }))
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
  isHttpLoggingEnabled: () => httpLogging.enabled,
  logHttpRequest: vi.fn(),
  logHttpResponse: vi.fn(),
  logHttpResponseBody: httpLogging.responseBody,
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

describe('proxyFetch — redirects and bounded downloads', () => {
  let server: http.Server

  async function start(handler: http.RequestListener): Promise<void> {
    server = http.createServer(handler)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    networkChangeHandler?.({ proxy: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, noProxy: '' })
  }

  afterEach(() => {
    networkChangeHandler?.({ proxy: '', noProxy: '' })
    server?.closeAllConnections()
    server?.close()
  })

  it.each(['manual', 'error', 'follow'] as const)('respects redirect=%s through the proxy', async redirect => {
    const requests: string[] = []
    await start((req, res) => {
      requests.push(req.url!)
      if (req.url?.endsWith('/start')) res.writeHead(302, { location: '/destination' }).end('redirect body')
      else res.writeHead(200).end('arrived')
    })
    const request = proxyFetch('http://download.example/start', { redirect })
    if (redirect === 'error') {
      await expect(request).rejects.toThrow('Redirect refused')
      expect(requests).toHaveLength(1)
    } else {
      const response = await request
      expect(response.status).toBe(redirect === 'manual' ? 302 : 200)
      expect(await response.text()).toBe(redirect === 'manual' ? 'redirect body' : 'arrived')
      expect(requests).toHaveLength(redirect === 'manual' ? 1 : 2)
      if (redirect === 'manual') expect(response.headers.get('location')).toBe('/destination')
    }
  })

  it('keeps the default redirect-follow behavior', async () => {
    await start((req, res) => req.url?.endsWith('/start')
      ? res.writeHead(307, { location: '/destination' }).end()
      : res.end('arrived'))
    expect(await (await proxyFetch('http://download.example/start')).text()).toBe('arrived')
  })

  it('does not create a decompressor for a HEAD response with encoding metadata', async () => {
    await start((_req, res) => res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': 100 }).end())
    const response = await proxyFetch('http://download.example/metadata', { method: 'HEAD' })
    expect(response.body).toBeNull()
    expect(response.headers.get('content-length')).toBe('100')
  })

  it('stops reading a large proxied download while the caller is idle, and closes on cancel', async () => {
    const totalBytes = 64 * 1024 * 1024
    const chunk = Buffer.alloc(64 * 1024, 1)
    let sentBytes = 0
    let connectionClosed = false
    await start((_req, res) => {
      res.on('close', () => { connectionClosed = true })
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': totalBytes })
      const send = () => {
        while (sentBytes < totalBytes && !res.destroyed) {
          sentBytes += chunk.length
          if (!res.write(chunk)) { res.once('drain', send); return }
        }
        if (sentBytes === totalBytes) res.end()
      }
      send()
    })

    const response = await proxyFetch('http://download.example/large')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(sentBytes).toBeLessThan(totalBytes / 2)
    const reader = response.body!.getReader()
    expect((await reader.read()).value?.byteLength).toBeGreaterThan(0)
    await reader.cancel()
    await vi.waitFor(() => expect(connectionClosed).toBe(true))
  })

  it('cancels the underlying request when a decompressed response is cancelled', async () => {
    let connectionClosed = false
    await start((_req, res) => {
      res.on('close', () => { connectionClosed = true })
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' })
      res.write(zlib.gzipSync('first frame'))
    })
    const response = await proxyFetch('http://download.example/compressed')
    const reader = response.body!.getReader()
    expect((await reader.read()).value?.byteLength).toBeGreaterThan(0)
    await reader.cancel()
    await vi.waitFor(() => expect(connectionClosed).toBe(true))
  })

  it('propagates a failed compressed download to the caller', async () => {
    await start((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' })
      res.flushHeaders()
      res.write(zlib.gzipSync('partial frame'))
      setTimeout(() => res.destroy(), 20)
    })
    const response = await proxyFetch('http://download.example/interrupted')
    await expect(response.text()).rejects.toThrow()
  })

  it.each([false, true])('aborts an in-flight response after headers (compressed=%s)', async compressed => {
    let connectionClosed = false
    await start((_req, res) => {
      res.on('close', () => { connectionClosed = true })
      res.writeHead(200, compressed ? { 'content-encoding': 'gzip' } : {})
      res.flushHeaders()
    })
    const controller = new AbortController()
    const response = await proxyFetch('http://download.example/pending', { signal: controller.signal })
    const read = response.text()
    controller.abort()
    await expect(read).rejects.toThrow()
    await vi.waitFor(() => expect(connectionClosed).toBe(true))
  })
})

describe('proxyFetch — bounded developer HTTP previews', () => {
  beforeEach(() => {
    httpLogging.enabled = true
    httpLogging.responseBody.mockClear()
    networkChangeHandler?.({ proxy: '', noProxy: '' })
    clearProxyCache()
    resolveProxy.mockResolvedValue('DIRECT')
  })

  afterEach(() => { httpLogging.enabled = false })

  it.each([
    { 'content-type': 'application/octet-stream', 'content-length': '274000000' },
    { 'content-type': 'application/json', 'content-length': '274000000' },
    { 'content-type': 'text/event-stream' },
  ] as Record<string, string>[])('does not clone binary, large, or event-stream bodies (%j)', async headers => {
    const response = new Response('body remains available', { headers })
    const clone = vi.spyOn(response, 'clone')
    originalFetchMock.mockResolvedValueOnce(response)
    const received = await proxyFetch('https://preview.example/binary')
    expect(clone).not.toHaveBeenCalled()
    expect(await received.text()).toBe('body remains available')
    expect(httpLogging.responseBody.mock.calls[0][2]).toContain('Body omitted')
  })

  it('captures a finite text body without consuming the caller response', async () => {
    originalFetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }))
    const response = await proxyFetch('https://preview.example/json')
    expect(await response.json()).toEqual({ ok: true })
    await vi.waitFor(() => expect(httpLogging.responseBody).toHaveBeenCalledWith('GET', 'https://preview.example/json', '{"ok":true}'))
  })

  it('bounds a text preview even when the server omits content-length', async () => {
    const payload = 'x'.repeat(256 * 1024)
    originalFetchMock.mockResolvedValueOnce(new Response(payload, { headers: { 'content-type': 'text/plain' } }))
    const response = await proxyFetch('https://preview.example/unknown-length')
    expect((await response.text()).length).toBe(payload.length)
    await vi.waitFor(() => expect(httpLogging.responseBody).toHaveBeenCalled())
    const preview = httpLogging.responseBody.mock.calls[0][2] as string
    expect(preview.length).toBeLessThan(33 * 1024)
    expect(preview).toContain('Preview truncated')
  })

  it('stops waiting for text that never finishes without cancelling the caller', async () => {
    vi.useFakeTimers()
    let sourceCancelled = false
    const stream = new ReadableStream<Uint8Array>({ cancel() { sourceCancelled = true } })
    originalFetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/plain' } }))
    try {
      const response = await proxyFetch('https://preview.example/stalled')
      await vi.advanceTimersByTimeAsync(2100)
      expect(httpLogging.responseBody.mock.calls[0][2]).toContain('Preview stopped')
      expect(sourceCancelled).toBe(false)
      await response.body!.cancel()
      expect(sourceCancelled).toBe(true)
    } finally { vi.useRealTimers() }
  })
})
