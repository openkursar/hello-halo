import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import { join } from 'path'
import { initializeApp } from '../../../src/main/foundation/config.service'
import {
  _resetActivityState, _resetSpaceRegistry, createSpace, deleteSpace, forgetSpace,
  getHaloSpace, hasSpace,
} from '../../../src/main/services/space.service'
import {
  addMessage, createConversation, deleteConversation, flushAllPendingIndexWrites,
  getConversation, getConversationFrom, getMessageThoughts,
  saveSessionId, toggleStarConversation, updateConversation, updateLastMessage,
} from '../../../src/main/services/conversation.service'

vi.mock('../../../src/main/services/tlon', () => ({ getSeedKBIds: () => [] }))
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync), statSync: vi.fn(actual.statSync),
    readFileSync: vi.fn(actual.readFileSync), readdirSync: vi.fn(actual.readdirSync),
  }
})

async function settleIndexes() {
  flushAllPendingIndexWrites()
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('conversation cache ownership and workspace lifecycle', () => {
  beforeEach(async () => {
    _resetActivityState()
    _resetSpaceRegistry()
    await initializeApp()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await settleIndexes()
    _resetActivityState()
  })

  it('refuses cached history and late writes after deleting its workspace', async () => {
    const space = await createSpace({ name: 'Removed workspace', icon: 'folder' })
    const control = await createSpace({ name: 'Retained workspace', icon: 'folder' })
    const removed = createConversation(space.id, 'Removed history')
    const retained = createConversation(control.id, 'Retained history')
    const message = addMessage(space.id, removed.id, { role: 'assistant', content: 'Deleted evidence' })
    updateLastMessage(space.id, removed.id, { thoughts: [{ id: 'thought', type: 'text', content: 'Deleted reasoning', timestamp: '2026-01-01T00:00:00Z' }] })
    addMessage(control.id, retained.id, { role: 'assistant', content: 'Retained evidence' })
    await settleIndexes()
    expect(getConversation(space.id, removed.id)?.messages).toHaveLength(1)
    expect(await deleteSpace(space.id)).toBe(true)

    expect(getConversation(space.id, removed.id)).toBeNull()
    expect(getConversationFrom(space.id, removed.id, message.id)).toBeNull()
    expect(updateConversation(space.id, removed.id, { title: 'Late title' })).toBeNull()
    expect(toggleStarConversation(space.id, removed.id, true)).toBeNull()
    expect(() => addMessage(space.id, removed.id, { role: 'assistant', content: 'Late reply' })).toThrow('Conversation not found')
    expect(() => saveSessionId(space.id, removed.id, 'late-session')).not.toThrow()
    expect(() => getMessageThoughts(space.id, removed.id, message.id)).toThrow('Space not found')
    await settleIndexes()
    expect(fs.existsSync(space.path)).toBe(false)
    expect(getConversation(control.id, retained.id)?.messages[0].content).toBe('Retained evidence')
  })

  it('forgets cached history without rewriting the retained offline files when they return', async () => {
    const space = await createSpace({ name: 'Forgotten workspace', icon: 'folder' })
    const conversation = createConversation(space.id, 'Retained on disk')
    await settleIndexes()
    const index = join(space.path, '.halo/conversations/index.json')
    const previousIndex = fs.readFileSync(index, 'utf8')
    addMessage(space.id, conversation.id, { role: 'assistant', content: 'Pending index entry' })
    const offline = `${space.path}.offline`
    fs.renameSync(space.path, offline)
    expect(await forgetSpace(space.id)).toBe(true)
    fs.renameSync(offline, space.path)

    expect(getConversation(space.id, conversation.id)).toBeNull()
    expect(updateLastMessage(space.id, conversation.id, { content: 'Rejected late edit' })).toBeNull()
    await settleIndexes()
    expect(fs.readFileSync(index, 'utf8')).toBe(previousIndex)
    const stored = JSON.parse(fs.readFileSync(join(space.path, '.halo/conversations', `${conversation.id}.json`), 'utf8'))
    expect(stored.messages[0].content).toBe('Pending index entry')
    expect(hasSpace(space.id)).toBe(false)
  })

  it('cancels a queued index rebuild after a workspace is forgotten', async () => {
    const space = await createSpace({ name: 'Queued rebuild workspace', icon: 'folder' })
    vi.useFakeTimers({ toFake: ['setImmediate'] })
    const conversation = createConversation(space.id, 'Queued history')
    const index = join(space.path, '.halo/conversations/index.json')
    expect(fs.existsSync(index)).toBe(false)
    const offline = `${space.path}.offline`
    fs.renameSync(space.path, offline)
    expect(await forgetSpace(space.id)).toBe(true)
    fs.renameSync(offline, space.path)
    await vi.runAllTimersAsync()
    vi.useRealTimers()
    expect(fs.existsSync(index)).toBe(false)
    expect(fs.existsSync(join(space.path, '.halo/conversations', `${conversation.id}.json`))).toBe(true)
  })

  it('keeps a registered workspace cache readable while its drive is unavailable', async () => {
    const space = await createSpace({ name: 'Offline workspace', icon: 'folder' })
    const conversation = createConversation(space.id, 'Offline history')
    addMessage(space.id, conversation.id, { role: 'assistant', content: 'Available cached evidence' })
    await settleIndexes()
    const cached = getConversation(space.id, conversation.id)
    const offline = `${space.path}.offline`
    fs.renameSync(space.path, offline)
    expect(hasSpace(space.id)).toBe(true)
    expect(getConversation(space.id, conversation.id)).toBe(cached)
    fs.renameSync(offline, space.path)
  })

  it('isolates reading, writing and eviction for the same conversation id in two workspaces', async () => {
    const first = await createSpace({ name: 'First workspace', icon: 'folder' })
    const second = await createSpace({ name: 'Second workspace', icon: 'folder' })
    const conversation = createConversation(first.id, 'First identity')
    addMessage(first.id, conversation.id, { role: 'assistant', content: 'First workspace evidence' })
    await settleIndexes()
    const firstCached = getConversation(first.id, conversation.id)!
    const secondDir = join(second.path, '.halo/conversations')
    fs.mkdirSync(secondDir, { recursive: true })
    fs.writeFileSync(join(secondDir, `${conversation.id}.json`), JSON.stringify({
      ...firstCached, spaceId: second.id, title: 'Second identity',
      messages: [{ ...firstCached.messages[0], content: 'Second workspace evidence' }],
    }))
    const secondCached = getConversation(second.id, conversation.id)!
    expect(secondCached.messages[0].content).toBe('Second workspace evidence')
    expect(secondCached).not.toBe(firstCached)
    expect(getConversation(first.id, conversation.id)).toBe(firstCached)
    updateConversation(second.id, conversation.id, { title: 'Changed second identity' })
    expect(getConversation(first.id, conversation.id)?.title).toBe('First identity')
    expect(getConversation(second.id, conversation.id)?.title).toBe('Changed second identity')
    const currentSecond = getConversation(second.id, conversation.id)
    expect(deleteConversation(first.id, conversation.id)).toBe(true)
    expect(getConversation(second.id, conversation.id)).toBe(currentSecond)
    expect(JSON.parse(fs.readFileSync(join(secondDir, `${conversation.id}.json`), 'utf8')).title).toBe('Changed second identity')
  })

  it('does not borrow another workspace cache when the requested history does not exist', async () => {
    const first = await createSpace({ name: 'Owning workspace', icon: 'folder' })
    const second = await createSpace({ name: 'Different workspace', icon: 'folder' })
    const conversation = createConversation(first.id, 'Owned history')
    const original = getConversation(first.id, conversation.id)
    expect(getConversation(second.id, conversation.id)).toBeNull()
    expect(updateConversation(second.id, conversation.id, { title: 'Wrong workspace edit' })).toBeNull()
    expect(getConversation('unregistered-space', conversation.id)).toBeNull()
    expect(getConversation(first.id, conversation.id)).toBe(original)
    expect(original?.title).toBe('Owned history')
  })

  it('loads registration lazily including the default workspace and keeps cache hits free of filesystem reads', async () => {
    const space = await createSpace({ name: 'Known workspace', icon: 'folder' })
    const conversation = createConversation(space.id, 'Known history')
    const defaultConversation = createConversation('halo-temp', 'Default history')
    await settleIndexes()
    _resetSpaceRegistry()
    expect(hasSpace('halo-temp')).toBe(true)
    expect(hasSpace(space.id)).toBe(true)
    expect(hasSpace('unregistered-space')).toBe(false)
    expect(getHaloSpace().id).toBe('halo-temp')
    const filesystemReads = [
      vi.mocked(fs.existsSync), vi.mocked(fs.statSync),
      vi.mocked(fs.readFileSync), vi.mocked(fs.readdirSync),
    ]
    for (const read of filesystemReads) read.mockClear()
    expect(getConversation(space.id, conversation.id)?.title).toBe('Known history')
    expect(getConversation('halo-temp', defaultConversation.id)?.title).toBe('Default history')
    expect(hasSpace(space.id)).toBe(true)
    for (const read of filesystemReads) expect(read).not.toHaveBeenCalled()
  })
})
