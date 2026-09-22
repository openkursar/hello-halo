/**
 * Unit tests for apps/runtime/im-channels/feishu-bot.provider.
 *
 * The provider is the whole contract surface ImChannelManager and
 * dispatch-inbound see, so these pin the behaviours whose failure is invisible
 * from the outside:
 *
 *   1. validateConfig rejects an App ID of the wrong shape. The SDK refuses such
 *      an ID with a log line only, which in the UI looks like a bot that simply
 *      never connects.
 *   2. credentialId answers with the App ID — Feishu delivers each event to ONE
 *      connection, so two instances sharing an app split traffic at random.
 *   3. Inbound translation produces the normalized shape dispatch-inbound reads,
 *      including media staged to disk and inlined for the model.
 *   4. A group chat's display name is resolved once and cached.
 *   5. A failed quote-reply retries as a plain send before surfacing an error —
 *      a recalled parent message must not swallow the answer.
 *   6. start()/stop() never throw, stop() is idempotent, and the connection
 *      state maps onto the shared vocabulary.
 *
 * The Feishu SDK is fully mocked: no network, no credentials.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  ImChannelInstance,
  ImChannelProvider,
} from '../../../../../src/shared/types/im-channel'
import type { InboundMessage, ReplyHandle } from '../../../../../src/shared/types/inbound-message'

const resolveProxyAgentMock = vi.fn(async (): Promise<unknown> => undefined)
vi.mock('../../../../../src/main/services/proxy-fetch', () => ({
  resolveProxyAgent: () => resolveProxyAgentMock(),
}))

const notifyAppEventMock = vi.fn()
vi.mock('../../../../../src/main/services/notification.service', () => ({
  notifyAppEvent: (...args: unknown[]) => notifyAppEventMock(...args),
}))

const staged: { dir: string; filename: string; bytes: number; pruneOlderThanMs?: number }[] = []
vi.mock('../../../../../src/main/apps/runtime/im-channels/media-temp-files', () => ({
  stageMediaFile: async (dir: string, filename: string, data: Buffer, pruneOlderThanMs?: number) => {
    staged.push({ dir, filename, bytes: data.byteLength, pruneOlderThanMs })
    return { localPath: `${dir}/${filename}`, filename }
  },
  pruneMediaTempDir: () => 0,
}))

/** Handles registered by the provider, so a test can emit SDK events. */
interface FakeChannel {
  /** Options the provider passed to createLarkChannel. */
  createOptions: Record<string, unknown> | undefined
  handlers: Record<string, (payload?: unknown) => unknown>
  connectCount: number
  disconnectCount: number
  state: 'idle' | 'connecting' | 'reconnecting' | 'connected' | 'failed'
  sends: { to: string; input: unknown; opts?: { replyTo?: string } }[]
  streams: { to: string; opts?: { replyTo?: string } }[]
  policyUpdates: Record<string, unknown>[]
  chatInfoCalls: string[]
  /** Reject the next N sends that carry replyTo. */
  failQuoted: number
  failAllSends: boolean
  connectRejects: boolean
  on(name: string, handler: (payload?: unknown) => unknown): () => void
  connect(): Promise<void>
  disconnect(): Promise<void>
  getConnectionStatus(): { state: string; reconnectAttempts: number }
  send(to: string, input: unknown, opts?: { replyTo?: string }): Promise<unknown>
  stream(to: string, input: unknown, opts?: { replyTo?: string }): Promise<unknown>
  updatePolicy(partial: Record<string, unknown>): void
  getChatInfo(chatId: string): Promise<{ chatId: string; name?: string; chatType: string }>
  chatInfoName: string | undefined
  downloadResource(fileKey: string, type: string): Promise<Buffer>
  nextResourceBytes: Buffer
  resourceRequests: { messageId: string; fileKey: string; type: string }[]
  resourceError?: { code: number; msg: string }
  contactName?: string
  contactError?: { code: number; msg: string }
  contactCalls: number
  rawClient: {
    contact: {
      v3: {
        user: {
          get: (payload: {
            path: { user_id: string }
            params: { user_id_type: string }
          }) => Promise<{ data?: { user?: { name?: string } } }>
        }
      }
    }
    im: {
      v1: {
        messageResource: {
          get: (payload: {
            path: { message_id: string; file_key: string }
            params: { type: string }
          }) => Promise<{ getReadableStream: () => NodeJS.ReadableStream }>
        }
      }
    }
  }
}

