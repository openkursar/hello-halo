/**
 * A new conversation is named in the UI language until its first message
 * names it; main only knows the system locale, so the renderer supplies it.
 */

import { it, expect, vi } from 'vitest'
import { create } from 'zustand'
import type { Conversation } from '../../../src/renderer/types'

const apiMock = vi.hoisted(() => ({
  createConversation: vi.fn(),
  ensureSessionWarm: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../../src/renderer/api', () => ({ api: apiMock }))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({
  canvasLifecycle: { hideAllBrowserViews: vi.fn() },
}))
vi.mock('../../../src/renderer/i18n', () => ({
  default: {
    t: (text: string, values?: Record<string, string>) =>
      text === 'Chat {{time}}' ? `对话 ${values?.time}` : text,
    on: () => {}, off: () => {}, language: 'zh-CN',
  },
}))

import { createConversationsSlice } from '../../../src/renderer/stores/chat/conversations'
import type { ChatState } from '../../../src/renderer/stores/chat/internal'

it('names a new conversation with the date and time in the UI language, as an auto title', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 4, 9, 5))
  apiMock.createConversation.mockResolvedValue({
    success: true,
    data: { id: 'c', spaceId: 's', title: '对话 11-4 9:05', createdAt: 't', updatedAt: 't', messageCount: 0, messages: [] } as unknown as Conversation,
  })
  const store = create<ChatState>((set, get) => ({
    spaceStates: new Map([['s', { conversations: [], currentConversationId: null }]]),
    conversationCache: new Map(),
    sessions: new Map(),
    currentSpaceId: 's',
    ...createConversationsSlice(set as never, get as never),
  }) as unknown as ChatState)

  await store.getState().createConversation('s')

  // No keepTitle: the first message still replaces it.
  expect(apiMock.createConversation).toHaveBeenCalledWith('s', '对话 11-4 9:05', undefined)
  vi.useRealTimers()
})
