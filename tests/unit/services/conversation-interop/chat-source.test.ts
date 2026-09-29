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
  return { conversations, addMessage, updateMessageById, sendMessage }
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

  describe('dispatch', () => {
    const dispatched: DispatchedMessage = { turnInput: 'framed words', record: { content: 'raw words', source: 'cross-conversation', metadata: { fromConversationId: 'z' } } }

    it('runs the ordinary send with the framed text, then rewrites the persisted message into the recorded shape', async () => {
      const conv = { id: 'c1', title: 'One', updatedAt: 'x', messages: [message('a', 'user', 'earlier')] }
      h.conversations.set('c1', conv)
      h.sendMessage.mockImplementationOnce(async () => {
        conv.messages.push(message('new', 'user', 'framed words', { metadata: { goal: 'keep' } }))
      })

      const outcome = await source.dispatch('space-1', 'c1', dispatched)

      expect(h.sendMessage).toHaveBeenCalledWith({ spaceId: 'space-1', conversationId: 'c1', message: 'framed words' })
      expect(h.updateMessageById).toHaveBeenCalledWith('space-1', 'c1', 'new', {
        content: 'raw words',
        role: 'system',
        source: 'cross-conversation',
        metadata: { goal: 'keep', fromConversationId: 'z' },
      })
      expect(outcome).toEqual({ messageId: 'new' })
    })

    it('finds the delivered message even when the running turn appended something before it', async () => {
      const conv = { id: 'c1', title: 'One', updatedAt: 'x', messages: [] as FakeMessage[] }
      h.conversations.set('c1', conv)
      h.sendMessage.mockImplementationOnce(async () => {
        conv.messages.push(message('early', 'assistant', 'streamed first'))
        conv.messages.push(message('new', 'user', 'framed words'))
      })

      expect(await source.dispatch('space-1', 'c1', dispatched)).toEqual({ messageId: 'new' })
      expect(h.updateMessageById).toHaveBeenCalledWith('space-1', 'c1', 'new', expect.anything())
    })

    it('never rewrites some other message when the delivered one cannot be found, and says so', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const conv = { id: 'c1', title: 'One', updatedAt: 'x', messages: [] as FakeMessage[] }
        h.conversations.set('c1', conv)
        h.sendMessage.mockImplementationOnce(async () => {
          conv.messages.push(message('other', 'user', 'a different user message'))
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
