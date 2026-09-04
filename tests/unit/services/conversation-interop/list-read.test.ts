/**
 * Unit tests for conversation-interop/list-read.
 *
 * The service is real; only its IO boundaries (fs, space registry, config,
 * KB seed) are mocked as an in-memory disk — same harness as
 * conversation-title-ownership.test.ts. `isNativeConversationBusy` is mocked
 * directly so these tests don't have to drag in session-manager.
 *
 * Covers:
 * - the caller's own conversation never appears in the list
 * - list pagination (nextCursor / total) and invalid-cursor handling
 * - read mode returns only `messages` content — never touches thoughts
 * - bounded read pagination: most-recent-first, char-budget-bounded,
 *   hiddenBefore/nextCursor accounting, at-least-one-message guarantee
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => {
  const files = new Map<string, string>()
  // A "directory" is never a literal key in this flat file map — treat it as
  // existing when it holds at least one file, so fullScanConversations's own
  // `existsSync(conversationsDir)` guard doesn't short-circuit to empty.
  const existsSync = (p: string): boolean => {
    if (files.has(p)) return true
    const prefix = p.endsWith('/') ? p : `${p}/`
    for (const key of files.keys()) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }
  return {
    __disk: files,
    existsSync,
    readFileSync: (p: string) => {
      const data = files.get(p)
      if (data === undefined) throw new Error(`ENOENT: ${p}`)
      return data
    },
    writeFileSync: (p: string, data: string) => {
      files.set(p, data)
    },
    mkdirSync: () => undefined,
    readdirSync: (p: string) => [...files.keys()].filter((k) => k.startsWith(p)).map((k) => k.split('/').pop() as string),
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

vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: (spaceId: string) => ({ id: spaceId, path: `/spaces/${spaceId}`, isTemp: false }),
  touchSpaceActivity: () => undefined,
}))
vi.mock('../../../../src/main/services/tlon', () => ({ getSeedKBIds: () => [] }))
vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => undefined }))

const { isNativeConversationBusy } = vi.hoisted(() => ({ isNativeConversationBusy: vi.fn(() => false) }))
vi.mock('../../../../src/main/services/conversation-interop/busy', () => ({ isNativeConversationBusy }))

import { randomUUID } from 'crypto'
import { createConversation, addMessage, updateLastMessage } from '../../../../src/main/services/conversation.service'
import { listConversationsForInterop, readConversationForInterop } from '../../../../src/main/services/conversation-interop/list-read'

// A fresh space id per test: `listConversations` scans its whole directory,
// and `createConversation`'s index update defers to an async `setImmediate`
// rebuild the first time a space's index.json doesn't exist yet. That deferred
// rebuild can fire during a LATER test (vitest ticks the event loop between
// `it` blocks) and overwrite a shared directory's index with a stale scan.
// Distinct per-test space directories make that leftover callback a no-op
// against anyone else's data instead of a source of flakiness.
let SPACE: string

describe('listConversationsForInterop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isNativeConversationBusy.mockReturnValue(false)
    SPACE = `space-${randomUUID()}`
  })

  it('excludes the caller itself', () => {
    const self = createConversation(SPACE, 'Self')
    const other = createConversation(SPACE, 'Other')

    const result = listConversationsForInterop(SPACE, self.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.page.items.map((i) => i.id)).toEqual([other.id])
    expect(result.page.total).toBe(1)
  })

  it('paginates and reports nextCursor only when more remain', () => {
    const self = createConversation(SPACE, 'Self')
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(createConversation(SPACE, `Conv ${i}`).id)

    const page1 = listConversationsForInterop(SPACE, self.id, undefined, 2)
    expect(page1.ok).toBe(true)
    if (!page1.ok) return
    expect(page1.page.items).toHaveLength(2)
    expect(page1.page.total).toBe(5)
    expect(page1.page.nextCursor).toBe('2')

    const page3 = listConversationsForInterop(SPACE, self.id, '4', 2)
    expect(page3.ok).toBe(true)
    if (!page3.ok) return
    expect(page3.page.items).toHaveLength(1)
    expect(page3.page.nextCursor).toBeUndefined()
  })

  it('rejects a malformed cursor', () => {
    const self = createConversation(SPACE, 'Self')
    const result = listConversationsForInterop(SPACE, self.id, 'not-a-number')
    expect(result).toEqual({ ok: false, reason: 'invalid_cursor' })
  })

  it('projects the running flag from isNativeConversationBusy per row', () => {
    const self = createConversation(SPACE, 'Self')
    const busy = createConversation(SPACE, 'Busy one')
    isNativeConversationBusy.mockImplementation((id: string) => id === busy.id)

    const result = listConversationsForInterop(SPACE, self.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.page.items.find((i) => i.id === busy.id)?.running).toBe(true)
  })
})

describe('readConversationForInterop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isNativeConversationBusy.mockReturnValue(false)
    SPACE = `space-${randomUUID()}`
  })

  it('returns not_found for a missing conversation', () => {
    const result = readConversationForInterop(SPACE, 'does-not-exist')
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('reads only message content, oldest-first, never the thoughts stream', () => {
    const conv = createConversation(SPACE, 'Thread')
    addMessage(SPACE, conv.id, { role: 'user', content: 'hello' })
    addMessage(SPACE, conv.id, { role: 'assistant', content: 'hi there', toolCalls: [] })
    updateLastMessage(SPACE, conv.id, {
      content: 'hi there',
      thoughts: [{ id: 't1', type: 'thinking', content: 'secret reasoning', timestamp: new Date().toISOString() }],
    })

    const result = readConversationForInterop(SPACE, conv.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.page.lines.map((l) => l.content)).toEqual(['hello', 'hi there'])
    expect(result.page.lines.map((l) => l.role)).toEqual(['user', 'assistant'])
    // No line carries anything resembling the thoughts payload.
    expect(JSON.stringify(result.page.lines)).not.toContain('secret reasoning')
    expect(result.page.hiddenBefore).toBe(0)
    expect(result.page.nextCursor).toBeUndefined()
  })

  it('bounds a page by character budget, always including at least one message', () => {
    const conv = createConversation(SPACE, 'Long thread')
    for (let i = 0; i < 5; i++) addMessage(SPACE, conv.id, { role: 'user', content: 'x'.repeat(50) })

    const result = readConversationForInterop(SPACE, conv.id, undefined, 120)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 120-char budget over 50-char messages: 2 fit (100 chars), a 3rd would exceed it.
    expect(result.page.lines).toHaveLength(2)
    expect(result.page.totalMessages).toBe(5)
    expect(result.page.hiddenBefore).toBe(3)
    expect(result.page.nextCursor).toBe('2')
  })

  it('always includes at least one message even if it alone exceeds the budget', () => {
    const conv = createConversation(SPACE, 'One huge message')
    addMessage(SPACE, conv.id, { role: 'user', content: 'x'.repeat(500) })

    const result = readConversationForInterop(SPACE, conv.id, undefined, 10)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.page.lines).toHaveLength(1)
  })

  it('pages backwards with a cursor, continuing from just before what was already shown', () => {
    const conv = createConversation(SPACE, 'Paged thread')
    for (let i = 0; i < 4; i++) addMessage(SPACE, conv.id, { role: 'user', content: `msg-${i}` })

    const page1 = readConversationForInterop(SPACE, conv.id, undefined, 1000)
    expect(page1.ok).toBe(true)
    if (!page1.ok) return
    // Budget covers everything in one page — nothing to cursor into.
    expect(page1.page.lines.map((l) => l.content)).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3'])

    // Force one message per page to exercise the cursor explicitly.
    const firstPage = readConversationForInterop(SPACE, conv.id, undefined, 1)
    expect(firstPage.ok).toBe(true)
    if (!firstPage.ok) return
    expect(firstPage.page.lines.map((l) => l.content)).toEqual(['msg-3'])
    expect(firstPage.page.nextCursor).toBe('1')

    const secondPage = readConversationForInterop(SPACE, conv.id, firstPage.page.nextCursor, 1)
    expect(secondPage.ok).toBe(true)
    if (!secondPage.ok) return
    expect(secondPage.page.lines.map((l) => l.content)).toEqual(['msg-2'])
  })

  it('rejects a cursor beyond the message count', () => {
    const conv = createConversation(SPACE, 'Short')
    addMessage(SPACE, conv.id, { role: 'user', content: 'only one' })
    const result = readConversationForInterop(SPACE, conv.id, '99')
    expect(result).toEqual({ ok: false, reason: 'invalid_cursor' })
  })
})
