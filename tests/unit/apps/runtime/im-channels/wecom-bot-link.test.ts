/**
 * Link-supervision tests for the WeCom bot provider
 * (apps/runtime/im-channels/wecom-bot.provider).
 *
 * The regressions these pin down, from a real incident: a proxy that accepted
 * the connection and never answered left four bots "connecting" for an hour,
 * the SDK kept redialling on the proxy it was built with after the user
 * changed it, and nothing redialled on wake. Halo now owns every redial: each
 * attempt is a new SDK client on a freshly resolved route, under a deadline.
 *
 * The SDK is mocked (FakeWSClient records its options and connect/disconnect
 * calls); timers are faked; no network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { powerMonitor } from 'electron'

interface FakeAgent {
  id: number
  destroy: ReturnType<typeof vi.fn>
}

const dialAgents: FakeAgent[] = []
const resolveProxyDialAgent = vi.fn(async () => {
  const agent: FakeAgent = { id: dialAgents.length + 1, destroy: vi.fn() }
  dialAgents.push(agent)
  return agent
})
vi.mock('../../../../../src/main/services/proxy-fetch', () => ({
  resolveProxyAgent: async () => undefined,
  resolveProxyDialAgent: (...args: unknown[]) => resolveProxyDialAgent(...(args as [])),
}))

vi.mock('../../../../../src/main/services/notification.service', () => ({
  notifyAppEvent: vi.fn(),
}))

interface FakeWSClient extends EventEmitter {
  options: { maxReconnectAttempts?: number; wsOptions?: { agent?: unknown } }
  isConnected: boolean
  connectCount: number
  disconnectCount: number
  connect(): void
  disconnect(): void
  goAuthenticated(): void
}

vi.mock('@wecom/aibot-node-sdk', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events')
  const registry: FakeWSClient[] = []

  class WSClient extends EE {
    isConnected = false
    connectCount = 0
    disconnectCount = 0
    sendMessage = vi.fn(async () => undefined)

    constructor(public options: unknown) {
      super()
      registry.push(this as unknown as FakeWSClient)
    }

    connect(): void {
      this.connectCount++
    }

    disconnect(): void {
      this.disconnectCount++
      this.isConnected = false
    }

    goAuthenticated(): void {
      this.isConnected = true
      this.emit('authenticated')
    }
  }

  return { default: { WSClient }, __registry: registry }
})

import { WecomBotProvider } from '../../../../../src/main/apps/runtime/im-channels/wecom-bot.provider'
import * as sdk from '@wecom/aibot-node-sdk'

const clients = (sdk as unknown as { __registry: FakeWSClient[] }).__registry

interface Instance {
  start(): void
  stop(): void
  reconnect(): void
  getConnectionState(): string
  getLinkStatus(): { attempt: number; lastError?: string; viaProxy: boolean; drops: number; nextRetryAt?: number } | undefined
}

function makeInstance(): Instance {
  return new WecomBotProvider().createInstance('inst-link', {
    botId: 'aib-test',
    secret: 'shh',
  }) as unknown as Instance
}

function latest(): FakeWSClient {
  return clients[clients.length - 1]
}

/** Let the asynchronous route lookup of a dial settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('WeCom bot link supervision', () => {
  let inst: Instance

  beforeEach(() => {
    clients.length = 0
    dialAgents.length = 0
    resolveProxyDialAgent.mockClear()
    vi.useFakeTimers()
    inst = makeInstance()
  })

  afterEach(() => {
    inst.stop()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('never lets the SDK redial on its own', async () => {
    inst.start()
    await settle()
    expect(latest().options.maxReconnectAttempts).toBe(0)
  })

  it('replaces a dial that never authenticates after 25 s, on a freshly resolved route', async () => {
    inst.start()
    await settle()
    const first = latest()
    expect(first.connectCount).toBe(1)
    expect(first.options.wsOptions?.agent).toBe(dialAgents[0])
    expect(inst.getConnectionState()).toBe('connecting')

    await vi.advanceTimersByTimeAsync(25_000)
    expect(inst.getLinkStatus()?.lastError).toContain('no connection within 25 s')
    expect(inst.getLinkStatus()?.viaProxy).toBe(true)

    await vi.advanceTimersByTimeAsync(1_500)
    expect(clients).toHaveLength(2)
    expect(resolveProxyDialAgent).toHaveBeenCalledTimes(2)
    // The hung attempt is torn down and every socket of its route destroyed —
    // including one a proxy accepted and never answered.
    expect(first.disconnectCount).toBe(1)
    expect(dialAgents[0].destroy).toHaveBeenCalledTimes(1)
    expect(latest().options.wsOptions?.agent).toBe(dialAgents[1])
  })

  it('redials a dropped link itself and reports reconnecting with the cause', async () => {
    inst.start()
    await settle()
    const first = latest()
    first.goAuthenticated()
    expect(inst.getConnectionState()).toBe('online')

    first.emit('error', new Error('read ECONNRESET'))
    first.emit('disconnected', 'code: 1006')
    // Torn down inside the SDK's own close handling, so it cannot redial.
    expect(first.disconnectCount).toBe(1)
    expect(inst.getConnectionState()).toBe('reconnecting')
    expect(inst.getLinkStatus()).toMatchObject({ attempt: 1, lastError: 'read ECONNRESET', drops: 1 })

    await vi.advanceTimersByTimeAsync(1_500)
    expect(clients).toHaveLength(2)
    latest().goAuthenticated()
    expect(inst.getConnectionState()).toBe('online')
    expect(inst.getLinkStatus()?.attempt).toBe(0)
  })

  it('stops after five rejected authentications and resumes on a manual reconnect', async () => {
    inst.start()
    await settle()
    for (let i = 0; i < 5; i++) {
      const client = latest()
      client.emit('error', new Error('Authentication failed: invalid secret (code: 40058)'))
      client.emit('disconnected', 'code: 1006')
      await vi.advanceTimersByTimeAsync(30_000)
    }
    const afterHalt = clients.length
    expect(inst.getConnectionState()).toBe('offline')
    expect(inst.getLinkStatus()?.lastError).toContain('rejected the bot credentials')

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(clients).toHaveLength(afterHalt)

    inst.reconnect()
    await settle()
    expect(clients).toHaveLength(afterHalt + 1)
    expect(inst.getConnectionState()).toBe('connecting')
  })

  it('does not stop on five rejections within the first minute, only on one a minute after the first', async () => {
    // A bot created moments ago may be refused for a while before the platform knows it.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const bot = makeInstance()
    try {
      bot.start()
      await settle()
      const reject = (): void => {
        const client = latest()
        client.emit('error', new Error('Authentication failed: invalid secret (code: 40058)'))
        client.emit('disconnected', 'code: 1006')
      }
      for (let i = 0; i < 5; i++) {
        reject() // at 0, 10, 20, 30, 40 s
        await vi.advanceTimersByTimeAsync(10_000)
      }
      expect(bot.getConnectionState()).toBe('connecting')

      await vi.advanceTimersByTimeAsync(10_000) // the next dial is up by 60 s
      reject() // 60 s after the first
      expect(bot.getConnectionState()).toBe('offline')
      expect(bot.getLinkStatus()?.lastError).toContain('rejected the bot credentials')
    } finally {
      bot.stop()
      vi.restoreAllMocks()
    }
  })

  it('redials within seconds of waking from sleep', async () => {
    inst.start()
    await settle()
    latest().goAuthenticated()

    // powerMonitor.on is overloaded per event; the mock's calls are read untyped.
    const calls = vi.mocked(powerMonitor.on).mock.calls as unknown as [string, () => void][]
    const onResume = calls.find(([event]) => event === 'resume')?.[1]
    expect(onResume).toBeDefined()
    onResume!()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(clients).toHaveLength(2)
  })
})
