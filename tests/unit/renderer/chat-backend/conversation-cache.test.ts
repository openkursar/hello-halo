/**
 * The conversation cache is bounded by size as well as count, and thoughts
 * read on demand stay within their own budget.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: {} }))

import {
  cacheConversation,
  cacheLoadedThoughts,
  estimateConversationBytes,
  shedBackgroundDetail,
} from '../../../../src/renderer/stores/chat/backend/cache'
import { CONVERSATION_CACHE_BYTES, LOADED_THOUGHTS_BYTES, createEmptySessionState } from '../../../../src/renderer/stores/chat/internal'
import type { ChatState, Conversation, Message, Thought } from '../../../../src/renderer/stores/chat/internal'
import { holdOpenThoughts } from '../../../../src/renderer/stores/chat/open-thoughts'

const SPACE = 'space-1'
type CacheState = Pick<ChatState, 'conversationCache' | 'spaceStates' | 'sessions' | 'currentSpaceId'>

function conversation(id: string, messages: Message[]): Conversation {
  return { id, spaceId: SPACE, title: id, createdAt: 't', updatedAt: 't', messageCount: messages.length, messages } as unknown as Conversation
}
const text = (id: string, chars: number): Message => ({ id, role: 'assistant', content: 'x'.repeat(chars), timestamp: 't' })
const withSummary = (id: string): Message => ({ id, role: 'assistant', content: 'r', timestamp: 't', thoughts: null, thoughtsSummary: { count: 1, types: {} } })
const thoughtsOf = (chars: number): Thought[] => [{ id: 't', type: 'thinking', content: 'y'.repeat(chars), timestamp: 't' }]

function state(onScreen: string | null, cache: Conversation[] = []): CacheState {
  return {
    conversationCache: new Map(cache.map(c => [c.id, c])),
    spaceStates: new Map([[SPACE, { conversations: [], currentConversationId: onScreen }]]),
    sessions: new Map(),
    currentSpaceId: SPACE,
  } as unknown as CacheState
}

describe('conversation cache size budget', () => {
  const quarter = CONVERSATION_CACHE_BYTES / 4 / 2 // characters for a quarter of the budget

  it('counts message text, inline images and inline thoughts', () => {
    const c = conversation('c', [
      { ...text('m1', 10), images: [{ id: 'i', type: 'image', mediaType: 'image/png', data: 'z'.repeat(100) }] },
      { ...text('m2', 0), thoughts: thoughtsOf(50) },
    ])
    expect(estimateConversationBytes(c)).toBe((10 + 100 + 50) * 2)
  })

  it('evicts the oldest conversations once the cached total passes the budget', () => {
    let s = state('on-screen', [conversation('on-screen', [text('a', 10)])])
    for (const id of ['old-1', 'old-2', 'old-3']) {
      s = { ...s, conversationCache: cacheConversation(s, conversation(id, [text(id, quarter)])) }
    }
    s = { ...s, conversationCache: cacheConversation(s, conversation('new', [text('n', quarter * 2.5)])) }
    expect([...s.conversationCache.keys()]).toEqual(['on-screen', 'old-3', 'new'])
  })

  it('never evicts the conversation on screen or a generating one, even over budget', () => {
    let s = state('on-screen', [conversation('on-screen', [text('a', quarter * 3)]), conversation('running', [text('b', quarter)])])
    s = { ...s, sessions: new Map([['running', { ...createEmptySessionState(), isGenerating: true }]]) }
    const next = cacheConversation(s, conversation('big', [text('c', quarter * 2)]))
    expect([...next.keys()]).toEqual(['on-screen', 'running', 'big'])
  })
})

describe('thoughts loaded on demand', () => {
  const eighth = LOADED_THOUGHTS_BYTES / 8 / 2

  it('stay within budget, dropping other conversations first and never the one just loaded', () => {
    let s = state('on-screen', [
      conversation('other', [withSummary('o1'), withSummary('o2')]),
      conversation('on-screen', [withSummary('s1'), withSummary('s2'), withSummary('s3'), withSummary('s4')]),
    ])
    const load = (conversationId: string, messageId: string, chars: number) => {
      s = { ...s, conversationCache: cacheLoadedThoughts(s, conversationId, messageId, thoughtsOf(chars)) }
    }
    load('other', 'o1', eighth * 3)
    load('other', 'o2', eighth * 3)
    load('on-screen', 's1', eighth)
    load('on-screen', 's4', eighth * 3)

    const loadedIds = [...s.conversationCache.values()].flatMap(c => c.messages.filter(m => Array.isArray(m.thoughts)).map(m => m.id))
    expect(loadedIds).toEqual(['o2', 's1', 's4'])
    const dropped = s.conversationCache.get('other')!.messages[0]
    expect(dropped.thoughts).toBeNull()
    expect(dropped.thoughtsSummary?.count).toBe(1)
  })

  it('trims the conversation on screen farthest from the message just opened', () => {
    let s = state('on-screen', [conversation('on-screen', ['s1', 's2', 's3', 's4', 's5'].map(withSummary))])
    for (const id of ['s1', 's2', 's3', 's4']) {
      s = { ...s, conversationCache: cacheLoadedThoughts(s, 'on-screen', id, thoughtsOf(eighth * 2)) }
    }
    s = { ...s, conversationCache: cacheLoadedThoughts(s, 'on-screen', 's5', thoughtsOf(eighth * 2)) }
    const loaded = s.conversationCache.get('on-screen')!.messages.filter(m => Array.isArray(m.thoughts)).map(m => m.id)
    expect(loaded).toEqual(['s2', 's3', 's4', 's5'])
  })

  it('never drops thoughts of a panel expanded on screen, even over budget', () => {
    let s = state('on-screen', [conversation('on-screen', ['s1', 's2', 's3', 's4', 's5'].map(withSummary))])
    const release = holdOpenThoughts('s1')
    for (const id of ['s1', 's2', 's3', 's4', 's5']) {
      s = { ...s, conversationCache: cacheLoadedThoughts(s, 'on-screen', id, thoughtsOf(eighth * 2)) }
    }
    const loaded = s.conversationCache.get('on-screen')!.messages.filter(m => Array.isArray(m.thoughts)).map(m => m.id)
    expect(loaded).toContain('s1')
    expect(loaded).toContain('s5')
    expect(loaded).not.toContain('s2')
    // Released (panel collapsed or unmounted), it is evictable again: the
    // farthest-first case without a hold is the test above.
    release()
  })

  it('never drops inline thoughts that cannot be read again', () => {
    const inline: Message = { ...text('v1', 0), thoughts: thoughtsOf(LOADED_THOUGHTS_BYTES) }
    let s = state('c', [conversation('c', [inline, withSummary('s1')])])
    s = { ...s, conversationCache: cacheLoadedThoughts(s, 'c', 's1', thoughtsOf(10)) }
    expect(Array.isArray(s.conversationCache.get('c')!.messages[0].thoughts)).toBe(true)
  })
})

describe('critical memory pressure', () => {
  it('keeps only what is on screen or running, and on-demand thoughts only on screen', () => {
    const loaded = (id: string): Message => ({ ...withSummary(id), thoughts: thoughtsOf(10) })
    const s = {
      ...state('on-screen', [
        conversation('background', [loaded('b1')]),
        conversation('running', [loaded('r1')]),
        conversation('on-screen', [loaded('s1')]),
      ]),
      sessions: new Map([
        ['running', { ...createEmptySessionState(), isGenerating: true, thoughts: thoughtsOf(5) }],
        ['finished', { ...createEmptySessionState(), thoughts: thoughtsOf(5) }],
        ['on-screen', { ...createEmptySessionState(), thoughts: thoughtsOf(5) }],
      ]),
    } as CacheState
    const { conversationCache, sessions } = shedBackgroundDetail(s)

    expect([...conversationCache.keys()]).toEqual(['running', 'on-screen'])
    expect(conversationCache.get('running')!.messages[0].thoughts).toBeNull()
    expect(Array.isArray(conversationCache.get('on-screen')!.messages[0].thoughts)).toBe(true)
    expect(sessions.get('finished')!.thoughts).toEqual([])
    expect(sessions.get('running')!.thoughts).toHaveLength(1)
    expect(sessions.get('on-screen')!.thoughts).toHaveLength(1)
  })
})
