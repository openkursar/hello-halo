/**
 * Link-supervision tests for the WeChat iLink provider
 * (apps/runtime/im-channels/weixin-ilink.provider).
 *
 * The long-poll used to give up for good after 100 failed polls (about 50
 * minutes of outage) and left a poll that never answered to hang. Now a failed
 * poll ends the session and the link supervisor starts a new one, forever,
 * until the session itself expires — which only a new QR login fixes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ImChannelInstance } from '../../../../../src/shared/types/im-channel'

const fetchJson = vi.fn()

vi.mock('../../../../../src/main/apps/runtime/im-channels/ilink-api', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../../../src/main/apps/runtime/im-channels/ilink-api')
  >()
  return { ...actual, fetchJson: (...args: unknown[]) => fetchJson(...args) }
})

vi.mock('../../../../../src/main/services/proxy-fetch', () => ({
  resolveProxyAgent: async () => undefined,
  resolveProxyDialAgent: async () => undefined,
  proxyFetch: vi.fn(),
}))

const { WeixinIlinkBotProvider } = await import(
  '../../../../../src/main/apps/runtime/im-channels/weixin-ilink.provider'
)

function pollCalls(): unknown[][] {
  return fetchJson.mock.calls.filter(([, url]) => String(url).endsWith('/ilink/bot/getupdates'))
}

/** A poll that holds until it is aborted, like a long-poll with nothing to deliver. */
function hold(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
  })
}

describe('WeChat iLink link supervision', () => {
  let instance: ImChannelInstance

  beforeEach(() => {
    fetchJson.mockReset()
    vi.useFakeTimers()
    instance = new WeixinIlinkBotProvider().createInstance('inst-ilink', {
      botToken: 'token-abc',
      accountId: 'bot-1',
    })
  })

  afterEach(() => {
    instance.stop()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('keeps polling through a long outage and comes back when the network does', async () => {
    let reachable = false
    fetchJson.mockImplementation(async (_m: string, _u: string, _h: unknown, _b: unknown, signal?: AbortSignal) => {
      if (!reachable) throw new Error('connect ETIMEDOUT 203.0.113.10:8443')
      return hold(signal)
    })
    instance.start()

    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(pollCalls().length).toBeGreaterThan(200)
    expect(instance.getConnectionState?.()).toBe('connecting')
    expect(instance.getLinkStatus?.()?.lastError).toContain('ETIMEDOUT')

    reachable = true
    fetchJson.mockImplementationOnce(async () => ({ get_updates_buf: 'buf-1', msgs: [] }))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(instance.getConnectionState?.()).toBe('online')
  })

  it('bounds every poll by the server hold plus slack', async () => {
    fetchJson.mockImplementation(async (_m: string, _u: string, _h: unknown, _b: unknown, signal?: AbortSignal) => hold(signal))
    instance.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollCalls()[0][5]).toMatchObject({ deadlineMs: 60_000 })
  })

  it('stops for good when the session expires, and says why', async () => {
    fetchJson.mockResolvedValue({ ret: -14, get_updates_buf: '' })
    instance.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(instance.getConnectionState?.()).toBe('offline')
    expect(instance.getLinkStatus?.()?.lastError).toContain('session expired')

    const calls = pollCalls().length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(pollCalls().length).toBe(calls)
  })
})
