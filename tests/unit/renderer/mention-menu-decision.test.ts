/**
 * The composer's `#` conversation-mention menu decision (InputArea.tsx).
 *
 * Reversed from `@`'s behavior on purpose: a bare `#` deliberately lists
 * every conversation instead of nothing (see mentionMenuDecision.ts for why
 * this is safe for `#` specifically and was NOT safe for `@`, which is what
 * originally caused the P0 this module's earlier version was built to fix).
 * `@`'s own file-matching logic is unrelated and lives inline in
 * InputArea.tsx — untouched by this module.
 */

import { describe, it, expect } from 'vitest'
import { decideConversationMentionCandidates } from '../../../src/renderer/components/chat/mentionMenuDecision'
import type { ConversationMentionCandidate } from '../../../src/renderer/components/chat/cross-conversation'

function conversation(id: string, title: string): ConversationMentionCandidate {
  return { id, title, summary: '', updatedAt: new Date(0).toISOString(), status: 'idle' }
}

const CONVERSATIONS = [conversation('a', 'Alpha planning'), conversation('b', 'Beta rollout')]

describe('decideConversationMentionCandidates', () => {
  it('a bare "#" (empty query) lists EVERY conversation, not none — the deliberate reversal from @', () => {
    const result = decideConversationMentionCandidates({ query: '', conversations: CONVERSATIONS })
    expect(result.candidates.map((c) => c.id)).toEqual(['a', 'b'])
    expect(result.shouldOpenMenu).toBe(true)
  })

  it('does not open the menu when this space has no other conversation at all', () => {
    const result = decideConversationMentionCandidates({ query: '', conversations: [] })
    expect(result.shouldOpenMenu).toBe(false)
    expect(result.candidates).toEqual([])
  })

  it('a typed query narrows the list by substring match on the title, case-insensitively', () => {
    const result = decideConversationMentionCandidates({ query: 'alpha', conversations: CONVERSATIONS })
    expect(result.candidates.map((c) => c.id)).toEqual(['a'])
    expect(result.shouldOpenMenu).toBe(true)
  })

  it('a query matching nothing narrows the shown candidates to none, independent of shouldOpenMenu', () => {
    const result = decideConversationMentionCandidates({ query: 'nothing matches this', conversations: CONVERSATIONS })
    expect(result.candidates).toEqual([])
    // shouldOpenMenu reflects "does this space have conversations at all", not
    // "does the current query match" — the render path already hides the
    // popup box on an empty candidate list regardless of this flag.
    expect(result.shouldOpenMenu).toBe(true)
  })

  it('caps candidates at 20 for a bare "#", not just for a matched query', () => {
    const many = Array.from({ length: 25 }, (_, i) => conversation(`c${i}`, `Conversation ${i}`))
    const result = decideConversationMentionCandidates({ query: '', conversations: many })
    expect(result.candidates).toHaveLength(20)
  })

  it('caps candidates at 20 for a matched query too', () => {
    const many = Array.from({ length: 25 }, (_, i) => conversation(`c${i}`, `Match ${i}`))
    const result = decideConversationMentionCandidates({ query: 'match', conversations: many })
    expect(result.candidates).toHaveLength(20)
  })
})
