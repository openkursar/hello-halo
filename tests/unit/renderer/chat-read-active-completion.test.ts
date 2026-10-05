/**
 * Coming back to the window reads an unseen completion of the conversation on
 * screen into the task panel's grace period (countdown, Keep/Remove), the same
 * way opening it does. Other conversations and plain errors are left alone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'

const apiMock = vi.hoisted(() => ({
  taskMarkRead: vi.fn(() => Promise.resolve({ success: true })),
  taskListState: vi.fn(),
  taskSetKept: vi.fn(() => Promise.resolve({ success: true })),
  taskRemoveState: vi.fn(() => Promise.resolve({ success: true })),
}))
vi.mock('../../../src/renderer/api', () => ({ api: apiMock }))
// Module-load subscribers elsewhere in the import graph only need callable stubs.
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({
  canvasLifecycle: new Proxy({ getIsOpen: () => false, getTabCount: () => 0, getTabs: () => [] } as Record<string, unknown>, {
    get: (target, key: string) => target[key] ?? (() => () => {}),
  }),
}))

import { createSessionSlice } from '../../../src/renderer/stores/chat/session'
import type { ChatState } from '../../../src/renderer/stores/chat/internal'

function makeStore(unseen: string[], sessions: Map<string, unknown> = new Map()) {
  return create<ChatState>((set, get) => ({
    currentSpaceId: 's',
    visibleConversationId: 'c1',
    spaceStates: new Map([['s', { conversations: [], currentConversationId: 'c1', selectedAppChat: null }]]),
    sessions,
    unseenCompletions: new Map(unseen.map(id => [id, { spaceId: 's', title: `T-${id}` }])),
    pulseReadAt: new Map(),
    ...createSessionSlice(set as never, get as never),
  }) as unknown as ChatState)
}

describe('readActiveCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('document', { hidden: false, hasFocus: () => true })
  })

  it('moves the on-screen unseen completion into the grace period and persists it', () => {
    const store = makeStore(['c1', 'c2'])

    store.getState().readActiveCompletion()

    const state = store.getState()
    expect(state.unseenCompletions.has('c1')).toBe(false)
    expect(state.unseenCompletions.has('c2')).toBe(true)
    expect(state.pulseReadAt.get('c1')).toMatchObject({ originalStatus: 'completed-unseen', spaceId: 's', title: 'T-c1' })
    expect(apiMock.taskMarkRead).toHaveBeenCalledWith('c1', 's', 'T-c1', 'completed-unseen')
  })

  it.each([
    { visibleConversationId: null, hidden: false, focused: true },
    { visibleConversationId: 'c2', hidden: false, focused: true },
    { visibleConversationId: 'c1', hidden: true, focused: true },
    { visibleConversationId: 'c1', hidden: false, focused: false },
  ])('preserves unread when the selected conversation is not viewed: %o', ({ visibleConversationId, hidden, focused }) => {
    const store = makeStore(['c1'])
    store.setState({ visibleConversationId })
    vi.stubGlobal('document', { hidden, hasFocus: () => focused })
    const before = store.getState()

    store.getState().readActiveCompletion()

    expect(store.getState()).toBe(before)
    expect(apiMock.taskMarkRead).not.toHaveBeenCalled()
  })

  it('reads when the chat returns after focusing another page, not on focus alone', () => {
    const store = makeStore(['c1', 'c2'])
    store.getState().setVisibleConversation(null)
    store.getState().readActiveCompletion()
    expect(store.getState().unseenCompletions.has('c1')).toBe(true)

    store.getState().setVisibleConversation('c1')

    expect(store.getState().unseenCompletions.has('c1')).toBe(false)
    expect(store.getState().unseenCompletions.has('c2')).toBe(true)
    expect(apiMock.taskMarkRead).toHaveBeenCalledTimes(1)
  })

  it('waits for foreground focus if the chat mounts in the background', () => {
    const store = makeStore(['c1'])
    vi.stubGlobal('document', { hidden: false, hasFocus: () => false })
    store.getState().setVisibleConversation('c1')
    expect(store.getState().unseenCompletions.has('c1')).toBe(true)

    vi.stubGlobal('document', { hidden: false, hasFocus: () => true })
    store.getState().readActiveCompletion()
    store.getState().readActiveCompletion()

    expect(store.getState().unseenCompletions.has('c1')).toBe(false)
    expect(apiMock.taskMarkRead).toHaveBeenCalledTimes(1)
  })

  it('reads the regular conversation revealed after leaving a digital-human chat', () => {
    const store = makeStore(['c1'])
    const digitalHuman = 'app-chat:a1:local:direct:s1'
    store.setState({ spaceStates: new Map([['s', { conversations: [], currentConversationId: 'c1', selectedAppChat: { appId: 'a1', conversationId: digitalHuman } }]]) })
    store.getState().setVisibleConversation(digitalHuman)
    expect(store.getState().unseenCompletions.has('c1')).toBe(true)

    store.setState({ spaceStates: new Map([['s', { conversations: [], currentConversationId: 'c1', selectedAppChat: null }]]) })
    store.getState().setVisibleConversation('c1')

    expect(store.getState().unseenCompletions.has('c1')).toBe(false)
    expect(apiMock.taskMarkRead).toHaveBeenCalledWith('c1', 's', 'T-c1', 'completed-unseen')
  })

  it('reads a visible digital-human completion without consuming other conversations', () => {
    const id = 'app-chat:a1:local:direct:s1'
    const store = makeStore([id, 'c1'])
    store.setState({ spaceStates: new Map([['s', { conversations: [], currentConversationId: 'c1', selectedAppChat: { appId: 'a1', conversationId: id } }]]) })

    store.getState().setVisibleConversation(id)

    expect(store.getState().unseenCompletions.has(id)).toBe(false)
    expect(store.getState().unseenCompletions.has('c1')).toBe(true)
    expect(apiMock.taskMarkRead).toHaveBeenCalledWith(id, 's', `T-${id}`, 'completed-unseen')
  })

  it('repeated foreground events preserve the existing grace period and Keep choice', () => {
    const store = makeStore(['c1'])
    store.getState().readActiveCompletion()
    const read = { ...store.getState().pulseReadAt.get('c1')!, kept: true }
    store.setState({ pulseReadAt: new Map([['c1', read]]) })
    const before = store.getState()

    store.getState().setVisibleConversation('c1')
    store.getState().readActiveCompletion()

    expect(store.getState()).toBe(before)
    expect(store.getState().pulseReadAt.get('c1')).toBe(read)
    expect(apiMock.taskMarkRead).toHaveBeenCalledTimes(1)
  })

  it('does not consume a failed completion on foreground without an explicit selection', () => {
    const error = { error: 'boom', errorType: null, errorSeen: false }
    const store = makeStore(['c1'], new Map([['c1', error]]))
    const before = store.getState()

    store.getState().readActiveCompletion()
    store.getState().setVisibleConversation('c1')

    expect(store.getState()).toBe(before)
    expect(store.getState().sessions.get('c1')).toBe(error)
    expect(apiMock.taskMarkRead).not.toHaveBeenCalled()
  })

  it.each(['loadPersistedTaskState', 'syncPersistedTaskState'] as const)(
    'reads late-arriving unread state only for the viewed conversation: %s', async action => {
      const store = makeStore([])
      let resolve!: (value: unknown) => void
      apiMock.taskListState.mockReturnValue(new Promise(done => { resolve = done }))
      const loading = store.getState()[action]()
      store.getState().setVisibleConversation('c1')
      resolve({ success: true, data: ['c1', 'c2'].map(conversationId => ({
        conversationId, spaceId: 's', title: `T-${conversationId}`, state: 'unseen', originalStatus: 'completed-unseen', readAt: null, kept: false,
      })) })

      await loading

      expect(store.getState().unseenCompletions.has('c1')).toBe(false)
      expect(store.getState().unseenCompletions.has('c2')).toBe(true)
      expect(apiMock.taskMarkRead).toHaveBeenCalledWith('c1', 's', 'T-c1', 'completed-unseen')
    }
  )

  it.each(['loadPersistedTaskState', 'syncPersistedTaskState'] as const)(
    'does not replay a stale unread response after the completion was read and kept: %s', async action => {
      const store = makeStore(['c1'])
      let resolve!: (value: unknown) => void
      apiMock.taskListState.mockReturnValueOnce(new Promise(done => { resolve = done }))
      const loading = store.getState()[action]()
      store.getState().readActiveCompletion()
      store.getState().keepPulseItem('c1')
      const read = store.getState().pulseReadAt.get('c1')!
      apiMock.taskListState.mockResolvedValue({ success: true, data: [{ conversationId: 'c1', state: 'read', ...read }] })
      resolve({ success: true, data: [{ conversationId: 'c1', spaceId: 's', title: 'T-c1', state: 'unseen' }] })

      await loading

      expect(store.getState().pulseReadAt.get('c1')).toEqual(read)
      expect(store.getState().unseenCompletions.has('c1')).toBe(false)
      expect(apiMock.taskMarkRead).toHaveBeenCalledTimes(1)
      expect(apiMock.taskListState).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['loadPersistedTaskState', 'syncPersistedTaskState'] as const)(
    'does not resurrect an item removed during a pending task read: %s', async action => {
      const store = makeStore(['c1'])
      store.getState().readActiveCompletion()
      let resolve!: (value: unknown) => void
      apiMock.taskListState.mockReturnValueOnce(new Promise(done => { resolve = done }))
      apiMock.taskListState.mockResolvedValue({ success: true, data: [] })
      const loading = store.getState()[action]()
      store.getState().removePulseItem('c1')
      resolve({ success: true, data: [{ conversationId: 'c1', spaceId: 's', title: 'T-c1', state: 'unseen' }] })

      await loading

      expect(store.getState().unseenCompletions.has('c1')).toBe(false)
      expect(store.getState().pulseReadAt.has('c1')).toBe(false)
      expect(apiMock.taskMarkRead).toHaveBeenCalledTimes(1)
      expect(apiMock.taskListState).toHaveBeenCalledTimes(2)
    }
  )

  it('ignores older concurrent syncs even when the newer snapshot has no rows', async () => {
    const store = makeStore([])
    let resolve!: (value: unknown) => void
    apiMock.taskListState.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const older = store.getState().syncPersistedTaskState()
    apiMock.taskListState.mockResolvedValueOnce({ success: true, data: [] })
    await store.getState().syncPersistedTaskState()
    resolve({ success: true, data: [{ conversationId: 'c1', spaceId: 's', title: 'T-c1', state: 'unseen' }] })

    await older

    expect(store.getState().unseenCompletions.size).toBe(0)
    expect(store.getState().pulseReadAt.size).toBe(0)
    expect(apiMock.taskMarkRead).not.toHaveBeenCalled()
    expect(apiMock.taskListState).toHaveBeenCalledTimes(2)
  })

  it('retains late-arriving unread state when another page is on screen', async () => {
    const store = makeStore([])
    store.getState().setVisibleConversation(null)
    apiMock.taskListState.mockResolvedValue({ success: true, data: [{ conversationId: 'c1', spaceId: 's', title: 'T-c1', state: 'unseen' }] })

    await store.getState().syncPersistedTaskState()

    expect(store.getState().unseenCompletions.has('c1')).toBe(true)
    expect(apiMock.taskMarkRead).not.toHaveBeenCalled()
  })

  it('does nothing when the conversation on screen has no unseen completion', () => {
    const sessions = new Map([['c1', { error: 'boom', errorType: null, errorSeen: false }]])
    const store = makeStore(['c2'], sessions)
    const before = store.getState()

    store.getState().readActiveCompletion()

    expect(store.getState()).toBe(before)
    expect(apiMock.taskMarkRead).not.toHaveBeenCalled()
  })
})