vi.mock('@larksuiteoapi/node-sdk', () => {
  const registry: FakeChannel[] = []
  // Set by a test before the provider builds its next channel, so a connect
  // failure can be staged for a channel object the test does not hold yet.
  const failNextConnect = { value: false }

  function createLarkChannel(opts?: Record<string, unknown>): FakeChannel {
    const channel: FakeChannel = {
      createOptions: opts,
      handlers: {},
      connectCount: 0,
      disconnectCount: 0,
      state: 'idle',
      sends: [],
      streams: [],
      policyUpdates: [],
      chatInfoCalls: [],
      failQuoted: 0,
      failAllSends: false,
      connectRejects: failNextConnect.value,
      on(name, handler) {
        channel.handlers[name] = handler
        return () => { delete channel.handlers[name] }
      },
      async connect() {
        channel.connectCount++
        if (channel.connectRejects) {
          channel.state = 'failed'
          throw new Error('invalid app secret')
        }
        channel.state = 'connected'
      },
      async disconnect() {
        channel.disconnectCount++
        channel.state = 'idle'
      },
      getConnectionStatus() {
        return { state: channel.state, reconnectAttempts: 0 }
      },
      async send(to, input, opts) {
        if (channel.failAllSends) throw new Error('send refused')
        if (opts?.replyTo && channel.failQuoted > 0) {
          channel.failQuoted--
          throw new Error('parent message was recalled')
        }
        channel.sends.push({ to, input, opts })
        return { messageId: 'om_sent' }
      },
      async stream(to, input, opts) {
        channel.streams.push({ to, opts })
        const producer = (input as { markdown: (c: unknown) => Promise<void> }).markdown
        await producer({ setContent: async () => undefined })
        return { messageId: 'om_stream' }
      },
      updatePolicy(partial) {
        channel.policyUpdates.push(partial)
      },
      async getChatInfo(chatId) {
        channel.chatInfoCalls.push(chatId)
        return { chatId, name: channel.chatInfoName, chatType: 'group' }
      },
      chatInfoName: 'Release Room' as string | undefined,
      async downloadResource() {
        return channel.nextResourceBytes
      },
      nextResourceBytes: Buffer.from('binary-bytes'),
      resourceRequests: [],
      resourceError: undefined,
      contactName: undefined,
      contactError: undefined,
      contactCalls: 0,
      rawClient: {
        contact: {
          v3: {
            user: {
              get: async () => {
                channel.contactCalls++
                if (channel.contactError) {
                  // eslint-disable-next-line @typescript-eslint/no-require-imports
                  const { Readable } = require('stream')
                  throw Object.assign(new Error('Request failed with status code 400'), {
                    response: { data: Readable.from([Buffer.from(JSON.stringify(channel.contactError))]) },
                  })
                }
                return { data: { user: { name: channel.contactName } } }
              },
            },
          },
        },
        im: {
          v1: {
            messageResource: {
              get: async (payload: {
                path: { message_id: string; file_key: string }
                params: { type: string }
              }) => {
                channel.resourceRequests.push({
                  messageId: payload.path.message_id,
                  fileKey: payload.path.file_key,
                  type: payload.params.type,
                })
                if (channel.resourceError) {
                  // Downloads stream, so a rejection arrives with its body
                  // unread — the shape the real client produces.
                  // eslint-disable-next-line @typescript-eslint/no-require-imports
                  const { Readable } = require('stream')
                  throw Object.assign(new Error('Request failed with status code 400'), {
                    response: { data: Readable.from([Buffer.from(JSON.stringify(channel.resourceError))]) },
                  })
                }
                const bytes = channel.nextResourceBytes
                return {
                  getReadableStream: () => {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { Readable } = require('stream')
                    return Readable.from([bytes])
                  },
                }
              },
            },
          },
        },
      },
    }
    registry.push(channel)
    return channel
  }

  return {
    createLarkChannel,
    defaultHttpInstance: { defaults: {} as Record<string, unknown> },
    Domain: { Feishu: 0, Lark: 1 },
    LoggerLevel: { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 },
    __channels: registry,
    __failNextConnect: failNextConnect,
  }
})

const sdk = await import('@larksuiteoapi/node-sdk')
const { FeishuBotProvider } = await import(
  '../../../../../src/main/apps/runtime/im-channels/feishu-bot.provider'
)

