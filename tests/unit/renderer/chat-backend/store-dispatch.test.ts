/**
 * The chat store over both kinds of conversation: one set of verbs, dispatched
 * by where the conversation lives. Exercised on the real slices with only the
 * transport mocked, so what is asserted is what the page would observe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'

const apiMock = vi.hoisted(() => ({
  appChatTranscript: vi.fn(),
  appChatMessageThoughts: vi.fn(),
  appChatSend: vi.fn(),
  appChatStop: vi.fn(),
  appChatInject: vi.fn(),
  appChatClear: vi.fn(),
  appSessionDelete: vi.fn(),
  getSessionState: vi.fn(),
  subscribeToConversation: vi.fn(),
  sendMessage: vi.fn(),
  stopGeneration: vi.fn(),
  injectMessage: vi.fn(),
  getConversation: vi.fn(),
  getMessageThoughts: vi.fn(),
  ensureSessionWarm: vi.fn(() => Promise.resolve()),
  taskMarkUnseen: vi.fn(() => Promise.resolve()),
  taskMarkRead: vi.fn(() => Promise.resolve()),
  listConversations: vi.fn(),
}))

vi.mock('../../../../src/renderer/api', () => ({ api: apiMock }))
vi.mock('../../../../src/renderer/services/canvas-lifecycle', () => ({
  canvasLifecycle: {
    getIsOpen: () => true,
    getTabCount: () => 1,
    getTabs: () => [{ id: 't1', type: 'terminal', title: 'zsh', terminalSessionId: 'pty-1' }],
    getActiveTabId: () => 't1',
    getActiveTab: () => ({ id: 't1', type: 'terminal', title: 'zsh', terminalSessionId: 'pty-1' }),
  },
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
import { CONVERSATION_CACHE_SIZE, createEmptySessionState } from '../../../../src/renderer/stores/chat/internal'
import type { ChatState } from '../../../../src/renderer/stores/chat/internal'
import { selectActiveConversation, selectActiveConversationId } from '../../../../src/renderer/stores/chat/active'
import { conversationKind, digitalHumanAppId } from '../../../../src/renderer/stores/chat/backend'
import { messageRowKey } from '../../../../src/renderer/utils/message-row-key'
import type { Conversation, Message } from '../../../../src/renderer/types'
import type { TranscriptPage } from '../../../../src/shared/types/transcript'

const SPACE = 'space-1'
const APP = 'app-1'
const DH = `app-chat:${APP}`
const DH_LOCAL = `app-chat:${APP}:local:direct:abc123`

function makeStore() {
  return create<ChatState>((set, get) => ({
    spaceStates: new Map([[SPACE, { conversations: [], currentConversationId: null }]]),
    conversationCache: new Map(),
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

const m = (id: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({
  id, role, content, timestamp: '2026-09-01T10:00:00.000Z', ...extra,
})

function page(messages: Message[], extra: Partial<TranscriptPage> = {}): { success: true; data: TranscriptPage } {
  return {
    success: true,
    data: { messages, hasMoreBefore: false, cursor: messages[0]?.id ?? null, total: messages.length, ...extra },
  }
}

function selectDigitalHuman(store: ReturnType<typeof makeStore>, conversationId = DH) {
  store.getState().selectAppChatConversation(SPACE, APP, conversationId)
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.getSessionState.mockResolvedValue({ success: true, data: { isActive: false, thoughts: [] } })
  apiMock.appChatSend.mockResolvedValue({ success: true, data: { conversationId: DH } })
  apiMock.appChatInject.mockResolvedValue({ success: true, data: { delivered: true } })
  apiMock.appChatClear.mockResolvedValue({ success: true })
  apiMock.appSessionDelete.mockResolvedValue({ success: true })
  apiMock.appChatMessageThoughts.mockResolvedValue({ success: true, data: [] })
  Object.defineProperty(globalThis, 'document', { value: { hasFocus: () => true }, configurable: true })
})

describe('classifying a conversation id', () => {
  it('tells apart space, chat-board digital-human and other session keys', () => {
    expect(conversationKind('7f3a-uuid')).toBe('space')
    expect(conversationKind(DH)).toBe('digital-human')
    expect(conversationKind(DH_LOCAL)).toBe('digital-human')
    expect(conversationKind(`app-chat:${APP}:wecom:direct:someone`)).toBe('virtual')
    expect(conversationKind(`app-chat:${APP}:team:t1:e1`)).toBe('virtual')
    expect(digitalHumanAppId(DH_LOCAL)).toBe(APP)
    expect(digitalHumanAppId('7f3a-uuid')).toBeNull()
  })
})

describe('the conversation on screen', () => {
  it('is the selected digital human, else the regular conversation, else nothing', () => {
    const store = makeStore()
    expect(selectActiveConversationId(store.getState())).toBeNull()

    store.setState({ spaceStates: new Map([[SPACE, { conversations: [], currentConversationId: 'c1' }]]) })
    expect(selectActiveConversationId(store.getState())).toBe('c1')

    apiMock.appChatTranscript.mockResolvedValue(page([]))
    selectDigitalHuman(store)
    expect(selectActiveConversationId(store.getState())).toBe(DH)
    // The regular pointer is kept for the way back.
    expect(store.getState().spaceStates.get(SPACE)!.currentConversationId).toBe('c1')
  })

  it('follows the cache for its conversation', () => {
    const store = makeStore()
    const conversation = { id: 'c1', spaceId: SPACE, messages: [] } as unknown as Conversation
    store.setState({
      spaceStates: new Map([[SPACE, { conversations: [], currentConversationId: 'c1' }]]),
      conversationCache: new Map([['c1', conversation]]),
    })
    expect(selectActiveConversation(store.getState())).toBe(conversation)
  })
})

describe('opening a digital-human conversation', () => {
  it('reads the newest page into the cache and subscribes remote clients', async () => {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', 'hi'), m('session-msg-2', 'assistant', 'hello')], { total: 2 }))

    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH)).toBe(true))

    expect(apiMock.appChatTranscript).toHaveBeenCalledWith({ appId: APP, spaceId: SPACE, conversationId: DH, limit: 50 })
    expect(apiMock.subscribeToConversation).toHaveBeenCalledWith(DH)
    const conversation = store.getState().conversationCache.get(DH)!
    expect(conversation.appId).toBe(APP)
    expect(conversation.messages.map(x => x.id)).toEqual(['session-msg-1', 'session-msg-2'])
  })

  it('shows a seen conversation at once and merges the re-read in place', async () => {
    const store = makeStore()
    const first = m('session-msg-1', 'user', 'hi')
    apiMock.appChatTranscript.mockResolvedValue(page([first]))
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH)).toBe(true))
    const shown = store.getState().conversationCache.get(DH)!.messages[0]

    // Come back to it: no loading, and an unchanged read leaves the row objects alone.
    apiMock.appChatTranscript.mockResolvedValue(page([{ ...first }, m('session-msg-2', 'assistant', 'written elsewhere')]))
    selectDigitalHuman(store)
    expect(store.getState().isLoadingConversation).toBe(false)
    await vi.waitFor(() => expect(store.getState().conversationCache.get(DH)!.messages).toHaveLength(2))

    expect(store.getState().conversationCache.get(DH)!.messages[0]).toBe(shown)
  })

  it('records why a read failed, and clears it when a read succeeds', async () => {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValue({ success: false, error: 'boom' })
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationLoadErrors.get(DH)).toBe('boom'))

    apiMock.appChatTranscript.mockResolvedValue(page([]))
    await store.getState().refreshConversation(DH)
    expect(store.getState().conversationLoadErrors.has(DH)).toBe(false)
  })

  it('picks up a turn that is already running', async () => {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', 'go')]))
    apiMock.getSessionState.mockResolvedValue({
      success: true,
      data: { isActive: true, thoughts: [{ id: 't1', type: 'thinking', content: 'x', timestamp: 't' }] },
    })
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().sessions.get(DH)?.isGenerating).toBe(true))
    expect(store.getState().sessions.get(DH)!.thoughts).toHaveLength(1)
  })

  it('does not list the running turn\'s partial reply beside the live stream that draws it', async () => {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', 'go'), m('session-msg-2', 'assistant', 'half a repl')]))
    apiMock.getSessionState.mockResolvedValue({
      success: true,
      data: { isActive: true, thoughts: [{ id: 't1', type: 'thinking', content: 'x', timestamp: 't' }] },
    })
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH)).toBe(true))

    expect(store.getState().sessions.get(DH)?.isGenerating).toBe(true)
    expect(store.getState().conversationCache.get(DH)!.messages.map(x => x.id)).toEqual(['session-msg-1'])
  })

  it('still shows the conversation when the running-turn lookup fails', async () => {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', 'hi')]))
    apiMock.getSessionState.mockRejectedValue(new Error('offline'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationCache.get(DH)?.messages).toHaveLength(1))
  })
})

describe('a digital-human turn', () => {
  async function opened() {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', 'earlier'), m('session-msg-2', 'assistant', 'earlier reply')]))
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH)).toBe(true))
    return store
  }

  it('sends to the digital human with the canvas context, showing the message and the turn in one commit', async () => {
    const store = await opened()
    const commits: Array<{ generating: boolean; last?: Message }> = []
    store.subscribe(state => {
      const messages = state.conversationCache.get(DH)?.messages ?? []
      commits.push({ generating: state.sessions.get(DH)?.isGenerating ?? false, last: messages[messages.length - 1] })
    })

    expect(await store.getState().sendMessage('build it')).toBe(true)

    expect(apiMock.appChatSend).toHaveBeenCalledWith(expect.objectContaining({
      appId: APP,
      spaceId: SPACE,
      conversationId: DH,
      message: 'build it',
      canvasContext: expect.objectContaining({ isOpen: true, tabCount: 1 }),
    }))
    // No commit shows the bubble without the turn, or the turn without the bubble.
    const first = commits[0]
    expect(first.generating).toBe(true)
    expect(first.last?.content).toBe('build it')
    expect(apiMock.sendMessage).not.toHaveBeenCalled()
  })

  it('withdraws the bubble and reports a refusal, so the composer can hand the draft back', async () => {
    const store = await opened()
    apiMock.appChatSend.mockResolvedValue({ success: false, error: 'no capacity' })

    expect(await store.getState().sendMessage('build it')).toBe(false)

    expect(store.getState().conversationCache.get(DH)!.messages.map(x => x.content)).toEqual(['earlier', 'earlier reply'])
    expect(store.getState().sessions.get(DH)).toMatchObject({ isGenerating: false, error: 'no capacity' })
  })

  it('finalizes in place: the reply arrives in the same commit the stream ends, and the bubble is not rebuilt', async () => {
    const store = await opened()
    await store.getState().sendMessage('build it')
    const pendingKey = messageRowKey(store.getState().conversationCache.get(DH)!.messages.at(-1)!)
    const turnId = store.getState().sessions.get(DH)!.turnId

    store.getState().handleAgentMessage({ spaceId: SPACE, conversationId: DH, content: 'working…', isComplete: false } as never)
    apiMock.appChatTranscript.mockResolvedValue(page([
      m('session-msg-1', 'user', 'earlier'), m('session-msg-2', 'assistant', 'earlier reply'),
      m('session-msg-3', 'user', 'build it'), m('session-msg-4', 'assistant', 'built'),
    ]))

    const commits: Array<{ streaming: string; generating: boolean; ids: string[] }> = []
    store.subscribe(state => commits.push({
      streaming: state.sessions.get(DH)?.streamingContent ?? '',
      generating: state.sessions.get(DH)?.isGenerating ?? false,
      ids: (state.conversationCache.get(DH)?.messages ?? []).map(x => x.id),
    }))

    await store.getState().handleAgentComplete({ spaceId: SPACE, conversationId: DH } as never)

    // The streamed text never disappears before the persisted reply is there.
    for (const commit of commits) {
      if (commit.streaming === '' && !commit.generating) expect(commit.ids).toContain('session-msg-4')
      if (commit.generating) expect(commit.streaming).toBe('working…')
    }
    const messages = store.getState().conversationCache.get(DH)!.messages
    expect(messages.map(x => x.id)).toEqual(['session-msg-1', 'session-msg-2', 'session-msg-3', 'session-msg-4'])
    expect(messageRowKey(messages[2])).toBe(pendingKey)
    expect(store.getState().sessions.get(DH)).toMatchObject({ isGenerating: false, streamingContent: '' })
    expect(store.getState().sessions.get(DH)!.turnId).toBe(turnId)
    // Digital-human chats never enter Pulse.
    expect(store.getState().unseenCompletions.size).toBe(0)
    expect(apiMock.taskMarkUnseen).not.toHaveBeenCalled()
  })

  it('does not overwrite a turn that started while the finished one was being re-read', async () => {
    const store = await opened()
    await store.getState().sendMessage('one')
    let release: (value: unknown) => void = () => {}
    apiMock.appChatTranscript.mockReturnValue(new Promise(resolve => { release = resolve }))

    const completing = store.getState().handleAgentComplete({ spaceId: SPACE, conversationId: DH } as never)
    store.getState().handleAgentTurnStart({ spaceId: SPACE, conversationId: DH } as never)
    store.getState().handleAgentMessage({ spaceId: SPACE, conversationId: DH, content: 'second turn', isComplete: false } as never)
    release(page([m('session-msg-1', 'user', 'earlier'), m('session-msg-2', 'assistant', 'earlier reply'), m('session-msg-3', 'user', 'one'), m('session-msg-4', 'assistant', 'first reply')]))
    await completing

    expect(store.getState().sessions.get(DH)).toMatchObject({ isGenerating: true, streamingContent: 'second turn' })
  })

  it('clears the streamed turn completely when the finished turn cannot be read', async () => {
    const store = await opened()
    await store.getState().sendMessage('go')
    store.getState().handleAgentThought({ spaceId: SPACE, conversationId: DH, thought: { id: 't1', type: 'thinking', content: 'x', timestamp: 't' } } as never)
    apiMock.appChatTranscript.mockRejectedValue(new Error('offline'))

    await store.getState().handleAgentComplete({ spaceId: SPACE, conversationId: DH } as never)

    expect(store.getState().sessions.get(DH)).toMatchObject({ isGenerating: false, isThinking: false, streamingContent: '', thoughts: [] })
  })

  it('holds back the partial reply of a running turn that a re-read already lists', async () => {
    const store = await opened()
    await store.getState().sendMessage('go')
    apiMock.getSessionState.mockResolvedValue({ success: true, data: { isActive: true, thoughts: [] } })
    apiMock.appChatTranscript.mockResolvedValue(page([
      m('session-msg-1', 'user', 'earlier'), m('session-msg-2', 'assistant', 'earlier reply'),
      m('session-msg-3', 'user', 'go'), m('session-msg-4', 'assistant', 'half a repl'),
    ]))

    await store.getState().refreshConversation(DH)

    const ids = store.getState().conversationCache.get(DH)!.messages.map(x => x.id)
    expect(ids).toEqual(['session-msg-1', 'session-msg-2', 'session-msg-3'])
  })

  it('settles a turn the page still thinks is running when the backend says it is over', async () => {
    const store = await opened()
    await store.getState().sendMessage('go')
    apiMock.getSessionState.mockResolvedValue({ success: true, data: { isActive: false, thoughts: [] } })
    apiMock.appChatTranscript.mockResolvedValue(page([
      m('session-msg-1', 'user', 'earlier'), m('session-msg-2', 'assistant', 'earlier reply'),
      m('session-msg-3', 'user', 'go'), m('session-msg-4', 'assistant', 'done'),
    ]))

    await store.getState().refreshConversation(DH)

    expect(store.getState().sessions.get(DH)!.isGenerating).toBe(false)
    expect(store.getState().conversationCache.get(DH)!.messages.at(-1)!.id).toBe('session-msg-4')
  })

  it('stops through the digital human and settles the session', async () => {
    const store = await opened()
    await store.getState().sendMessage('go')
    await store.getState().stopGeneration()
    expect(apiMock.appChatStop).toHaveBeenCalledWith(APP, DH)
    expect(apiMock.stopGeneration).not.toHaveBeenCalled()
    expect(store.getState().sessions.get(DH)!.isGenerating).toBe(false)
  })

  it('adds a message to the running turn and lists it as queued', async () => {
    const store = await opened()
    await store.getState().sendMessage('go')
    await store.getState().injectMessage(DH, '  also this  ')
    expect(apiMock.appChatInject).toHaveBeenCalledWith({ appId: APP, conversationId: DH, message: 'also this' })
    expect(store.getState().sessions.get(DH)!.queuedMessages).toEqual(['also this'])
  })

  it('sends the text as a new message when the turn ended before it could be added', async () => {
    const store = await opened()
    apiMock.appChatInject.mockResolvedValue({ success: true, data: { delivered: false } })

    await store.getState().injectMessage(DH, 'too late')

    expect(apiMock.appChatSend).toHaveBeenCalledWith(expect.objectContaining({ message: 'too late', conversationId: DH }))
    expect(store.getState().sessions.get(DH)!.queuedMessages).toEqual([])
  })

  it('takes a queued message back when it could not be delivered', async () => {
    const store = await opened()
    apiMock.appChatInject.mockResolvedValue({ success: false, error: 'nope' })
    await store.getState().injectMessage(DH, 'lost')
    expect(store.getState().sessions.get(DH)!.queuedMessages).toEqual([])
  })

  it('continues an interrupted reply by sending "continue" to the digital human', async () => {
    const store = await opened()
    store.getState().continueAfterInterrupt(DH)
    await vi.waitFor(() => expect(apiMock.appChatSend).toHaveBeenCalledWith(expect.objectContaining({ message: 'continue', conversationId: DH })))
  })
})

describe('older history', () => {
  it('pages older messages in front of the loaded ones, once', async () => {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValueOnce(page([m('session-msg-5', 'user', 'e'), m('session-msg-6', 'assistant', 'f')], { hasMoreBefore: true, cursor: 'session-msg-5', total: 6 }))
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH)).toBe(true))
    expect(store.getState().conversationCache.get(DH)!.earlier).toEqual({ hasMore: true, before: 'session-msg-5' })

    apiMock.appChatTranscript.mockResolvedValueOnce(page([m('session-msg-3', 'user', 'c'), m('session-msg-4', 'assistant', 'd')], { hasMoreBefore: false, cursor: 'session-msg-3', total: 6 }))
    await Promise.all([store.getState().loadEarlierMessages(DH), store.getState().loadEarlierMessages(DH)])

    expect(apiMock.appChatTranscript).toHaveBeenLastCalledWith({ appId: APP, spaceId: SPACE, conversationId: DH, before: 'session-msg-5', limit: 50 })
    expect(apiMock.appChatTranscript).toHaveBeenCalledTimes(2)
    const conversation = store.getState().conversationCache.get(DH)!
    expect(conversation.messages.map(x => x.id)).toEqual(['session-msg-3', 'session-msg-4', 'session-msg-5', 'session-msg-6'])
    expect(conversation.earlier).toEqual({ hasMore: false, before: 'session-msg-3' })
  })
})

describe('thoughts on demand', () => {
  it('loads a message\'s thoughts through the digital-human reader and keeps them', async () => {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-2', 'assistant', 'done', { thoughts: null, thoughtsSummary: { count: 1, types: { thinking: 1 } } })]))
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH)).toBe(true))
    const thoughts = [{ id: 't1', type: 'thinking', content: 'hmm', timestamp: 't' }]
    apiMock.appChatMessageThoughts.mockResolvedValue({ success: true, data: thoughts })

    expect(await store.getState().loadMessageThoughts(SPACE, DH, 'session-msg-2')).toEqual(thoughts)
    expect(apiMock.appChatMessageThoughts).toHaveBeenCalledWith({ appId: APP, spaceId: SPACE, conversationId: DH, messageId: 'session-msg-2' })
    expect(store.getState().conversationCache.get(DH)!.messages[0].thoughts).toEqual(thoughts)

    await store.getState().loadMessageThoughts(SPACE, DH, 'session-msg-2')
    expect(apiMock.appChatMessageThoughts).toHaveBeenCalledTimes(1)
  })
})

describe('clearing and deleting', () => {
  it('clears a conversation in place', async () => {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', 'a')]))
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH)).toBe(true))

    expect(await store.getState().clearConversation(DH)).toBe(true)

    expect(apiMock.appChatClear).toHaveBeenCalledWith(APP, SPACE, DH)
    expect(store.getState().conversationCache.get(DH)!.messages).toEqual([])
    expect(store.getState().sessions.get(DH)!.isGenerating).toBe(false)
  })

  it('leaves history alone when the clear is refused', async () => {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', 'a')]))
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH)).toBe(true))
    apiMock.appChatClear.mockResolvedValue({ success: false })

    expect(await store.getState().clearConversation(DH)).toBe(false)
    expect(store.getState().conversationCache.get(DH)!.messages).toHaveLength(1)
  })

  it('does not offer clearing for a space conversation', async () => {
    const store = makeStore()
    expect(await store.getState().clearConversation('7f3a-uuid')).toBe(false)
    expect(apiMock.appChatClear).not.toHaveBeenCalled()
  })

  it('deleting a local session forgets everything held for it and leaves the selection', async () => {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', 'a')]))
    selectDigitalHuman(store, DH_LOCAL)
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH_LOCAL)).toBe(true))
    store.getState().setComposerDraft(DH_LOCAL, 'unsent')
    store.setState({ sessions: new Map([[DH_LOCAL, createEmptySessionState()]]) })

    expect(await store.getState().deleteAppChatSession(APP, SPACE, DH_LOCAL)).toBe(true)

    const state = store.getState()
    expect(apiMock.appSessionDelete).toHaveBeenCalledWith(APP, SPACE, DH_LOCAL)
    expect(state.conversationCache.has(DH_LOCAL)).toBe(false)
    expect(state.sessions.has(DH_LOCAL)).toBe(false)
    expect(state.composerDrafts.has(DH_LOCAL)).toBe(false)
    expect(state.spaceStates.get(SPACE)!.selectedAppChat).toBeNull()
  })
})

describe('the cache', () => {
  it('drops digital-human conversations of a space that is reset', async () => {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', 'a')]))
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH)).toBe(true))
    store.setState({ sessions: new Map([[DH, createEmptySessionState()]]), sessionInitInfo: new Map([[DH, { slashCommands: [], skills: [], agents: [] }]]) })

    store.getState().resetSpace(SPACE)

    expect(store.getState().conversationCache.has(DH)).toBe(false)
    expect(store.getState().sessions.has(DH)).toBe(false)
    expect(store.getState().sessionInitInfo.has(DH)).toBe(false)
  })

  it('never evicts what is on screen or generating, however old', async () => {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', 'a')]))
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH)).toBe(true))
    const busy = `app-chat:${APP}:local:direct:busy`
    store.setState({
      sessions: new Map([[busy, { ...createEmptySessionState(), isGenerating: true }]]),
      conversationCache: new Map([
        [DH, store.getState().conversationCache.get(DH)!],
        [busy, { id: busy, spaceId: SPACE, messages: [] } as unknown as Conversation],
      ]),
    })

    for (let i = 0; i < CONVERSATION_CACHE_SIZE + 3; i++) {
      const id = `app-chat:${APP}:local:direct:other${i}`
      apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', `c${i}`)]))
      await store.getState().refreshConversation(id)
    }

    const cache = store.getState().conversationCache
    expect(cache.size).toBeLessThanOrEqual(CONVERSATION_CACHE_SIZE)
    expect(cache.has(DH)).toBe(true)
    expect(cache.has(busy)).toBe(true)
  })
})

describe('sessions the chat board does not show', () => {
  it('only retires the streamed state on complete', async () => {
    const store = makeStore()
    const im = `app-chat:${APP}:wecom:direct:someone`
    store.setState({
      sessions: new Map([[im, { ...createEmptySessionState(), isGenerating: true, streamingContent: 'x', turnId: 1 }]]),
    })

    await store.getState().handleAgentComplete({ spaceId: SPACE, conversationId: im } as never)

    expect(store.getState().sessions.get(im)).toMatchObject({ isGenerating: false, streamingContent: '' })
    expect(apiMock.appChatTranscript).not.toHaveBeenCalled()
    expect(apiMock.getConversation).not.toHaveBeenCalled()
  })
})

describe('space conversations through the same verbs', () => {
  const conversation = { id: 'c1', spaceId: SPACE, title: 'T', createdAt: 't', updatedAt: 't', messageCount: 0, messages: [] } as unknown as Conversation

  function spaceStore() {
    const store = makeStore()
    store.setState({
      spaceStates: new Map([[SPACE, { conversations: [{ id: 'c1', spaceId: SPACE, title: 'T', createdAt: 't', updatedAt: 't', messageCount: 0 }], currentConversationId: 'c1' }]]),
      conversationCache: new Map([['c1', conversation]]),
    })
    return store
  }

  it('sends, stops and injects through the space agent', async () => {
    const store = spaceStore()
    apiMock.sendMessage.mockResolvedValue({ success: true })
    apiMock.injectMessage.mockResolvedValue({ success: true })

    await store.getState().sendMessage('hi')
    await store.getState().injectMessage('c1', 'more')
    await store.getState().stopGeneration()

    expect(apiMock.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ spaceId: SPACE, conversationId: 'c1', message: 'hi' }))
    expect(apiMock.injectMessage).toHaveBeenCalledWith({ conversationId: 'c1', message: 'more' })
    expect(apiMock.stopGeneration).toHaveBeenCalledWith('c1')
    expect(apiMock.appChatSend).not.toHaveBeenCalled()
  })

  it('a selected digital human takes the message that would have gone to the regular conversation', async () => {
    const store = spaceStore()
    apiMock.appChatTranscript.mockResolvedValue(page([]))
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH)).toBe(true))

    await store.getState().sendMessage('hello dh')

    expect(apiMock.appChatSend).toHaveBeenCalledWith(expect.objectContaining({ message: 'hello dh', conversationId: DH }))
    expect(apiMock.sendMessage).not.toHaveBeenCalled()
  })

  it('marks a finished space turn unseen while a digital human, not that conversation, is on screen', async () => {
    const store = spaceStore()
    apiMock.appChatTranscript.mockResolvedValue(page([]))
    selectDigitalHuman(store)
    apiMock.getConversation.mockResolvedValue({ success: true, data: { ...conversation, messages: [m('a', 'assistant', 'done')] } })
    store.setState({ sessions: new Map([['c1', { ...createEmptySessionState(), isGenerating: true, turnId: 1 }]]) })

    await store.getState().handleAgentComplete({ spaceId: SPACE, conversationId: 'c1' } as never)

    expect(store.getState().unseenCompletions.has('c1')).toBe(true)
  })

  it('does not mark a finished space turn unseen while its conversation is on screen', async () => {
    const store = spaceStore()
    apiMock.getConversation.mockResolvedValue({ success: true, data: { ...conversation, messages: [m('a', 'assistant', 'done')] } })
    store.setState({ sessions: new Map([['c1', { ...createEmptySessionState(), isGenerating: true, turnId: 1 }]]) })

    await store.getState().handleAgentComplete({ spaceId: SPACE, conversationId: 'c1' } as never)

    expect(store.getState().unseenCompletions.has('c1')).toBe(false)
  })

  it('reloads a finished space turn from the space store and marks it unseen when nobody watches', async () => {
    const store = spaceStore()
    store.setState({ currentSpaceId: 'other-space' })
    apiMock.getConversation.mockResolvedValue({ success: true, data: { ...conversation, messages: [m('a', 'assistant', 'done')] } })
    store.setState({ sessions: new Map([['c1', { ...createEmptySessionState(), isGenerating: true, streamingContent: 'x', turnId: 1 }]]) })

    await store.getState().handleAgentComplete({ spaceId: SPACE, conversationId: 'c1' } as never)

    expect(apiMock.getConversation).toHaveBeenCalledWith(SPACE, 'c1')
    expect(store.getState().sessions.get('c1')).toMatchObject({ isGenerating: false, streamingContent: '' })
    expect(store.getState().unseenCompletions.has('c1')).toBe(true)
    expect(store.getState().conversationCache.get('c1')!.messages).toHaveLength(1)
  })
})

describe('review fixes', () => {
  it('a digital-human read never touches the space source\'s loading flag', async () => {
    const store = makeStore()
    store.setState({ isLoadingConversation: true })
    let release: (value: unknown) => void = () => {}
    apiMock.appChatTranscript.mockReturnValue(new Promise(resolve => { release = resolve }))
    selectDigitalHuman(store)
    release(page([m('session-msg-1', 'user', 'a')]))
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH)).toBe(true))
    // The space conversation that is still loading keeps its flag.
    expect(store.getState().isLoadingConversation).toBe(true)
  })

  it('keeps another space\'s selected digital human cached, however many conversations are opened elsewhere', async () => {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', 'a')]))
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH)).toBe(true))
    store.setState({ currentSpaceId: 'space-2', spaceStates: new Map([...store.getState().spaceStates, ['space-2', { conversations: [], currentConversationId: null }]]) })

    for (let i = 0; i < CONVERSATION_CACHE_SIZE + 3; i++) {
      apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', `c${i}`)]))
      await store.getState().refreshConversation(`app-chat:${APP}:local:direct:x${i}`)
    }
    expect(store.getState().conversationCache.has(DH)).toBe(true)
  })

  it('re-reads an on-screen digital-human conversation that is not cached', async () => {
    const store = makeStore()
    store.setState({ spaceStates: new Map([[SPACE, { conversations: [], currentConversationId: null, selectedAppChat: { appId: APP, conversationId: DH } }]]) })
    apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', 'back')]))

    await store.getState().openConversation(DH)

    expect(store.getState().conversationCache.get(DH)!.messages[0].content).toBe('back')
  })

  it('does not read a finished turn of a conversation nobody has open, but ends its stream', async () => {
    const store = makeStore()
    store.setState({ sessions: new Map([[DH_LOCAL, { ...createEmptySessionState(), isGenerating: true, streamingContent: 'x', turnId: 1 }]]) })

    await store.getState().handleAgentComplete({ spaceId: SPACE, conversationId: DH_LOCAL } as never)

    expect(apiMock.appChatTranscript).not.toHaveBeenCalled()
    expect(store.getState().conversationCache.has(DH_LOCAL)).toBe(false)
    expect(store.getState().sessions.get(DH_LOCAL)).toMatchObject({ isGenerating: false, streamingContent: '' })
  })

  it('does not bring cleared messages back when the finished turn\'s read lands after a clear', async () => {
    const store = makeStore()
    apiMock.appChatTranscript.mockResolvedValue(page([m('session-msg-1', 'user', 'old')]))
    selectDigitalHuman(store)
    await vi.waitFor(() => expect(store.getState().conversationCache.has(DH)).toBe(true))
    await store.getState().sendMessage('go')
    let release: (value: unknown) => void = () => {}
    apiMock.appChatTranscript.mockReturnValue(new Promise(resolve => { release = resolve }))

    const completing = store.getState().handleAgentComplete({ spaceId: SPACE, conversationId: DH } as never)
    await store.getState().clearConversation(DH)
    release(page([m('session-msg-1', 'user', 'old'), m('session-msg-2', 'user', 'go'), m('session-msg-3', 'assistant', 'done')]))
    await completing

    expect(store.getState().conversationCache.get(DH)!.messages).toEqual([])
  })
})
