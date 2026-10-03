/**
 * Lazy transcript replication: a node keeps a copy only of the sessions it
 * wants, remembers the rest, subscribes when one becomes wanted, and a serving
 * node announces its feeds as one digest to peers that negotiated it.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { FeedStore } from '../../../../../src/main/apps/federation/feed-store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../../src/main/apps/federation/migrations'
import {
  createSessionFeed,
  historyCacheKey,
  SETTLED_EPOCH_ARCHIVE_MS,
} from '../../../../../src/main/apps/runtime/federation/session-feed'
import { feedIdKey, type FeedSyncFrame } from '../../../../../src/main/apps/runtime/federation/log/types'
import { buildTeamSessionKey } from '../../../../../src/shared/apps/im-keys'

const OFFICE = 'office-1'
const AUTH = 'node-auth'
const ME = 'node-me'
const OWNER = 'node-owner'
const sessionKey = (app: string) => buildTeamSessionKey(app, OFFICE, 'epoch-1')
const feedKey = (app: string) => feedIdKey({ officeId: OFFICE, author: OWNER, kind: `session:${sessionKey(app)}` })

describe('lazy transcript replication', () => {
  const dbs: DatabaseManager[] = []
  afterEach(() => dbs.splice(0).forEach((d) => d.closeAll()))

  function store(): FeedStore {
    const dbm = createDatabaseManager(':memory:')
    dbm.runMigrations(dbm.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
    dbs.push(dbm)
    return new FeedStore(dbm.getAppDatabase())
  }

  it('remembers unwanted feeds and subscribes once one becomes wanted', () => {
    const wanted = new Set<string>()
    const sent: FeedSyncFrame[] = []
    const feed = createSessionFeed({
      officeId: OFFICE, selfNodeId: ME, feedStore: store(),
      sendToPeer: (_p, f) => sent.push(f), broadcast: () => {},
      readOwnedTranscript: () => null, isSessionActive: () => false,
      servesMirror: () => false, acceptEntriesFrom: () => true, retransmitIntervalMs: 0,
      wantsReplica: (key) => wanted.has(key),
    })
    feed.handleFrame(AUTH, { kind: 'feed-digest', officeId: OFFICE, feeds: [[feedKey('a'), 5], [feedKey('b'), 3]] })
    expect(sent.filter((f) => f.kind === 'feed-subscribe')).toHaveLength(0)

    wanted.add(feedKey('b'))
    feed.refreshWanted()
    const subs = sent.filter((f) => f.kind === 'feed-subscribe') as Array<{ feedKey: string }>
    expect(subs.map((f) => f.feedKey)).toEqual([feedKey('b')])
    feed.refreshWanted()
    expect(sent.filter((f) => f.kind === 'feed-subscribe')).toHaveLength(1)
    feed.stop()
  })

  it('restarts every copy it takes after a (re)join, when the serving node may have forgotten it', () => {
    const sent: FeedSyncFrame[] = []
    const feed = createSessionFeed({
      officeId: OFFICE, selfNodeId: ME, feedStore: store(),
      sendToPeer: (_p, f) => sent.push(f), broadcast: () => {},
      readOwnedTranscript: () => null, isSessionActive: () => false,
      servesMirror: () => false, acceptEntriesFrom: () => true, retransmitIntervalMs: 0,
      wantsReplica: (key) => key === feedKey('a'),
    })
    feed.handleFrame(AUTH, { kind: 'feed-digest', officeId: OFFICE, feeds: [[feedKey('a'), 3], [feedKey('b'), 3]] })
    sent.length = 0
    feed.resubscribeCopies()
    expect(sent.filter((f) => f.kind === 'feed-subscribe').map((f) => (f as { feedKey: string }).feedKey)).toEqual([feedKey('a')])
    feed.stop()
  })

  it('announces every feed to a peer in one frame', () => {
    const s = store()
    for (const app of ['a', 'b', 'c']) s.putCache(OFFICE, feedKey(app), 1, JSON.stringify({ seq: 1, hlc: '0', fid: 'f', type: 'msg', payload: { seq: 1 }, ts: 1 }))
    const toPeer = new Map<string, FeedSyncFrame[]>([['new', []], ['old', []]])
    const feed = createSessionFeed({
      officeId: OFFICE, selfNodeId: AUTH, feedStore: s,
      sendToPeer: (p, f) => toPeer.get(p)?.push(f), broadcast: () => { throw new Error('no broadcast expected') },
      readOwnedTranscript: () => null, isSessionActive: () => false,
      servesMirror: () => true, acceptEntriesFrom: () => true, retransmitIntervalMs: 0,
      announceTargets: () => ['new', 'old'],
    })
    for (let i = 0; i < 6; i++) feed.retransmitTick()
    for (const peer of ['new', 'old']) {
      expect(toPeer.get(peer)!.map((f) => f.kind)).toEqual(['feed-digest'])
      expect((toPeer.get(peer)![0] as { feeds: unknown[] }).feeds).toHaveLength(3)
    }
    feed.stop()
  })

  it('does not restart a feed it is already copying on each announcement', () => {
    const sent: FeedSyncFrame[] = []
    const feed = createSessionFeed({
      officeId: OFFICE, selfNodeId: ME, feedStore: store(),
      sendToPeer: (_p, f) => sent.push(f), broadcast: () => {},
      readOwnedTranscript: () => null, isSessionActive: () => false,
      servesMirror: () => false, acceptEntriesFrom: () => true, retransmitIntervalMs: 0,
      wantsReplica: () => true,
    })
    for (let upToSeq = 1; upToSeq <= 5; upToSeq++) {
      feed.handleFrame(AUTH, { kind: 'feed-digest', officeId: OFFICE, feeds: [[feedKey('a'), upToSeq]] })
    }
    expect(sent.filter((f) => f.kind === 'feed-subscribe')).toHaveLength(1)
    feed.stop()
  })

  it('keeps a copy still inside its release grace from settled-copy archiving', () => {
    const s = store()
    const history = historyCacheKey(OWNER, 'a', 'epoch-1')
    s.putCache(OFFICE, history, 1, JSON.stringify({ seq: 1, role: 'assistant', content: 'hi' }))
    let wanted = true
    const now = 10 * SETTLED_EPOCH_ARCHIVE_MS
    const feed = createSessionFeed({
      officeId: OFFICE, selfNodeId: ME, feedStore: s,
      sendToPeer: () => {}, broadcast: () => {},
      readOwnedTranscript: () => null, isSessionActive: () => false,
      servesMirror: () => false, acceptEntriesFrom: () => true, retransmitIntervalMs: 0,
      wantsReplica: () => wanted,
      epochEndedAt: () => now - SETTLED_EPOCH_ARCHIVE_MS - 1,
      now: () => now,
    })
    feed.handleFrame(AUTH, { kind: 'feed-digest', officeId: OFFICE, feeds: [[feedKey('a'), 4]] })
    // The panel closes: the copy is released only after its grace, which a frozen clock never reaches.
    wanted = false
    for (let i = 0; i < 24; i++) feed.retransmitTick()
    expect(s.getCacheMaxSeq(OFFICE, history)).toBe(1)
    feed.stop()
  })

  it('archives an unwanted copy of a long-finished epoch and rewinds its cursor', () => {
    const s = store()
    const history = historyCacheKey(OWNER, 'a', 'epoch-1')
    s.putCache(OFFICE, history, 1, JSON.stringify({ seq: 1, role: 'assistant', content: 'hi' }))
    s.setLocalCursor(OFFICE, feedKey('a'), 4, 0)
    const now = 10 * SETTLED_EPOCH_ARCHIVE_MS
    const feed = createSessionFeed({
      officeId: OFFICE, selfNodeId: ME, feedStore: s,
      sendToPeer: () => {}, broadcast: () => {},
      readOwnedTranscript: () => null, isSessionActive: () => false,
      servesMirror: () => false, acceptEntriesFrom: () => true, retransmitIntervalMs: 0,
      wantsReplica: () => false,
      epochEndedAt: () => now - SETTLED_EPOCH_ARCHIVE_MS - 1,
      now: () => now,
    })
    for (let i = 0; i < 24; i++) feed.retransmitTick()
    expect(s.getCacheMaxSeq(OFFICE, history)).toBe(0)
    expect(s.getLocalCursor(OFFICE, feedKey('a'))).toBe(0)
    feed.stop()
  })

  it('keeps a wanted copy, and any copy of an epoch still open', () => {
    const s = store()
    const history = historyCacheKey(OWNER, 'a', 'epoch-1')
    s.putCache(OFFICE, history, 1, JSON.stringify({ seq: 1, role: 'assistant', content: 'hi' }))
    for (const [wanted, ended] of [[true, 0], [false, null]] as const) {
      const feed = createSessionFeed({
        officeId: OFFICE, selfNodeId: ME, feedStore: s,
        sendToPeer: () => {}, broadcast: () => {},
        readOwnedTranscript: () => null, isSessionActive: () => false,
        servesMirror: () => false, acceptEntriesFrom: () => true, retransmitIntervalMs: 0,
        wantsReplica: () => wanted, epochEndedAt: () => ended, now: () => 10 * SETTLED_EPOCH_ARCHIVE_MS,
      })
      for (let i = 0; i < 24; i++) feed.retransmitTick()
      expect(s.getCacheMaxSeq(OFFICE, history)).toBe(1)
      feed.stop()
    }
  })
})

describe('feed announcements carry only what changed', () => {
  const dbs: DatabaseManager[] = []
  afterEach(() => dbs.splice(0).forEach((d) => d.closeAll()))

  it('an idle office announces nothing after the first digest; growth sends only the grown feed', () => {
    const dbm = createDatabaseManager(':memory:')
    dbm.runMigrations(dbm.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
    dbs.push(dbm)
    const s = new FeedStore(dbm.getAppDatabase())
    const entry = (seq: number) => ({ seq, hlc: seq.toString(16).padStart(16, '0'), fid: `f${seq}`, type: 'msg', payload: { seq, role: 'assistant', content: 'x' }, ts: seq })
    const toPeer = new Map<string, FeedSyncFrame[]>([['new', []], ['old', []]])
    const feed = createSessionFeed({
      officeId: OFFICE, selfNodeId: AUTH, feedStore: s,
      sendToPeer: (p, f) => toPeer.get(p)?.push(f), broadcast: () => { throw new Error('no broadcast expected') },
      readOwnedTranscript: () => null, isSessionActive: () => false,
      servesMirror: () => true, acceptEntriesFrom: () => true, retransmitIntervalMs: 0,
      announceTargets: () => ['new', 'old'],
    })
    const batch = (app: string, seqs: number[]): FeedSyncFrame => ({
      kind: 'feed-entries', officeId: OFFICE, feedKey: feedKey(app), entries: seqs.map(entry), upToSeq: seqs.at(-1)!, more: false, truncatedBeforeSeq: 0,
    })
    feed.handleFrame(OWNER, batch('a', [1]))
    feed.handleFrame(OWNER, batch('b', [1]))
    // Appends are announced on the next tick, not one frame each.
    expect(toPeer.get('new')).toEqual([])

    feed.retransmitTick()
    const first = toPeer.get('new')!.filter((f) => f.kind === 'feed-digest') as Array<{ feeds: Array<[string, number]> }>
    expect(first).toHaveLength(1)
    expect(first[0].feeds).toHaveLength(2)

    for (let i = 0; i < 20; i++) feed.retransmitTick()
    expect(toPeer.get('new')!.filter((f) => f.kind === 'feed-digest')).toHaveLength(1)

    feed.handleFrame(OWNER, batch('a', [2]))
    feed.retransmitTick()
    const digests = toPeer.get('new')!.filter((f) => f.kind === 'feed-digest') as Array<{ feeds: Array<[string, number]> }>
    expect(digests).toHaveLength(2)
    expect(digests[1].feeds).toEqual([[feedKey('a'), 2]])
    feed.stop()
  })
})
