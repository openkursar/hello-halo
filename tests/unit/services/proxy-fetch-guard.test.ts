/**
 * Requests of an account the user asked to keep off direct routes: with the
 * Settings switch on they are refused wherever the ordinary route would have
 * been direct, and never silently fall back to it. Everything else is left as
 * it was.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ resolveProxy: vi.fn(async (_url: string) => 'DIRECT') }))
vi.mock('electron', () => ({
  session: {
    defaultSession: { resolveProxy: electron.resolveProxy },
    fromPartition: () => ({ setProxy: vi.fn(async () => {}) }),
  },
}))

const config = vi.hoisted(() => ({
  network: {} as Record<string, unknown>,
  listeners: [] as Array<(payload: Record<string, unknown>) => void>,
}))
vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({ network: config.network }),
  onNetworkConfigChange: (listener: (payload: Record<string, unknown>) => void) => {
    config.listeners.push(listener)
    return () => {}
  },
}))
vi.mock('../../../src/main/foundation/logging', () => ({
  isHttpLoggingEnabled: () => false,
  logHttpRequest: vi.fn(),
  logHttpResponse: vi.fn(),
  logHttpResponseBody: vi.fn(),
}))

const directFetch = vi.fn(async () => new Response('direct'))

async function load(network: Record<string, unknown>) {
  config.network = network
  config.listeners = []
  vi.resetModules()
  vi.stubGlobal('fetch', directFetch)
  return import('../../../src/main/services/proxy-fetch')
}

beforeEach(() => {
  directFetch.mockClear()
  electron.resolveProxy.mockReset()
  electron.resolveProxy.mockResolvedValue('DIRECT')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const URL_ = 'https://api.anthropic.com/v1/messages'

describe('a guarded request', () => {
  it('goes direct as any request does while Settings does not require a proxy', async () => {
    const { proxyFetch } = await load({})
    const response = await proxyFetch(URL_, {}, { guarded: true })
    expect(await response.text()).toBe('direct')
    expect(directFetch).toHaveBeenCalledOnce()
  })

  it.each([
    ['the system answers with a direct connection', async () => 'DIRECT'],
    ['the system lookup fails', async () => { throw new Error('PAC unavailable') }],
  ])('is refused, never sent, when %s', async (_label, answer) => {
    const { proxyFetch, ProxyRequiredError } = await load({ requireProxyForOAuth: true })
    electron.resolveProxy.mockImplementation(answer)
    await expect(proxyFetch(URL_, {}, { guarded: true })).rejects.toMatchObject({ name: 'ProxyRequiredError', reason: 'none' })
    await expect(proxyFetch(URL_, {}, { guarded: true })).rejects.toBeInstanceOf(ProxyRequiredError)
    expect(directFetch).not.toHaveBeenCalled()
  })

  it('is refused for an address on the list that skips the proxy, even with a proxy set', async () => {
    const { proxyFetch } = await load({ requireProxyForOAuth: true, proxy: 'http://127.0.0.1:9', noProxy: '.anthropic.com' })
    await expect(proxyFetch(URL_, {}, { guarded: true })).rejects.toMatchObject({ reason: 'bypassed' })
    expect(directFetch).not.toHaveBeenCalled()
  })

  it('follows a change of the switch at once', async () => {
    const { proxyFetch } = await load({})
    await proxyFetch(URL_, {}, { guarded: true })
    config.listeners[0]({ proxy: undefined, noProxy: undefined, requireProxyForOAuth: true })
    await expect(proxyFetch(URL_, {}, { guarded: true })).rejects.toMatchObject({ reason: 'none' })
    config.listeners[0]({ proxy: undefined, noProxy: undefined, requireProxyForOAuth: false })
    await proxyFetch(URL_, {}, { guarded: true })
    expect(directFetch).toHaveBeenCalledTimes(2)
  })

  it('reports an unreachable proxy as such instead of falling back to a direct connection', async () => {
    const closed = await new Promise<number>(resolve => {
      const probe = http.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo
        probe.close(() => resolve(port))
      })
    })
    const { proxyFetch } = await load({ requireProxyForOAuth: true, proxy: `http://127.0.0.1:${closed}` })
    await expect(proxyFetch('http://upstream.invalid/x', {}, { guarded: true })).rejects.toMatchObject({
      reason: 'unreachable',
      message: expect.stringContaining(`127.0.0.1:${closed}`),
    })
    expect(directFetch).not.toHaveBeenCalled()
  })

  it('reports an unreachable SOCKS proxy the same way', async () => {
    const closed = await new Promise<number>(resolve => {
      const probe = http.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo
        probe.close(() => resolve(port))
      })
    })
    electron.resolveProxy.mockResolvedValue(`SOCKS5 127.0.0.1:${closed}`)
    const { proxyFetch } = await load({ requireProxyForOAuth: true })
    await expect(proxyFetch('https://api.anthropic.com/x', {}, { guarded: true })).rejects.toMatchObject({
      reason: 'unreachable',
      message: expect.stringContaining(`127.0.0.1:${closed}`),
    })
    expect(directFetch).not.toHaveBeenCalled()
  })

  it('travels through the proxy when there is one', async () => {
    const seen: string[] = []
    const proxy = http.createServer((request, response) => { seen.push(request.url ?? ''); response.end('via proxy') })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    try {
      const { proxyFetch } = await load({ requireProxyForOAuth: true, proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` })
      const response = await proxyFetch('http://upstream.invalid/x', {}, { guarded: true })
      expect(await response.text()).toBe('via proxy')
      expect(seen).toEqual(['http://upstream.invalid/x'])
      expect(directFetch).not.toHaveBeenCalled()
    } finally {
      proxy.closeAllConnections()
      await new Promise(resolve => proxy.close(resolve))
    }
  })
})

describe('an ordinary request', () => {
  it('is untouched by the switch', async () => {
    const { proxyFetch } = await load({ requireProxyForOAuth: true })
    await proxyFetch(URL_)
    await proxyFetch(URL_, {}, { guarded: false })
    expect(directFetch).toHaveBeenCalledTimes(2)
  })
})

describe('checking before an interactive step', () => {
  it('asks nothing when no proxy is required', async () => {
    const { resolveGuardedProxyUrl } = await load({})
    await expect(resolveGuardedProxyUrl(URL_)).resolves.toBeNull()
    expect(electron.resolveProxy).not.toHaveBeenCalled()
  })

  it('refuses when one is required and none is usable, and names the proxy otherwise', async () => {
    const required = await load({ requireProxyForOAuth: true })
    await expect(required.resolveGuardedProxyUrl(URL_)).rejects.toMatchObject({ reason: 'none' })

    const withProxy = await load({ requireProxyForOAuth: true, proxy: 'http://127.0.0.1:7890' })
    await expect(withProxy.resolveGuardedProxyUrl(URL_)).resolves.toBe('http://127.0.0.1:7890')
  })
})

describe('describing the route', () => {
  it('names the proxy by host and port only, and says where it came from', async () => {
    const settings = await load({ proxy: 'http://user:secret@127.0.0.1:7890' })
    expect(await settings.describeProxyRoute(URL_)).toEqual({ kind: 'proxy', via: 'settings', address: '127.0.0.1:7890' })

    electron.resolveProxy.mockResolvedValue('PROXY 10.0.0.2:8080')
    const system = await load({})
    expect(await system.describeProxyRoute(URL_)).toEqual({ kind: 'proxy', via: 'system', address: '10.0.0.2:8080' })
  })

  it('says when the route is direct, and whether the list asked for it', async () => {
    const none = await load({})
    expect(await none.describeProxyRoute(URL_)).toEqual({ kind: 'direct', listed: false })
    const listed = await load({ proxy: 'http://127.0.0.1:7890', noProxy: '.anthropic.com' })
    expect(await listed.describeProxyRoute(URL_)).toEqual({ kind: 'direct', listed: true })
  })
})
