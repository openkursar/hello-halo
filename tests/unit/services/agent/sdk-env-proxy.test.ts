/**
 * The engine process gets the proxy policy every route shares: the NO_PROXY the
 * app inherited is kept and joined by the local addresses and the hosts listed
 * in Settings, instead of being replaced by the local addresses alone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))
const network = vi.hoisted(() => ({ value: {} as { proxy?: string; noProxy?: string } }))
vi.mock('../../../../src/main/foundation/config.service', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../src/main/foundation/config.service')>()
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), network: network.value }) }
})

import { buildSdkEnv } from '../../../../src/main/services/agent/sdk-config'

const PROXY_VARS = ['NO_PROXY', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(PROXY_VARS.map(key => [key, process.env[key]]))
  for (const key of PROXY_VARS) delete process.env[key]
})

afterEach(() => {
  for (const key of PROXY_VARS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  network.value = {}
})

const env = () => buildSdkEnv({ anthropicApiKey: 'key', anthropicBaseUrl: 'http://127.0.0.1:3457' })

describe('proxy environment of the engine process', () => {
  it('keeps the inherited NO_PROXY and adds the hosts listed in Settings', () => {
    process.env.NO_PROXY = 'corp.example.com'
    network.value = { proxy: 'http://127.0.0.1:7890', noProxy: '.weixin.qq.com' }

    const built = env()

    expect(built.NO_PROXY).toBe('localhost,127.0.0.1,[::1],corp.example.com,.weixin.qq.com')
    expect(built.no_proxy).toBe(built.NO_PROXY)
    expect(built.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
  })

  it('sends only the local addresses direct when nothing is listed', () => {
    network.value = { proxy: 'http://127.0.0.1:7890' }

    expect(env().NO_PROXY).toBe('localhost,127.0.0.1,[::1]')
  })

  it('leaves a proxy the environment already names in place', () => {
    process.env.HTTPS_PROXY = '10.0.0.1:3128'
    network.value = { proxy: 'http://127.0.0.1:7890' }

    const built = env()

    expect(built.HTTPS_PROXY).toBe('http://10.0.0.1:3128')
    expect(built.HTTP_PROXY).toBe('http://127.0.0.1:7890')
  })
})
