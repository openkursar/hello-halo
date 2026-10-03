/**
 * Which conversations the chat store asks main to stream in full: a turn sent
 * from this window is held until it ends, and detail events for a
 * conversation nobody retains do not create session state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'

const holders = vi.hoisted(() => new Map<string, number>())
const apiMock = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getConversation: vi.fn(),
  getSessionState: vi.fn(),
  taskMarkUnseen: vi.fn(() => Promise.resolve()),
  retainConversationDetail: vi.fn((id: string) => {
    holders.set(id, (holders.get(id) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (holders.get(id) ?? 1) - 1
      if (left > 0) holders.set(id, left)
      else holders.delete(id)
    }
  }),
  isConversationDetailRetained: vi.fn((id: string) => holders.has(id)),
}))

vi.mock('../../../../src/renderer/api', () => ({ api: apiMock }))
vi.mock('../../../../src/renderer/services/canvas-lifecycle', () => ({
  canvasLifecycle: { getIsOpen: () => false, getTabCount: () => 0, getTabs: () => [], getActiveTabId: () => null, getActiveTab: () => null },
}))
vi.mock('../../../../src/renderer/stores/team.store', () => ({ isRemoteMemberAppId: () => false }))
vi.mock('../../../../src/renderer/stores/goal.store', () => ({ useGoalStore: { getState: () => ({ forget: () => {} }) } }))
vi.mock('../../../../src/renderer/stores/goal-ui.store', () => ({ useGoalUiStore: { getState: () => ({ forget: () => {} }) } }))
vi.mock('../../../../src/renderer/i18n', () => ({
  default: { t: (text: string) => text },
  useTranslation: () => ({ t: (text: string) => text }),
}))

import { createGettersSlice } from '../../../../src/renderer/stores/chat/getters'
import { createConversationsSlice } from '../../../../src/renderer/stores/chat/conversations'
import { createMessagingSlice } from '../../../../src/renderer/stores/chat/messaging'
import { createAgentEventsSlice } from '../../../../src/renderer/stores/chat/agent-events'
import { createSessionSlice } from '../../../../src/renderer/stores/chat/session'
import { createAppChatSelectionSlice } from '../../../../src/renderer/stores/chat/app-chat-selection'
import type { ChatState } from '../../../../src/renderer/stores/chat/internal'
import type { Conversation, ConversationMeta } from '../../../../src/renderer/types'

const SPACE = 'space-1'
const ON_SCREEN = 'c1'
const BACKGROUND = 'app-chat:someone:team:t1:e1'

function makeStore() {
  const meta = { id: ON_SCREEN, spaceId: SPACE, title: 'Chat' } as ConversationMeta
  const conversation = { id: ON_SCREEN, spaceId: SPACE, title: 'Chat', messages: [] } as unknown as Conversation
  return create<ChatState>((set, get) => ({
    spaceStates: new Map([[SPACE, { conversations: [meta], currentConversationId: ON_SCREEN }]]),
    conversationCache: new Map([[ON_SCREEN, conversation]]),
    sessions: new Map(),
    sessionInitInfo: new Map(),
    unseenCompletions: new Map(),
    pulseReadAt: new Map(),
    composerDrafts: new Map(),
    conversationLoadErrors: new Map(),
    currentSpaceId: SPACE,
    isLoadingConversation: false,
    ...createGettersSlice(set as never, get as never),
    ...createConversationsSlice(set as never, get as never),
    ...createMessagingSlice(set as never, get as never),
    ...createAgentEventsSlice(set as never, get as never),
    ...createSessionSlice(set as never, get as never),
    ...createAppChatSelectionSlice(set as never, get as never),
  }) as unknown as ChatState)
}

beforeEach(() => {
  vi.clearAllMocks()
  holders.clear()
  apiMock.sendMessage.mockResolvedValue({ success: true })
  apiMock.getSessionState.mockResolvedValue({ success: true, data: { isActive: false, thoughts: [] } })
  apiMock.getConversation.mockResolvedValue({
    success: true,
    data: { id: ON_SCREEN, spaceId: SPACE, title: 'Chat', messages: [] },
  })
  Object.defineProperty(globalThis, 'document', { value: { hasFocus: () => true }, configurable: true })
})

describe('detail events for conversations nobody retains', () => {
  it('create no session state', () => {
    const store = makeStore()
    const base = { spaceId: SPACE, conversationId: BACKGROUND }
    store.getState().handleAgentMessage({ ...base, delta: 'hi', isComplete: false, isStreaming: true } as never)
    store.getState().handleAgentThought({ ...base, thought: { id: 't1', type: 'thinking', content: '', timestamp: '' } } as never)
    store.getState().handleAgentToolCall({ ...base, id: 'tool-1', name: 'Bash' } as never)
    store.getState().handleAgentCompact({ ...base, trigger: 'auto', preTokens: 1 } as never)
    store.getState().handleAgentSessionInfo({ ...base, slashCommands: [], skills: [], agents: [] } as never)
    expect(store.getState().sessions.has(BACKGROUND)).toBe(false)
    expect(store.getState().sessionInitInfo.has(BACKGROUND)).toBe(false)
  })

  it('except a tool approval request, which blocks the turn until answered', () => {
    const store = makeStore()
    store.getState().handleAgentToolCall({ spaceId: SPACE, conversationId: BACKGROUND, id: 'tool-1', name: 'Bash', requiresApproval: true } as never)
    expect(store.getState().sessions.get(BACKGROUND)?.pendingToolApproval?.id).toBe('tool-1')
  })

  it('still update a conversation the store already tracks', () => {
    const store = makeStore()
    store.getState().handleAgentTurnStart({ spaceId: SPACE, conversationId: BACKGROUND } as never)
    store.getState().handleAgentMessage({ spaceId: SPACE, conversationId: BACKGROUND, delta: 'hi', isComplete: false } as never)
    expect(store.getState().sessions.get(BACKGROUND)?.streamingContent).toBe('hi')
  })

  it('are accepted for a retained conversation', () => {
    const store = makeStore()
    const release = apiMock.retainConversationDetail(BACKGROUND)
    store.getState().handleAgentMessage({ spaceId: SPACE, conversationId: BACKGROUND, delta: 'hi', isComplete: false } as never)
    expect(store.getState().sessions.get(BACKGROUND)?.streamingContent).toBe('hi')
    release()
  })
})

describe('a turn sent from this window', () => {
  it('keeps its detail streaming until the turn has settled', async () => {
    const store = makeStore()
    await store.getState().sendMessage('hello')
    expect(holders.has(ON_SCREEN)).toBe(true)

    await store.getState().handleAgentComplete({ spaceId: SPACE, conversationId: ON_SCREEN })
    expect(holders.has(ON_SCREEN)).toBe(false)
  })

  it('releases the hold when the turn fails', async () => {
    const store = makeStore()
    await store.getState().sendMessage('hello')
    store.getState().handleAgentError({ spaceId: SPACE, conversationId: ON_SCREEN, error: 'boom' })
    expect(holders.has(ON_SCREEN)).toBe(false)
  })

  it('releases the hold when main refuses the message', async () => {
    apiMock.sendMessage.mockResolvedValue({ success: false, error: 'refused' })
    const store = makeStore()
    expect(await store.getState().sendMessage('hello')).toBe(false)
    expect(holders.has(ON_SCREEN)).toBe(false)
  })

  it('keeps the hold for a turn sent while the previous one was settling', async () => {
    const store = makeStore()
    await store.getState().sendMessage('first')
    let finishRead!: (value: unknown) => void
    apiMock.getConversation.mockReturnValueOnce(new Promise(resolve => { finishRead = resolve }))
    const completing = store.getState().handleAgentComplete({ spaceId: SPACE, conversationId: ON_SCREEN })
    await store.getState().sendMessage('second')
    finishRead({ success: true, data: { id: ON_SCREEN, spaceId: SPACE, title: 'Chat', messages: [] } })
    await completing
    expect(holders.has(ON_SCREEN)).toBe(true)
  })
})
