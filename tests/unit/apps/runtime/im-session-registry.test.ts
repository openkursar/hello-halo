/**
 * Unit tests for apps/runtime/im-session-registry.ts source classification.
 *
 * The registry is the single store for a digital human's external sessions
 * across all channels. The `source` marker decides which sessions are pushable
 * (IM, with a live channel adapter) versus read-only external sessions (HTTP):
 *   - getAllSessions      → every session (UI conversation list)
 *   - getPushableSessions → source==='im' only (notify_bot contact directory)
 *   - getProactiveSessions→ proactive && source==='im' (auto-sync targets)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, readFileSync, readdirSync, rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ImSessionRegistry } from '../../../../src/main/apps/runtime/im-session-registry'
import { AtomicFileWriter } from '../../../../src/main/apps/runtime/atomic-file-writer'
import { PendingRelayStore, setPendingRelayStore, type RelayPushEvent } from '../../../../src/main/apps/runtime/pending-relays'
import { buildImSessionKey, buildTeamSessionKey } from '../../../../src/shared/apps/im-keys'

const { removeForChat } = vi.hoisted(() => ({ removeForChat: vi.fn() }))
vi.mock('../../../../src/main/apps/runtime/reminders', () => ({
  getConversationReminders: () => ({ removeForChat }),
}))

describe('ImSessionRegistry — channel source classification', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'im-reg-'))
    file = join(dir, 'sessions.json')
  })

  afterEach(async () => {
    // register() persists fire-and-forget via queueMicrotask + async writeFile;
    // let any in-flight write settle before removing the directory so the test
    // output stays free of spurious "failed to persist" warnings.
    await new Promise(resolve => setTimeout(resolve, 20))
    rmSync(dir, { recursive: true, force: true })
  })

  it('marks IM channel registrations as source=im', () => {
    const reg = new ImSessionRegistry(file)
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1')
    expect(reg.findSession('app1', 'wecom-bot', 'chat-1')?.source).toBe('im')
  })

  it('marks http registrations as source=http', () => {
    const reg = new ImSessionRegistry(file)
    reg.register('app1', 'http', 'user-9', 'direct', '')
    expect(reg.findSession('app1', 'http', 'user-9')?.source).toBe('http')
  })

  it('excludes http sessions from pushable and proactive results', () => {
    const reg = new ImSessionRegistry(file)
    reg.register('app1', 'http', 'user-9', 'direct', '')
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1')

    // UI list shows both channels
    expect(reg.getAllSessions('app1')).toHaveLength(2)

    // Push targets are IM-only
    const pushable = reg.getPushableSessions('app1')
    expect(pushable).toHaveLength(1)
    expect(pushable[0].channel).toBe('wecom-bot')

    // Even a (defensively) proactive-flagged http session is never returned
    reg.setProactive('app1', 'http', 'user-9', true)
    reg.setProactive('app1', 'wecom-bot', 'chat-1', true)
    const proactive = reg.getProactiveSessions('app1')
    expect(proactive).toHaveLength(1)
    expect(proactive[0].channel).toBe('wecom-bot')
  })

  it('backfills source for legacy records persisted without it', () => {
    const legacy = [{
      appId: 'app1',
      channel: 'feishu-bot',
      instanceId: 'inst-1',
      chatId: 'room-1',
      chatType: 'group',
      displayName: 'Room',
      proactive: false,
      lastActiveAt: Date.now(),
    }]
    writeFileSync(file, JSON.stringify(legacy), 'utf8')

    const reg = new ImSessionRegistry(file)
    expect(reg.findSession('app1', 'feishu-bot', 'room-1')?.source).toBe('im')
  })
})

describe('ImSessionRegistry — session revisions', () => {
  let dir: string
  let file: string
  let reg: ImSessionRegistry
  const teamContext = { teamId: 'team-1', epochId: 'epoch-1' }
  const original = { contactId: 'owner-1', teamContext }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'im-reg-revisions-'))
    file = join(dir, 'sessions.json')
    reg = new ImSessionRegistry(file)
    setPendingRelayStore(new PendingRelayStore(join(dir, 'relays.json')))
  })

  afterEach(async () => {
    setPendingRelayStore(null)
    await new Promise(resolve => setTimeout(resolve, 50))
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('returns undefined for missing sessions and distinct opaque identities per session', () => {
    expect(reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')).toBeUndefined()
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1')
    reg.register('app1', 'wecom-bot', 'chat-2', 'direct', 'inst-1')
    const revision = reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')!
    expect(revision).toEqual({})
    expect(Reflect.ownKeys(revision)).toEqual([])
    expect(reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')).toBe(revision)
    expect(reg.getSessionRevision('app1', 'wecom-bot', 'chat-2')).not.toBe(revision)
    expect(reg.getSessionRevision('app2', 'wecom-bot', 'chat-1')).toBeUndefined()
    expect(reg.getSessionRevision('app1', 'feishu-bot', 'chat-1')).toBeUndefined()
  })

  it('preserves revisions across normal repeated inbound messages, pushes, names and unrelated edits', () => {
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1', original)
    reg.setProactive('app1', 'wecom-bot', 'chat-1', true)
    const revision = reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')
    for (let i = 0; i < 5; i++) {
      reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1', {
        contactId: i % 2 ? undefined : 'owner-1', teamContext: { ...teamContext },
        displayName: `Name ${i}`, lastSender: `Sender ${i}`, lastMessage: `Message ${i}`,
      })
      expect(reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')).toBe(revision)
    }
    reg.notePush('app1', 'wecom-bot', 'chat-1', { lastSender: 'Bot', lastMessage: 'A push' })
    reg.setCustomName('app1', 'wecom-bot', 'chat-1', 'A custom name')
    reg.setResolvedName('app1', 'wecom-bot', 'chat-1', 'A resolved name')
    reg.setProactive('app1', 'wecom-bot', 'chat-1', true)
    reg.setTeamContext('app1', 'wecom-bot', 'chat-1', { ...teamContext })
    reg.setPushLink('app2', { appId: 'app1', channel: 'wecom-bot', chatId: 'chat-1' }, { autoSync: true })
    reg.register('app2', 'wecom-bot', 'chat-1', 'direct', 'inst-2')
    reg.resetActivity('app2', 'wecom-bot', 'chat-1')
    reg.removeAllForApp('app2')
    expect(reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')).toBe(revision)
    expect(reg.findSession('app1', 'wecom-bot', 'chat-1')).toMatchObject({
      messageCount: 7, contactId: 'owner-1', displayName: 'chat-1', lastMessage: 'A push',
    })
  })

  it.each([
    ['instance', 'inst-2', original],
    ['contact', 'inst-1', { ...original, contactId: 'owner-2' }],
    ['team', 'inst-1', { ...original, teamContext: { teamId: 'team-2', epochId: 'epoch-1' } }],
    ['epoch', 'inst-1', { ...original, teamContext: { teamId: 'team-1', epochId: 'epoch-2' } }],
    ['team removal', 'inst-1', { contactId: 'owner-1', teamContext: undefined }],
  ] as const)('never revives a revision after %s changes and reverts without an intervening lookup', (_name, instanceId, opts) => {
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1', original)
    const revision = reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', instanceId, opts)
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1', original)
    const current = reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')
    expect(current).toBeDefined()
    expect(current).not.toBe(revision)
    expect(reg.findSession('app1', 'wecom-bot', 'chat-1')).toMatchObject({ instanceId: 'inst-1', ...original })
  })

  it.each([
    { teamId: 'team-2', epochId: 'epoch-1' },
    { teamId: 'team-1', epochId: 'epoch-2' },
    undefined,
  ])('never revives a revision after a push destination refresh to %j and back', changed => {
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1', original)
    const before = reg.findSession('app1', 'wecom-bot', 'chat-1')
    const revision = reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')
    reg.setTeamContext('app1', 'wecom-bot', 'chat-1', changed)
    reg.setTeamContext('app1', 'wecom-bot', 'chat-1', { ...teamContext })
    expect(reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')).not.toBe(revision)
    expect(reg.findSession('app1', 'wecom-bot', 'chat-1')).toEqual(before)
  })

  it('never revives a revision when proactive selection is disabled and restored', () => {
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1', original)
    reg.setProactive('app1', 'wecom-bot', 'chat-1', true)
    const revision = reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')
    reg.setProactive('app1', 'wecom-bot', 'chat-1', false)
    reg.setProactive('app1', 'wecom-bot', 'chat-1', true)
    expect(reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')).not.toBe(revision)
    expect(reg.findSession('app1', 'wecom-bot', 'chat-1')?.proactive).toBe(true)
  })

  it('invalidates on every clear, including an already empty transcript', () => {
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1', { ...original, lastMessage: 'Message' })
    reg.setProactive('app1', 'wecom-bot', 'chat-1', true)
    const revision = reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')
    reg.resetActivity('app1', 'wecom-bot', 'chat-1')
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1', { ...original, lastMessage: 'Message' })
    const afterMessage = reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')
    expect(afterMessage).not.toBe(revision)
    reg.resetActivity('app1', 'wecom-bot', 'chat-1')
    const afterClear = reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')
    expect(afterClear).not.toBe(afterMessage)
    reg.resetActivity('app1', 'wecom-bot', 'chat-1')
    expect(reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')).not.toBe(afterClear)
    expect(reg.findSession('app1', 'wecom-bot', 'chat-1')).toMatchObject({ ...original, proactive: true, messageCount: 0, lastMessage: undefined })
  })

  it.each(['removeSession', 'removeAllForApp'] as const)('never revives a revision after %s and recreation', removal => {
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1', original)
    reg.register('app2', 'wecom-bot', 'chat-1', 'direct', 'inst-2')
    const revision = reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')
    const otherRevision = reg.getSessionRevision('app2', 'wecom-bot', 'chat-1')
    if (removal === 'removeSession') reg.removeSession('app1', 'wecom-bot', 'chat-1')
    else reg.removeAllForApp('app1')
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1', original)
    expect(reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')).not.toBe(revision)
    expect(reg.getSessionRevision('app2', 'wecom-bot', 'chat-1')).toBe(otherRevision)
    reg.removeSession('app1', 'wecom-bot', 'chat-1')
    expect(reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')).toBeUndefined()
  })

  it('restores records with fresh identities but preserves existing records on a no-op restore', () => {
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1', original)
    const record = reg.findSession('app1', 'wecom-bot', 'chat-1')!
    const revision = reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')
    expect(reg.restoreSession(record)).toBe(false)
    expect(reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')).toBe(revision)
    reg.removeSession('app1', 'wecom-bot', 'chat-1')
    expect(reg.restoreSession(record)).toBe(true)
    expect(reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')).not.toBe(revision)
  })

  it('keeps revision lookups memory-only and does not add fields to persisted sessions', async () => {
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1', original)
    await vi.waitFor(() => expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1))
    const persisted = readFileSync(file, 'utf8')
    const write = vi.spyOn(AtomicFileWriter.prototype, 'write')
    const revision = reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')!
    for (let i = 0; i < 10; i++) expect(reg.getSessionRevision('app1', 'wecom-bot', 'chat-1')).toBe(revision)
    await Promise.resolve()
    expect(write).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(persisted)
    expect(reg.findSession('app1', 'wecom-bot', 'chat-1')).toEqual(JSON.parse(persisted)[0])
    const reloaded = new ImSessionRegistry(file)
    expect(reloaded.getSessionRevision('app1', 'wecom-bot', 'chat-1')).toBeDefined()
    expect(reloaded.getSessionRevision('app1', 'wecom-bot', 'chat-1')).not.toBe(revision)
    reg.setCustomName('app1', 'wecom-bot', 'chat-1', 'Renamed')
    await vi.waitFor(() => expect(JSON.parse(readFileSync(file, 'utf8'))[0].customName).toBe('Renamed'))
    expect(JSON.parse(readFileSync(file, 'utf8'))[0]).toEqual({ ...JSON.parse(persisted)[0], customName: 'Renamed' })
  })
})

describe('ImSessionRegistry — resolvedName', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'im-reg-'))
    file = join(dir, 'sessions.json')
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    rmSync(dir, { recursive: true, force: true })
  })

  it('sets resolvedName on an existing session and returns true', () => {
    const reg = new ImSessionRegistry(file)
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1')
    expect(reg.setResolvedName('app1', 'wecom-bot', 'chat-1', 'Real Name')).toBe(true)
    expect(reg.findSession('app1', 'wecom-bot', 'chat-1')?.resolvedName).toBe('Real Name')
  })

  it('no-ops for a session that is not yet registered', () => {
    const reg = new ImSessionRegistry(file)
    expect(reg.setResolvedName('app1', 'wecom-bot', 'unknown-chat', 'Real Name')).toBe(false)
  })

  it('no-ops (and reports no change) when the value is already current', () => {
    const reg = new ImSessionRegistry(file)
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1')
    expect(reg.setResolvedName('app1', 'wecom-bot', 'chat-1', 'Real Name')).toBe(true)
    expect(reg.setResolvedName('app1', 'wecom-bot', 'chat-1', 'Real Name')).toBe(false)
  })

  it('overwrites a stale resolvedName as fresher lookups succeed (unlike displayName)', () => {
    const reg = new ImSessionRegistry(file)
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1')
    reg.setResolvedName('app1', 'wecom-bot', 'chat-1', 'Old Name')
    reg.setResolvedName('app1', 'wecom-bot', 'chat-1', 'New Name')
    expect(reg.findSession('app1', 'wecom-bot', 'chat-1')?.resolvedName).toBe('New Name')
  })

  it('never overwrites customName, and customName is not required to set resolvedName', () => {
    const reg = new ImSessionRegistry(file)
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1')
    reg.setCustomName('app1', 'wecom-bot', 'chat-1', 'My Own Label')
    reg.setResolvedName('app1', 'wecom-bot', 'chat-1', 'Real Name')
    const session = reg.findSession('app1', 'wecom-bot', 'chat-1')
    expect(session?.customName).toBe('My Own Label')
    expect(session?.resolvedName).toBe('Real Name')
  })
})

describe('ImSessionRegistry — HTTP session bounds', () => {
  let dir: string
  let file: string
  const CAP = 500

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'im-reg-'))
    file = join(dir, 'sessions.json')
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    rmSync(dir, { recursive: true, force: true })
  })

  it('caps HTTP sessions per app at the configured maximum', () => {
    const reg = new ImSessionRegistry(file)
    for (let i = 0; i <= CAP; i++) {
      reg.register('app1', 'http', `user-${i}`, 'direct', '')
    }
    const http = reg.getAllSessions('app1').filter(s => s.source === 'http')
    expect(http.length).toBe(CAP)
  })

  it('never caps IM sessions (human-bounded, carry user intent)', () => {
    const reg = new ImSessionRegistry(file)
    // Register a generous number of IM sessions; none should be evicted.
    for (let i = 0; i < CAP + 50; i++) {
      reg.register('app1', 'wecom-bot', `chat-${i}`, 'direct', 'inst-1')
    }
    const im = reg.getAllSessions('app1').filter(s => s.source === 'im')
    expect(im.length).toBe(CAP + 50)
  })

  it('prunes expired HTTP sessions when a new one is registered', () => {
    const stale = [{
      appId: 'app1', channel: 'http', source: 'http', instanceId: '',
      chatId: 'old-user', chatType: 'direct', displayName: 'old-user',
      proactive: false,
      lastActiveAt: Date.now() - 40 * 24 * 60 * 60 * 1000, // 40 days ago
    }]
    writeFileSync(file, JSON.stringify(stale), 'utf8')

    const reg = new ImSessionRegistry(file)
    expect(reg.findSession('app1', 'http', 'old-user')).toBeDefined()

    // Registering a fresh HTTP session triggers TTL pruning of the stale one.
    reg.register('app1', 'http', 'new-user', 'direct', '')

    expect(reg.findSession('app1', 'http', 'old-user')).toBeUndefined()
    expect(reg.findSession('app1', 'http', 'new-user')).toBeDefined()
  })

  it('exempts user-pinned (customName) HTTP sessions from TTL pruning', () => {
    const pinned = [{
      appId: 'app1', channel: 'http', source: 'http', instanceId: '',
      chatId: 'vip', chatType: 'direct', displayName: 'vip', customName: 'VIP',
      proactive: false,
      lastActiveAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
    }]
    writeFileSync(file, JSON.stringify(pinned), 'utf8')

    const reg = new ImSessionRegistry(file)
    reg.register('app1', 'http', 'new-user', 'direct', '')

    // Pinned stale session survives despite being past TTL.
    expect(reg.findSession('app1', 'http', 'vip')).toBeDefined()
  })
})

describe('ImSessionRegistry — native local sessions', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'im-reg-'))
    file = join(dir, 'sessions.json')
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a local session with source=local on the "local" channel', () => {
    const reg = new ImSessionRegistry(file)
    const rec = reg.createLocalSession('app1', 'uuid-1')
    expect(rec.source).toBe('local')
    expect(rec.channel).toBe('local')
    expect(rec.chatType).toBe('direct')
    expect(reg.findSession('app1', 'local', 'uuid-1')?.source).toBe('local')
  })

  it('createLocalSession is idempotent for the same uuid', () => {
    const reg = new ImSessionRegistry(file)
    reg.createLocalSession('app1', 'uuid-1', { displayName: 'first' })
    reg.createLocalSession('app1', 'uuid-1', { displayName: 'second' })
    const all = reg.getAllSessions('app1').filter(s => s.source === 'local')
    expect(all).toHaveLength(1)
    expect(all[0].displayName).toBe('first')
  })

  it('never evicts local sessions under HTTP cap pressure', () => {
    const reg = new ImSessionRegistry(file)
    reg.createLocalSession('app1', 'keep-me')
    // Flood HTTP sessions past the cap; local session must survive.
    for (let i = 0; i <= 501; i++) {
      reg.register('app1', 'http', `user-${i}`, 'direct', '')
    }
    expect(reg.findSession('app1', 'local', 'keep-me')?.source).toBe('local')
  })

  it('is excluded from pushable and proactive results', () => {
    const reg = new ImSessionRegistry(file)
    reg.createLocalSession('app1', 'uuid-1')
    reg.register('app1', 'wecom-bot', 'chat-1', 'direct', 'inst-1')
    expect(reg.getPushableSessions('app1').every(s => s.source === 'im')).toBe(true)
    expect(reg.getPushableSessions('app1')).toHaveLength(1)
  })

  it('seeds and clears a pending resume-and-fork marker', () => {
    const reg = new ImSessionRegistry(file)
    reg.createLocalSession('app1', 'forked', {
      forkOrigin: 'app-chat:app1:wecom-bot:direct:u1',
      pendingResumeSessionId: 'sdk-session-abc',
    })
    // Peek does not consume.
    expect(reg.getPendingResume('app1', 'local', 'forked')).toBe('sdk-session-abc')
    expect(reg.getPendingResume('app1', 'local', 'forked')).toBe('sdk-session-abc')
    // Clear removes it.
    reg.clearPendingResume('app1', 'local', 'forked')
    expect(reg.getPendingResume('app1', 'local', 'forked')).toBeUndefined()
  })

  it('renaming (setCustomName) and removeSession work for local sessions', () => {
    const reg = new ImSessionRegistry(file)
    reg.createLocalSession('app1', 'uuid-1')
    expect(reg.setCustomName('app1', 'local', 'uuid-1', 'My chat')).toBe(true)
    expect(reg.findSession('app1', 'local', 'uuid-1')?.customName).toBe('My chat')
    expect(reg.removeSession('app1', 'local', 'uuid-1')).toBe(true)
    expect(reg.findSession('app1', 'local', 'uuid-1')).toBeUndefined()
  })
})

describe('ImSessionRegistry — pending relay cleanup', () => {
  let dir: string
  let reg: ImSessionRegistry
  let spool: PendingRelayStore

  function enqueue(target: string, id = target, action?: RelayPushEvent['action']) {
    spool.append(target, {
      kind: 'push', id, at: Date.now(),
      source: { key: 'app-run:author:run-1', appId: 'author', runId: 'run-1' },
      sourceOwner: false, message: 'Waiting for a reply', action,
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'im-reg-relay-'))
    reg = new ImSessionRegistry(join(dir, 'sessions.json'))
    spool = new PendingRelayStore(join(dir, 'relays.json'))
    setPendingRelayStore(spool)
    removeForChat.mockClear()
  })

  afterEach(async () => {
    setPendingRelayStore(null)
    await new Promise(resolve => setTimeout(resolve, 50))
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('clears ordinary pending relays for only the removed chat, including both chat types', () => {
    reg.register('app1', 'wecom-bot', 'boss', 'direct', 'inst-1')
    const removed = ['direct', 'group'].map(type => buildImSessionKey('app1', 'wecom-bot', type as 'direct' | 'group', 'boss'))
    const kept = [
      buildImSessionKey('app1', 'wecom-bot', 'direct', 'other-chat'),
      buildImSessionKey('app1', 'feishu-bot', 'direct', 'boss'),
      buildImSessionKey('app2', 'wecom-bot', 'direct', 'boss'),
    ]
    for (const target of [...removed, ...kept]) enqueue(target)

    expect(reg.removeSession('app1', 'wecom-bot', 'boss')).toBe(true)

    for (const target of removed) expect(spool.peek(target)).toEqual([])
    for (const target of kept) expect(spool.count(target)).toBe(1)
    expect(removeForChat).toHaveBeenCalledWith('app1', 'wecom-bot', 'boss')
    reg.register('app1', 'wecom-bot', 'boss', 'direct', 'inst-1')
    for (const target of removed) expect(spool.peek(target)).toEqual([])
  })

  it('clears only the removed member conversation and ordinary alias, preserving other members, chats and accepted history', async () => {
    reg.register('app1', 'wecom-bot', 'boss', 'direct', 'inst-1', { teamContext: { teamId: 'team-1', epochId: 'private-epoch' } })
    const teamTarget = buildTeamSessionKey('app1', 'team-1', 'private-epoch')
    const ordinaryTarget = buildImSessionKey('app1', 'wecom-bot', 'direct', 'boss')
    const kept = [
      buildTeamSessionKey('app2', 'team-1', 'private-epoch'),
      buildTeamSessionKey('app1', 'team-1', 'other-chat-epoch'),
      buildTeamSessionKey('app1', 'other-team', 'private-epoch'),
      buildImSessionKey('app1', 'wecom-bot', 'direct', 'other-chat'),
    ]
    const questionAction: RelayPushEvent['action'] = { kind: 'answer-question', appId: 'author', entryId: 'open-question' }
    enqueue(teamTarget, 'accepted')
    const accepted = spool.peek(teamTarget)
    spool.commit(teamTarget, ['accepted'])
    const history = join(dir, 'accepted-history.jsonl')
    writeFileSync(history, JSON.stringify(accepted))
    enqueue(teamTarget, 'unanswered', questionAction)
    enqueue(ordinaryTarget)
    for (const target of kept) enqueue(target)

    expect(reg.removeSession('app1', 'wecom-bot', 'boss')).toBe(true)

    expect(spool.peek(teamTarget)).toEqual([])
    expect(spool.peek(ordinaryTarget)).toEqual([])
    for (const target of kept) expect(spool.count(target)).toBe(1)
    expect(readFileSync(history, 'utf8')).toBe(JSON.stringify(accepted))
    expect(questionAction).toEqual({ kind: 'answer-question', appId: 'author', entryId: 'open-question' })
    reg.register('app1', 'wecom-bot', 'boss', 'direct', 'inst-1', { teamContext: { teamId: 'team-1', epochId: 'private-epoch' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    const reloaded = new PendingRelayStore(join(dir, 'relays.json'))
    expect(reloaded.peek(teamTarget)).toEqual([])
    expect(reloaded.peek(ordinaryTarget)).toEqual([])
    for (const target of kept) expect(reloaded.count(target)).toBe(1)
  })

  it('removes all registered app destinations without clearing another member or an unregistered conversation', () => {
    reg.register('app1', 'wecom-bot', 'boss', 'direct', 'inst-1', { teamContext: { teamId: 'team-1', epochId: 'private-epoch' } })
    reg.register('app1', 'feishu-bot', 'group', 'group', 'inst-2', { teamContext: { teamId: 'team-2', epochId: 'group-epoch' } })
    reg.register('app1', 'wecom-bot', 'ordinary', 'direct', 'inst-1')
    reg.register('app2', 'wecom-bot', 'boss', 'direct', 'inst-3', { teamContext: { teamId: 'team-1', epochId: 'private-epoch' } })
    reg.setPushLink('app1', { appId: 'app2', channel: 'wecom-bot', chatId: 'boss' }, { autoSync: true })
    const removed = [
      buildTeamSessionKey('app1', 'team-1', 'private-epoch'),
      buildTeamSessionKey('app1', 'team-2', 'group-epoch'),
      buildImSessionKey('app1', 'wecom-bot', 'direct', 'boss'),
      buildImSessionKey('app1', 'feishu-bot', 'group', 'group'),
      buildImSessionKey('app1', 'wecom-bot', 'direct', 'ordinary'),
    ]
    const kept = [
      buildTeamSessionKey('app2', 'team-1', 'private-epoch'),
      buildImSessionKey('app2', 'wecom-bot', 'direct', 'boss'),
      buildTeamSessionKey('app1', 'team-1', 'unregistered-epoch'),
    ]
    for (const target of [...removed, ...kept]) enqueue(target)

    expect(reg.removeAllForApp('app1')).toBe(3)

    expect(reg.getAllSessions('app1')).toEqual([])
    expect(reg.findSession('app2', 'wecom-bot', 'boss')?.pushLinks).toBeUndefined()
    for (const target of removed) expect(spool.peek(target)).toEqual([])
    for (const target of kept) expect(spool.count(target)).toBe(1)
    expect(removeForChat.mock.calls).toEqual([
      ['app1', 'wecom-bot', 'boss'], ['app1', 'feishu-bot', 'group'], ['app1', 'wecom-bot', 'ordinary'],
    ])
    reg.register('app1', 'wecom-bot', 'boss', 'direct', 'inst-1', { teamContext: { teamId: 'team-1', epochId: 'private-epoch' } })
    expect(spool.peek(removed[0])).toEqual([])
  })

  it('leaves pending relays alone when no registry session was removed', () => {
    const target = buildImSessionKey('app1', 'wecom-bot', 'direct', 'unknown')
    enqueue(target)

    expect(reg.removeSession('app1', 'wecom-bot', 'unknown')).toBe(false)
    expect(reg.removeAllForApp('app1')).toBe(0)
    expect(spool.count(target)).toBe(1)
    expect(removeForChat).not.toHaveBeenCalled()
  })

  it('reports the removed destination when cleanup cannot reach the relay spool', () => {
    reg.register('app1', 'wecom-bot', 'boss', 'direct', 'inst-1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setPendingRelayStore(null)

    expect(reg.removeSession('app1', 'wecom-bot', 'boss')).toBe(true)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('appId=app1, channel=wecom-bot, chatId=boss, reason=relay spool unavailable'))
  })
})

describe('ImSessionRegistry — persistence', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'im-reg-'))
    file = join(dir, 'sessions.json')
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
    rmSync(dir, { recursive: true, force: true })
  })

  const settle = () => new Promise(resolve => setTimeout(resolve, 50))

  it('survives deleting a local chat: reset then removal persist in separate microtasks', async () => {
    const reg = new ImSessionRegistry(file)
    for (let i = 0; i < 30; i++) reg.register('app1', 'wecom-bot', `contact-${i}-${'x'.repeat(20)}`, 'direct', 'inst-1', { lastMessage: 'an earlier message' })
    reg.createLocalSession('app1', 'doomed')
    await settle()

    // deleteNativeChatSession's order: the clear path resets activity, an await
    // later the record is removed — two structural writes back to back.
    reg.resetActivity('app1', 'local', 'doomed')
    await Promise.resolve()
    await Promise.resolve()
    reg.removeSession('app1', 'local', 'doomed')
    await settle()

    const reloaded = new ImSessionRegistry(file)
    expect(reloaded.getAllSessions('app1')).toHaveLength(30)
    expect(readdirSync(dir)).toEqual(['sessions.json'])
  })

  it('sets an unreadable file aside instead of overwriting it', async () => {
    const broken = '[{"appId":"app1"}]garbage'
    writeFileSync(file, broken, 'utf8')
    const reg = new ImSessionRegistry(file)
    expect(reg.listAll()).toHaveLength(0)

    reg.createLocalSession('app1', 'fresh')
    await settle()

    const aside = readdirSync(dir).filter(name => name.startsWith('sessions.json.unreadable-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dir, aside[0]), 'utf8')).toBe(broken)
    expect(new ImSessionRegistry(file).findSession('app1', 'local', 'fresh')).toBeDefined()
  })

  it('restoreSession adds a missing record but never replaces a registered one', () => {
    const reg = new ImSessionRegistry(file)
    const record = {
      appId: 'app1', channel: 'native', source: 'native' as const, instanceId: '', chatId: 'default',
      chatType: 'direct' as const, displayName: '', proactive: false, lastActiveAt: 1000, messageCount: 1,
    }
    expect(reg.restoreSession(record)).toBe(true)
    expect(reg.restoreSession({ ...record, lastActiveAt: 2000 })).toBe(false)
    expect(reg.findSession('app1', 'native', 'default')?.lastActiveAt).toBe(1000)
  })
})

describe('ImSessionRegistry — a push to a chat', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'im-reg-push-')) })
  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
    rmSync(dir, { recursive: true, force: true })
  })

  it('makes the push the chat\'s latest message and moves the chat to the top', async () => {
    const reg = new ImSessionRegistry(join(dir, 'sessions.json'))
    reg.register('app1', 'wecom-bot', 'ops-group', 'group', 'inst-1', { lastMessage: 'old question', lastSender: 'Alice' })
    await new Promise(resolve => setTimeout(resolve, 5))
    reg.register('app1', 'wecom-bot', 'boss', 'direct', 'inst-1', { lastMessage: 'hi', lastSender: 'Boss' })

    reg.notePush('app1', 'wecom-bot', 'ops-group', { lastSender: 'Release Bot', lastMessage: 'Nightly report: 3 failures' })

    const sessions = reg.getAllSessions('app1')
    expect(sessions[0]).toMatchObject({ chatId: 'ops-group', lastSender: 'Release Bot', lastMessage: 'Nightly report: 3 failures', messageCount: 2 })
    expect(sessions[1].chatId).toBe('boss')
  })

  it('persists a refreshed team destination without counting another message or changing activity', async () => {
    const file = join(dir, 'sessions.json')
    const reg = new ImSessionRegistry(file)
    reg.register('app1', 'wecom-bot', 'boss', 'direct', 'inst-1', {
      lastMessage: 'old question', lastSender: 'Boss', teamContext: { teamId: 't1', epochId: 'cleared' },
    })
    const before = reg.findSession('app1', 'wecom-bot', 'boss')!
    const teamContext = { teamId: 't1', epochId: 'current' }

    reg.setTeamContext('app1', 'wecom-bot', 'boss', teamContext)
    teamContext.epochId = 'not-the-stored-context'

    expect(reg.findSession('app1', 'wecom-bot', 'boss')).toEqual({ ...before, teamContext: { teamId: 't1', epochId: 'current' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(new ImSessionRegistry(file).findSession('app1', 'wecom-bot', 'boss')?.teamContext).toEqual({ teamId: 't1', epochId: 'current' })

    reg.setTeamContext('app1', 'wecom-bot', 'boss', undefined)
    expect(reg.findSession('app1', 'wecom-bot', 'boss')).toEqual({ ...before, teamContext: undefined })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(new ImSessionRegistry(file).findSession('app1', 'wecom-bot', 'boss')?.teamContext).toBeUndefined()
  })

  it('does not create a chat while refreshing a missing destination', () => {
    const reg = new ImSessionRegistry(join(dir, 'sessions.json'))
    reg.setTeamContext('app1', 'wecom-bot', 'unknown', { teamId: 't1', epochId: 'current' })
    expect(reg.listAll()).toEqual([])
  })

  it('leaves an unknown chat alone', () => {
    const reg = new ImSessionRegistry(join(dir, 'sessions.json'))
    reg.notePush('app1', 'wecom-bot', 'nobody', { lastMessage: 'x' })
    expect(reg.getAllSessions('app1')).toEqual([])
  })
})
