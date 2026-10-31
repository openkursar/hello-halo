import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import { join } from 'path'
import { initializeApp } from '../../../src/main/foundation/config.service'
import {
  _resetActivityState, _resetSpaceRegistry, createSpace, deleteSpace, forgetSpace, getHaloSpace,
} from '../../../src/main/services/space.service'
import {
  addMessage, createConversation, deleteConversation, flushAllPendingIndexWrites, getConversation,
  listConversations, toggleStarConversation, updateConversation, type Conversation, type ConversationMeta,
} from '../../../src/main/services/conversation.service'

vi.mock('../../../src/main/services/tlon', () => ({ getSeedKBIds: () => [] }))
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync), readdirSync: vi.fn(actual.readdirSync),
    writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync),
  }
})

function directory(space: { path: string; isTemp: boolean }) {
  return join(space.path, ...(space.isTemp ? [] : ['.halo']), 'conversations')
}

function stored(directory: string, id: string): Conversation {
  return JSON.parse(fs.readFileSync(join(directory, `${id}.json`), 'utf8'))
}

function index(directory: string): ConversationMeta[] {
  return JSON.parse(fs.readFileSync(join(directory, 'index.json'), 'utf8')).conversations
}

async function settleIndexes() {
  flushAllPendingIndexWrites()
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('conversation lists during pending index writes', () => {
  beforeEach(async () => {
    _resetActivityState()
    _resetSpaceRegistry()
    await initializeApp()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await settleIndexes()
    _resetActivityState()
    vi.restoreAllMocks()
  })

  it('lists the first-message title and preview immediately while keeping the index write delayed', async () => {
    const space = getHaloSpace()
    const conversation = createConversation(space.id)
    const dir = directory(space)
    await settleIndexes()
    const initialIndex = fs.readFileSync(join(dir, 'index.json'), 'utf8')
    const originalTitle = index(dir)[0].title
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const title = 'The first question names this conversation'
    addMessage(space.id, conversation.id, { role: 'user', content: title })
    const body = stored(dir, conversation.id)
    const listed = listConversations(space.id).find(item => item.id === conversation.id)
    expect(body).toMatchObject({ title, messageCount: 1 })
    expect(getConversation(space.id, conversation.id)?.title).toBe(title)
    expect(index(dir)[0].title).toBe(originalTitle)
    expect(fs.readFileSync(join(dir, 'index.json'), 'utf8')).toBe(initialIndex)
    expect(listed).toMatchObject({ title, messageCount: 1, preview: title })
    await vi.advanceTimersByTimeAsync(499)
    expect(fs.readFileSync(join(dir, 'index.json'), 'utf8')).toBe(initialIndex)
    await vi.advanceTimersByTimeAsync(1)
    expect(index(dir).find(item => item.id === conversation.id)).toEqual(listed)
    expect(stored(dir, conversation.id).title).toBe(title)
  })

  it('lists the latest manual name without reading full conversations or writing the index', async () => {
    const space = await createSpace({ name: 'List consistency', icon: 'folder' })
    const first = createConversation(space.id, 'Original name')
    const control = createConversation(space.id, 'Unrelated name')
    const dir = directory(space)
    await settleIndexes()
    const initialIndex = fs.readFileSync(join(dir, 'index.json'), 'utf8')
    const controlBytes = fs.readFileSync(join(dir, `${control.id}.json`), 'utf8')
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(Date.now() + 1000)
    updateConversation(space.id, first.id, { title: 'Intermediate name' })
    vi.setSystemTime(Date.now() + 1000)
    updateConversation(space.id, first.id, { title: 'Current user name' })
    for (const spy of [fs.readFileSync, fs.readdirSync, fs.writeFileSync, fs.renameSync]) vi.mocked(spy).mockClear()
    const listed = listConversations(space.id)
    expect(vi.mocked(fs.readFileSync).mock.calls.map(([file]) => file)).toEqual([join(dir, 'index.json')])
    expect(fs.readdirSync).not.toHaveBeenCalled()
    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(fs.renameSync).not.toHaveBeenCalled()
    expect(listed.map(item => item.id)).toEqual([first.id, control.id])
    expect(listed[0]).toMatchObject({ title: 'Current user name', titleCustomized: true })
    expect(stored(dir, first.id).title).toBe('Current user name')
    expect(fs.readFileSync(join(dir, 'index.json'), 'utf8')).toBe(initialIndex)
    expect(fs.readFileSync(join(dir, `${control.id}.json`), 'utf8')).toBe(controlBytes)
    await vi.advanceTimersByTimeAsync(500)
    expect(index(dir)).toEqual(listed)
  })

  it('keeps immediate pin changes ahead of older pending metadata and accepts a later rename', async () => {
    const space = getHaloSpace()
    const conversation = createConversation(space.id, 'Original name')
    const dir = directory(space)
    await settleIndexes()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    updateConversation(space.id, conversation.id, { title: 'Name before pin' })
    toggleStarConversation(space.id, conversation.id, true)
    expect(index(dir)[0]).toMatchObject({ title: 'Name before pin', starred: true, titleCustomized: true })
    expect(listConversations(space.id)[0]).toMatchObject({ title: 'Name before pin', starred: true })
    updateConversation(space.id, conversation.id, { title: 'Name after pin' })
    expect(listConversations(space.id)[0]).toMatchObject({ title: 'Name after pin', starred: true })
    await vi.advanceTimersByTimeAsync(500)
    expect(index(dir)[0]).toMatchObject({ title: 'Name after pin', starred: true })
    expect(stored(dir, conversation.id)).toMatchObject({ title: 'Name after pin', starred: true })
  })

  it('does not expose pending records to mutation by a list reader', async () => {
    const space = getHaloSpace()
    const conversation = createConversation(space.id, 'Original name')
    const dir = directory(space)
    await settleIndexes()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    updateConversation(space.id, conversation.id, { title: 'Saved user name' })
    const result = listConversations(space.id)
    result[0].title = 'Caller-only mutation'
    result[0].messageCount = 900
    result[0].starred = true
    result.reverse()
    expect(listConversations(space.id)[0]).toMatchObject({ title: 'Saved user name', messageCount: 0 })
    expect(listConversations(space.id)[0].starred).toBeUndefined()
    await vi.advanceTimersByTimeAsync(500)
    expect(index(dir)[0]).toMatchObject({ title: 'Saved user name', messageCount: 0 })
    expect(index(dir)[0].starred).toBeUndefined()
    expect(stored(dir, conversation.id)).toMatchObject({ title: 'Saved user name', messageCount: 0 })
  })

  it('preserves the persisted tie order while merging pending updates', async () => {
    const space = getHaloSpace()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
    createConversation(space.id, 'First')
    createConversation(space.id, 'Second')
    createConversation(space.id, 'Third')
    await settleIndexes()
    const initial = listConversations(space.id).map(meta => meta.id)
    updateConversation(space.id, initial[1], { title: 'Changed middle record' })
    updateConversation(space.id, initial[0], { title: 'Changed first record' })
    expect(listConversations(space.id).map(meta => meta.id)).toEqual(initial)
    await vi.advanceTimersByTimeAsync(500)
    expect(index(directory(space)).map(meta => meta.id)).toEqual(initial)
  })

  it('does not restore a deleted conversation from its pending metadata', async () => {
    const space = getHaloSpace()
    const removed = createConversation(space.id, 'Remove this')
    const retained = createConversation(space.id, 'Keep this')
    const dir = directory(space)
    await settleIndexes()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    updateConversation(space.id, removed.id, { title: 'Queued before deletion' })
    updateConversation(space.id, retained.id, { title: 'Retained current name' })
    expect(deleteConversation(space.id, removed.id)).toBe(true)
    expect(listConversations(space.id)).toEqual([expect.objectContaining({ id: retained.id, title: 'Retained current name' })])
    await vi.advanceTimersByTimeAsync(500)
    expect(index(dir)).toEqual([expect.objectContaining({ id: retained.id, title: 'Retained current name' })])
    expect(fs.existsSync(join(dir, `${removed.id}.json`))).toBe(false)
  })

  it('keeps ephemeral pending entries out of the public list', async () => {
    const space = getHaloSpace()
    const visible = createConversation(space.id, 'Visible')
    const hidden = createConversation(space.id, 'Internal', undefined, { ephemeral: true })
    await settleIndexes()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    updateConversation(space.id, visible.id, { title: 'Visible current name' })
    addMessage(space.id, hidden.id, { role: 'user', content: 'Private backing conversation' })
    expect(listConversations(space.id)).toEqual([expect.objectContaining({ id: visible.id, title: 'Visible current name' })])
    await vi.advanceTimersByTimeAsync(500)
    expect(index(directory(space))).toHaveLength(2)
    expect(listConversations(space.id).map(item => item.id)).toEqual([visible.id])
  })

  it('does not recreate a removed workspace when its delayed index write fires', async () => {
    const space = await createSpace({ name: 'Delete pending workspace', icon: 'folder' })
    const conversation = createConversation(space.id, 'Old name')
    await settleIndexes()
    updateConversation(space.id, conversation.id, { title: 'Queued name' })
    expect(await deleteSpace(space.id)).toBe(true)
    expect(() => listConversations(space.id)).toThrow('Space not found')
    await settleIndexes()
    expect(fs.existsSync(space.path)).toBe(false)
  })

  it('does not apply pending metadata after a forgotten workspace folder returns', async () => {
    const space = await createSpace({ name: 'Forget pending workspace', icon: 'folder' })
    const conversation = createConversation(space.id, 'Old name')
    const dir = directory(space)
    await settleIndexes()
    const initialIndex = fs.readFileSync(join(dir, 'index.json'), 'utf8')
    updateConversation(space.id, conversation.id, { title: 'Queued name' })
    const offline = `${space.path}.offline`
    fs.renameSync(space.path, offline)
    expect(await forgetSpace(space.id)).toBe(true)
    fs.renameSync(offline, space.path)
    expect(() => listConversations(space.id)).toThrow('Space not found')
    await settleIndexes()
    expect(fs.readFileSync(join(dir, 'index.json'), 'utf8')).toBe(initialIndex)
    expect(stored(dir, conversation.id).title).toBe('Queued name')
  })
})
