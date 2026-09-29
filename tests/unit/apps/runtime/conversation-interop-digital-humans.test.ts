/**
 * Cross-conversation collaboration with digital humans, end to end through the
 * `halo-conversations` tools: a space conversation reading, messaging and
 * awaiting a digital human, and two digital humans working with each other.
 *
 * Real: the interop module (tools, resolution, delivery, turn gate, replies,
 * breaker), the space conversation source and the digital-human source. Faked:
 * conversation storage, the engine's send paths and turn-end events, the app
 * manager / session registry, and the digital human's transcript (which the fake
 * chat send appends to the way the real sink does).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'

type Listener = (event: { channel: string; conversationId: string }) => void

interface ChatMessage { id: string; role: string; content: string; timestamp: string; source?: string; metadata?: Record<string, unknown> }
interface Line { id: string; role: string; content: string; timestamp: string; source?: string; thoughts: null }

const h = vi.hoisted(() => {
  const state = {
    config: { agent: {} } as Record<string, any>,
    // space conversations
    chats: new Map<string, { id: string; title: string; updatedAt: string; messages: any[] }>(),
    chatBusy: new Set<string>(),
    // digital humans
    apps: new Map<string, any>(),
    records: [] as any[],
    dhBusy: new Set<string>(),
    dhSessions: new Set<string>(),
    dhTranscripts: new Map<string, any[]>(),
    listeners: new Set<(event: { channel: string; conversationId: string }) => void>(),
    nextId: 0,
  }
  const emit = (channel: string, conversationId: string) => {
    for (const l of [...state.listeners]) l({ channel, conversationId })
  }
  return { state, emit, sendAppChatMessage: vi.fn(), sendChat: vi.fn() }
})

vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => h.state.config }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: (options: { tools: Array<{ name: string }> }) => options,
}))
vi.mock('../../../../src/main/services/agent/events', () => ({
  onAgentEvent: (listener: Listener) => {
    h.state.listeners.add(listener)
    return { dispose: () => h.state.listeners.delete(listener) }
  },
}))
vi.mock('../../../../src/main/services/agent/send-message', () => ({ sendMessage: (...args: unknown[]) => h.sendChat(...args) }))
vi.mock('../../../../src/main/services/conversation-interop/busy', () => ({
  isNativeConversationBusy: (id: string) => h.state.chatBusy.has(id),
  hasLiveNativeSession: () => true,
}))
vi.mock('../../../../src/main/services/conversation.service', () => ({
  listConversations: () => [...h.state.chats.values()].map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length })),
  getConversation: (_space: string, id: string) => h.state.chats.get(id) ?? null,
  addMessage: (_space: string, id: string, message: Record<string, unknown>) => {
    const conv = h.state.chats.get(id)!
    const added = { id: `n-${h.state.nextId++}`, timestamp: 't', ...message }
    conv.messages.push(added)
    return added
  },
  updateMessageById: (_space: string, id: string, messageId: string, patch: Record<string, unknown>) => {
    const conv = h.state.chats.get(id)!
    const index = conv.messages.findIndex((m) => m.id === messageId)
    conv.messages[index] = { ...conv.messages[index], ...patch }
  },
}))

vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({
    getApp: (id: string) => h.state.apps.get(id) ?? null,
    listApps: (filter: { spaceId?: string; type?: string }) =>
      [...h.state.apps.values()].filter((a) => a.spaceId === filter.spaceId && a.spec.type === filter.type),
  }),
}))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => ({
    findSession: (appId: string, channel: string, chatId: string) =>
      h.state.records.find((r) => r.appId === appId && r.channel === channel && r.chatId === chatId),
    getAllSessions: (appId: string) => h.state.records.filter((r) => r.appId === appId),
  }),
}))
vi.mock('../../../../src/main/services/space.service', () => ({ getSpace: () => ({ id: 'space-1', path: '/spaces/space-1' }) }))
vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({
  sendAppChatMessage: (...args: unknown[]) => h.sendAppChatMessage(...args),
  loadChatTranscriptForConversation: (_path: string, _app: string, key: string) => {
    const messages = h.state.dhTranscripts.get(key) ?? []
    return { messages, hasMoreBefore: false, cursor: messages[0]?.id ?? null, total: messages.length }
  },
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-live-turn', () => ({
  isAppChatConversationGenerating: (id: string) => h.state.dhBusy.has(id),
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-sink', () => ({
  hasActiveAppChatRound: () => false,
  peekAppChatSink: () => undefined,
}))
vi.mock('../../../../src/main/services/agent', () => ({
  sendMessage: (...args: unknown[]) => h.sendChat(...args),
  v2Sessions: { has: (id: string) => h.state.dhSessions.has(id) },
  onAgentEvent: (listener: Listener) => {
    h.state.listeners.add(listener)
    return { dispose: () => h.state.listeners.delete(listener) }
  },
}))

type ToolReply = { content: Array<{ text: string }>; isError?: boolean }
type ToolHandle = { name: string; handler: (args: Record<string, unknown>) => Promise<ToolReply> }

let runSenders: typeof import('../../../../src/main/apps/runtime/run-conversation-source')
let interop: {
  server: (scope: { spaceId: string; conversationId: string }, includeSend?: boolean) => { tools: ToolHandle[] }
}

const SPACE = 'space-1'
const NOTES = 'aaaaaaaa-1111-4111-8111-111111111111'
const PLAN = 'bbbbbbbb-2222-4222-8222-222222222222'
const DH_A = 'app-chat:app-a'
const DH_B_LOCAL = 'app-chat:app-b:local:direct:sess-1'
const IM_KEY = 'app-chat:app-a:wecom-bot:direct:stranger'
const T0 = Date.UTC(2026, 0, 1)

const sha8 = (value: string) => createHash('sha1').update(value).digest('hex').slice(0, 8)
const flush = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve() }

function tools(conversationId: string, includeSend = true) {
  const server = interop.server({ spaceId: SPACE, conversationId }, includeSend)
  const byName = (name: string) => server.tools.find((t) => t.name === name)?.handler as ToolHandle['handler']
  return { read: byName('conversation_read'), send: byName('conversation_send'), names: server.tools.map((t) => t.name) }
}

function seedChat(id: string, title: string, messages: Array<Partial<ChatMessage>> = [], updatedAt = new Date(T0).toISOString()) {
  h.state.chats.set(id, {
    id, title, updatedAt,
    messages: messages.map((m, i) => ({ id: `${id}-m${i}`, timestamp: 't', role: 'user', content: '', ...m })),
  })
}

function seedDh(appId: string, name: string, key: string, kind: 'native' | 'local', lines: Array<[string, string]>, lastActiveAt = T0) {
  if (!h.state.apps.has(appId)) h.state.apps.set(appId, { id: appId, spaceId: SPACE, status: 'active', spec: { name, type: 'automation' }, permissions: { granted: ['conversation-collab'], denied: [] } })
  h.state.records.push({
    appId, source: kind, channel: kind, chatId: kind === 'native' ? 'default' : key.split(':').pop(), chatType: 'direct',
    displayName: kind === 'local' ? 'Planning' : '', lastActiveAt, messageCount: lines.length, lastMessage: lines.at(-1)?.[1],
  })
  h.state.dhTranscripts.set(key, lines.map(([role, content], i): Line => ({ id: `${key}#${i}`, role, content, timestamp: `t${i}`, thoughts: null })))
}

/** The digital human's transcript, as its sink would have written it. */
function transcriptOf(key: string): Line[] {
  return h.state.dhTranscripts.get(key) as Line[]
}

