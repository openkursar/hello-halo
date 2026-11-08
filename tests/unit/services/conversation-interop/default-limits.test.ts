/**
 * Pins the production circuit-breaker defaults. They are the last-resort stop
 * for a runaway loop (e.g. a model bug), not pace control: ordinary traffic
 * must pass. A test that trips at the old caps by construction is the negative
 * control for this product decision.
 *
 * The conversation side runs the real delivery path with the real breaker
 * defaults; the team side is in message-bus.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  source?: string
  metadata?: Record<string, unknown>
}
interface FakeConversation {
  id: string
  spaceId: string
  title: string
  messages: FakeMessage[]
}

const { store, sendMessage, sendIntoLiveTurn, isNativeConversationBusy, hasLiveNativeSession } = vi.hoisted(() => {
  const store = new Map<string, FakeConversation>()
  let nextMessageId = 0
  const sendMessage = vi.fn(async (params: { spaceId: string; conversationId: string; message: string }, internal?: { onUserMessageRecorded?: (id: string) => void }) => {
    await Promise.resolve()
    const conv = store.get(params.conversationId)
    if (!conv) throw new Error('conversation not found')
    const id = `msg-${nextMessageId++}`
    conv.messages.push({ id, role: 'user', content: params.message })
    internal?.onUserMessageRecorded?.(id)
  })
  const isNativeConversationBusy = vi.fn((_conversationId: string) => false)
  const hasLiveNativeSession = vi.fn((_conversationId: string) => true)
  return { store, sendMessage, sendIntoLiveTurn: vi.fn((_conversationId: string, _text: string) => false), isNativeConversationBusy, hasLiveNativeSession }
})

function seed(id: string, title: string): FakeConversation {
  const conv: FakeConversation = { id, spaceId: 'space-1', title, messages: [] }
  store.set(id, conv)
  return conv
}

vi.mock('../../../../src/main/services/agent/send-message', () => ({ sendMessage }))
vi.mock('../../../../src/main/services/agent', async () => ({
  hasPendingSessionInput: () => false,
  onAgentEvent: (await import('../../../../src/main/services/agent/events')).onAgentEvent,
  emitAgentEvent: (await import('../../../../src/main/services/agent/events')).emitAgentEvent,
  sendIntoLiveTurn,
  sendMessage: (await import('../../../../src/main/services/agent/send-message')).sendMessage,
}))
vi.mock('../../../../src/main/services/conversation.service', () => ({
  getConversation: (_spaceId: string, id: string) => store.get(id) ?? null,
  updateMessageById: (_spaceId: string, id: string, messageId: string, patch: Partial<FakeMessage>) => {
    const conv = store.get(id)
    if (!conv) return null
    const index = conv.messages.findIndex((m) => m.id === messageId)
    if (index === -1) return null
    conv.messages[index] = { ...conv.messages[index], ...patch }
    return conv.messages[index]
  },
  addMessage: (_spaceId: string, id: string, message: Omit<FakeMessage, 'id'>) => {
    const conv = store.get(id)
    if (!conv) throw new Error('conversation not found')
    const withId = { id: `notice-${conv.messages.length}`, ...message }
    conv.messages.push(withId)
    return withId
  },
}))
vi.mock('../../../../src/main/services/conversation-interop/busy', () => ({ isNativeConversationBusy, hasLiveNativeSession }))

import {
  deliverToConversation,
  releaseConversationTurn,
  drainConversationTurn,
} from '../../../../src/main/services/conversation-interop/delivery'
import { registerConversationSource } from '../../../../src/main/services/conversation-interop/source'
import { createChatConversationSource } from '../../../../src/main/services/conversation-interop/chat-source'

registerConversationSource(createChatConversationSource())

describe('production circuit-breaker defaults', () => {
  beforeEach(() => {
    store.clear()
    sendMessage.mockClear()
    sendIntoLiveTurn.mockReset().mockReturnValue(false)
    isNativeConversationBusy.mockReturnValue(false)
    hasLiveNativeSession.mockReturnValue(true)
  })

  it('delivers 100 messages along the same pair within one window', async () => {
    seed('pin-src', 'Source')
    const target = seed('pin-tgt', 'Target')

    for (let i = 0; i < 100; i++) {
      expect(await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'pin-src',
        toConversationId: 'pin-tgt',
        message: `m-${i}`,
        summary: 's',
      })).toMatchObject({ ok: true, status: 'delivered' })

      // Free the target until the next send, so this measures the breaker and
      // not the mailbox cap.
      await releaseConversationTurn('pin-tgt')
      drainConversationTurn('pin-tgt')
    }

    expect(target.messages).toHaveLength(100)
  })
})
