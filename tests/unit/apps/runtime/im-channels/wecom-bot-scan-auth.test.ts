/**
 * WeCom bot QR-code sign-in connects directly, as WeCom's own CLI does, unless
 * the product turns on `networkPolicy.imScanViaProxy` — then it takes the
 * message channels' route as the agent of its raw HTTPS request.
 */

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  policy: undefined as { imScanViaProxy?: boolean } | undefined,
  linkAgent: undefined as unknown,
  requests: [] as Array<Record<string, unknown>>,
}))

vi.mock('https', () => ({
  request: (options: Record<string, unknown>, onResponse: (res: PassThrough & { statusCode?: number }) => void) => {
    state.requests.push(options)
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() })
    queueMicrotask(() => {
      const res = Object.assign(new PassThrough(), { statusCode: 200 })
      onResponse(res)
      res.end(JSON.stringify({ data: { scode: 'code', auth_url: 'https://work.weixin.qq.com/ai/qc/auth?scode=code' } }))
    })
    return req
  },
}))
vi.mock('../../../../../src/main/foundation/product-config', () => ({
  getNetworkPolicy: () => state.policy,
}))
const resolveLinkAgent = vi.fn(async (_url: string) => state.linkAgent)
vi.mock('../../../../../src/main/apps/runtime/im-channels/link-route', () => ({
  resolveLinkAgent: (url: string) => resolveLinkAgent(url),
}))

const { generateScode } = await import('../../../../../src/main/apps/runtime/im-channels/wecom-bot-scan-auth')

beforeEach(() => {
  state.policy = undefined
  state.linkAgent = undefined
  state.requests = []
  resolveLinkAgent.mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('WeCom scan sign-in route', () => {
  it('connects directly by default, without asking for a route', async () => {
    await expect(generateScode()).resolves.toMatchObject({ scode: 'code' })
    expect(resolveLinkAgent).not.toHaveBeenCalled()
    expect(state.requests[0].agent).toBeUndefined()
  })

  it('takes the message channels\' route when the product turns it on', async () => {
    const agent = { name: 'link-agent' }
    state.policy = { imScanViaProxy: true }
    state.linkAgent = agent
    await generateScode()
    expect(resolveLinkAgent).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/work\.weixin\.qq\.com\/ai\/qc\/generate\?/))
    expect(state.requests[0].agent).toBe(agent)
  })

  it('still connects directly when that route is direct', async () => {
    state.policy = { imScanViaProxy: true }
    await generateScode()
    expect(resolveLinkAgent).toHaveBeenCalledOnce()
    expect(state.requests[0].agent).toBeUndefined()
  })
})