/** A turn on `key` ends: the engine reports completion, the conversation is idle again. */
async function endDhTurn(key: string): Promise<void> {
  h.state.dhBusy.delete(key)
  h.emit('agent:complete', key)
  await flush()
}
async function endChatTurn(id: string): Promise<void> {
  h.state.chatBusy.delete(id)
  h.emit('agent:complete', id)
  await flush()
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  const s = h.state
  s.config = { agent: {} }
  s.chats.clear(); s.chatBusy.clear(); s.apps.clear(); s.records = []; s.dhBusy.clear(); s.dhSessions.clear(); s.dhTranscripts.clear(); s.listeners.clear()
  h.sendAppChatMessage.mockReset()
  h.sendChat.mockReset()

  // The fake chat send: persists the turn input like the real one, then the turn runs.
  h.sendChat.mockImplementation(async (params: { conversationId: string; message: string }) => {
    h.state.chats.get(params.conversationId)!.messages.push({ id: `u-${h.state.nextId++}`, role: 'user', content: params.message, timestamp: 't' })
    h.state.chatBusy.add(params.conversationId)
  })
  // The fake digital-human send: the sink records what the caller says to keep (or the text itself), the turn runs.
  h.sendAppChatMessage.mockImplementation(async (request: any) => {
    const transcript = (h.state.dhTranscripts.get(request.conversationId) ?? [])
    transcript.push({
      id: `${request.conversationId}#${transcript.length}`,
      role: request.recorded ? 'system' : 'user',
      content: request.recorded?.content ?? request.message,
      source: request.recorded?.provenance.source,
      metadata: request.recorded?.provenance.metadata,
      timestamp: 't', thoughts: null,
    })
    h.state.dhTranscripts.set(request.conversationId, transcript)
    h.state.dhBusy.add(request.conversationId)
    h.state.dhSessions.add(request.conversationId)
    request.onMessageAccepted?.()
  })

  const lifecycle = await import('../../../../src/main/services/conversation-interop/lifecycle')
  const mcp = await import('../../../../src/main/services/conversation-interop/mcp-server')
  const source = await import('../../../../src/main/services/conversation-interop/source')
  const dh = await import('../../../../src/main/apps/runtime/conversation-source')
  const runs = await import('../../../../src/main/apps/runtime/run-conversation-source')
  source.registerConversationSource(dh.createDigitalHumanConversationSource())
  source.registerConversationSource(runs.createRunConversationSource())
  runSenders = runs
  lifecycle.initConversationInterop()
  interop = { server: mcp.createConversationInteropMcpServer as unknown as typeof interop.server }
  ;(interop as any).dispose = lifecycle.disposeConversationInterop

  seedChat(NOTES, 'Research notes', [{ role: 'user', content: 'collect sources' }, { role: 'assistant', content: 'done' }], new Date(T0 + 1000).toISOString())
  seedChat(PLAN, 'Launch plan', [{ role: 'user', content: 'draft the plan' }], new Date(T0 + 500).toISOString())
  seedDh('app-a', 'Analyst', DH_A, 'native', [['user', 'analyze churn'], ['assistant', 'churn is 4%']], T0 + 3000)
  seedDh('app-b', 'Writer', DH_B_LOCAL, 'local', [['user', 'outline the post'], ['assistant', 'here is an outline']], T0 + 2000)
})