const VALID_APP_ID = 'cli_a1b2c3d4e5f60718'

function registry(): FakeChannel[] {
  return (sdk as unknown as { __channels: FakeChannel[] }).__channels
}

function failNextConnect(value: boolean): void {
  ;(sdk as unknown as { __failNextConnect: { value: boolean } }).__failNextConnect.value = value
}

function latestChannel(): FakeChannel {
  const list = registry()
  return list[list.length - 1]
}

interface Started {
  provider: ImChannelProvider
  instance: ImChannelInstance
  channel: FakeChannel
  inbound: { msg: InboundMessage; reply: ReplyHandle }[]
}

async function startInstance(config: Record<string, unknown> = {}): Promise<Started> {
  const provider = new FeishuBotProvider()
  const instance = provider.createInstance('inst-1', {
    appId: VALID_APP_ID,
    appSecret: 'secret',
    domain: 'feishu',
    requireMention: true,
    quoteReply: true,
    ...config,
  })
  const inbound: { msg: InboundMessage; reply: ReplyHandle }[] = []
  instance.onInbound((msg, reply) => { inbound.push({ msg, reply }) })
  instance.start()
  // openChannel() awaits the proxy lookup before constructing the channel.
  await flushMicrotasks()
  return { provider, instance, channel: latestChannel(), inbound }
}

