/**
 * The space's own conversation source: what it exposes, how it recognizes its
 * ids, and how it records a delivered message. Delivery timing, queueing and
 * limits are the module's concern and are covered in delivery.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  source?: string
  metadata?: Record<string, unknown>
}

const h = vi.hoisted(() => {
  const conversations = new Map<string, { id: string; title: string; updatedAt: string; messages: FakeMessage[] }>()
  const addMessage = vi.fn()
  const updateMessageById = vi.fn()
  const sendMessage = vi.fn()
  return { conversations, addMessage, updateMessageById, sendMessage, sendIntoLiveTurn: vi.fn((..._args: unknown[]) => true), emitAgentEvent: vi.fn() }
})

vi.mock('../../../../src/main/services/conversation.service', () => ({
  getConversation: (_space: string, id: string) => h.conversations.get(id) ?? null,
  listConversations: () =>
    [...h.conversations.values()].map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length })),
  addMessage: h.addMessage,
  updateMessageById: h.updateMessageById,
}))
vi.mock('../../../../src/main/services/agent/send-message', () => ({ sendMessage: h.sendMessage }))

// chat-source reaches the engine through the services/agent barrel; without this
// every module reset would load the whole engine graph.
vi.mock('../../../../src/main/services/agent', async () => ({
  hasPendingSessionInput: () => false,
  sendIntoLiveTurn: h.sendIntoLiveTurn,
  emitAgentEvent: h.emitAgentEvent,
  onAgentEvent: (await import('../../../../src/main/services/agent/events')).onAgentEvent,
  sendMessage: (await import('../../../../src/main/services/agent/send-message')).sendMessage,
}))
vi.mock('../../../../src/main/services/conversation-interop/busy', () => ({
  isNativeConversationBusy: (id: string) => id === 'busy-1',
  hasLiveNativeSession: (id: string) => id === 'live-1',
}))

import type { DispatchedMessage } from '../../../../src/main/services/conversation-interop/source'
import { createChatConversationSource } from '../../../../src/main/services/conversation-interop/chat-source'

const message = (id: string, role: FakeMessage['role'], content: string, extra: Partial<FakeMessage> = {}): FakeMessage => ({
  id, role, content, timestamp: `2026-01-01T00:00:0${id.length}.000Z`, ...extra,
})

describe('chat conversation source', () => {
  const source = createChatConversationSource()

  beforeEach(() => {
    h.conversations.clear()
    h.addMessage.mockReset()
    h.updateMessageById.mockReset()
    h.sendMessage.mockReset()
    h.sendIntoLiveTurn.mockReset().mockReturnValue(true)
    h.emitAgentEvent.mockClear()
  })

  it('is readable and writable', () => {
    expect(source.kind).toBe('chat')
    expect(source.capabilities).toEqual({ readable: true, writable: true })
    expect(source.label).toBeUndefined()
  })

  it('owns every id outside the digital-human namespace', () => {
    expect(source.owns('3a5d77ea-1c2b-4f7e-9d10-0123456789ab')).toBe(true)
    expect(source.owns('app-chat:app-1')).toBe(false)
    expect(source.owns('app-chat:app-1:local:direct:s1')).toBe(false)
  })

  it('lists conversation metadata and reports a conversation\'s own message count from its content', () => {
    h.conversations.set('c1', { id: 'c1', title: 'One', updatedAt: '2026-01-02T00:00:00.000Z', messages: [message('a', 'user', 'hi'), message('bb', 'assistant', 'yo')] })

    expect(source.list('space-1')).toEqual([{ id: 'c1', title: 'One', updatedAt: '2026-01-02T00:00:00.000Z', messageCount: 2 }])
    expect(source.getMeta('space-1', 'c1')).toEqual({ id: 'c1', title: 'One', updatedAt: '2026-01-02T00:00:00.000Z', messageCount: 2 })
    expect(source.getMeta('space-1', 'missing')).toBeNull()
  })

  it('reads the clean transcript with id, role and source, and nothing else of a message', () => {
    h.conversations.set('c1', {
      id: 'c1', title: 'One', updatedAt: 'x',
      messages: [
        message('a', 'user', 'hi'),
        message('bb', 'system', 'from elsewhere', { source: 'cross-conversation', metadata: { fromConversationId: 'z' } }),
      ],
    })

    expect(source.readTranscript('space-1', 'c1')).toEqual([
      { id: 'a', role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:01.000Z', source: undefined },
      { id: 'bb', role: 'system', content: 'from elsewhere', timestamp: '2026-01-01T00:00:02.000Z', source: 'cross-conversation' },
    ])
    expect(source.readTranscript('space-1', 'missing')).toBeNull()
  })

  it('derives the short handle from the uuid', () => {
    expect(source.shortRef('3a5d77ea-1c2b-4f7e-9d10-0123456789ab')).toBe('3a5d77ea')
  })

  it('answers busyness and liveness from the engine', () => {
    expect(source.isBusy('busy-1')).toBe(true)
    expect(source.isBusy('idle-1')).toBe(false)
    expect(source.hasLiveSession('live-1')).toBe(true)
    expect(source.hasLiveSession('dead-1')).toBe(false)
  })

  it('leaves a system notice through the conversation store', () => {
    source.writeNotice('space-1', 'c1', 'paused')
    expect(h.addMessage).toHaveBeenCalledWith('space-1', 'c1', { role: 'system', content: 'paused', source: 'cross-conversation-notice' })
  })

  it('announces one accepted batch with original source records before the turn ends', () => {
    h.conversations.set('c1', { id: 'c1', title: 'One', updatedAt: 'x', messages: [message('reply', 'assistant', '')] })
    h.addMessage.mockImplementation((_space, _conversation, record) => ({ ...record, id: `record-${record.content}`, timestamp: '2026-10-09T10:00:00.000Z' }))
    const outcomes = source.deliverMidTurn!('space-1', 'c1', [
      { turnInput: 'framed first', record: { content: 'first', source: 'team-message', metadata: { fromMemberName: 'Reviewer' } } },
      { turnInput: 'framed second', record: { content: 'second', source: 'cross-conversation', metadata: { fromConversationId: 'other' } } },
    ], () => {})
    expect(outcomes).toEqual([{ messageId: 'record-first' }, { messageId: 'record-second' }])
    expect(h.emitAgentEvent).toHaveBeenCalledOnce()
    expect(h.emitAgentEvent.mock.calls[0]).toEqual(['agent:input-arrived', 'space-1', 'c1', {
      live: true, messages: [
        expect.objectContaining({ content: 'first', source: 'team-message', metadata: { fromMemberName: 'Reviewer', inputMode: 'live', inputReplyId: 'reply' } }),
        expect.objectContaining({ content: 'second', source: 'cross-conversation', metadata: { fromConversationId: 'other', inputMode: 'live', inputReplyId: 'reply' } }),
      ],
    }])
  })

  it('does not attribute a continuation-gap delivery to an already completed reply', () => {
    h.conversations.set('c1', { id: 'c1', title: 'One', updatedAt: 'x', messages: [message('done', 'assistant', 'finished')] })
    h.addMessage.mockImplementation((_space, _conversation, record) => ({ ...record, id: 'late', timestamp: 'now' }))
    source.deliverMidTurn!('space-1', 'c1', [{ turnInput: 'late', record: { content: 'late', source: 'team-message', metadata: { teamId: 'team' } } }], () => {})
    expect(h.addMessage.mock.calls[0][2].metadata).toEqual({ teamId: 'team', inputMode: 'live' })
  })

  it('does not persist refused live deliveries', () => {
    h.sendIntoLiveTurn.mockReturnValue(false)
    expect(source.deliverMidTurn!('space-1', 'c1', [{ turnInput: 'report', record: { content: 'report', source: 'team-message', metadata: {} } }], () => {})).toBe(false)
    expect(h.addMessage).not.toHaveBeenCalled()
    expect(h.emitAgentEvent).not.toHaveBeenCalled()
  })

  it('returns recipient record IDs for withdrawn live inputs and retains earlier IDs without recording them again', () => {
    h.conversations.set('c1', { id: 'c1', title: 'One', updatedAt: 'x', messages: [] })
    h.addMessage.mockImplementation((_space, _conversation, record) => ({ ...record, id: 'new-input', timestamp: 'now' }))
    const withdrawn = vi.fn()
    source.deliverMidTurn!('space-1', 'c1', [
      { turnInput: 'same words', record: { content: 'same words', source: 'team-message', metadata: {} }, inputRecorded: true, recordedInputIds: ['old-input'] },
      { turnInput: 'same words', record: { content: 'same words', source: 'cross-conversation', metadata: {} } },
    ], withdrawn)
    const options = h.sendIntoLiveTurn.mock.calls[0][3] as { onWithdrawn: () => void }
    options.onWithdrawn()
    expect(withdrawn).toHaveBeenCalledWith([['old-input'], ['new-input']])
    expect(h.addMessage).toHaveBeenCalledTimes(1)
  })

  it('excludes existing redelivery and newly recorded batch IDs before the sender prepares its history', async () => {
    const conv = { id: 'c1', title: 'One', updatedAt: 'x', messages: [message('old-input', 'system', 'same words')] }
    h.conversations.set('c1', conv)
    h.addMessage.mockImplementation((_space, _conversation, record) => {
      const stored = message('last-input', record.role, record.content, record)
      conv.messages.push(stored)
      return stored
    })
    h.updateMessageById.mockImplementation((_space, _conversation, id, patch) => {
      const stored = conv.messages.find(item => item.id === id)!
      Object.assign(stored, patch)
      return stored
    })
    h.sendMessage.mockImplementationOnce(async (params, options) => {
      await Promise.resolve()
      conv.messages.push(message('current-input', 'user', params.message))
      options.onUserMessageRecorded('current-input')
      expect(options.excludedHistoryMessageIds).toEqual(['old-input', 'current-input', 'last-input'])
      expect(conv.messages.map(item => item.content)).toEqual(['same words', 'same words', 'third message'])
    })
    const outcomes = await source.dispatchBatch!('space-1', 'c1', [
      { turnInput: 'framed same words', record: { content: 'same words', source: 'team-message', metadata: {} }, inputRecorded: true, recordedInputIds: ['old-input'] },
      { turnInput: 'framed same words', record: { content: 'same words', source: 'team-message', metadata: {} } },
      { turnInput: 'framed third message', record: { content: 'third message', source: 'cross-conversation', metadata: {} } },
    ])
    expect(outcomes).toEqual([{}, { messageId: 'current-input' }, { messageId: 'last-input' }])
    expect(h.addMessage).toHaveBeenCalledTimes(1)
  })

  it('does not create another transcript opener for a batch containing only recorded inputs', async () => {
    await expect(source.dispatchBatch!('space-1', 'c1', [{ turnInput: 'held input', record: { content: 'held input', source: 'team-message', metadata: {} }, inputRecorded: true, recordedInputIds: ['held-id'] }])).rejects.toThrow('must join an existing turn')
    expect(h.sendMessage).not.toHaveBeenCalled()
  })

  it('marks every record opening a batch as input to the following turn', async () => {
    const conv = { id: 'c1', title: 'One', updatedAt: 'x', messages: [] as FakeMessage[] }
    h.conversations.set('c1', conv)
    h.sendMessage.mockImplementationOnce(async (_params, options) => {
      await Promise.resolve()
      conv.messages.push(message('opener', 'user', 'first\n\nsecond'))
      options.onUserMessageRecorded('opener')
      expect(options.excludedHistoryMessageIds).toEqual(['opener', 'second'])
    })
    h.addMessage.mockImplementation((_space, _conversation, record) => ({ ...record, id: 'second', timestamp: 'now' }))
    await source.dispatchBatch!('space-1', 'c1', ['first', 'second'].map(content => ({
      turnInput: content, record: { content, source: 'team-message', metadata: { teamId: 'team' } },
    })))
    expect(h.updateMessageById).toHaveBeenCalledWith('space-1', 'c1', 'opener', expect.objectContaining({ metadata: { teamId: 'team', inputMode: 'turn' } }))
    expect(h.addMessage).toHaveBeenCalledWith('space-1', 'c1', expect.objectContaining({ metadata: { teamId: 'team', inputMode: 'turn' } }))
  })

  describe('dispatch', () => {
    const dispatched: DispatchedMessage = { turnInput: 'framed words', record: { content: 'raw words', source: 'cross-conversation', metadata: { fromConversationId: 'z' } } }

    it('runs the ordinary send with the framed text, then rewrites the persisted message into the recorded shape', async () => {
      const conv = { id: 'c1', title: 'One', updatedAt: 'x', messages: [message('a', 'user', 'earlier')] }
      h.conversations.set('c1', conv)
      h.sendMessage.mockImplementationOnce(async (_params, options) => {
        await Promise.resolve()
        conv.messages.push(message('new', 'user', 'framed words', { metadata: { goal: 'keep' } }))
        options.onUserMessageRecorded('new')
      })

      const outcome = await source.dispatch('space-1', 'c1', dispatched)

      expect(h.sendMessage).toHaveBeenCalledWith({ spaceId: 'space-1', conversationId: 'c1', message: 'framed words' }, expect.objectContaining({ onUserMessageRecorded: expect.any(Function) }))
      expect(h.updateMessageById).toHaveBeenCalledWith('space-1', 'c1', 'new', {
        content: 'raw words',
        role: 'system',
        source: 'cross-conversation',
        metadata: { goal: 'keep', fromConversationId: 'z' },
      })
      expect(outcome).toEqual({ messageId: 'new' })
    })

    it('patches only the reported ID after awaited preparation, even beside an identical user input', async () => {
      const conv = { id: 'c1', title: 'One', updatedAt: 'x', messages: [] as FakeMessage[] }
      h.conversations.set('c1', conv)
      h.sendMessage.mockImplementationOnce(async (_params, options) => {
        await Promise.resolve()
        conv.messages.push(message('early', 'assistant', 'streamed first'))
        conv.messages.push(message('identical-other', 'user', 'framed words'))
        conv.messages.push(message('new', 'user', 'framed words'))
        options.onUserMessageRecorded('new')
      })

      expect(await source.dispatch('space-1', 'c1', dispatched)).toEqual({ messageId: 'new' })
      expect(h.updateMessageById).toHaveBeenCalledWith('space-1', 'c1', 'new', expect.anything())
      expect(h.updateMessageById).toHaveBeenCalledTimes(1)
    })

    it('never rewrites some other message when the delivered one cannot be found, and says so', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const conv = { id: 'c1', title: 'One', updatedAt: 'x', messages: [] as FakeMessage[] }
        h.conversations.set('c1', conv)
        h.sendMessage.mockImplementationOnce(async (_params, options) => {
          conv.messages.push(message('other', 'user', 'a different user message'))
          options.onUserMessageRecorded('missing-id')
        })

        expect(await source.dispatch('space-1', 'c1', dispatched)).toEqual({})
        expect(h.updateMessageById).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('delivery patch missed'))
      } finally {
        warn.mockRestore()
      }
    })

    it('rejects when the send cannot start', async () => {
      h.conversations.set('c1', { id: 'c1', title: 'One', updatedAt: 'x', messages: [] })
      h.sendMessage.mockRejectedValueOnce(new Error('spawn failed'))
      await expect(source.dispatch('space-1', 'c1', dispatched)).rejects.toThrow('spawn failed')
    })
  })
})
