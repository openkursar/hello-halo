/**
 * The sidebar shows the first-message title as soon as the message is sent,
 * not after the turn ends, and never over a name the user chose.
 */

import { it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'
import type { Conversation, ConversationMeta } from '../../../src/renderer/types'

const apiMock = vi.hoisted(() => ({ sendMessage: vi.fn(), updateConversation: vi.fn(), retainConversationDetail: vi.fn(() => () => {}), isConversationDetailRetained: vi.fn(() => true) }))
vi.mock('../../../src/renderer/api', () => ({ api: apiMock }))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({
  canvasLifecycle: new Proxy({ getIsOpen: () => false, getTabCount: () => 0, getTabs: () => [] } as Record<string, unknown>, {
    get: (target, key: string) => target[key] ?? (() => () => {}),
  }),
}))
vi.mock('../../../src/renderer/i18n', () => ({
  default: { t: (text: string) => text, on: () => {}, off: () => {}, language: 'en' },
}))

import { createMessagingSlice } from '../../../src/renderer/stores/chat/messaging'
import { createConversationsSlice } from '../../../src/renderer/stores/chat/conversations'
import { createGettersSlice } from '../../../src/renderer/stores/chat/getters'
import type { ChatState } from '../../../src/renderer/stores/chat/internal'

const PLACEHOLDER = 'Chat 9-27 16:06'

function makeStore(overrides: Partial<ConversationMeta> = {}) {
  const meta = { id: 'c', spaceId: 's', title: PLACEHOLDER, createdAt: 't', updatedAt: 't', messageCount: 0, ...overrides } as ConversationMeta
  const conversation = { ...meta, messages: [] } as unknown as Conversation
  return create<ChatState>((set, get) => ({
    spaceStates: new Map([['s', { conversations: [meta], currentConversationId: 'c' }]]),
    conversationCache: new Map([['c', conversation]]),
    sessions: new Map(),
    currentSpaceId: 's',
    ...createMessagingSlice(set as never, get as never),
    ...createConversationsSlice(set as never, get as never),
    ...createGettersSlice(set as never, get as never),
  }) as unknown as ChatState)
}

const titles = (store: ReturnType<typeof makeStore>) => ({
  list: store.getState().spaceStates.get('s')!.conversations[0].title,
  cache: store.getState().conversationCache.get('c')!.title,
})

beforeEach(() => {
  apiMock.sendMessage.mockReset()
  apiMock.updateConversation.mockReset()
})

it('titles the conversation from its first message before the reply arrives', async () => {
  let observed: ReturnType<typeof titles> | undefined
  const store = makeStore()
  apiMock.sendMessage.mockImplementationOnce(async () => {
    observed = titles(store)
    return { success: true }
  })

  await store.getState().sendMessage('Why is the sidebar title late?')

  expect(observed).toEqual({ list: 'Why is the sidebar title late?', cache: 'Why is the sidebar title late?' })
  expect(titles(store)).toEqual(observed)
  expect(store.getState().conversationCache.get('c')!.messages).toHaveLength(1)
})

it('leaves a renamed conversation alone', async () => {
  apiMock.sendMessage.mockResolvedValueOnce({ success: true })
  const store = makeStore({ titleCustomized: true, title: 'My name' })

  await store.getState().sendMessage('first message')

  expect(titles(store)).toEqual({ list: 'My name', cache: 'My name' })
})

it('does not retitle on later messages', async () => {
  apiMock.sendMessage.mockResolvedValueOnce({ success: true })
  const store = makeStore({ messageCount: 2, title: 'Earlier title' })

  await store.getState().sendMessage('another message')

  expect(titles(store).list).toBe('Earlier title')
})

it('restores the placeholder when main refuses the first message', async () => {
  apiMock.sendMessage.mockResolvedValueOnce({ success: false, error: 'Network error' })
  const store = makeStore()

  await store.getState().sendMessage('refused message')

  expect(titles(store)).toEqual({ list: PLACEHOLDER, cache: PLACEHOLDER })
  expect(store.getState().conversationCache.get('c')!.messages).toHaveLength(0)
  expect(store.getState().spaceStates.get('s')!.conversations[0].messageCount).toBe(0)
})

it('keeps a successful manual rename when the pending first send is refused', async () => {
  let refuseSend!: (result: { success: false; error: string }) => void
  apiMock.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { refuseSend = resolve }))
  apiMock.updateConversation.mockResolvedValueOnce({ success: true })
  const store = makeStore()

  const send = store.getState().sendMessage('first message')
  expect(titles(store)).toEqual({ list: 'first message', cache: 'first message' })
  expect(await store.getState().renameConversation('s', 'c', 'My renamed title')).toBe(true)
  expect(apiMock.updateConversation).toHaveBeenCalledWith('s', 'c', { title: 'My renamed title' })
  refuseSend({ success: false, error: 'Network error' })
  expect(await send).toBe(false)

  expect(titles(store)).toEqual({ list: 'My renamed title', cache: 'My renamed title' })
  expect(store.getState().spaceStates.get('s')!.conversations[0].titleCustomized).toBe(true)
  expect(store.getState().conversationCache.get('c')!.titleCustomized).toBe(true)
  expect(store.getState().conversationCache.get('c')!.messages).toHaveLength(0)
  expect(store.getState().spaceStates.get('s')!.conversations[0].messageCount).toBe(0)
})

it('keeps a manual rename when a pending goal send throws', async () => {
  let rejectSend!: (error: Error) => void
  apiMock.sendMessage.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSend = reject }))
  apiMock.updateConversation.mockResolvedValueOnce({ success: true })
  const store = makeStore()

  const send = store.getState().sendMessage('first message', undefined, true, {
    goal: { objective: 'Complete the task', doneWhen: ['Done'] },
  })
  expect(await store.getState().renameConversation('s', 'c', 'My renamed title')).toBe(true)
  rejectSend(new Error('transport closed'))
  expect(await send).toBe(false)

  expect(titles(store)).toEqual({ list: 'My renamed title', cache: 'My renamed title' })
  expect(store.getState().conversationCache.get('c')!.messages).toHaveLength(0)
  expect(store.getState().spaceStates.get('s')!.conversations[0].messageCount).toBe(0)
})
