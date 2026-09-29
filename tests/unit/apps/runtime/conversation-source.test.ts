/**
 * The digital-human conversation source: which chats it exposes to other
 * conversations, how it reads them, and how a delivery becomes a chat turn.
 * Everything under it (app manager, session registry, transcript reader, chat
 * send, live-turn probes) is faked; the source's own decisions are under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'

const h = vi.hoisted(() => {
  const state = {
    config: {} as Record<string, any>,
    apps: new Map<string, any>(),
    records: [] as any[],
    spacePath: '/spaces/space-1' as string | undefined,
    generating: new Set<string>(),
    activeRounds: new Set<string>(),
    sessions: new Set<string>(),
    sinks: new Map<string, { writeUserMessage: (...args: unknown[]) => void }>(),
    transcripts: new Map<string, any[]>(),
    agentListener: null as null | ((event: { channel: string; conversationId: string }) => void),
  }
  return {
    state,
    sendAppChatMessage: vi.fn(),
    loadChatTranscriptForConversation: vi.fn(),
    agentDispose: vi.fn(),
  }
})

vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => h.state.config }))
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
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: () => (h.state.spacePath ? { id: 'space-1', path: h.state.spacePath } : null),
}))
vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({
  sendAppChatMessage: (...args: unknown[]) => h.sendAppChatMessage(...args),
  loadChatTranscriptForConversation: (...args: unknown[]) => h.loadChatTranscriptForConversation(...args),
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-live-turn', () => ({
  isAppChatConversationGenerating: (id: string) => h.state.generating.has(id) || h.state.activeRounds.has(id),
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-sink', () => ({
  hasActiveAppChatRound: (id: string) => h.state.activeRounds.has(id),
  peekAppChatSink: (id: string) => h.state.sinks.get(id),
}))
vi.mock('../../../../src/main/services/agent', () => ({
  v2Sessions: { has: (id: string) => h.state.sessions.has(id) },
  onAgentEvent: (listener: (event: { channel: string; conversationId: string }) => void) => {
    h.state.agentListener = listener
    return { dispose: h.agentDispose }
  },
}))

import { createDigitalHumanConversationSource } from '../../../../src/main/apps/runtime/conversation-source'
import { COLLAB_OFF_REASON } from '../../../../src/main/apps/runtime/conversation-collab'
import { buildImSessionKey, buildLocalSessionKey, buildTeamSessionKey, getAppChatConversationId } from '../../../../src/shared/apps/im-keys'

const SPACE = 'space-1'
const T0 = Date.UTC(2026, 0, 1)

const COLLAB_ON = { granted: ['conversation-collab'], denied: [] as string[] }
const app = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, spaceId: SPACE, status: 'active', spec: { name, type: 'automation' }, permissions: COLLAB_ON, ...over,
})
const record = (appId: string, source: string, chatId: string, over: Record<string, unknown> = {}) => ({
  appId, source, channel: source === 'native' ? 'native' : source === 'local' ? 'local' : 'wecom-bot', chatId,
  chatType: 'direct', displayName: '', lastActiveAt: T0, messageCount: 0, ...over,
})

const source = createDigitalHumanConversationSource()

beforeEach(() => {
  const s = h.state
  s.config = { agent: {} }
  s.apps = new Map([['app-1', app('app-1', 'Analyst')], ['app-2', app('app-2', 'Writer')]])
  s.records = []
  s.spacePath = '/spaces/space-1'
  s.generating.clear()
  s.activeRounds.clear()
  s.sessions.clear()
  s.sinks.clear()
  s.transcripts.clear()
  s.agentListener = null
  h.sendAppChatMessage.mockReset()
  h.agentDispose.mockClear()
  h.loadChatTranscriptForConversation.mockReset()
})

describe('what it exposes', () => {
  it('is a readable, writable, labelled source that owns the whole app-chat namespace', () => {
    expect(source.kind).toBe('digital-human')
    expect(source.label).toBe('digital human')
    expect(source.capabilities).toEqual({ readable: true, writable: true })
    expect(source.owns(getAppChatConversationId('app-1'))).toBe(true)
    expect(source.owns(buildImSessionKey('app-1', 'wecom-bot', 'direct', 'x'))).toBe(true)
    expect(source.owns('3a5d77ea-1c2b-4f7e-9d10-0123456789ab')).toBe(false)
  })

  it('lists the default session once it holds a conversation, and every local session', () => {
    h.state.records = [
      record('app-1', 'native', 'default', { lastMessage: 'hi', messageCount: 3, lastActiveAt: T0 + 5_000 }),
      record('app-1', 'local', 'sess-1', { customName: 'Q3 numbers', messageCount: 2, lastActiveAt: T0 + 9_000 }),
      record('app-1', 'local', 'sess-2', { lastMessage: 'a very first message', lastActiveAt: T0 + 1_000 }),
      record('app-1', 'local', 'sess-3', { lastActiveAt: T0 }),
      record('app-2', 'native', 'default', { messageCount: 1, lastActiveAt: T0 + 2_000 }),
    ]

    expect(source.list(SPACE)).toEqual(
      expect.arrayContaining([
        { id: 'app-chat:app-1', title: 'Analyst', updatedAt: new Date(T0 + 5_000).toISOString(), messageCount: 3 },
        { id: 'app-chat:app-1:local:direct:sess-1', title: 'Analyst: Q3 numbers', updatedAt: new Date(T0 + 9_000).toISOString(), messageCount: 2 },
        { id: 'app-chat:app-1:local:direct:sess-2', title: 'Analyst: a very first message', updatedAt: new Date(T0 + 1_000).toISOString(), messageCount: 0 },
        { id: 'app-chat:app-1:local:direct:sess-3', title: 'Analyst: New chat', updatedAt: new Date(T0).toISOString(), messageCount: 0 },
        { id: 'app-chat:app-2', title: 'Writer', updatedAt: new Date(T0 + 2_000).toISOString(), messageCount: 1 },
      ])
    )
    expect(source.list(SPACE)).toHaveLength(5)
  })

  it('does not list a default session nobody has written in yet', () => {
    h.state.records = [record('app-1', 'native', 'default')]
    expect(source.list(SPACE)).toEqual([])
  })

  it('never lists IM, HTTP or team sessions', () => {
    h.state.records = [
      record('app-1', 'im', 'chat-1', { messageCount: 9, lastMessage: 'hello' }),
      record('app-1', 'http', 'api-1', { messageCount: 9, lastMessage: 'hello' }),
      { ...record('app-1', 'im', 'e', { messageCount: 9 }), channel: 'team', teamContext: { teamId: 't', epochId: 'e' } },
    ]
    expect(source.list(SPACE)).toEqual([])
  })

  it('lists only the digital humans installed in that space, and none that were uninstalled or are not automations', () => {
    h.state.apps.set('app-3', app('app-3', 'Elsewhere', { spaceId: 'space-2' }))
    h.state.apps.set('app-4', app('app-4', 'Gone', { status: 'uninstalled' }))
    h.state.apps.set('app-5', { ...app('app-5', 'Tool'), spec: { name: 'Tool', type: 'mcp' } } as any)
    h.state.records = ['app-3', 'app-4', 'app-5'].map((id) => record(id, 'local', 's', { messageCount: 1 }))

    expect(source.list(SPACE)).toEqual([])
  })

  it('exposes nothing while digital humans are switched off', () => {
    h.state.config = { agent: { enableDigitalHumans: false } }
    h.state.records = [record('app-1', 'local', 's1', { messageCount: 1 })]
    expect(source.list(SPACE)).toEqual([])
    expect(source.getMeta(SPACE, 'app-chat:app-1:local:direct:s1')).toBeNull()
    expect(source.readTranscript(SPACE, 'app-chat:app-1:local:direct:s1')).toBeNull()
  })

  it('resolves exactly the sessions it lists, and nothing else', () => {
    h.state.records = [
      record('app-1', 'native', 'default', { messageCount: 1, lastActiveAt: T0 }),
      record('app-1', 'local', 's1', { messageCount: 1, lastActiveAt: T0 }),
      record('app-1', 'im', 'chat-1', { messageCount: 1 }),
    ]
    h.state.apps.set('app-3', app('app-3', 'Elsewhere', { spaceId: 'space-2' }))

    expect(source.getMeta(SPACE, 'app-chat:app-1')).toMatchObject({ id: 'app-chat:app-1', title: 'Analyst' })
    expect(source.getMeta(SPACE, 'app-chat:app-1:local:direct:s1')).toMatchObject({ title: expect.stringContaining('Analyst') })
    expect(source.getMeta(SPACE, buildImSessionKey('app-1', 'wecom-bot', 'direct', 'chat-1'))).toBeNull()
    expect(source.getMeta(SPACE, buildTeamSessionKey('app-1', 'team-1', 'epoch-1'))).toBeNull()
    expect(source.getMeta(SPACE, 'app-chat:app-1:local:direct:unknown')).toBeNull()
    expect(source.getMeta(SPACE, 'app-chat:app-3')).toBeNull()
    expect(source.getMeta(SPACE, 'app-chat:missing')).toBeNull()
    expect(source.getMeta(SPACE, 'not-a-key')).toBeNull()
  })

  it('derives the short handle by hashing the session key', () => {
    const key = buildLocalSessionKey('app-1', 'sess-1')
    expect(source.shortRef(key)).toBe(createHash('sha1').update(key).digest('hex').slice(0, 8))
  })
})

describe('reading', () => {
  const key = 'app-chat:app-1'
  beforeEach(() => {
    h.state.records = [record('app-1', 'native', 'default', { messageCount: 1 })]
  })

  it('walks the transcript pages back to the start and returns clean lines oldest first', () => {
    const msg = (id: string, role: string, content: string, source?: string) => ({ id, role, content, timestamp: `t-${id}`, source, thoughts: null })
    const pages = [
      { messages: [msg('m4', 'assistant', 'd'), msg('m5', 'system', 'e', 'cross-conversation')], hasMoreBefore: true, cursor: 'm4', total: 5 },
      { messages: [msg('m2', 'user', 'b'), msg('m3', 'assistant', 'c')], hasMoreBefore: true, cursor: 'm2', total: 5 },
      { messages: [msg('m1', 'user', 'a')], hasMoreBefore: false, cursor: 'm1', total: 5 },
    ]
    h.loadChatTranscriptForConversation.mockImplementation((_path: string, _app: string, _key: string, request: { before?: string }) =>
      request.before === undefined ? pages[0] : request.before === 'm4' ? pages[1] : pages[2]
    )

    const lines = source.readTranscript(SPACE, key)

    expect(lines).toEqual([
      { id: 'm1', role: 'user', content: 'a', timestamp: 't-m1', source: undefined },
      { id: 'm2', role: 'user', content: 'b', timestamp: 't-m2', source: undefined },
      { id: 'm3', role: 'assistant', content: 'c', timestamp: 't-m3', source: undefined },
      { id: 'm4', role: 'assistant', content: 'd', timestamp: 't-m4', source: undefined },
      { id: 'm5', role: 'system', content: 'e', timestamp: 't-m5', source: 'cross-conversation' },
    ])
    expect(h.loadChatTranscriptForConversation).toHaveBeenNthCalledWith(1, '/spaces/space-1', 'app-1', key, { before: undefined, limit: 200 })
  })

  it('returns an empty transcript for a session with no messages yet', () => {
    h.loadChatTranscriptForConversation.mockReturnValue({ messages: [], hasMoreBefore: false, cursor: null, total: 0 })
    expect(source.readTranscript(SPACE, key)).toEqual([])
  })

  it('refuses sessions it does not expose, and a space it cannot locate', () => {
    expect(source.readTranscript(SPACE, buildImSessionKey('app-1', 'wecom-bot', 'direct', 'x'))).toBeNull()
    expect(source.readTranscript(SPACE, 'app-chat:missing')).toBeNull()
    h.state.spacePath = undefined
    expect(source.readTranscript(SPACE, key)).toBeNull()
    expect(h.loadChatTranscriptForConversation).not.toHaveBeenCalled()
  })
})

describe('busyness', () => {
  it('is busy while a turn runs or a dispatched message waits for one', () => {
    h.state.generating.add('app-chat:app-1')
    h.state.activeRounds.add('app-chat:app-2')
    expect(source.isBusy('app-chat:app-1')).toBe(true)
    expect(source.isBusy('app-chat:app-2')).toBe(true)
    expect(source.isBusy('app-chat:app-3')).toBe(false)
  })

  it('has a live session while the engine holds one or a round is queued', () => {
    h.state.sessions.add('app-chat:app-1')
    h.state.activeRounds.add('app-chat:app-2')
    expect(source.hasLiveSession('app-chat:app-1')).toBe(true)
    expect(source.hasLiveSession('app-chat:app-2')).toBe(true)
    expect(source.hasLiveSession('app-chat:app-3')).toBe(false)
  })
})

describe('dispatch', () => {
  const message = {
    turnInput: '[Message from another conversation ("Notes")]\n\nthe words',
    record: { content: 'the words', source: 'cross-conversation' as const, metadata: { fromConversationId: 'c-1', fromConversationTitle: 'Notes', summary: 's', forwardDepth: 1 } },
  }
  const key = 'app-chat:app-1:local:direct:s1'

  it('runs an ordinary chat turn with the framed text, recording the sender\'s own words with provenance', async () => {
    h.sendAppChatMessage.mockImplementation(async (request: { onMessageAccepted: () => void }) => { request.onMessageAccepted() })

    await expect(source.dispatch(SPACE, key, message)).resolves.toEqual({})

    expect(h.sendAppChatMessage).toHaveBeenCalledWith({
      appId: 'app-1',
      spaceId: SPACE,
      conversationId: key,
      message: message.turnInput,
      recorded: { content: 'the words', provenance: { source: 'cross-conversation', metadata: message.record.metadata } },
      onMessageAccepted: expect.any(Function),
    })
  })

  it('resolves as soon as the engine accepts the message, not when the whole turn ends', async () => {
    let acceptMessage: () => void = () => {}
    let endTurn: () => void = () => {}
    h.sendAppChatMessage.mockImplementation(
      (request: { onMessageAccepted: () => void }) =>
        new Promise<void>((resolve) => { acceptMessage = request.onMessageAccepted; endTurn = resolve })
    )
    let settled = false
    const dispatched = source.dispatch(SPACE, key, message).then(() => { settled = true })

    await Promise.resolve()
    expect(settled).toBe(false)
    acceptMessage()
    await dispatched
    expect(settled).toBe(true)
    endTurn()
  })

  it('rejects when the turn cannot be started', async () => {
    h.sendAppChatMessage.mockRejectedValue(new Error('App not found'))
    await expect(source.dispatch(SPACE, key, message)).rejects.toThrow('App not found')
  })

  it('logs, and does not reject, a failure that comes after the message was accepted', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let failTurn: (err: Error) => void = () => {}
      h.sendAppChatMessage.mockImplementation(
        (request: { onMessageAccepted: () => void }) =>
          new Promise<void>((_resolve, reject) => { request.onMessageAccepted(); failTurn = reject })
      )
      await source.dispatch(SPACE, key, message)
      failTurn(new Error('engine died'))
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining(key), expect.any(Error)))
    } finally {
      error.mockRestore()
    }
  })

  it('resolves when a turn ends without ever reporting acceptance', async () => {
    h.sendAppChatMessage.mockResolvedValue(undefined)
    await expect(source.dispatch(SPACE, key, message)).resolves.toEqual({})
  })

  it('refuses ids that are not one of its sessions', async () => {
    await expect(source.dispatch(SPACE, buildImSessionKey('app-1', 'wecom-bot', 'direct', 'x'), message)).rejects.toThrow('not a digital-human session')
    expect(h.sendAppChatMessage).not.toHaveBeenCalled()
  })
})

describe('turn ends', () => {
  it('reports a completed or failed turn of an app-chat key, and nothing else', () => {
    const listener = vi.fn()
    const subscription = source.onTurnEnd(listener)

    h.state.agentListener!({ channel: 'agent:complete', conversationId: 'app-chat:app-1' })
    h.state.agentListener!({ channel: 'agent:error', conversationId: 'app-chat:app-1:local:direct:s1' })
    h.state.agentListener!({ channel: 'agent:message', conversationId: 'app-chat:app-1' })
    h.state.agentListener!({ channel: 'agent:complete', conversationId: '3a5d77ea-1c2b-4f7e-9d10-0123456789ab' })

    expect(listener.mock.calls).toEqual([['app-chat:app-1'], ['app-chat:app-1:local:direct:s1']])
    subscription.dispose()
    expect(h.agentDispose).toHaveBeenCalledTimes(1)
  })
})

describe('notices', () => {
  it('writes a notice into the live transcript as a system line with its own source', () => {
    const writeUserMessage = vi.fn()
    h.state.sinks.set('app-chat:app-1', { writeUserMessage })
    source.writeNotice(SPACE, 'app-chat:app-1', 'paused for 5 minutes')
    expect(writeUserMessage).toHaveBeenCalledWith('paused for 5 minutes', undefined, undefined, { source: 'cross-conversation-notice' })
  })

  it('says so, rather than failing silently, when there is no live transcript to write into', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      source.writeNotice(SPACE, 'app-chat:app-1', 'paused')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('app-chat:app-1'))
    } finally {
      warn.mockRestore()
    }
  })
})

describe('conversation collaboration switched off', () => {
  const off = () => h.state.apps.set('app-1', app('app-1', 'Analyst', { permissions: { granted: [], denied: [] } }))
  const local = 'app-chat:app-1:local:direct:s1'

  beforeEach(() => {
    h.state.records = [
      record('app-1', 'native', 'default', { messageCount: 2, lastMessage: 'hi' }),
      record('app-1', 'local', 's1', { customName: 'Q3', messageCount: 1 }),
      record('app-2', 'local', 's2', { messageCount: 1 }),
    ]
  })

  it('is off by default: a digital human that never had it granted is marked, not hidden', () => {
    off()
    expect(source.list(SPACE)).toEqual([
      expect.objectContaining({ id: 'app-chat:app-1', unavailable: COLLAB_OFF_REASON }),
      expect.objectContaining({ id: local, unavailable: COLLAB_OFF_REASON }),
      expect.objectContaining({ id: 'app-chat:app-2:local:direct:s2' }),
    ])
    expect(source.list(SPACE).find((c) => c.id === 'app-chat:app-2:local:direct:s2')?.unavailable).toBeUndefined()
  })

  it('still knows and reads its chats: the switch governs other conversations\' AI, not the user', () => {
    off()
    h.loadChatTranscriptForConversation.mockReturnValue({ messages: [], hasMoreBefore: false, cursor: null })
    expect(source.getMeta(SPACE, local)).toMatchObject({ id: local, title: 'Analyst: Q3', unavailable: COLLAB_OFF_REASON })
    source.readTranscript(SPACE, local)
    expect(h.loadChatTranscriptForConversation).toHaveBeenCalled()
  })

  it('does not mark a chat it does not own or that does not exist', () => {
    off()
    expect(source.getMeta(SPACE, 'app-chat:app-1:local:direct:unknown')).toBeNull()
    expect(source.getMeta(SPACE, 'app-chat:app-1:wecom-bot:direct:x')).toBeNull()
  })

  it('reads the switch on every call, so turning it back on takes effect at once', () => {
    off()
    expect(source.getMeta(SPACE, local)?.unavailable).toBe(COLLAB_OFF_REASON)
    h.state.apps.set('app-1', app('app-1', 'Analyst'))
    expect(source.getMeta(SPACE, local)?.unavailable).toBeUndefined()
  })
})
