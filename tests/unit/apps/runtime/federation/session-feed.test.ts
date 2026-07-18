/**
 * Multi-replica session-transcript replication tests (session-feed.ts).
 *
 * A three-node star — HOST (office authority, serving replica) and two joiners
 * A (owner) and B (viewer) — each with its own real FeedStore, exchanges frames
 * through an in-memory router that mirrors the PRODUCTION transport semantics:
 * joiner frames always travel to the host carrying the joiner's proven identity;
 * host→joiner frames arrive labeled with the RECEIVER's own node id (the joined
 * office's single upstream leg labels inbound frames with self). Proves:
 *   - an owner's transcript replicates to the host (mirror + history cache),
 *   - the host serves the mirror onward so joiner↔joiner replication works,
 *   - replication is incremental (only the tail is appended/applied),
 *   - a dropped frame self-heals on the retransmit backstop,
 *   - a late joiner backfills the full transcript via advertise-all,
 *   - an owner restart continues seq with no duplicates,
 *   - session feeds are never pruned (late-join backfill stays possible),
 *   - forged entries from a non-author non-authority peer are rejected,
 *   - start() heals a tail persisted before the last shutdown.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { FeedStore } from '../../../../../src/main/apps/federation/feed-store'
import {
  MIGRATION_NAMESPACE,
  migrations,
} from '../../../../../src/main/apps/federation/migrations'
import {
  createSessionFeed,
  historyCacheKey,
  isSessionFeedFrame,
  type SessionFeed,
} from '../../../../../src/main/apps/runtime/federation/session-feed'
import { feedIdKey, type FeedSyncFrame } from '../../../../../src/main/apps/runtime/federation/log/types'
import type { SerializedHistoryMessage } from '../../../../../src/main/apps/runtime/federation/protocol-m2'
import { buildTeamSessionKey } from '../../../../../src/shared/apps/im-keys'

const OFFICE = 'office-1'
const HOST = 'node-host'
const A = 'node-a'
const B = 'node-b'
const APP = 'app-a'
const EPOCH = 'epoch-1'
const SESSION_KEY = buildTeamSessionKey(APP, OFFICE, EPOCH)
const A_FEED_KEY = feedIdKey({ officeId: OFFICE, author: A, kind: `session:${SESSION_KEY}` })
const CACHE_KEY = historyCacheKey(A, APP, EPOCH)

function msg(seq: number): SerializedHistoryMessage {
  return { seq, role: 'assistant', content: `m${seq}`, ts: 1000 + seq }
}

interface TestNode {
  self: string
  feed: SessionFeed
  store: FeedStore
  dbm: DatabaseManager
  /** This node's owned transcripts, sessionKey → messages (mutable). */
  transcripts: Map<string, SerializedHistoryMessage[]>
  /** Session keys with a live in-flight turn (drives the provisional-tail gate). */
  activeSessions: Set<string>
}

interface Harness {
  host: TestNode
  a: TestNode
  b: TestNode
  /** Wire a NEW joiner into the star (late join). */
  addJoiner: (self: string) => TestNode
  /** Rebuild a joiner's feed over its SAME store (process restart). */
  rebuild: (node: TestNode) => void
  /** Drop the next routed frame matching pred (single-shot). */
  dropOnce: (pred: (to: string, f: FeedSyncFrame) => boolean) => void
  closeAll: () => void
}

