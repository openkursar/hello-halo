/**
 * A server on a split network names the only hosts that take the proxy
 * (`proxyOnly`); every other host goes direct. The desktop ignores the list,
 * an empty list changes nothing, and an account the user keeps off direct
 * routes still takes the proxy for hosts the list leaves out.
 */

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

const product = vi.hoisted(() => ({ networkPolicy: undefined as { proxyOnly?: string[] } | undefined }))
vi.mock('../../../src/main/foundation/product-config', () => ({
  getNetworkPolicy: () => product.networkPolicy,
}))

const PROXY = 'http://127.0.0.1:7890'
const WECOM = 'wss://openws.work.weixin.qq.com'
const MODEL = 'https://llm.corp.example/v1/messages'
const INTRANET = 'http://10.0.0.8:8080/api'
const OAUTH = 'https://api.anthropic.com/v1/messages'

async function load(network: Record<string, unknown>) {
  config.network = network
  config.listeners = []
  vi.resetModules()
  return import('../../../src/main/services/proxy-fetch')
}

async function routes(network: Record<string, unknown>) {
  const { resolveProxyAgent } = await load(network)
  const proxied = async (url: string) => (await resolveProxyAgent(url)) !== undefined
  return { wecom: await proxied(WECOM), model: await proxied(MODEL), intranet: await proxied(INTRANET) }
}

beforeEach(() => {
  for (const key of ['HALO_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) vi.stubEnv(key, '')
  electron.resolveProxy.mockReset()
  electron.resolveProxy.mockResolvedValue('DIRECT')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  product.networkPolicy = undefined
})

describe('proxyOnly on a server', () => {
  beforeEach(() => {
    vi.stubEnv('HALO_SERVER_MODE', '1')
  })

  it('applies deployment proxy credentials without logging their value', async () => {
    vi.stubEnv('HALO_PROXY', 'http://fixture:private-value@proxy.example:3128')
    const route = await load({})
    expect(await route.describeProxyRoute(OAUTH)).toMatchObject({ kind: 'proxy', address: 'proxy.example:3128' })
    for (const listener of config.listeners) listener({ browserUseProxy: true })
    await Promise.resolve()
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('private-value')
  })

  it('proxies only the listed hosts and sends the rest direct', async () => {
    expect(await routes({ proxy: PROXY, proxyOnly: ['*.weixin.qq.com', '10.0.0.0/24'] }))
      .toEqual({ wecom: true, model: false, intranet: true })
  })

  it('falls back to the product default when the config names none', async () => {
    product.networkPolicy = { proxyOnly: ['*.weixin.qq.com'] }
    expect(await routes({ proxy: PROXY })).toEqual({ wecom: true, model: false, intranet: false })
  })

  it('proxies every host when the config clears the list', async () => {
    product.networkPolicy = { proxyOnly: ['*.weixin.qq.com'] }
    expect(await routes({ proxy: PROXY, proxyOnly: [] })).toEqual({ wecom: true, model: true, intranet: true })
  })

  it('still lets the bypass list send a listed host direct', async () => {
    expect(await routes({ proxy: PROXY, proxyOnly: ['*.weixin.qq.com'], noProxy: 'openws.work.weixin.qq.com' }))
      .toEqual({ wecom: false, model: false, intranet: false })
  })

  it('follows a change of the list at once', async () => {
    const { resolveProxyAgent } = await load({ proxy: PROXY })
    expect(await resolveProxyAgent(MODEL)).toBeDefined()
    for (const listener of config.listeners) listener({ proxy: PROXY, proxyOnly: ['*.weixin.qq.com'] })
    expect(await resolveProxyAgent(MODEL)).toBeUndefined()
  })

  it('keeps an account that must not go direct on the proxy, the list notwithstanding', async () => {
    const guarded = await load({ proxy: PROXY, proxyOnly: ['*.weixin.qq.com'], requireProxyForOAuth: true })
    await expect(guarded.resolveGuardedProxyUrl(OAUTH)).resolves.toBe(PROXY)
    expect(await guarded.describeProxyRoute(OAUTH)).toEqual({ kind: 'proxy', via: 'settings', address: '127.0.0.1:7890' })
    // An ordinary request to the same host still follows the list.
    expect(await guarded.resolveProxyAgent(OAUTH)).toBeUndefined()
  })

  it('reports a host the list leaves out as direct by policy', async () => {
    const { describeProxyRoute } = await load({ proxy: PROXY, proxyOnly: ['*.weixin.qq.com'] })
    expect(await describeProxyRoute(OAUTH)).toEqual({ kind: 'direct', listed: true })
  })
})

describe('proxyOnly on the desktop', () => {
  it('is ignored, from the config and the product alike', async () => {
    product.networkPolicy = { proxyOnly: ['*.weixin.qq.com'] }
    expect(await routes({ proxy: PROXY, proxyOnly: ['*.weixin.qq.com'] })).toEqual({ wecom: true, model: true, intranet: true })
  })
})
