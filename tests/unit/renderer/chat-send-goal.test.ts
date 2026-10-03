/**
 * Sending with a goal: the goal rides on the request and on the optimistic
 * bubble, and a message main refuses before recording it, or that fails in
 * transport, is withdrawn so the composer can hand the text back instead of
 * spinning forever.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { create } from 'zustand'
import type { Conversation, ConversationMeta } from '../../../src/renderer/types'

const apiMock = vi.hoisted(() => ({ sendMessage: vi.fn(), retainConversationDetail: vi.fn(() => () => {}), isConversationDetailRetained: vi.fn(() => true) }))
vi.mock('../../../src/renderer/api', () => ({ api: apiMock }))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({
  canvasLifecycle: { getIsOpen: () => false, getTabCount: () => 0 },
}))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (text: string) => text } }))

import { createMessagingSlice } from '../../../src/renderer/stores/chat/messaging'
import { createGettersSlice } from '../../../src/renderer/stores/chat/getters'
import type { ChatState } from '../../../src/renderer/stores/chat/internal'

const conversation = {
  id: 'c', spaceId: 's', title: 'Chat', createdAt: 't', updatedAt: 't', messageCount: 0, messages: [], engineId: 'halo',
} as unknown as Conversation
const meta = { id: 'c', spaceId: 's', title: 'Chat', createdAt: 't', updatedAt: 't', messageCount: 0 } as ConversationMeta

function buildStore() {
  const base = {
    spaceStates: new Map([['s', { conversations: [meta], currentConversationId: 'c' }]]),
    conversationCache: new Map([['c', conversation]]),
    sessions: new Map(),
    currentSpaceId: 's',
  } as unknown as ChatState
  type Store = ChatState
  return create<Store>((set, get) => ({
    ...base,
    ...createMessagingSlice(set as never, get as never),
    ...createGettersSlice(set as never, get as never),
  }) as Store)
}

const goal = { objective: 'Ship it', doneWhen: ['Tests pass'] }

describe('sendMessage with a goal', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('sends the goal and marks the optimistic bubble with it', async () => {
    apiMock.sendMessage.mockResolvedValueOnce({ success: true })
    const store = buildStore()

    expect(await store.getState().sendMessage('Ship it\n- Tests pass', undefined, true, { goal })).toBe(true)
    expect(apiMock.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ goal, message: 'Ship it\n- Tests pass' }))
    const messages = store.getState().conversationCache.get('c')!.messages
    expect(messages.at(-1)?.metadata?.goal).toEqual(goal)
    expect(store.getState().sessions.get('c')?.isGenerating).toBe(true)
  })

  it('withdraws a refused message and stops generating', async () => {
    apiMock.sendMessage.mockResolvedValueOnce({ success: false, error: 'The active agent engine does not support goals' })
    const store = buildStore()

    expect(await store.getState().sendMessage('Ship it', undefined, true, { goal })).toBe(false)
    expect(store.getState().conversationCache.get('c')!.messages).toHaveLength(0)
    expect(store.getState().sessions.get('c')?.isGenerating).toBe(false)
    expect(store.getState().spaceStates.get('s')!.conversations[0].messageCount).toBe(0)
    // The goal composer reports this failure itself.
    expect(store.getState().sessions.get('c')?.error).toBeNull()
  })

  it('withdraws a refused ordinary message and shows that it failed', async () => {
    apiMock.sendMessage.mockResolvedValueOnce({ success: false, error: 'Conversation not found' })
    const store = buildStore()

    expect(await store.getState().sendMessage('hello')).toBe(false)
    expect(store.getState().conversationCache.get('c')!.messages).toHaveLength(0)
    expect(store.getState().sessions.get('c')?.isGenerating).toBe(false)
    expect(store.getState().sessions.get('c')?.error).toBe('Failed to send message')
  })

  it('reports a goal send that throws as not sent, and withdraws its bubble', async () => {
    apiMock.sendMessage.mockRejectedValueOnce(new Error('transport closed'))
    const store = buildStore()

    expect(await store.getState().sendMessage('Ship it', undefined, true, { goal })).toBe(false)
    expect(store.getState().conversationCache.get('c')!.messages).toHaveLength(0)
    expect(store.getState().sessions.get('c')?.isGenerating).toBe(false)
    expect(store.getState().spaceStates.get('s')!.conversations[0].messageCount).toBe(0)
    // The goal path reports the failure itself; no second, inline error.
    expect(store.getState().sessions.get('c')?.error).toBeNull()
  })

  it('keeps the bubble of an ordinary send that throws', async () => {
    apiMock.sendMessage.mockRejectedValueOnce(new Error('transport closed'))
    const store = buildStore()

    expect(await store.getState().sendMessage('hello')).toBe(true)
    expect(store.getState().conversationCache.get('c')!.messages).toHaveLength(1)
    expect(store.getState().sessions.get('c')?.error).toBe('Failed to send message')
  })

  it('sends no goal field for an ordinary message', async () => {
    apiMock.sendMessage.mockResolvedValueOnce({ success: true })
    const store = buildStore()

    await store.getState().sendMessage('hello')
    expect(apiMock.sendMessage.mock.calls[0][0]).not.toHaveProperty('goal')
    expect(store.getState().conversationCache.get('c')!.messages[0].metadata).toBeUndefined()
  })
})
