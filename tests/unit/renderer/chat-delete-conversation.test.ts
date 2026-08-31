/**
 * deleteConversation regression tests for #294.
 *
 * Deleting the last conversation of a space used to leave
 * currentConversationId = null, so sendMessage hit its null-guard and user
 * input was silently dropped. The fix routes through the existing
 * createConversation path, mirroring what SpacePage init does for an empty
 * space.
 *
 * The store is a real zustand compose of the conversations + getters slices;
 * only the api transport is mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { create } from 'zustand'
import type { Conversation, ConversationMeta } from '../../../src/renderer/types'

const apiMock = vi.hoisted(() => ({
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  ensureSessionWarm: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../../src/renderer/api', () => ({ api: apiMock }))

vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({
  canvasLifecycle: { hideAllBrowserViews: vi.fn() },
}))

import { createConversationsSlice } from '../../../src/renderer/stores/chat/conversations'
import { createGettersSlice } from '../../../src/renderer/stores/chat/getters'
import type { ChatState } from '../../../src/renderer/stores/chat/internal'

function makeConversation(id: string): Conversation {
  return {
    id,
    spaceId: 'space-1',
    title: `Chat ${id}`,
    createdAt: '2026-08-30T10:00:00.000Z',
    updatedAt: '2026-08-30T10:00:00.000Z',
    messageCount: 0,
    messages: [],
    engineId: 'anthropic',
  } as Conversation
}

function makeMeta(conversation: Conversation): ConversationMeta {
  return {
    id: conversation.id,
    spaceId: conversation.spaceId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: 0,
    preview: undefined,
    engineId: conversation.engineId,
  }
}

type Store = ChatState & ReturnType<typeof createConversationsSlice> & ReturnType<typeof createGettersSlice>

function buildStore(initial: Conversation[], currentId: string | null) {
  const metas = initial.map(makeMeta)
  const cache = new Map(initial.map((c) => [c.id, c]))

  const base: ChatState = {
    spaceStates: new Map([['space-1', { conversations: metas, currentConversationId: currentId }]]),
    conversationCache: cache,
    sessions: new Map(),
    sessionInitInfo: new Map(),
    unseenCompletions: new Map(),
    pulseReadAt: new Map(),
    currentSpaceId: 'space-1',
    pendingPulseNavigation: null,
    artifacts: [],
    isLoading: false,
    isLoadingConversation: false,
    // The slices under test replace these; the rest satisfy the type.
  } as unknown as ChatState

  const useStore = create<Store>((set, get) => ({
    ...base,
    ...createConversationsSlice(
      set as never as (fn: (state: ChatState) => Partial<ChatState>) => void,
      get as unknown as () => ChatState
    ),
    ...createGettersSlice(
      set as never as (fn: (state: ChatState) => Partial<ChatState>) => void,
      get as unknown as () => ChatState
    ),
  }))

  return useStore
}

describe('deleteConversation — last-conversation deletion (#294)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('auto-creates a fresh conversation when the last one is deleted', async () => {
    const conv = makeConversation('only-one')
    const replacement = makeConversation('fresh')
    apiMock.deleteConversation.mockResolvedValue({ success: true })
    apiMock.createConversation.mockResolvedValue({ success: true, data: replacement })

    const useStore = buildStore([conv], 'only-one')
    const ok = await useStore.getState().deleteConversation('space-1', 'only-one')

    expect(ok).toBe(true)
    expect(apiMock.createConversation).toHaveBeenCalledWith('space-1')
    expect(useStore.getState().getCurrentConversationId()).toBe('fresh')
    expect(useStore.getState().getConversations()).toHaveLength(1)
    // The new conversation is usable end-to-end: meta + cache both seeded.
    expect(useStore.getState().getCurrentConversationMeta()?.id).toBe('fresh')
    expect(useStore.getState().getCurrentConversation()?.id).toBe('fresh')
  })

  it('keeps the pointer on the remaining conversation when a non-current one is deleted', async () => {
    const current = makeConversation('current')
    const other = makeConversation('other')
    apiMock.deleteConversation.mockResolvedValue({ success: true })

    const useStore = buildStore([current, other], 'current')
    const ok = await useStore.getState().deleteConversation('space-1', 'other')

    expect(ok).toBe(true)
    expect(apiMock.createConversation).not.toHaveBeenCalled()
    expect(useStore.getState().getCurrentConversationId()).toBe('current')
    expect(useStore.getState().getConversations().map((c) => c.id)).toEqual(['current'])
  })

  it('selects the remaining conversation when the current one is deleted but others exist', async () => {
    const current = makeConversation('current')
    const survivor = makeConversation('survivor')
    apiMock.deleteConversation.mockResolvedValue({ success: true })

    const useStore = buildStore([current, survivor], 'current')
    await useStore.getState().deleteConversation('space-1', 'current')

    expect(apiMock.createConversation).not.toHaveBeenCalled()
    expect(useStore.getState().getCurrentConversationId()).toBe('survivor')
  })

  it('does not auto-create when the deleted conversation was not the current one and the space becomes empty', async () => {
    // Edge: pointer already moved elsewhere (e.g. remote deletion racing a
    // local switch) — recreating would clobber the pointer's intent.
    const stray = makeConversation('stray')
    apiMock.deleteConversation.mockResolvedValue({ success: true })

    const useStore = buildStore([stray], null)
    await useStore.getState().deleteConversation('space-1', 'stray')

    expect(apiMock.createConversation).not.toHaveBeenCalled()
    expect(useStore.getState().getCurrentConversationId()).toBeNull()
  })
})