afterEach(() => {
  ;(interop as any).dispose?.()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('a space conversation looking at digital humans', () => {
  it('lists digital-human chats beside its own conversations, marked as such, and leaves IM chats out', async () => {
    h.state.records.push({ appId: 'app-a', source: 'im', channel: 'wecom-bot', chatId: 'stranger', chatType: 'direct', displayName: 'Stranger', lastActiveAt: T0 + 9000, messageCount: 5, lastMessage: 'hi' })

    const { read } = tools(NOTES)
    const text = (await read({})).content[0].text

    expect(text).toContain(`[${DH_A}] "Analyst" (digital human)`)
    expect(text).toContain(`[${DH_B_LOCAL}] "Writer: Planning" (digital human)`)
    expect(text).toContain(`[${PLAN}] "Launch plan"`)
    expect(text).not.toContain(NOTES)
    expect(text).not.toContain('stranger')
    // Most recently active first, across both kinds of conversation.
    expect(text.indexOf(DH_A)).toBeLessThan(text.indexOf(DH_B_LOCAL))
    expect(text.indexOf(DH_B_LOCAL)).toBeLessThan(text.indexOf(PLAN))
  })

  it('reads a digital human\'s transcript by id, by title, and by the short handle a mention inserts', async () => {
    const { read } = tools(NOTES)
    for (const target of [DH_A, 'Analyst', sha8(DH_A), `conv:${sha8(DH_A)}`]) {
      const reply = await read({ target })
      expect(reply.isError, target).toBeUndefined()
      expect(reply.content[0].text, target).toContain('[user] analyze churn')
      expect(reply.content[0].text, target).toContain('[assistant] churn is 4%')
      expect(reply.content[0].text, target).toContain('(digital human)')
    }
  })

  it('cannot reach an IM chat of the same digital human, however it asks', async () => {
    h.state.records.push({ appId: 'app-a', source: 'im', channel: 'wecom-bot', chatId: 'stranger', chatType: 'direct', displayName: 'Stranger', lastActiveAt: T0, messageCount: 5, lastMessage: 'hi' })
    h.state.dhTranscripts.set(IM_KEY, [{ id: 'x', role: 'user', content: 'private', timestamp: 't', thoughts: null }])

    const { read, send } = tools(NOTES)
    expect((await read({ target: IM_KEY })).isError).toBe(true)
    expect((await read({ target: sha8(IM_KEY) })).isError).toBe(true)
    expect((await send({ target: IM_KEY, message: 'hi', summary: 's' })).isError).toBe(true)
    expect(h.sendAppChatMessage).not.toHaveBeenCalled()
  })

  it('reports a running digital human as running', async () => {
    h.state.dhBusy.add(DH_A)
    const text = (await tools(NOTES).read({})).content[0].text
    expect(text).toMatch(new RegExp(`\\[${DH_A}\\].*— running —`))
  })
})

describe('a space conversation messaging a digital human', () => {
  it('starts a chat turn with the framed text, and the transcript keeps the sender\'s words with provenance', async () => {
    const reply = await tools(NOTES).send({ target: 'Analyst', message: 'please re-run the churn numbers', summary: 'rerun churn' })

    expect(reply.content[0].text).toContain('Delivered')
    expect(h.sendAppChatMessage).toHaveBeenCalledTimes(1)
    const request = h.sendAppChatMessage.mock.calls[0][0]
    expect(request).toMatchObject({ appId: 'app-a', spaceId: SPACE, conversationId: DH_A })
    expect(request.message).toContain('please re-run the churn numbers')
    expect(request.message).toContain('Research notes')
    expect(request.message).toContain('not from your user')
    expect(request.recorded).toEqual({
      content: 'please re-run the churn numbers',
      provenance: {
        source: 'cross-conversation',
        metadata: { fromConversationId: NOTES, fromConversationTitle: 'Research notes', summary: 'rerun churn', forwardDepth: 1 },
      },
    })
    expect(transcriptOf(DH_A).at(-1)).toMatchObject({ role: 'system', source: 'cross-conversation', content: 'please re-run the churn numbers' })
  })

  it('queues behind a digital human that is mid-turn and delivers when that turn ends', async () => {
    h.state.dhBusy.add(DH_A)
    const reply = await tools(NOTES).send({ target: DH_A, message: 'later', summary: 's' })
    expect(reply.content[0].text).toContain('status: queued')
    expect(h.sendAppChatMessage).not.toHaveBeenCalled()

    await endDhTurn(DH_A)

    expect(h.sendAppChatMessage).toHaveBeenCalledTimes(1)
    expect(h.sendAppChatMessage.mock.calls[0][0].recorded.content).toBe('later')
  })

  it('waits for the digital human\'s own reply, sent through its own tool, and hands it back', async () => {
    const asking = tools(NOTES).send({ target: DH_A, message: 'what is the churn rate?', summary: 'ask churn', waitForReply: true })
    await flush()
    expect(h.sendAppChatMessage).toHaveBeenCalledTimes(1)
    expect(h.sendAppChatMessage.mock.calls[0][0].recorded.provenance.metadata).toMatchObject({ correlationId: expect.any(String) })

    // The digital human answers by sending back to the conversation that asked.
    const answered = await tools(DH_A).send({ target: NOTES, message: 'Churn is 4%', summary: 'answer' })
    expect(answered.content[0].text).toContain('Delivered')

    const reply = await asking
    expect(reply.content[0].text).toContain('replied')
    expect(reply.content[0].text).toContain('Churn is 4%')
    // The answer went to the waiting tool call, not into the asker's transcript.
    expect(h.state.chats.get(NOTES)!.messages.some((m) => m.content === 'Churn is 4%')).toBe(false)
  })

  it('tells the asker there was no reply when the digital human finishes its turn without answering', async () => {
    const asking = tools(NOTES).send({ target: DH_A, message: 'ping?', summary: 's', waitForReply: true })
    await flush()

    await endDhTurn(DH_A)

    expect((await asking).content[0].text).toContain('no_reply')
  })

  it('times out when the digital human neither answers nor finishes', async () => {
    const asking = tools(NOTES).send({ target: DH_A, message: 'ping?', summary: 's', waitForReply: true, timeoutSec: 10 })
    await flush()
    await vi.advanceTimersByTimeAsync(10_001)
    expect((await asking).content[0].text).toContain('timeout')
  })

  it('reports it when the digital human\'s turn cannot start', async () => {
    h.sendAppChatMessage.mockRejectedValueOnce(new Error('App not found'))
    const reply = await tools(NOTES).send({ target: DH_A, message: 'hi', summary: 's' })
    expect(reply.isError).toBe(true)
    expect(reply.content[0].text).toContain('unreachable')
  })

  it('cannot send when the conversation only has the read tool', async () => {
    expect(tools(NOTES, false).names).toEqual(['conversation_read'])
  })
})

describe('a digital human collaborating', () => {
  it('reads a space conversation and lists the others, its own chat excluded', async () => {
    const { read } = tools(DH_A)
    const list = (await read({})).content[0].text
    expect(list).toContain(NOTES)
    expect(list).toContain(PLAN)
    expect(list).toContain(DH_B_LOCAL)
    expect(list).not.toContain(`[${DH_A}]`)

    const reply = await read({ target: 'Research notes' })
    expect(reply.content[0].text).toContain('[assistant] done')
  })

  it('messages a space conversation and is named by its digital-human title', async () => {
    await tools(DH_A).send({ target: NOTES, message: 'analysis is ready', summary: 'ready' })

    expect(h.sendChat).toHaveBeenCalledTimes(1)
    const delivered = h.state.chats.get(NOTES)!.messages.at(-1)!
    expect(delivered).toMatchObject({
      role: 'system',
      source: 'cross-conversation',
      content: 'analysis is ready',
      metadata: { fromConversationId: DH_A, fromConversationTitle: 'Analyst', summary: 'ready' },
    })
  })

  it('works with another digital human: reads its chat and waits on it, both answering through their own tools', async () => {
    const analyst = tools(DH_A)
    const writer = tools(DH_B_LOCAL)

    const read = await analyst.read({ target: 'Writer: Planning' })
    expect(read.content[0].text).toContain('[assistant] here is an outline')

    const asking = analyst.send({ target: DH_B_LOCAL, message: 'Can you draft the intro?', summary: 'intro', waitForReply: true })
    await flush()
    expect(h.sendAppChatMessage).toHaveBeenCalledTimes(1)
    expect(h.sendAppChatMessage.mock.calls[0][0]).toMatchObject({ appId: 'app-b', conversationId: DH_B_LOCAL })
    expect(transcriptOf(DH_B_LOCAL).at(-1)).toMatchObject({
      role: 'system', source: 'cross-conversation', content: 'Can you draft the intro?',
      metadata: { fromConversationId: DH_A, fromConversationTitle: 'Analyst' },
    })

    await writer.send({ target: DH_A, message: 'Here is the intro.', summary: 'intro' })

    expect((await asking).content[0].text).toContain('Here is the intro.')
  })

  it('refuses two digital humans waiting on each other in a ring', async () => {
    const analyst = tools(DH_A)
    const writer = tools(DH_B_LOCAL)

    const analystAsks = analyst.send({ target: DH_B_LOCAL, message: 'q1', summary: 's', waitForReply: true })
    await flush()
    // The writer asks a third conversation instead of answering, and that one tries to wait on the analyst.
    const writerAsks = writer.send({ target: NOTES, message: 'q2', summary: 's', waitForReply: true })
    await flush()
    const closing = await tools(NOTES).send({ target: DH_A, message: 'q3', summary: 's', waitForReply: true })
    expect(closing.isError).toBe(true)
    expect(closing.content[0].text).toContain('waiting on you')

    await endDhTurn(DH_B_LOCAL)
    await endChatTurn(NOTES)
    await analystAsks
    await writerAsks
  })

  it('a digital human with a chat that ends unanswered leaves the other digital human\'s ask as no_reply', async () => {
    const asking = tools(DH_A).send({ target: DH_B_LOCAL, message: 'ping', summary: 's', waitForReply: true })
    await flush()
    await endDhTurn(DH_B_LOCAL)
    expect((await asking).content[0].text).toContain('no_reply')
  })
})

describe('a digital human with conversation collaboration off', () => {
  const switchOff = (appId: string) => { h.state.apps.get(appId)!.permissions = { granted: [], denied: [] } }

  it('is not listed, and a reference to it by id, title or handle gets the reason instead of "not found"', async () => {
    switchOff('app-b')
    const { read } = tools(NOTES)

    expect((await read({})).content[0].text).not.toContain(DH_B_LOCAL)
    for (const target of [DH_B_LOCAL, 'Writer: Planning', sha8(DH_B_LOCAL)]) {
      const reply = await read({ target })
      expect(reply.isError, target).toBe(true)
      expect(reply.content[0].text, target).toContain('conversation collaboration turned off')
      expect(reply.content[0].text, target).toContain('(status: unavailable)')
    }
  })

  it('cannot be messaged by another digital human, and is never woken', async () => {
    switchOff('app-b')
    const reply = await tools(DH_A).send({ target: 'Writer: Planning', message: 'hi', summary: 's', waitForReply: true })

    expect(reply.isError).toBe(true)
    expect(reply.content[0].text).toContain('conversation collaboration turned off')
    expect(h.sendAppChatMessage).not.toHaveBeenCalled()
  })

  it('a message already queued behind its turn is refused when it would dispatch, still without waking it', async () => {
    h.state.dhBusy.add(DH_B_LOCAL)
    expect((await tools(NOTES).send({ target: DH_B_LOCAL, message: 'later', summary: 's' })).content[0].text).toContain('queued')
    switchOff('app-b')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await endDhTurn(DH_B_LOCAL)
      expect(h.sendAppChatMessage).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it('tells a sender waiting on a queued message at once when the switch goes off before it is delivered', async () => {
    h.state.dhBusy.add(DH_B_LOCAL)
    const asking = tools(NOTES).send({ target: DH_B_LOCAL, message: 'q', summary: 's', waitForReply: true, timeoutSec: 300 })
    await flush()
    switchOff('app-b')
    const quiet = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})]
    try {
      await endDhTurn(DH_B_LOCAL)
      const reply = await asking
      expect(reply.isError).toBe(true)
      expect(reply.content[0].text).toContain('never reached')
      expect(reply.content[0].text).toContain('conversation collaboration turned off')
      expect(h.sendAppChatMessage).not.toHaveBeenCalled()
    } finally {
      quiet.forEach((spy) => spy.mockRestore())
    }
  })

  it('a reachable conversation sharing its title still resolves', async () => {
    switchOff('app-b')
    seedChat('cccccccc-3333-4333-8333-333333333333', 'Writer: Planning')
    const reply = await tools(NOTES).read({ target: 'Writer: Planning' })
    expect(reply.isError).toBeUndefined()
  })
})

describe('a scheduled run as the sender', () => {
  const RUN = 'app-run:app-a:run-1'

  function openRun() {
    return runSenders.openRunSender({ appId: 'app-a', runId: 'run-1', spaceId: SPACE, name: 'Analyst', startedAt: T0 })
  }

  it('sends a one-way notice under its own identity, never the digital human\'s chat', async () => {
    expect(openRun()).toBe(RUN)
    await tools(RUN).send({ target: NOTES, message: 'nightly report ready', summary: 'report' })

    const delivered = h.state.chats.get(NOTES)!.messages.at(-1)!
    expect(delivered.metadata).toMatchObject({ fromConversationId: RUN })
    expect(delivered.metadata.fromConversationTitle).toMatch(/^Analyst · scheduled run \(.+ run\)$/)
    const framed = h.sendChat.mock.calls.at(-1)![0].message as string
    expect(framed).toContain('one-way notice')
    expect(framed).toContain('do not reply')
    runSenders.closeRunSender(RUN)
  })

  it('refuses a reply to a finished run with a reason, and never delivers it to the digital human\'s chat', async () => {
    openRun()
    await tools(RUN).send({ target: NOTES, message: 'fyi', summary: 's' })
    runSenders.closeRunSender(RUN)
    const before = transcriptOf(DH_A).length

    const reply = await tools(NOTES).send({ target: RUN, message: 'thanks!', summary: 's' })

    expect(reply.isError).toBe(true)
    expect(reply.content[0].text).toContain('takes no replies')
    expect(h.sendAppChatMessage).not.toHaveBeenCalled()
    expect(transcriptOf(DH_A)).toHaveLength(before)
  })

  it('knows a finished run only in its own space', () => {
    openRun()
    runSenders.closeRunSender(RUN)
    const source = runSenders.createRunConversationSource()

    expect(source.getMeta(SPACE, RUN)).toMatchObject({ id: RUN, unavailable: expect.any(String) })
    expect(source.getMeta('another-space', RUN)).toBeNull()
    expect(source.getMeta(SPACE, 'app-run:app-a:never-opened')).toBeNull()
  })

  it('withdraws the tools from a sender whose collaboration is switched off mid-turn', async () => {
    h.state.apps.get('app-a')!.permissions = { granted: [], denied: [] }

    const sent = await tools(DH_A).send({ target: NOTES, message: 'x', summary: 's' })
    const read = await tools(DH_A).read({})

    for (const reply of [sent, read]) {
      expect(reply.isError).toBe(true)
      expect(reply.content[0].text).toContain('no longer use the cross-conversation tools')
    }
    expect(h.sendChat).not.toHaveBeenCalled()
  })

  it('refuses a plain message to a run that is still going', async () => {
    openRun()
    const reply = await tools(NOTES).send({ target: RUN, message: 'hello?', summary: 's' })
    expect(reply.isError).toBe(true)
    expect(reply.content[0].text).toContain('takes no replies')
    runSenders.closeRunSender(RUN)
  })

  it('gets its answer through a wait it is blocked in, while it is alive', async () => {
    openRun()
    const asking = tools(RUN).send({ target: NOTES, message: 'approve the budget?', summary: 's', waitForReply: true })
    await flush()
    const framed = h.sendChat.mock.calls.at(-1)![0].message as string
    expect(framed).not.toContain('one-way notice')

    const answered = await tools(NOTES).send({ target: RUN, message: 'approved', summary: 's' })
    expect(answered.isError).toBeUndefined()
    expect((await asking).content[0].text).toContain('approved')
    expect(h.sendAppChatMessage).not.toHaveBeenCalled()
    runSenders.closeRunSender(RUN)
  })

  it('names itself with an unambiguous local time, whatever the OS locale', () => {
    openRun()
    const d = new Date(T0)
    const pad = (n: number) => String(n).padStart(2, '0')
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    return tools(RUN).send({ target: NOTES, message: 'm', summary: 's' }).then(() => {
      expect(h.state.chats.get(NOTES)!.messages.at(-1)!.metadata.fromConversationTitle).toBe(`Analyst · scheduled run (${expected} run)`)
      runSenders.closeRunSender(RUN)
    })
  })

  it('can be answered the way the recipient\'s model would: by the reply target its frame names', async () => {
    openRun()
    const asking = tools(RUN).send({ target: NOTES, message: 'approve the budget?', summary: 's', waitForReply: true })
    await flush()

    const framed = h.sendChat.mock.calls.at(-1)![0].message as string
    const replyTarget = /conversation_send, target "([^"]+)"/.exec(framed)?.[1]
    expect(replyTarget).toBeDefined()
    // What a model would try first — the name it was shown — reaches nothing: runs are not listed.
    const byTitle = await tools(NOTES).send({ target: 'Analyst', message: 'approved', summary: 's' })
    expect(byTitle.content[0].text).not.toContain('replied')

    const answered = await tools(NOTES).send({ target: replyTarget!, message: 'approved', summary: 's' })
    expect(answered.isError).toBeUndefined()
    expect((await asking).content[0].text).toContain('approved')
    runSenders.closeRunSender(RUN)
  })

  it('keeps its name on a notice that was queued and delivered after it finished', async () => {
    openRun()
    h.state.chatBusy.add(NOTES)
    expect((await tools(RUN).send({ target: NOTES, message: 'late report', summary: 's' })).content[0].text).toContain('queued')
    runSenders.closeRunSender(RUN)

    await endChatTurn(NOTES)

    const delivered = h.state.chats.get(NOTES)!.messages.at(-1)!
    expect(delivered.content).toBe('late report')
    expect(delivered.metadata.fromConversationTitle).toMatch(/^Analyst · scheduled run \(/)
  })

  it('stops accepting even the awaited reply once its digital human\'s collaboration is switched off', async () => {
    openRun()
    const asking = tools(RUN).send({ target: NOTES, message: 'ok?', summary: 's', waitForReply: true, timeoutSec: 10 })
    await flush()
    h.state.apps.get('app-a')!.permissions = { granted: [], denied: [] }

    const reply = await tools(NOTES).send({ target: RUN, message: 'yes', summary: 's' })
    expect(reply.isError).toBe(true)
    expect(reply.content[0].text).toContain('conversation collaboration turned off')

    await vi.advanceTimersByTimeAsync(10_001)
    const outcome = (await asking).content[0].text
    expect(outcome).toContain('timeout')
    expect(outcome).toContain('A late reply will not be delivered to this run')
    runSenders.closeRunSender(RUN)
  })

  it('an immediate failure of a waiting send reaches the sender with its real reason', async () => {
    h.sendAppChatMessage.mockRejectedValueOnce(new Error('this digital human has conversation collaboration turned off'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const reply = await tools(NOTES).send({ target: DH_A, message: 'q', summary: 's', waitForReply: true })
      expect(reply.isError).toBe(true)
      expect(reply.content[0].text).toContain('never reached')
      expect(reply.content[0].text).toContain('conversation collaboration turned off')
      expect(reply.content[0].text).not.toContain('could not be restarted')
    } finally {
      warn.mockRestore()
    }
  })

  it('is never listed', async () => {
    openRun()
    expect((await tools(NOTES).read({})).content[0].text).not.toContain(RUN)
    runSenders.closeRunSender(RUN)
  })
})
