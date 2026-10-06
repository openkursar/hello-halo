/**
 * What the WeCom bot provider hands the digital human for an inbound message
 * (apps/runtime/im-channels/wecom-bot.provider).
 *
 * A voice message arrives with the platform's own transcript. The digital human
 * used to see only "(voice message)" and could do nothing but ask for text —
 * on a phone, where speaking is the everyday way to ask.
 *
 * The SDK is mocked (as in wecom-bot-connmode.test.ts); a message is emitted
 * the way the SDK delivers it and the normalized InboundMessage is read back.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('../../../../../src/main/services/proxy-fetch', () => ({
  resolveProxyAgent: async () => undefined,
}))
vi.mock('../../../../../src/main/services/notification.service', () => ({
  notifyAppEvent: vi.fn(),
}))

interface FakeWSClient extends EventEmitter {
  isConnected: boolean
  goAuthenticated(): void
}

vi.mock('@wecom/aibot-node-sdk', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events')
  const registry: FakeWSClient[] = []

  class WSClient extends EE {
    isConnected = false
    sendMessage = vi.fn(async () => undefined)
    replyStreamNonBlocking = vi.fn(async () => 'sent')
    replyStream = vi.fn(async () => undefined)
    reply = vi.fn(async () => undefined)

    constructor(_opts: unknown) {
      super()
      registry.push(this as unknown as FakeWSClient)
    }

    connect(): void {}

    disconnect(): void {
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
import type { InboundMessage } from '../../../../../src/shared/types/inbound-message'

const createdClients = (sdk as unknown as { __registry: FakeWSClient[] }).__registry

/** Start an online instance and collect the messages it hands on. */
async function onlineInstance(): Promise<{ client: FakeWSClient; received: InboundMessage[] }> {
  const instance = new WecomBotProvider().createInstance('inst-1', { botId: 'aib-test', secret: 'shh' })
  const received: InboundMessage[] = []
  instance.onInbound((msg) => { received.push(msg) })
  instance.start()
  await vi.advanceTimersByTimeAsync(0)
  const client = createdClients[createdClients.length - 1]
  client.goAuthenticated()
  return { client, received }
}

/** Emit a message the way the SDK delivers it, and let the handler finish. */
async function deliver(client: FakeWSClient, msgType: string, body: Record<string, unknown>): Promise<void> {
  client.emit(`message.${msgType}`, {
    headers: { req_id: 'req-1' },
    body: { msgid: `m-${Math.random()}`, chattype: 'single', from: { userid: 'u1' }, msgtype: msgType, ...body },
  })
  await vi.advanceTimersByTimeAsync(0)
}

describe('WeCom inbound voice messages', () => {
  beforeEach(() => {
    createdClients.length = 0
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('hands on the platform transcript, marked as one', async () => {
    const { client, received } = await onlineInstance()

    await deliver(client, 'voice', { voice: { content: '帮我查下明天的会议' } })

    expect(received[0].body).toBe('(voice transcript) 帮我查下明天的会议')
  })

  it('keeps the placeholder when the platform sent no transcript', async () => {
    const { client, received } = await onlineInstance()

    await deliver(client, 'voice', { voice: { content: '  ' } })
    await deliver(client, 'voice', {})

    expect(received.map((msg) => msg.body)).toEqual(['(voice message)', '(voice message)'])
  })

  it('reads the transcript of a quoted voice message too', async () => {
    const { client, received } = await onlineInstance()

    await deliver(client, 'text', {
      text: { content: '这个几点开始？' },
      quote: { msgtype: 'voice', voice: { content: '明天上午开周会' } },
    })

    expect(received[0].body).toBe('这个几点开始？\n\n[Quoted message: (voice transcript) 明天上午开周会]')
  })
})