function makeHarness(): Harness {
  const joiners: TestNode[] = []
  let hostNode: TestNode
  let drop: ((to: string, f: FeedSyncFrame) => boolean) | null = null

  function deliver(target: TestNode, labelFrom: string, frame: FeedSyncFrame): void {
    if (drop && drop(target.self, frame)) {
      drop = null
      return
    }
    const wire = JSON.parse(JSON.stringify(frame)) as FeedSyncFrame
    target.feed.handleFrame(labelFrom, wire)
  }

  /** Joiner → host (proven identity); host → peer (receiver's self label). */
  function route(sender: TestNode, peer: string | null, frame: FeedSyncFrame): void {
    if (sender === hostNode) {
      const targets = peer === null ? joiners : joiners.filter((j) => j.self === peer)
      for (const j of targets) deliver(j, j.self, frame)
      return
    }
    deliver(hostNode, sender.self, frame)
  }

  function buildNode(
    self: string,
    existing?: {
      dbm: DatabaseManager
      store: FeedStore
      transcripts: Map<string, SerializedHistoryMessage[]>
      activeSessions: Set<string>
    }
  ): TestNode {
    const dbm = existing?.dbm ?? createDatabaseManager(':memory:')
    if (!existing) dbm.runMigrations(dbm.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
    const store = existing?.store ?? new FeedStore(dbm.getAppDatabase())
    const transcripts = existing?.transcripts ?? new Map<string, SerializedHistoryMessage[]>()
    const activeSessions = existing?.activeSessions ?? new Set<string>()
    const node: TestNode = { self, store, dbm, transcripts, activeSessions, feed: undefined as unknown as SessionFeed }
    node.feed = createSessionFeed({
      officeId: OFFICE,
      selfNodeId: self,
      feedStore: store,
      sendToPeer: (peer, frame) => route(node, peer, frame),
      broadcast: (frame) => route(node, null, frame),
      readOwnedTranscript: (teamId, appId, epochId) =>
        transcripts.get(buildTeamSessionKey(appId, teamId, epochId)) ?? null,
      isSessionActive: (sessionKey) => activeSessions.has(sessionKey),
      servesMirror: () => self === HOST,
      // Mirrors the manager's gate: the author itself, the office authority
      // (serving replica), or the joined office's self-labeled upstream leg.
      acceptEntriesFrom: (from, author) => from === author || from === self || from === HOST,
      retransmitIntervalMs: 0,
    })
    return node
  }

  hostNode = buildNode(HOST)
  const a = buildNode(A)
  const b = buildNode(B)
  joiners.push(a, b)

  return {
    host: hostNode,
    a,
    b,
    addJoiner: (self) => {
      const n = buildNode(self)
      joiners.push(n)
      return n
    },
    rebuild: (node) => {
      node.feed.stop()
      node.feed = buildNode(node.self, node).feed
    },
    dropOnce: (pred) => {
      drop = pred
    },
    closeAll: () => {
      hostNode.feed.stop()
      hostNode.dbm.closeAll()
      for (const j of joiners) {
        j.feed.stop()
        j.dbm.closeAll()
      }
    },
  }
}

/** The history-cache rows a node holds for A's transcript, parsed. */
function cachedTranscript(node: TestNode): SerializedHistoryMessage[] {
  return node.store
    .listCache(OFFICE, CACHE_KEY, 0, 1000)
    .map((r) => JSON.parse(r.entryJson) as SerializedHistoryMessage)
}

describe('session-feed — multi-replica transcript replication', () => {
  let h: Harness

  afterEach(() => h.closeAll())

  it('replicates an owned tail to the host: mirror rows + history-cache rows', () => {
    h = makeHarness()
    h.a.transcripts.set(SESSION_KEY, [msg(1), msg(2), msg(3)])
    expect(h.a.feed.publishOwnedTail(SESSION_KEY)).toBe(3)

    expect(cachedTranscript(h.host).map((m) => m.seq)).toEqual([1, 2, 3])
    expect(cachedTranscript(h.host)[0].content).toBe('m1')
    // The verbatim mirror rows let the host serve the feed onward.
    expect(h.host.store.getCacheMaxSeq(OFFICE, A_FEED_KEY)).toBe(3)
  })

  it('star topology: a viewer joiner replicates through the host mirror', () => {
    h = makeHarness()
    h.a.transcripts.set(SESSION_KEY, [msg(1), msg(2)])
    h.a.feed.publishOwnedTail(SESSION_KEY)

    // B learned the feed via the host's re-advertise and backfilled from the mirror.
    expect(cachedTranscript(h.b).map((m) => m.seq)).toEqual([1, 2])
  })

  it('replication is incremental: only the tail is appended and applied', () => {
    h = makeHarness()
    h.a.transcripts.set(SESSION_KEY, [msg(1), msg(2)])
    h.a.feed.publishOwnedTail(SESSION_KEY)

    h.a.transcripts.set(SESSION_KEY, [msg(1), msg(2), msg(3)])
    expect(h.a.feed.publishOwnedTail(SESSION_KEY)).toBe(1) // only the new row
    expect(h.a.store.getMaxSeq(OFFICE, A_FEED_KEY)).toBe(3)
    expect(cachedTranscript(h.b).map((m) => m.seq)).toEqual([1, 2, 3])
    // Re-publishing with no new transcript rows appends nothing.
    expect(h.a.feed.publishOwnedTail(SESSION_KEY)).toBe(0)
  })

  it('self-heals a dropped entries frame on the retransmit backstop', () => {
    h = makeHarness()
    h.a.transcripts.set(SESSION_KEY, [msg(1)])
    // Lose the first delivery to the host.
    h.dropOnce((to, f) => to === HOST && f.kind === 'feed-entries')
    h.a.feed.publishOwnedTail(SESSION_KEY)
    expect(cachedTranscript(h.host)).toHaveLength(0)

    h.a.feed.retransmitTick()
    expect(cachedTranscript(h.host).map((m) => m.seq)).toEqual([1])
    // And the host's own re-advertise/serve converged B too.
    expect(cachedTranscript(h.b).map((m) => m.seq)).toEqual([1])
  })

  it('a duplicate retransmit applies at most once', () => {
    h = makeHarness()
    h.a.transcripts.set(SESSION_KEY, [msg(1), msg(2)])
    h.a.feed.publishOwnedTail(SESSION_KEY)
    h.a.feed.retransmitTick()
    h.a.feed.retransmitTick()

    expect(cachedTranscript(h.host).map((m) => m.seq)).toEqual([1, 2])
    expect(h.host.store.getLocalCursor(OFFICE, A_FEED_KEY)).toBe(2)
    expect(cachedTranscript(h.b).map((m) => m.seq)).toEqual([1, 2])
  })

  it('late joiner: advertise-all backfills the full transcript from the mirror', () => {
    h = makeHarness()
    h.a.transcripts.set(SESSION_KEY, [msg(1), msg(2), msg(3)])
    h.a.feed.publishOwnedTail(SESSION_KEY)

    const c = h.addJoiner('node-c')
    expect(cachedTranscript(c)).toHaveLength(0)
    // What the manager fires when the new peer's presence turns online.
    h.host.feed.advertiseAllTo('node-c')
    expect(cachedTranscript(c).map((m) => m.seq)).toEqual([1, 2, 3])
  })

  it('owner restart: seq continues over the same store, no duplicates downstream', () => {
    h = makeHarness()
    h.a.transcripts.set(SESSION_KEY, [msg(1), msg(2)])
    h.a.feed.publishOwnedTail(SESSION_KEY)

    h.rebuild(h.a)
    h.a.transcripts.set(SESSION_KEY, [msg(1), msg(2), msg(3)])
    h.a.feed.publishOwnedTail(SESSION_KEY)
    h.a.feed.retransmitTick()

    expect(h.a.store.getMaxSeq(OFFICE, A_FEED_KEY)).toBe(3)
    expect(cachedTranscript(h.host).map((m) => m.seq)).toEqual([1, 2, 3])
    expect(cachedTranscript(h.b).map((m) => m.seq)).toEqual([1, 2, 3])
  })

  it('session feeds are never pruned, so late-join backfill stays possible', () => {
    h = makeHarness()
    h.a.transcripts.set(SESSION_KEY, [msg(1), msg(2), msg(3)])
    h.a.feed.publishOwnedTail(SESSION_KEY)
    // Everything is delivered + acked; ticks on both ends must NOT trim the log
    // (unlike the ctrl plane's acked-prefix retention).
    for (let i = 0; i < 8; i++) {
      h.a.feed.retransmitTick()
      h.host.feed.retransmitTick()
    }
    expect(h.a.store.listAfter(OFFICE, A_FEED_KEY, 0, 100)).toHaveLength(3)
    expect(h.host.store.getCacheMaxSeq(OFFICE, A_FEED_KEY)).toBe(3)
  })

  it('rejects forged entries from a peer that is neither author nor authority', () => {
    h = makeHarness()
    const forged: FeedSyncFrame = {
      kind: 'feed-entries',
      officeId: OFFICE,
      feedKey: A_FEED_KEY,
      entries: [{ seq: 1, hlc: '0'.repeat(16), fid: 'forged-1', type: 'msg', payload: msg(1), ts: 1 }],
      upToSeq: 1,
      more: false,
    }
    // B injects entries claiming to be A's feed; the host's origin gate drops them.
    h.host.feed.handleFrame(B, forged)
    expect(cachedTranscript(h.host)).toHaveLength(0)
  })

  it('start() heals a tail persisted before the last shutdown', () => {
    h = makeHarness()
    h.a.transcripts.set(SESSION_KEY, [msg(1)])
    h.a.feed.publishOwnedTail(SESSION_KEY)
    // The transcript grew while the feed was down (no publish trigger fired).
    h.a.transcripts.set(SESSION_KEY, [msg(1), msg(2)])
    h.rebuild(h.a)
    h.a.feed.start() // heal pass publishes the missing tail
    h.a.feed.retransmitTick()
    expect(cachedTranscript(h.host).map((m) => m.seq)).toEqual([1, 2])
  })

  it('ignores a session key that does not belong to this office', () => {
    h = makeHarness()
    const foreignKey = buildTeamSessionKey(APP, 'office-other', EPOCH)
    h.a.transcripts.set(foreignKey, [msg(1)])
    expect(h.a.feed.publishOwnedTail(foreignKey)).toBe(0)
  })

  it('schedulePublish coalesces bursts and runs a finalize pass', () => {
    vi.useFakeTimers()
    try {
      h = makeHarness()
      h.a.transcripts.set(SESSION_KEY, [msg(1)])
      h.a.feed.schedulePublish(SESSION_KEY)
      h.a.feed.schedulePublish(SESSION_KEY) // coalesced into one publish
      vi.advanceTimersByTime(500)
      expect(cachedTranscript(h.host).map((m) => m.seq)).toEqual([1])

      // A row landing after the debounced publish is caught by the finalize pass.
      h.a.transcripts.set(SESSION_KEY, [msg(1), msg(2)])
      vi.advanceTimersByTime(3100)
      expect(cachedTranscript(h.host).map((m) => m.seq)).toEqual([1, 2])
    } finally {
      vi.useRealTimers()
    }
  })

  it('withholds an in-flight provisional tail, then completes it once the turn ends', () => {
    h = makeHarness()
    // Mid-turn: the trailing assistant message is a provisional flush.
    h.a.activeSessions.add(SESSION_KEY)
    h.a.transcripts.set(SESSION_KEY, [
      msg(1),
      { seq: 2, role: 'assistant', content: 'partial…', ts: 1002 },
    ])
    h.a.feed.publishOwnedTail(SESSION_KEY)
    // Only the finished prefix replicated; the provisional row is withheld.
    expect(cachedTranscript(h.host).map((m) => m.seq)).toEqual([1])

    // Turn ends: the message completes with its final text; the dirty sweep
    // publishes it (no explicit trigger needed).
    h.a.activeSessions.delete(SESSION_KEY)
    h.a.transcripts.set(SESSION_KEY, [
      msg(1),
      { seq: 2, role: 'assistant', content: 'final verdict: champion 3', ts: 1002 },
    ])
    h.a.feed.retransmitTick()
    const rows = cachedTranscript(h.host)
    expect(rows.map((m) => m.seq)).toEqual([1, 2])
    expect(rows[1].content).toBe('final verdict: champion 3')
    expect(cachedTranscript(h.b)[1]?.content).toBe('final verdict: champion 3')
  })

  it('revision self-heal: a changed last message re-replicates under the same seq', () => {
    h = makeHarness()
    // A provisional snapshot slipped through (e.g. a gate race): v1 published.
    h.a.transcripts.set(SESSION_KEY, [msg(1), { seq: 2, role: 'assistant', content: 'v1', ts: 1002 }])
    h.a.feed.publishOwnedTail(SESSION_KEY)
    expect(cachedTranscript(h.host)[1].content).toBe('v1')

    // The message completed differently on disk: a revision entry converges
    // every replica on the final form without breaking seq alignment.
    h.a.transcripts.set(SESSION_KEY, [msg(1), { seq: 2, role: 'assistant', content: 'v2 final', ts: 1002 }])
    h.a.feed.publishOwnedTail(SESSION_KEY)
    expect(cachedTranscript(h.host).map((m) => m.seq)).toEqual([1, 2])
    expect(cachedTranscript(h.host)[1].content).toBe('v2 final')
    expect(cachedTranscript(h.b)[1].content).toBe('v2 final')

    // Later appends still replicate normally after a revision.
    h.a.transcripts.set(SESSION_KEY, [
      msg(1),
      { seq: 2, role: 'assistant', content: 'v2 final', ts: 1002 },
      msg(3),
    ])
    h.a.feed.publishOwnedTail(SESSION_KEY)
    expect(cachedTranscript(h.host).map((m) => m.seq)).toEqual([1, 2, 3])
    expect(cachedTranscript(h.b).map((m) => m.seq)).toEqual([1, 2, 3])
  })

  it('classifies session vs ctrl feed frames', () => {
    h = makeHarness()
    const sessionFrame: FeedSyncFrame = { kind: 'feed-advertise', officeId: OFFICE, feedKey: A_FEED_KEY, upToSeq: 1 }
    const ctrlFrame: FeedSyncFrame = {
      kind: 'feed-subscribe',
      officeId: OFFICE,
      feedKey: feedIdKey({ officeId: OFFICE, author: A, kind: 'ctrl' }),
      afterSeq: 0,
    }
    expect(isSessionFeedFrame(OFFICE, sessionFrame)).toBe(true)
    expect(isSessionFeedFrame(OFFICE, ctrlFrame)).toBe(false)
  })
})