/** Let the provider's async channel open settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: 'om_1',
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderId: 'ou_sender',
    senderName: 'Dong',
    content: 'hello there',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1_700_000_000_000,
    ...overrides,
  }
}

async function emitMessage(started: Started, msg: Record<string, unknown>): Promise<void> {
  await started.channel.handlers.message?.(msg)
}

beforeEach(() => {
  registry().length = 0
  staged.length = 0
  notifyAppEventMock.mockClear()
  failNextConnect(false)
})

describe('FeishuBotProvider — contract', () => {
  const provider = new FeishuBotProvider()

  it('declares itself as the feishu-bot plugin', () => {
    expect(provider.type).toBe('feishu-bot')
    expect(provider.direction).toBe('bidirectional')
    expect(provider.defaultConfig).toMatchObject({ domain: 'feishu', requireMention: true })
  })

  it('rejects an App ID of the wrong shape', () => {
    expect(provider.validateConfig({ appId: '', appSecret: 's' })).toMatch(/App ID is required/)
    expect(provider.validateConfig({ appId: 'not-an-app-id', appSecret: 's' })).toMatch(/cli_/)
    expect(provider.validateConfig({ appId: VALID_APP_ID })).toMatch(/App Secret/)
    expect(provider.validateConfig({ appId: VALID_APP_ID, appSecret: 's', domain: 'slack' }))
      .toMatch(/feishu.*lark/)
    expect(provider.validateConfig({ appId: VALID_APP_ID, appSecret: 's' })).toBeNull()
  })

  it('identifies the credential by App ID so one app cannot back two digital humans', () => {
    expect(provider.credentialId?.({ appId: VALID_APP_ID })).toBe(VALID_APP_ID)
    expect(provider.credentialId?.({ appId: '  ' })).toBeUndefined()
    expect(provider.credentialId?.({})).toBeUndefined()
  })

  it('marks only the preference fields as hot-updatable', () => {
    expect(provider.hotUpdatableConfigKeys).toEqual(['requireMention', 'quoteReply'])
  })
})

describe('FeishuBotProvider — lifecycle', () => {
  it('connects on start and reports connection state', async () => {
    const started = await startInstance()
    expect(started.channel.connectCount).toBe(1)
    expect(started.instance.isConnected()).toBe(true)
    expect(started.instance.getConnectionState?.()).toBe('online')
  })

  it('does not open a connection without credentials', async () => {
    const provider = new FeishuBotProvider()
    const instance = provider.createInstance('inst-2', { appId: '', appSecret: '' })
    const before = registry().length
    expect(() => instance.start()).not.toThrow()
    await flushMicrotasks()
    expect(registry().length).toBe(before)
    expect(instance.isConnected()).toBe(false)
  })

  it('maps SDK states onto the shared vocabulary', async () => {
    const started = await startInstance()
    started.channel.state = 'reconnecting'
    expect(started.instance.getConnectionState?.()).toBe('connecting')
    started.channel.state = 'failed'
    expect(started.instance.getConnectionState?.()).toBe('offline')
    started.instance.stop()
    expect(started.instance.getConnectionState?.()).toBe('offline')
  })

  it('notifies the user once when the connection cannot be established', async () => {
    failNextConnect(true)
    const provider = new FeishuBotProvider()
    const instance = provider.createInstance('inst-3', {
      appId: VALID_APP_ID,
      appSecret: 'wrong',
    })
    instance.start()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(notifyAppEventMock).toHaveBeenCalledTimes(1)
    expect(instance.getConnectionState?.()).toBe('offline')
    instance.stop()
    failNextConnect(false)
  })

  it('rebuilds the channel after a failed first connect (the SDK has no loop yet)', async () => {
    vi.useFakeTimers()
    try {
      failNextConnect(true)
      const provider = new FeishuBotProvider()
      const instance = provider.createInstance('inst-retry', {
        appId: VALID_APP_ID,
        appSecret: 'secret',
      })
      instance.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(registry()).toHaveLength(1)

      // The retry must build a NEW channel object, because a channel whose
      // connect() failed before the handshake owns no reconnect loop.
      failNextConnect(false)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(registry().length).toBeGreaterThan(1)
      expect(latestChannel().connectCount).toBe(1)
      expect(instance.isConnected()).toBe(true)

      instance.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rebuilds the channel when the SDK reports a terminal link failure', async () => {
    vi.useFakeTimers()
    try {
      const started = await startInstance()
      const before = registry().length
      started.channel.state = 'failed'
      started.channel.handlers.error?.({ code: 'not_connected', message: 'gave up' })

      await vi.advanceTimersByTimeAsync(15_000)
      expect(registry().length).toBe(before + 1)

      started.instance.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops retrying once the instance is stopped', async () => {
    vi.useFakeTimers()
    try {
      failNextConnect(true)
      const provider = new FeishuBotProvider()
      const instance = provider.createInstance('inst-retry-stop', {
        appId: VALID_APP_ID,
        appSecret: 'secret',
      })
      instance.start()
      await vi.advanceTimersByTimeAsync(0)
      const afterStart = registry().length

      instance.stop()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(registry().length).toBe(afterStart)
    } finally {
      failNextConnect(false)
      vi.useRealTimers()
    }
  })

  it('stop() is idempotent and disconnects once', async () => {
    const started = await startInstance()
    started.instance.stop()
    started.instance.stop()
    expect(started.channel.disconnectCount).toBe(1)
  })

  it('applies a requireMention change to the live policy gate', async () => {
    const started = await startInstance()
    started.instance.updateConfig?.({
      appId: VALID_APP_ID,
      appSecret: 'secret',
      requireMention: false,
      quoteReply: true,
    })
    expect(started.channel.policyUpdates).toEqual([{ requireMention: false }])
  })
})

describe('FeishuBotProvider — HTTP transport', () => {
  interface AxiosLikeInstance {
    defaults: { httpsAgent?: unknown; httpAgent?: unknown; proxy?: unknown }
    request(config: Record<string, unknown>): Promise<unknown>
  }

  function transportOf(channel: FakeChannel): AxiosLikeInstance {
    return channel.createOptions?.httpInstance as AxiosLikeInstance
  }

  it('hands the SDK a private transport instead of mutating its module singleton', async () => {
    // A class instance, not a plain object: axios deep-clones plain objects
    // when building instance defaults but keeps class instances (like real
    // proxy agents) by reference.
    const fakeAgent = new (class FakeAgent {})()
    resolveProxyAgentMock.mockResolvedValueOnce(fakeAgent)
    const started = await startInstance()

    const transport = transportOf(started.channel)
    expect(transport).toBeDefined()
    expect(transport.defaults.httpsAgent).toBe(fakeAgent)
    expect(transport.defaults.httpAgent).toBe(fakeAgent)
    expect(transport.defaults.proxy).toBe(false)

    // The module-level defaultHttpInstance must stay pristine: mutating it
    // leaks one instance's proxy route into every other Feishu/Lark instance.
    const singleton = (sdk as unknown as { defaultHttpInstance: { defaults: Record<string, unknown> } })
      .defaultHttpInstance
    expect(singleton.defaults).toEqual({})
  })

  it('still provides a direct-connection transport when no proxy is configured', async () => {
    const started = await startInstance()
    const transport = transportOf(started.channel)
    expect(transport).toBeDefined()
    expect(transport.defaults.httpsAgent).toBeUndefined()
    expect(transport.defaults.proxy).toBe(false)
  })

  it('gives each instance its own transport', async () => {
    const first = await startInstance()
    const provider = new FeishuBotProvider()
    const instance = provider.createInstance('inst-b', {
      appId: 'cli_ffffffffffffffff',
      appSecret: 'secret',
    })
    instance.start()
    await flushMicrotasks()

    expect(transportOf(latestChannel())).not.toBe(transportOf(first.channel))
    instance.stop()
  })

  it('honors the SDK response contract: unwrap the body, {data, headers} on $return_headers', async () => {
    // The SDK's own call sites read the unwrapped body (e.g. resp.access_token,
    // WSClient's pullConnectConfig destructuring), so the private transport
    // must replicate the singleton's response interceptor exactly.
    const started = await startInstance()
    const transport = transportOf(started.channel)
    const adapter = async (config: Record<string, unknown>) => ({
      data: { code: 0, access_token: 'tok' },
      status: 200,
      statusText: 'OK',
      headers: { 'x-request-id': 'req-1' },
      config,
    })

    const plain = await transport.request({ url: 'https://example.invalid', adapter })
    expect(plain).toEqual({ code: 0, access_token: 'tok' })

    const withHeaders = await transport.request({
      url: 'https://example.invalid',
      adapter,
      $return_headers: true,
    }) as { data: unknown; headers: Record<string, string> }
    expect(withHeaders.data).toEqual({ code: 0, access_token: 'tok' })
    expect(withHeaders.headers).toMatchObject({ 'x-request-id': 'req-1' })
  })
})

describe('FeishuBotProvider — inbound translation', () => {
  it('normalizes a direct message and labels it with the person, not an id', async () => {
    const started = await startInstance()
    started.channel.chatInfoName = 'Dong Wang'
    await emitMessage(started, message())

    expect(started.inbound).toHaveLength(1)
    expect(started.inbound[0].msg).toMatchObject({
      body: 'hello there',
      from: 'ou_sender',
      fromName: 'Dong',
      channel: 'feishu-bot',
      chatType: 'direct',
      chatId: 'oc_chat',
      messageId: 'om_1',
      // Without this the conversation list shows a raw chat id, which tells
      // the user nothing about who they are talking to.
      chatName: 'Dong Wang',
    })
    expect(started.channel.chatInfoCalls).toEqual(['oc_chat'])
  })

  it('labels a nameless direct chat with the person on the other side', async () => {
    // Feishu names groups but never one-to-one chats, so without this the
    // conversation list shows an opaque chat id.
    const started = await startInstance()
    started.channel.chatInfoName = undefined
    started.channel.contactName = 'Dong Wang'
    await emitMessage(started, message())

    expect(started.inbound[0].msg.chatName).toBe('Dong Wang')
  })

  it('stops asking for names once the tenant refuses the contacts permission', async () => {
    const started = await startInstance()
    started.channel.chatInfoName = undefined
    started.channel.contactError = {
      code: 99991672,
      msg: 'Access denied. One of the following scopes is required: [contact:contact.base:readonly]',
    }
    await emitMessage(started, message({ messageId: 'om_a', chatId: 'oc_a' }))
    await emitMessage(started, message({ messageId: 'om_b', chatId: 'oc_b' }))

    // One refusal is enough: retrying cannot start working until the app is
    // re-published, and every attempt costs the turn a round trip.
    expect(started.channel.contactCalls).toBe(1)
  })

  it('falls back to the sender when neither the chat nor contacts yield a name', async () => {
    const started = await startInstance()
    started.channel.chatInfoName = undefined
    started.channel.contactName = undefined
    await emitMessage(started, message())
    expect(started.inbound[0].msg.chatName).toBe('Dong')
  })

  it('resolves a group chat name once and caches it', async () => {
    const started = await startInstance()
    await emitMessage(started, message({ chatType: 'group', messageId: 'om_a' }))
    await emitMessage(started, message({ chatType: 'group', messageId: 'om_b' }))

    expect(started.inbound[0].msg.chatType).toBe('group')
    expect(started.inbound[0].msg.chatName).toBe('Release Room')
    expect(started.channel.chatInfoCalls).toEqual(['oc_chat'])
  })

  it('publishes learned names so a conversation stops showing a raw id', async () => {
    // A conversation's label is fixed at first registration, so a name learned
    // later only reaches the screen through the directory this exposes.
    const started = await startInstance()
    started.channel.chatInfoName = 'Dong Wang'
    await emitMessage(started, message())

    const directory = await started.instance.identityCapability!.fetchIdentityDirectory()
    expect(directory.get('oc_chat')).toBe('Dong Wang')
  })

  it('publishes nothing for a chat whose name is unknown', async () => {
    const started = await startInstance()
    started.channel.chatInfoName = undefined
    await emitMessage(started, message())

    const directory = await started.instance.identityCapability!.fetchIdentityDirectory()
    expect(directory.size).toBe(0)
  })

  it('drops a message with no chat or sender', async () => {
    const started = await startInstance()
    await emitMessage(started, message({ chatId: '', senderId: '' }))
    expect(started.inbound).toHaveLength(0)
  })

  it('stages an inbound image to disk and inlines it for the model', async () => {
    const started = await startInstance()
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('rest-of-the-png'),
    ])
    started.channel.nextResourceBytes = png
    await emitMessage(started, message({
      rawContentType: 'image',
      resources: [{ type: 'image', fileKey: 'img_key_1', fileName: 'diagram.png' }],
    }))

    const msg = started.inbound[0].msg
    expect(staged).toHaveLength(1)
    // Staging must also prune expired temp files, so cleanup does not depend
    // on an app restart.
    expect(staged[0].pruneOlderThanMs).toBe(24 * 60 * 60 * 1000)
    expect(msg.attachments?.[0]).toMatchObject({ type: 'image', filename: 'diagram.png' })
    expect(msg.images?.[0]).toMatchObject({
      type: 'image',
      mediaType: 'image/png',
      name: 'diagram.png',
    })
    expect(msg.images?.[0].data).toBe(png.toString('base64'))
    // Addressed by the message that carried it — fetching by key alone is the
    // API for re-reading the app's own uploads and is refused for this one.
    expect(started.channel.resourceRequests).toEqual([
      { messageId: 'om_1', fileKey: 'img_key_1', type: 'image' },
    ])
  })

  it('trusts the bytes over a misleading filename', async () => {
    const started = await startInstance()
    // Feishu often omits the name, and this provider then invents one ending in
    // .jpg — a PNG labelled image/jpeg makes the model reject the message.
    started.channel.nextResourceBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('rest-of-the-png'),
    ])
    await emitMessage(started, message({
      rawContentType: 'image',
      resources: [{ type: 'image', fileKey: 'img_key_2' }],
    }))

    expect(started.inbound[0].msg.images?.[0].mediaType).toBe('image/png')
  })

  it('keeps an unrecognizable image as an attachment instead of mislabelling it', async () => {
    const started = await startInstance()
    started.channel.nextResourceBytes = Buffer.from('not-an-image-at-all')
    await emitMessage(started, message({
      rawContentType: 'image',
      resources: [{ type: 'image', fileKey: 'img_key_3', fileName: 'mystery.bin' }],
    }))

    const msg = started.inbound[0].msg
    expect(msg.attachments?.[0]).toMatchObject({ type: 'image', filename: 'mystery.bin' })
    expect(msg.images).toBeUndefined()
  })

  it('tells the model an attachment was refused instead of letting it invent a reason', async () => {
    // The permission failure users actually hit. Silently dropping it makes the
    // model answer "I can't see the image", which reads as a fault in the model
    // rather than a permission the user can grant in one click.
    const started = await startInstance()
    started.channel.resourceError = {
      code: 99991672,
      msg: 'Access denied. One of the following scopes is required: [im:message:readonly]',
    }
    await emitMessage(started, message({
      rawContentType: 'image',
      resources: [{ type: 'image', fileKey: 'img_key_9', fileName: 'shot.png' }],
    }))

    const msg = started.inbound[0].msg
    expect(msg.attachments).toBeUndefined()
    expect(msg.images).toBeUndefined()
    expect(msg.body).toMatch(/could not be downloaded/i)
    expect(msg.body).toMatch(/lacks permission to read files/i)
  })

  it('carries a non-image resource as an attachment only', async () => {
    const started = await startInstance()
    started.channel.nextResourceBytes = Buffer.from('%PDF-1.7 ...')
    await emitMessage(started, message({
      rawContentType: 'file',
      resources: [{ type: 'file', fileKey: 'file_key_1', fileName: 'report.pdf' }],
    }))

    const msg = started.inbound[0].msg
    expect(msg.attachments?.[0]).toMatchObject({ type: 'file', filename: 'report.pdf' })
    expect(msg.images).toBeUndefined()
  })
})

describe('FeishuBotProvider — replies', () => {
  it('quotes the triggering message in a group chat', async () => {
    const started = await startInstance()
    await emitMessage(started, message({ chatType: 'group' }))
    await started.inbound[0].reply.send('answer')

    expect(started.channel.sends[0]).toMatchObject({
      to: 'oc_chat',
      input: { markdown: 'answer' },
      opts: { replyTo: 'om_1' },
    })
  })

  it('never quotes in a direct chat', async () => {
    const started = await startInstance()
    await emitMessage(started, message())
    await started.inbound[0].reply.send('answer')
    expect(started.channel.sends[0].opts).toBeUndefined()
  })

  it('honors quoteReply=false for group replies', async () => {
    const started = await startInstance({ quoteReply: false })
    await emitMessage(started, message({ chatType: 'group' }))
    await started.inbound[0].reply.send('answer')
    expect(started.channel.sends[0].opts).toBeUndefined()
  })

  it('retries without the quote when the quoted parent is gone', async () => {
    const started = await startInstance()
    started.channel.failQuoted = 1
    await emitMessage(started, message({ chatType: 'group' }))
    await started.inbound[0].reply.send('answer')

    expect(started.channel.sends).toHaveLength(1)
    expect(started.channel.sends[0].opts).toBeUndefined()
  })

  it('throws when the message cannot be delivered at all', async () => {
    const started = await startInstance()
    started.channel.failAllSends = true
    await emitMessage(started, message())
    await expect(started.inbound[0].reply.send('answer')).rejects.toThrow(/send refused/)
  })

  it('offers streaming, and a finish with no prior progress sends a plain message', async () => {
    const started = await startInstance()
    await emitMessage(started, message())
    const reply = started.inbound[0].reply
    expect(reply.streaming).toBeDefined()

    await reply.streaming!.finish('final answer')
    expect(started.channel.streams).toHaveLength(0)
    expect(started.channel.sends[0]).toMatchObject({ input: { markdown: 'final answer' } })
  })

  it('opens a streaming card once progress arrives', async () => {
    const started = await startInstance()
    await emitMessage(started, message({ chatType: 'group' }))
    const reply = started.inbound[0].reply

    await reply.streaming!.update({ type: 'status', text: 'working' })
    await reply.streaming!.finish('final answer')

    expect(started.channel.streams).toHaveLength(1)
    expect(started.channel.streams[0]).toMatchObject({ to: 'oc_chat', opts: { replyTo: 'om_1' } })
  })

  it('falls back to a plain message when the link drops mid-stream', async () => {
    const started = await startInstance()
    await emitMessage(started, message())
    const reply = started.inbound[0].reply
    await reply.streaming!.update({ type: 'status', text: 'working' })

    // The SDK reports it is reconnecting: an open card can no longer be patched.
    started.channel.handlers.reconnecting?.()
    await reply.streaming!.finish('final answer')

    expect(started.channel.sends.some(s => (s.input as { markdown?: string }).markdown === 'final answer')).toBe(true)
  })
})

describe('FeishuBotProvider — proactive push', () => {
  it('reports false before the channel exists', async () => {
    const provider = new FeishuBotProvider()
    const instance = provider.createInstance('inst-4', { appId: '', appSecret: '' })
    instance.start()
    await flushMicrotasks()
    expect(instance.pushToChat('oc_chat', 'ping', 'direct')).toBe(false)
  })

  it('accepts a push while the long connection is down, because sends are API calls', async () => {
    const started = await startInstance()
    started.channel.state = 'reconnecting'
    expect(started.instance.pushToChat('oc_chat', 'ping', 'direct')).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(started.channel.sends[0]).toMatchObject({ to: 'oc_chat', input: { markdown: 'ping' } })
  })

  it('exposes a stable file-send capability', async () => {
    const started = await startInstance()
    expect(started.instance.fileCapability).toBeDefined()
    // Stability matters: a capability that appears and disappears rebuilds the
    // agent session's tool set and destroys the turn that is starting.
    expect(started.instance.fileCapability).toBe(started.instance.fileCapability)
  })
})
