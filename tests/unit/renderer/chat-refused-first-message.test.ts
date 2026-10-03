/**
 * A first message the main process refuses leaves the conversation without
 * messages. The error must still reach the screen: the conversation shows the
 * message list (not the empty state), and the list draws the error.
 */

import { it, expect, vi } from 'vitest'
import { create } from 'zustand'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Conversation, ConversationMeta } from '../../../src/renderer/types'

const apiMock = vi.hoisted(() => ({ sendMessage: vi.fn(), retainConversationDetail: vi.fn(() => () => {}), isConversationDetailRetained: vi.fn(() => true) }))
vi.mock('../../../src/renderer/api', () => ({ api: apiMock }))
// Module-load subscribers elsewhere in the import graph only need callable stubs.
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({
  canvasLifecycle: new Proxy({ getIsOpen: () => false, getTabCount: () => 0, getTabs: () => [] } as Record<string, unknown>, {
    get: (target, key: string) => target[key] ?? (() => () => {}),
  }),
}))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string) => text }),
  getCurrentLanguage: () => 'en',
  default: { t: (text: string) => text, on: () => {}, off: () => {}, language: 'en' },
}))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: (select: any) => select({ apps: [] }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: (select: any) => select({ sessions: new Map() }) }))

import { createMessagingSlice } from '../../../src/renderer/stores/chat/messaging'
import { createGettersSlice } from '../../../src/renderer/stores/chat/getters'
import type { ChatState } from '../../../src/renderer/stores/chat/internal'
import { showsMessageList } from '../../../src/renderer/components/chat/conversation-body'
import { MessageList } from '../../../src/renderer/components/chat/MessageList'

const conversation = {
  id: 'c', spaceId: 's', title: 'Chat', createdAt: 't', updatedAt: 't', messageCount: 0, messages: [], engineId: 'anthropic',
} as unknown as Conversation
const meta = { id: 'c', spaceId: 's', title: 'Chat', createdAt: 't', updatedAt: 't', messageCount: 0 } as ConversationMeta

it('shows the error of a refused first message in an empty conversation', async () => {
  apiMock.sendMessage.mockResolvedValueOnce({ success: false, error: 'Network error' })
  const store = create<ChatState>((set, get) => ({
    spaceStates: new Map([['s', { conversations: [meta], currentConversationId: 'c' }]]),
    conversationCache: new Map([['c', conversation]]),
    sessions: new Map(),
    currentSpaceId: 's',
    ...createMessagingSlice(set as never, get as never),
    ...createGettersSlice(set as never, get as never),
  }) as unknown as ChatState)

  expect(await store.getState().sendMessage('hello')).toBe(false)

  const messages = store.getState().conversationCache.get('c')!.messages
  const session = store.getState().sessions.get('c')!
  expect(messages).toHaveLength(0)
  expect(showsMessageList({ messageCount: messages.length, hasStreamingContent: false, isThinking: false, error: session.error })).toBe(true)

  const html = renderToStaticMarkup(createElement(MessageList as any, {
    conversationId: 'c',
    messages,
    streamingContent: '',
    isGenerating: session.isGenerating,
    isStreaming: false,
    thoughts: [],
    isThinking: false,
    compactInfo: null,
    error: session.error,
    errorType: session.errorType ?? null,
    isCompact: false,
    textBlockVersion: 0,
  }))
  expect(html).toContain('Failed to send message')
})

it('keeps the empty state for a conversation with nothing to show', () => {
  expect(showsMessageList({ messageCount: 0, hasStreamingContent: false, isThinking: false, error: null })).toBe(false)
})
