/**
 * Conversation search: space conversations from their files, digital-human
 * sessions through the registered conversation sources, never the thoughts file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const env = vi.hoisted(() => ({
  haloDir: '',
  tempPath: '',
  spaces: new Map<string, { id: string; name: string; path: string }>(),
  sources: [] as unknown[],
}))

vi.mock('../../../src/main/foundation/config.service', () => ({
  getHaloDir: () => env.haloDir,
  getTempSpacePath: () => env.tempPath,
}))
vi.mock('../../../src/main/services/space.service', () => ({
  getSpace: (id: string) => env.spaces.get(id) ?? null,
  listSpaces: () => [...env.spaces.values()],
}))
vi.mock('../../../src/main/services/conversation-interop', () => ({
  CHAT_SOURCE_KIND: 'chat',
  getReadableSources: () => env.sources,
}))

import { SearchService } from '../../../src/main/services/search.service'

const message = (id: string, content: string, at: number, role = 'user') => ({
  id,
  role,
  content,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, at)).toISOString(),
})

function writeConversation(dir: string, id: string, spaceId: string, title: string, messages: unknown[]) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, spaceId, title, createdAt: '', updatedAt: '', messageCount: messages.length, messages }))
}

function digitalHumanSource(sessions: Record<string, { title: string; lines: unknown[]; unavailable?: string }>) {
  return {
    kind: 'digital-human',
    capabilities: { readable: true, writable: true },
    owns: (id: string) => id.startsWith('app-chat:'),
    list: (spaceId: string) => (spaceId === 'space-a' ? Object.entries(sessions).map(([id, s]) => ({ id, title: s.title, updatedAt: '', messageCount: s.lines.length, ...(s.unavailable ? { unavailable: s.unavailable } : {}) })) : []),
    getMeta: (spaceId: string, id: string) => (spaceId === 'space-a' && sessions[id] ? { id, title: sessions[id].title, updatedAt: '', messageCount: 0 } : null),
    readTranscript: (_space: string, id: string) => sessions[id]?.lines ?? null,
  }
}

const chatSource = { kind: 'chat', capabilities: { readable: true, writable: true }, owns: () => true, list: () => { throw new Error('the chat source must not be used') } }

let service: SearchService
beforeEach(() => {
  env.haloDir = mkdtempSync(join(tmpdir(), 'halo-search-'))
  env.tempPath = join(env.haloDir, 'temp')
  env.spaces.clear()
  env.spaces.set('space-a', { id: 'space-a', name: 'Alpha', path: join(env.haloDir, 'spaces', 'space-a') })
  env.spaces.set('space-b', { id: 'space-b', name: 'Beta', path: join(env.haloDir, 'spaces', 'space-b') })
  env.sources = [chatSource]
  service = new SearchService()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  rmSync(env.haloDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const convDir = (spaceId: string) => join(env.spaces.get(spaceId)!.path, '.halo', 'conversations')

describe('space conversations', () => {
  it('finds matches with context, newest first, tagged as chat results', async () => {
    writeConversation(convDir('space-a'), 'c1', 'space-a', 'Trip', [
      message('m1', 'we should plan the Budget early', 1),
      message('m2', 'nothing here', 2),
      message('m3', 'budget budget', 3, 'assistant'),
    ])
    const results = await service.search('budget', 'space', undefined, 'space-a')
    expect(results.map((r) => [r.messageId, r.matchCount, r.messageRole])).toEqual([
      ['m3', 2, 'assistant'],
      ['m1', 1, 'user'],
    ])
    expect(results[1]).toMatchObject({
      kind: 'chat',
      conversationId: 'c1',
      conversationTitle: 'Trip',
      spaceName: 'Alpha',
      contextBefore: 'we should plan the',
      contextAfter: 'early',
    })
  })

  it('never reads the thoughts file as a conversation (and does not log an error for it)', async () => {
    const dir = convDir('space-a')
    writeConversation(dir, 'c1', 'space-a', 'Trip', [message('m1', 'needle', 1)])
    writeFileSync(join(dir, 'c1.thoughts.json'), JSON.stringify({ version: 1, conversationId: 'c1', messages: { m1: [{ id: 't', type: 'thinking', content: 'needle needle', timestamp: '' }] } }))
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, conversations: [] }))

    const results = await service.search('needle', 'space', undefined, 'space-a')
    expect(results).toHaveLength(1)
    expect(results[0].messageId).toBe('m1')
    expect(console.error).not.toHaveBeenCalled()
  })

  it('treats the query literally: regex characters neither throw nor widen the match', async () => {
    writeConversation(convDir('space-a'), 'c1', 'space-a', 'T', [
      message('m1', 'use c++ (carefully) [now]', 1),
      message('m2', 'use cccc', 2),
    ])
    expect((await service.search('c++', 'space', undefined, 'space-a')).map((r) => r.messageId)).toEqual(['m1'])
    expect((await service.search('(carefully', 'space', undefined, 'space-a')).map((r) => r.messageId)).toEqual(['m1'])
    expect(await service.search('.*', 'space', undefined, 'space-a')).toEqual([])
    expect(console.error).not.toHaveBeenCalled()
  })

  it('searches one conversation for the conversation scope, wherever it lives', async () => {
    writeConversation(convDir('space-a'), 'c1', 'space-a', 'One', [message('m1', 'alpha', 1)])
    writeConversation(convDir('space-b'), 'c2', 'space-b', 'Two', [message('m2', 'alpha', 2)])
    const results = await service.search('alpha', 'conversation', 'c2', 'space-a')
    expect(results.map((r) => r.conversationId)).toEqual(['c2'])
    expect(results[0].spaceName).toBe('Beta')
  })

  it('finds temp-space conversations in the global scope and skips unreadable files', async () => {
    writeConversation(join(env.tempPath, 'conversations'), 't1', 'halo-temp', 'Temp', [message('m1', 'hello world', 1)])
    writeFileSync(join(env.tempPath, 'conversations', 'broken.json'), '{not json')
    const results = await service.search('hello', 'global')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ spaceId: 'halo-temp', spaceName: 'Halo' })
  })

  it('leaves out an ephemeral conversation (the knowledge base chat), in every scope', async () => {
    const dir = join(env.tempPath, 'conversations')
    writeConversation(dir, 'mine', 'halo-temp', 'Mine', [message('m1', 'refund policy', 1)])
    writeFileSync(join(dir, 'kb-chat.json'), JSON.stringify({
      id: 'kb-chat', spaceId: 'halo-temp', title: 'Ask: Docs', createdAt: '', updatedAt: '', messageCount: 1,
      ephemeral: true, messages: [message('m2', 'refund policy?', 2)],
    }))

    for (const results of [
      await service.search('refund', 'global'),
      await service.search('refund', 'space', undefined, 'halo-temp'),
    ]) {
      expect(results.map((r) => r.conversationId)).toEqual(['mine'])
    }
    expect(await service.search('refund', 'conversation', 'kb-chat', 'halo-temp')).toEqual([])
  })

  it('ignores an empty query', async () => {
    expect(await service.search('   ', 'global')).toEqual([])
  })
})

describe('digital-human sessions', () => {
  const sessions = {
    'app-chat:dh1': {
      title: 'Ada',
      lines: [
        { id: 'session-msg-1', role: 'user', content: 'please review the roadmap', timestamp: message('x', '', 5).timestamp },
        { id: 'session-msg-4', role: 'assistant', content: 'the roadmap looks fine', timestamp: message('x', '', 6).timestamp },
        { role: 'assistant', content: 'roadmap line without an id is not addressable', timestamp: message('x', '', 7).timestamp },
      ],
    },
    'app-chat:dh1:local:direct:s2': {
      title: 'Ada: other chat',
      lines: [{ id: 'session-msg-2', role: 'system', content: 'roadmap delivered from elsewhere', timestamp: message('x', '', 8).timestamp }],
    },
  }

  beforeEach(() => {
    env.sources = [chatSource, digitalHumanSource(sessions)]
  })

  it('searches a space\'s digital-human sessions and reports stable message ids', async () => {
    const results = await service.search('roadmap', 'space', undefined, 'space-a')
    expect(results.map((r) => [r.kind, r.appId, r.conversationId, r.messageId, r.messageRole])).toEqual([
      ['digital-human', 'dh1', 'app-chat:dh1:local:direct:s2', 'session-msg-2', 'system'],
      ['digital-human', 'dh1', 'app-chat:dh1', 'session-msg-4', 'assistant'],
      ['digital-human', 'dh1', 'app-chat:dh1', 'session-msg-1', 'user'],
    ])
    expect(results[1]).toMatchObject({ conversationTitle: 'Ada', spaceId: 'space-a', spaceName: 'Alpha' })
  })

  it('searches a session whose digital human keeps conversation collaboration off: the switch governs AI access, not the user\'s search', async () => {
    env.sources = [chatSource, digitalHumanSource({
      'app-chat:quiet': { title: 'Quiet', lines: [{ id: 'm1', role: 'user', content: 'the roadmap review', timestamp: '', source: undefined }], unavailable: 'collaboration is off' },
    })]
    const results = await service.search('roadmap', 'space', undefined, 'space-a')
    expect(results.map((r) => [r.kind, r.conversationId])).toEqual([['digital-human', 'app-chat:quiet']])
  })

  it('does not search digital-human sessions of another space', async () => {
    expect(await service.search('roadmap', 'space', undefined, 'space-b')).toEqual([])
  })

  it('searches sessions in every space for the global scope, next to space conversations', async () => {
    writeConversation(convDir('space-a'), 'c1', 'space-a', 'Plan', [message('m1', 'roadmap in a chat', 1)])
    const results = await service.search('roadmap', 'global')
    expect(results.filter((r) => r.kind === 'chat')).toHaveLength(1)
    expect(results.filter((r) => r.kind === 'digital-human')).toHaveLength(3)
  })

  it('searches one session for the conversation scope', async () => {
    const results = await service.search('roadmap', 'conversation', 'app-chat:dh1', 'space-a')
    expect(results.map((r) => r.messageId)).toEqual(['session-msg-4', 'session-msg-1'])
  })

  it('finds the session for the conversation scope even when the caller names no space', async () => {
    const results = await service.search('roadmap', 'conversation', 'app-chat:dh1')
    expect(results.map((r) => r.messageId)).toEqual(['session-msg-4', 'session-msg-1'])
    expect(results[0].spaceId).toBe('space-a')
  })

  it('a source that fails does not sink the search', async () => {
    writeConversation(convDir('space-a'), 'c1', 'space-a', 'Plan', [message('m1', 'roadmap in a chat', 1)])
    env.sources = [
      chatSource,
      { ...digitalHumanSource(sessions), list: () => { throw new Error('registry offline') } },
    ]
    const results = await service.search('roadmap', 'space', undefined, 'space-a')
    expect(results.map((r) => r.kind)).toEqual(['chat'])
  })

  it('never goes through the space conversation source (a global search must not churn its cache)', async () => {
    // chatSource.list throws if touched; reaching here without error is the assertion.
    await expect(service.search('roadmap', 'global')).resolves.toBeDefined()
  })
})

describe('cancellation and progress', () => {
  it('a new search supersedes one still running: the old one reports no more progress and no results', async () => {
    for (let i = 0; i < 5; i++) writeConversation(convDir('space-a'), `c${i}`, 'space-a', `T${i}`, [message('m', 'needle', i)])
    const firstProgress: number[] = []
    let second: Promise<unknown> | undefined
    const first = service.search('needle', 'space', undefined, 'space-a', (current) => {
      firstProgress.push(current)
      if (current === 1) second = service.search('needle', 'space', undefined, 'space-a')
    })
    expect(await first).toEqual([])
    expect(firstProgress).toEqual([1])
    expect(await second).toHaveLength(5)
  })

  it('cancel stops the search in flight but not one started afterwards', async () => {
    writeConversation(convDir('space-a'), 'c1', 'space-a', 'T', [message('m', 'needle', 1)])
    const running = service.search('needle', 'space', undefined, 'space-a')
    service.cancel()
    expect(await running).toEqual([])
    expect(await service.search('needle', 'space', undefined, 'space-a')).toHaveLength(1)
  })

  it('reports progress per transcript and stops when cancelled', async () => {
    for (let i = 0; i < 5; i++) writeConversation(convDir('space-a'), `c${i}`, 'space-a', `T${i}`, [message('m', 'needle', i)])
    const progress: number[] = []
    const done = service.search('needle', 'space', undefined, 'space-a', (current) => {
      progress.push(current)
      if (current === 2) service.cancel()
    })
    expect(await done).toEqual([])
    expect(progress).toEqual([1, 2])
  })
})
