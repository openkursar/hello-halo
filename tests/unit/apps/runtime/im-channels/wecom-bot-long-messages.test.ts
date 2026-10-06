/**
 * The WeCom bot provider delivering text longer than one WeCom message
 * (apps/runtime/im-channels/wecom-bot.provider).
 *
 * WeCom caps one markdown reply or push at 20480 bytes and rejects anything
 * larger, so a long answer — a reply with streaming off, a push from the
 * notify tool, a digital human's own follow-up — must arrive as ordered
 * `(i/n)` parts, each sent once the previous one is acked. A short answer goes
 * out exactly as before: one quoted reply.
 *
 * The SDK is mocked (as in wecom-bot-connmode.test.ts); the instance is driven
 * through its public push and the reply handle it builds for an inbound message.
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
  sendMessage: ReturnType<typeof vi.fn>
  reply: ReturnType<typeof vi.fn>
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
import type { ReplyHandle } from '../../../../../src/shared/types/inbound-message'

const createdClients = (sdk as unknown as { __registry: FakeWSClient[] }).__registry

/** What the tests reach into: the reply handle an inbound message gets, and its reply window. */
interface InstanceInternals {
  start(): void
  stop(): void
  pushToChat(chatId: string, text: string, chatType: 'direct' | 'group'): boolean
  buildReplyHandle(chatId: string, chatType: 'direct' | 'group', trace: string, headers: unknown): ReplyHandle
  frameCache: Map<string, { frame: unknown; ts: number }>
}

const MESSAGE_BYTES = 20000
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')
/** About 50 KB of Chinese markdown: three WeCom messages. */
const LONG_ANSWER = Array.from({ length: 70 }, (_, i) => `## 第${i + 1}节\n\n${'这一节写得很详细。'.repeat(25)}`).join('\n\n')

/** The markdown content each recorded SDK call carried. */
function contents(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((call) => {
    const body = call[1] as { markdown: { content: string } }
    return body.markdown.content
  })
}

/** Bodies of `(i/n)` parts, in order, each checked against the limit. */
function partBodies(messages: string[]): string[] {
  return messages.map((message, i) => {
    const label = `(${i + 1}/${messages.length})\n\n`
    expect(message.startsWith(label)).toBe(true)
    expect(bytes(message)).toBeLessThanOrEqual(MESSAGE_BYTES)
    return message.slice(label.length)
  })
}

async function onlineInstance(config: Record<string, unknown> = {}): Promise<{ instance: InstanceInternals; client: FakeWSClient }> {
  const instance = new WecomBotProvider().createInstance('inst-1', { botId: 'aib-test', secret: 'shh', ...config }) as unknown as InstanceInternals
  instance.start()
  await vi.advanceTimersByTimeAsync(0)
  const client = createdClients[createdClients.length - 1]
  client.goAuthenticated()
  return { instance, client }
}

/** A reply handle for a message that just arrived (its reply window is open). */
function replyHandle(instance: InstanceInternals, chatType: 'direct' | 'group' = 'direct'): ReplyHandle {
  const headers = { req_id: 'req-1' }
  instance.frameCache.set('chat-1', { frame: { headers }, ts: Date.now() })
  return instance.buildReplyHandle('chat-1', chatType, 'trace-1', headers)
}

describe('WeCom: text longer than one message', () => {
  beforeEach(() => {
    createdClients.length = 0
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('pushes a long message as ordered parts, each once the previous one is acked', async () => {
    const { instance, client } = await onlineInstance()
    const acks: Array<() => void> = []
    client.sendMessage.mockImplementation(() => new Promise<void>((resolve) => acks.push(resolve)))

    expect(instance.pushToChat('chat-1', LONG_ANSWER, 'direct')).toBe(true)

    for (let sent = 1; sent <= 3; sent++) {
      await vi.advanceTimersByTimeAsync(0)
      expect(client.sendMessage).toHaveBeenCalledTimes(sent)
      acks[sent - 1]()
    }
    await vi.advanceTimersByTimeAsync(0)

    expect(partBodies(contents(client.sendMessage)).join('')).toBe(LONG_ANSWER)
  })

  it('replies with the first part, quoted, and sends the rest after it in order', async () => {
    const { instance, client } = await onlineInstance()

    await replyHandle(instance).send(LONG_ANSWER)

    expect(client.reply).toHaveBeenCalledTimes(1)
    expect(client.sendMessage).toHaveBeenCalledTimes(2)
    const messages = [...contents(client.reply), ...contents(client.sendMessage)]
    expect(partBodies(messages).join('')).toBe(LONG_ANSWER)
  })

  it('sends every part as a plain message in a group that turned the quote off', async () => {
    const { instance, client } = await onlineInstance({ quoteReply: false })

    await replyHandle(instance, 'group').send(LONG_ANSWER)

    expect(client.reply).not.toHaveBeenCalled()
    expect(partBodies(contents(client.sendMessage)).join('')).toBe(LONG_ANSWER)
  })

  it('answers a short message exactly as before: one quoted reply, unlabeled', async () => {
    const { instance, client } = await onlineInstance()

    await replyHandle(instance).send('短回答')

    expect(contents(client.reply)).toEqual(['短回答'])
    expect(client.sendMessage).not.toHaveBeenCalled()
  })
})
