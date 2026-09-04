/**
 * Unit tests for conversation-interop/target-resolution — letting a tool's
 * `target` argument be either a conversation id or the exact title
 * InputArea.tsx's @ mention inserts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeConversation {
  id: string
  title: string
  updatedAt: string
}

const { store } = vi.hoisted(() => ({ store: new Map<string, FakeConversation>() }))

function seed(id: string, title: string, updatedAt = new Date().toISOString()): FakeConversation {
  const conv = { id, title, updatedAt }
  store.set(id, conv)
  return conv
}

vi.mock('../../../../src/main/services/conversation.service', () => ({
  getConversation: (_spaceId: string, id: string) => store.get(id) ?? null,
  listConversations: (_spaceId: string) =>
    Array.from(store.values()).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: 0 })),
}))

import { resolveConversationTarget } from '../../../../src/main/services/conversation-interop/target-resolution'

describe('resolveConversationTarget', () => {
  beforeEach(() => {
    store.clear()
  })

  it('resolves an exact id match immediately, without needing a title match at all', () => {
    seed('conv_1', 'Some other title entirely')
    const result = resolveConversationTarget('space-1', 'self', 'conv_1')
    expect(result).toEqual({ ok: true, conversationId: 'conv_1' })
  })

  it('falls back to an exact title match when the id lookup misses', () => {
    seed('conv_1', 'Q3 pricing')
    const result = resolveConversationTarget('space-1', 'self', 'Q3 pricing')
    expect(result).toEqual({ ok: true, conversationId: 'conv_1' })
  })

  it('title matching is case-insensitive and trims leading/trailing whitespace', () => {
    seed('conv_1', 'Q3 Pricing')
    expect(resolveConversationTarget('space-1', 'self', '  q3 pricing  ')).toEqual({
      ok: true,
      conversationId: 'conv_1',
    })
  })

  it('title matching is EXACT, not a substring — a partial title does not match', () => {
    seed('conv_1', 'Q3 pricing discussion')
    expect(resolveConversationTarget('space-1', 'self', 'Q3 pricing')).toEqual({ ok: false, reason: 'not_found' })
  })

  it('reports not_found when neither an id nor a title matches anything', () => {
    seed('conv_1', 'Something else')
    expect(resolveConversationTarget('space-1', 'self', 'ghost')).toEqual({ ok: false, reason: 'not_found' })
  })

  it(
    'when the ONLY conversation with this title is the caller itself, reports self_target_title — ' +
      'never not_found, which would falsely claim the conversation does not exist while the caller is looking straight at it',
    () => {
      seed('self', 'My own title')
      const result = resolveConversationTarget('space-1', 'self', 'My own title')
      expect(result).toEqual({ ok: false, reason: 'self_target_title' })
    }
  )

  it(
    'when the caller AND another conversation share the same title, resolves to the OTHER one — ' +
      'self is excluded from the candidate set, not from the match check that decides not_found vs self_target_title',
    () => {
      seed('self', 'Standup')
      seed('conv_other', 'Standup')
      const result = resolveConversationTarget('space-1', 'self', 'Standup')
      expect(result).toEqual({ ok: true, conversationId: 'conv_other' })
    }
  )

  it('an id match on the caller itself still resolves — title exclusion does not apply to id matches, downstream self_target checks own that', () => {
    seed('self', 'My own title')
    const result = resolveConversationTarget('space-1', 'self', 'self')
    expect(result).toEqual({ ok: true, conversationId: 'self' })
  })

  it('two conversations sharing an exact title report ambiguous_title with both candidates, never silently picking one', () => {
    seed('conv_a', 'Q3 Planning', '2026-01-01T00:00:00.000Z')
    seed('conv_b', 'Q3 Planning', '2026-01-02T00:00:00.000Z')
    const result = resolveConversationTarget('space-1', 'self', 'Q3 Planning')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('ambiguous_title')
    if (result.reason !== 'ambiguous_title') return
    // Most recently active first.
    expect(result.candidates.map((c) => c.id)).toEqual(['conv_b', 'conv_a'])
  })

  it('three-way title collision lists all three candidates, not just the first two found', () => {
    seed('conv_a', 'Standup', '2026-01-01T00:00:00.000Z')
    seed('conv_b', 'Standup', '2026-01-02T00:00:00.000Z')
    seed('conv_c', 'Standup', '2026-01-03T00:00:00.000Z')
    const result = resolveConversationTarget('space-1', 'self', 'Standup')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('ambiguous_title')
    if (result.reason !== 'ambiguous_title') return
    expect(result.candidates).toHaveLength(3)
  })
})

describe('resolveConversationTarget — short ids from a [#Title](conv:...) reference', () => {
  beforeEach(() => {
    store.clear()
  })

  it('resolves the 8-char short id the composer puts in a reference', () => {
    seed('3a5d77ea-c33f-4df9-a15f-d5fb36229732', 'Some conversation')
    const result = resolveConversationTarget('space-1', 'self', '3a5d77ea')
    expect(result).toEqual({ ok: true, conversationId: '3a5d77ea-c33f-4df9-a15f-d5fb36229732' })
  })

  it('accepts the scheme copied verbatim out of the reference', () => {
    seed('3a5d77ea-c33f-4df9-a15f-d5fb36229732', 'Some conversation')
    const result = resolveConversationTarget('space-1', 'self', 'conv:3a5d77ea')
    expect(result).toEqual({ ok: true, conversationId: '3a5d77ea-c33f-4df9-a15f-d5fb36229732' })
  })

  it('reports colliding prefixes with their full ids instead of picking one', () => {
    seed('3a5d77ea-1111-4df9-a15f-d5fb36229732', 'First', '2026-01-01T00:00:00.000Z')
    seed('3a5d77ea-2222-4df9-a15f-d5fb36229732', 'Second', '2026-01-02T00:00:00.000Z')
    const result = resolveConversationTarget('space-1', 'self', '3a5d77ea')
    expect(result).toMatchObject({ ok: false, reason: 'ambiguous_short_id' })
    if (result.ok || result.reason !== 'ambiguous_short_id') throw new Error('expected ambiguous_short_id')
    // Most recently active first, and full ids — a short id is what failed, so
    // repeating it back would leave the caller no way to disambiguate.
    expect(result.candidates.map((c) => c.id)).toEqual([
      '3a5d77ea-2222-4df9-a15f-d5fb36229732',
      '3a5d77ea-1111-4df9-a15f-d5fb36229732',
    ])
  })

  it('falls through to title matching when a hex-shaped target is nobody\'s id', () => {
    seed('11111111-c33f-4df9-a15f-d5fb36229732', 'deadbeef')
    const result = resolveConversationTarget('space-1', 'self', 'deadbeef')
    expect(result).toEqual({ ok: true, conversationId: '11111111-c33f-4df9-a15f-d5fb36229732' })
  })

  it('leaves self-targeting by short id to the caller, exactly as a full id does', () => {
    seed('3a5d77ea-c33f-4df9-a15f-d5fb36229732', 'Mine')
    const result = resolveConversationTarget('space-1', '3a5d77ea-c33f-4df9-a15f-d5fb36229732', '3a5d77ea')
    expect(result).toEqual({ ok: true, conversationId: '3a5d77ea-c33f-4df9-a15f-d5fb36229732' })
  })
})
