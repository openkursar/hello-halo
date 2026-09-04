/**
 * Unit tests for conversation.service's `updateMessageById` — the id-keyed
 * patch added for Cross-Conversation Interop's delivery rewrite (delivery.ts).
 *
 * The service is real; only its IO boundaries (fs, space registry, config,
 * KB seed) are mocked as an in-memory disk — same harness as
 * conversation-title-ownership.test.ts.
 *
 * The property under test: patching by id must never lose a message added
 * by another writer in between — the exact shape of the bug a
 * read-snapshot-then-write-the-whole-array approach has. `updateMessageById`
 * re-reads the current cached/on-disk state itself and mutates only the
 * targeted entry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => {
  const files = new Map<string, string>()
  return {
    __disk: files,
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string) => {
      const data = files.get(p)
      if (data === undefined) throw new Error(`ENOENT: ${p}`)
      return data
    },
    writeFileSync: (p: string, data: string) => {
      files.set(p, data)
    },
    mkdirSync: () => undefined,
    readdirSync: (p: string) =>
      [...files.keys()]
        .filter((k) => k.startsWith(p))
        .map((k) => k.split('/').pop() as string),
    rmSync: (p: string) => {
      files.delete(p)
    },
    renameSync: (from: string, to: string) => {
      const data = files.get(from)
      if (data === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, data)
    },
  }
})

vi.mock('../../../src/main/services/space.service', () => ({
  getSpace: (spaceId: string) => ({ id: spaceId, path: `/spaces/${spaceId}`, isTemp: false }),
  touchSpaceActivity: () => undefined,
}))
vi.mock('../../../src/main/services/tlon', () => ({ getSeedKBIds: () => [] }))
vi.mock('../../../src/main/foundation/config.service', () => ({ getConfig: () => undefined }))

import {
  createConversation,
  getConversation,
  addMessage,
  updateMessageById,
} from '../../../src/main/services/conversation.service'

const SPACE = 'space-1'

describe('updateMessageById', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('patches only the targeted message, leaving everything else untouched', () => {
    const conv = createConversation(SPACE)
    const first = addMessage(SPACE, conv.id, { role: 'user', content: 'hello' })
    const second = addMessage(SPACE, conv.id, { role: 'assistant', content: 'hi', toolCalls: [] })

    const patched = updateMessageById(SPACE, conv.id, first.id, {
      role: 'system',
      source: 'cross-conversation',
      content: 'hello (patched)',
    })

    expect(patched?.role).toBe('system')
    expect(patched?.content).toBe('hello (patched)')

    const stored = getConversation(SPACE, conv.id)
    expect(stored?.messages).toHaveLength(2)
    expect(stored?.messages[0]).toMatchObject({ id: first.id, role: 'system', content: 'hello (patched)' })
    // The second message is completely unaffected.
    expect(stored?.messages[1]).toMatchObject({ id: second.id, role: 'assistant', content: 'hi' })
  })

  it('does not lose a message added by another writer in between — the exact bug a whole-array snapshot write has', () => {
    const conv = createConversation(SPACE)
    const target = addMessage(SPACE, conv.id, { role: 'user', content: 'will be patched' })

    // Simulate a concurrent writer (e.g. the session consumer's assistant
    // placeholder) landing AFTER `target` was created but BEFORE it gets
    // patched — `updateMessageById` must see it because it re-reads fresh.
    const concurrent = addMessage(SPACE, conv.id, { role: 'assistant', content: '', toolCalls: [] })

    updateMessageById(SPACE, conv.id, target.id, { role: 'system', source: 'cross-conversation' })

    const stored = getConversation(SPACE, conv.id)
    expect(stored?.messages).toHaveLength(2)
    expect(stored?.messages.find((m) => m.id === concurrent.id)).toMatchObject({
      role: 'assistant',
      content: '',
    })
    expect(stored?.messages.find((m) => m.id === target.id)).toMatchObject({ role: 'system' })
  })

  it('returns null for a conversation that does not exist', () => {
    expect(updateMessageById(SPACE, 'no-such-conversation', 'msg-1', { content: 'x' })).toBeNull()
  })

  it('returns null for a message id that does not exist in an existing conversation', () => {
    const conv = createConversation(SPACE)
    addMessage(SPACE, conv.id, { role: 'user', content: 'hi' })
    expect(updateMessageById(SPACE, conv.id, 'no-such-message', { content: 'x' })).toBeNull()
  })

  it('bumps updatedAt on a successful patch', () => {
    const conv = createConversation(SPACE)
    const msg = addMessage(SPACE, conv.id, { role: 'user', content: 'hi' })
    const before = getConversation(SPACE, conv.id)?.updatedAt

    updateMessageById(SPACE, conv.id, msg.id, { content: 'edited' })

    const after = getConversation(SPACE, conv.id)?.updatedAt
    expect(after).toBeDefined()
    expect(new Date(after!).getTime()).toBeGreaterThanOrEqual(new Date(before!).getTime())
  })
})
