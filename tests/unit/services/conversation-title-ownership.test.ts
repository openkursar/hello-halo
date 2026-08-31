/**
 * Title ownership regression tests for #307.
 *
 * addMessage used to overwrite the title unconditionally on the first user
 * message, so a rename that happened before the second message (or before
 * the first) was silently clobbered. The fix: updateConversation marks the
 * conversation titleCustomized when a title update arrives, and addMessage's
 * auto-title respects that flag. Legacy conversations without the field keep
 * the old auto-title behavior — no migration.
 *
 * The service is real; only its IO boundaries (fs, space registry, config,
 * KB seed) are mocked as an in-memory disk.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('fs', () => {
  const files = new Map<string, string>()
  return {
    __disk: files,
    existsSync: (p: string) => files.has(p),
    // Index-aware readers: callers pass either a conversation file or the
    // index.json — serve whichever the map holds.
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
  getSpace: (spaceId: string) => ({
    id: spaceId,
    path: `/spaces/${spaceId}`,
    isTemp: false,
  }),
  touchSpaceActivity: () => undefined,
}))

vi.mock('../../../src/main/services/tlon', () => ({
  getSeedKBIds: () => [],
}))

vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: () => undefined,
}))

import {
  createConversation,
  getConversation,
  updateConversation,
  addMessage,
} from '../../../src/main/services/conversation.service'

const SPACE = 'space-1'

describe('conversation title ownership (#307)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('auto-titles from the first user message when nobody renamed', () => {
    const conv = createConversation(SPACE)
    addMessage(SPACE, conv.id, { role: 'user', content: 'Deploy the staging cluster please' })

    const stored = getConversation(SPACE, conv.id)
    expect(stored?.title).toBe('Deploy the staging cluster please')
  })

  it('a rename before the first message survives that message (core #307)', () => {
    const conv = createConversation(SPACE)
    updateConversation(SPACE, conv.id, { title: 'My session name' })
    addMessage(SPACE, conv.id, { role: 'user', content: 'first message body' })

    const stored = getConversation(SPACE, conv.id)
    expect(stored?.title).toBe('My session name')
    expect(stored?.titleCustomized).toBe(true)
  })

  it('a rename between first and second message survives (original repro)', () => {
    const conv = createConversation(SPACE)
    addMessage(SPACE, conv.id, { role: 'user', content: 'first message body' })
    updateConversation(SPACE, conv.id, { title: 'Renamed after first' })
    addMessage(SPACE, conv.id, { role: 'assistant', content: 'ack' })

    const stored = getConversation(SPACE, conv.id)
    expect(stored?.title).toBe('Renamed after first')
  })

  it('non-title updates never set the flag (toolsets pin stays rename-only)', () => {
    const conv = createConversation(SPACE)
    updateConversation(SPACE, conv.id, { toolsets: ['ai-browser'] })

    const stored = getConversation(SPACE, conv.id)
    expect(stored?.titleCustomized).toBeUndefined()
  })

  it('auto-title still fires for legacy conversations lacking the flag', () => {
    // Old data: field absent. Writing any update without a title must not
    // manufacture the flag, and the first-message auto-title must still apply.
    const conv = createConversation(SPACE)
    addMessage(SPACE, conv.id, { role: 'user', content: 'legacy first message' })

    const stored = getConversation(SPACE, conv.id)
    expect(stored?.titleCustomized).toBeUndefined()
    expect(stored?.title).toBe('legacy first message')
  })
})
