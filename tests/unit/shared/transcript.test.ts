import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TRANSCRIPT_PAGE_SIZE,
  MAX_TRANSCRIPT_PAGE_SIZE,
  clampTranscriptLimit,
  pageTranscript,
  roleForTranscriptSource,
  summarizeThoughts,
  tailStartWithinBudget,
  withThoughtsUnloaded,
} from '../../../src/shared/transcript'
import type { Thought, TranscriptMessage } from '../../../src/shared/types/transcript'

const messages = (n: number): TranscriptMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i + 1}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `c${i + 1}`,
    timestamp: '2026-01-01T00:00:00.000Z',
  }))

describe('pageTranscript', () => {
  it('returns the newest messages oldest→newest, with the oldest id as cursor', () => {
    const page = pageTranscript(messages(10), { limit: 3 })
    expect(page.messages.map(m => m.id)).toEqual(['m8', 'm9', 'm10'])
    expect(page).toMatchObject({ hasMoreBefore: true, cursor: 'm8', total: 10 })
  })

  it('pages older messages before a cursor', () => {
    const page = pageTranscript(messages(10), { before: 'm8', limit: 3 })
    expect(page.messages.map(m => m.id)).toEqual(['m5', 'm6', 'm7'])
    expect(page.hasMoreBefore).toBe(true)
  })

  it('reports the end of history', () => {
    const page = pageTranscript(messages(10), { before: 'm3', limit: 5 })
    expect(page.messages.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(page.hasMoreBefore).toBe(false)
  })

  it('is empty (not restarted from the newest) when the cursor is the oldest or unknown', () => {
    expect(pageTranscript(messages(3), { before: 'm1' })).toEqual({ messages: [], hasMoreBefore: false, cursor: null, total: 3 })
    expect(pageTranscript(messages(3), { before: 'gone' })).toEqual({ messages: [], hasMoreBefore: false, cursor: null, total: 3 })
  })

  it('widens the newest page back to a message with `through`, keeping some context above it', () => {
    const page = pageTranscript(messages(100), { limit: 5, through: 'm40' })
    expect(page.messages[0].id).toBe('m35')
    expect(page.messages.at(-1)!.id).toBe('m100')
    expect(page).toMatchObject({ hasMoreBefore: true, cursor: 'm35', total: 100 })
  })

  it('leaves the page alone when `through` is already in it, unknown, or combined with `before`', () => {
    expect(pageTranscript(messages(100), { limit: 10, through: 'm95' }).messages).toHaveLength(10)
    expect(pageTranscript(messages(100), { limit: 10, through: 'gone' }).messages).toHaveLength(10)
    const older = pageTranscript(messages(100), { limit: 10, before: 'm50', through: 'm5' })
    expect(older.messages.map(m => m.id)[0]).toBe('m40')
  })

  it('bounds how far back `through` reaches, and does not widen for a message beyond it', () => {
    const beyond = pageTranscript(messages(3000), { through: 'm10' })
    expect(beyond.messages).toHaveLength(50)
    expect(beyond.messages.some(m => m.id === 'm10')).toBe(false)

    const edge = pageTranscript(messages(3000), { through: 'm1001' })
    expect(edge.messages.some(m => m.id === 'm1001')).toBe(true)
    expect(edge.messages.length).toBeLessThanOrEqual(2000)
  })

  it('handles an empty transcript', () => {
    expect(pageTranscript([])).toEqual({ messages: [], hasMoreBefore: false, cursor: null, total: 0 })
  })

  it('defaults and clamps the page size', () => {
    expect(clampTranscriptLimit(undefined)).toBe(DEFAULT_TRANSCRIPT_PAGE_SIZE)
    expect(clampTranscriptLimit(0)).toBe(DEFAULT_TRANSCRIPT_PAGE_SIZE)
    expect(clampTranscriptLimit(-5)).toBe(DEFAULT_TRANSCRIPT_PAGE_SIZE)
    expect(clampTranscriptLimit(NaN)).toBe(DEFAULT_TRANSCRIPT_PAGE_SIZE)
    expect(clampTranscriptLimit(7.9)).toBe(7)
    expect(clampTranscriptLimit(10_000)).toBe(MAX_TRANSCRIPT_PAGE_SIZE)
    expect(pageTranscript(messages(300)).messages).toHaveLength(DEFAULT_TRANSCRIPT_PAGE_SIZE)
  })
})

describe('roleForTranscriptSource', () => {
  it('shows delivered and notice messages as system, everything else as the user', () => {
    expect(roleForTranscriptSource('cross-conversation')).toBe('system')
    expect(roleForTranscriptSource('cross-conversation-notice')).toBe('system')
    expect(roleForTranscriptSource('team-message')).toBe('system')
    expect(roleForTranscriptSource('injection')).toBe('user')
    expect(roleForTranscriptSource(undefined)).toBe('user')
  })
})

describe('thoughts helpers', () => {
  const thought = (type: Thought['type'], second: number): Thought => ({
    id: `t${second}`,
    type,
    content: '',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
  })

  it('summarises counts per type and the span in seconds', () => {
    expect(summarizeThoughts([thought('thinking', 0), thought('tool_use', 3), thought('tool_use', 12)])).toEqual({
      count: 3,
      types: { thinking: 1, tool_use: 2 },
      duration: 12,
    })
  })

  it('has no duration for a single thought', () => {
    expect(summarizeThoughts([thought('thinking', 0)]).duration).toBeUndefined()
  })

  it('projects loaded thoughts to null and leaves other messages untouched', () => {
    const loaded: TranscriptMessage = { ...messages(1)[0], thoughts: [thought('thinking', 0)], thoughtsSummary: { count: 1, types: { thinking: 1 } } }
    const projected = withThoughtsUnloaded(loaded)
    expect(projected.thoughts).toBeNull()
    expect(projected.thoughtsSummary).toEqual(loaded.thoughtsSummary)
    expect(loaded.thoughts).toHaveLength(1)

    const plain = messages(1)[0]
    expect(withThoughtsUnloaded(plain)).toBe(plain)
    const unloaded = { ...plain, thoughts: null }
    expect(withThoughtsUnloaded(unloaded)).toBe(unloaded)
  })
})

describe('tailStartWithinBudget', () => {
  const sizes = [5, 5, 5, 5, 5]
  const start = (end: number, budget: number) => tailStartWithinBudget(sizes, end, budget, n => n)

  it('takes the newest items that fit', () => {
    expect(start(5, 12)).toBe(3)
    expect(start(3, 10)).toBe(1)
    expect(start(5, 100)).toBe(0)
  })

  it('always takes at least one item, even over budget', () => {
    expect(start(5, 1)).toBe(4)
    expect(tailStartWithinBudget([500], 1, 10, n => n)).toBe(0)
  })

  it('takes nothing from an empty range', () => {
    expect(start(0, 10)).toBe(0)
  })
})
