/**
 * Unit tests for the IM link route (apps/runtime/im-channels/link-route).
 *
 * The route follows the app's proxy chain unless the user turned "message
 * channels use proxy" off — never on the channel's own initiative — and a
 * per-connection route can destroy every socket it opened, including one a
 * proxy accepted and never answered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const resolveProxyDialAgent = vi.fn()
const resolveProxyAgent = vi.fn()
const proxyFetch = vi.fn()
vi.mock('../../../../../src/main/services/proxy-fetch', () => ({
  resolveProxyDialAgent: (...args: unknown[]) => resolveProxyDialAgent(...args),
  resolveProxyAgent: (...args: unknown[]) => resolveProxyAgent(...args),
  proxyFetch: (...args: unknown[]) => proxyFetch(...args),
}))

async function load() {
  vi.resetModules()
  const config = await import('../../../../../src/main/foundation/config.service')
  const route = await import('../../../../../src/main/apps/runtime/im-channels/link-route')
  return { config, route }
}

describe('link route', () => {
  beforeEach(() => {
    resolveProxyDialAgent.mockReset()
    resolveProxyAgent.mockReset()
    proxyFetch.mockReset()
  })

  it('follows the app proxy chain by default, on a private agent per connection', async () => {
    const { route } = await load()
    const agent = { destroy: vi.fn() }
    let signal: AbortSignal | undefined
    resolveProxyDialAgent.mockImplementation(async (_url: string, s: AbortSignal) => {
      signal = s
      return agent
    })

    const opened = await route.openLinkRoute('https://openws.work.weixin.qq.com')
    expect(resolveProxyDialAgent).toHaveBeenCalledWith('https://openws.work.weixin.qq.com', expect.any(AbortSignal))
    expect(opened.viaProxy).toBe(true)
    expect(opened.agent).toBe(agent)

    opened.close()
    opened.close()
    expect(signal?.aborted).toBe(true)
    expect(agent.destroy).toHaveBeenCalledTimes(1)
  })

  it('reports a direct route when no proxy applies', async () => {
    const { route } = await load()
    resolveProxyDialAgent.mockResolvedValue(undefined)
    const opened = await route.openLinkRoute('https://open.feishu.cn')
    expect(opened.viaProxy).toBe(false)
    expect(opened.agent).toBeUndefined()
  })

  it('goes direct for every kind of request once the user turns the channels off the proxy', async () => {
    const { config, route } = await load()
    config.saveConfig({ network: { proxy: 'http://127.0.0.1:7890', imUseProxy: false } })

    const opened = await route.openLinkRoute('https://openws.work.weixin.qq.com')
    expect(opened.viaProxy).toBe(false)
    expect(resolveProxyDialAgent).not.toHaveBeenCalled()
    expect(await route.resolveLinkAgent('https://ilinkai.weixin.qq.com')).toBeUndefined()
    expect(resolveProxyAgent).not.toHaveBeenCalled()

    const directFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    try {
      await route.linkFetch('https://example.invalid/media')
      expect(directFetch).toHaveBeenCalledWith('https://example.invalid/media')
      expect(proxyFetch).not.toHaveBeenCalled()
    } finally {
      directFetch.mockRestore()
    }
  })

  it('announces a change only when it moves IM traffic', async () => {
    const { config, route } = await load()
    const changed = vi.fn()
    const stop = route.onLinkRouteChange(changed)

    config.saveConfig({ network: { browserUseProxy: true } })
    expect(changed).not.toHaveBeenCalled()

    config.saveConfig({ network: { proxy: 'http://127.0.0.1:7890' } })
    expect(changed).toHaveBeenCalledTimes(1)
    config.saveConfig({ network: { imUseProxy: false } })
    expect(changed).toHaveBeenCalledTimes(2)
    config.saveConfig({ network: { noProxy: '*.weixin.qq.com' } })
    expect(changed).toHaveBeenCalledTimes(3)

    stop()
    config.saveConfig({ network: { imUseProxy: true } })
    expect(changed).toHaveBeenCalledTimes(3)
  })
})
