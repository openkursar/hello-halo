/**
 * Unit tests for the feed sync engine (producer + consumer) driven through an
 * in-memory paired transport with a controllable frame-drop injector. Proves
 * the effectively-once contract: happy-path delivery, lost-middle-frame recovery
 * via nack, whole-frame loss recovery via the retransmit backstop, duplicate
 * dedup, out-of-order buffering, windowed streaming, and deferred apply retry.
 */

import { describe, it, expect } from 'vitest'
import {
  createFeedProducer,
  createFeedConsumer,
  type FeedProducer,
  type FeedConsumer,
} from '../../../../../../src/main/apps/runtime/federation/log/sync-engine'
import type {
  FeedEntry,
  FeedEntriesFrame,
} from '../../../../../../src/main/apps/runtime/federation/log/types'

const OFFICE = 'office-1'
const FEED = 'author\u0000ctrl'
const READER = 'reader'

interface Harness {
  producer: FeedProducer
  consumer: FeedConsumer
  applied: FeedEntry[]
  appendAuthor: (payload: unknown) => void
  /** Add an entry to the author's readable log WITHOUT a live push (test setup). */
  seedFeedOnly: (payload: unknown) => void
  /** Preset the consumer's applied watermark (as if it had applied up to seq). */
  presetLocalCursor: (feedKey: string, seq: number) => void
  /** Drop the next producer→consumer entries frame whose predicate returns true. */
  dropProducerFrame: (pred: (f: FeedEntriesFrame) => boolean) => void
  failApplyForSeq: (seq: number | null) => void
  /** Drop the next N consumer→producer feed-subscribe frames (simulate lost subscribe). */
  dropNextSubscribes: (n: number) => void
}

function makeHarness(batchMax = 64, pendingMax?: number): Harness {
  const feed: FeedEntry[] = []
  const peerCursors = new Map<string, number>()
  const localCursor = new Map<string, number>()
  const applied: FeedEntry[] = []
  let dropPred: ((f: FeedEntriesFrame) => boolean) | null = null
  let dropSubscribes = 0
  let failSeq: number | null = null

  const key = (feedKey: string, peer: string): string => `${feedKey}|${peer}`

  const producer = createFeedProducer({
    officeId: OFFICE,
    batchMax,
    read: (_feedKey, after, limit) => feed.filter((e) => e.seq > after).slice(0, limit),
    latestSeq: () => (feed.length ? feed[feed.length - 1].seq : 0),
    getPeerCursor: (feedKey, peer) => peerCursors.get(key(feedKey, peer)) ?? 0,
    setPeerCursor: (feedKey, peer, seq) => peerCursors.set(key(feedKey, peer), seq),
    send: (_peer, frame) => {
      if (dropPred && dropPred(frame)) {
        dropPred = null // one-shot drop
        return
      }
      // Deliver to the consumer (deep copy to mimic serialization).
      consumer.onEntries(JSON.parse(JSON.stringify(frame)) as FeedEntriesFrame)
    },
  })

  const consumer: FeedConsumer = createFeedConsumer({
    officeId: OFFICE,
    ...(pendingMax !== undefined ? { pendingMax } : {}),
    getLocalCursor: (feedKey) => localCursor.get(feedKey) ?? 0,
    setLocalCursor: (feedKey, seq) => localCursor.set(feedKey, seq),
    apply: (_feedKey, entry) => {
      if (failSeq !== null && entry.seq === failSeq) throw new Error(`forced apply failure @${entry.seq}`)
      applied.push(entry)
    },
    send: (frame) => {
      // Route consumer control frames back to the producer (author = READER's peer).
      if (frame.kind === 'feed-subscribe') {
        if (dropSubscribes > 0) {
          dropSubscribes -= 1 // simulate a lost subscribe the producer never sees
          return
        }
        producer.onSubscribe(READER, frame.feedKey, frame.afterSeq)
      } else if (frame.kind === 'feed-ack') producer.onAck(READER, frame.feedKey, frame.ackedSeq)
      else if (frame.kind === 'feed-nack') producer.onNack(READER, frame.feedKey, frame.missing)
    },
  })

  function seedFeedOnly(payload: unknown): void {
    const seq = (feed.length ? feed[feed.length - 1].seq : 0) + 1
    feed.push({ seq, hlc: seq.toString(16).padStart(16, '0'), fid: `fid-${seq}`, type: 'msg', payload, ts: seq })
  }

  function appendAuthor(payload: unknown): void {
    seedFeedOnly(payload)
    producer.notifyAppended(FEED)
  }

  return {
    producer,
    consumer,
    applied,
    appendAuthor,
    seedFeedOnly,
    presetLocalCursor: (feedKey, seq) => localCursor.set(feedKey, seq),
    dropProducerFrame: (pred) => {
      dropPred = pred
    },
    failApplyForSeq: (seq) => {
      failSeq = seq
    },
    dropNextSubscribes: (n) => {
      dropSubscribes = n
    },
  }
}

describe('feed sync — happy path', () => {
  it('delivers appends live once subscribed', () => {
    const h = makeHarness()
    h.consumer.subscribe(FEED) // reader announces afterSeq=0
    h.appendAuthor({ n: 1 })
    h.appendAuthor({ n: 2 })
    h.appendAuthor({ n: 3 })
    expect(h.applied.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('backfills existing entries on subscribe (catch-up == live)', () => {
    const h = makeHarness()
    h.appendAuthor({ n: 1 }) // authored before anyone subscribed (no live push lands)
    h.appendAuthor({ n: 2 })
    expect(h.applied).toHaveLength(0)
    h.consumer.subscribe(FEED)
    expect(h.applied.map((e) => e.seq)).toEqual([1, 2])
  })
})

describe('feed sync — loss recovery', () => {
  it('recovers a lost middle frame on the next append (resend from ack)', () => {
    const h = makeHarness()
    h.consumer.subscribe(FEED)
    h.appendAuthor({ n: 1 })
    // Drop the live push for seq 2; the peer ack stays at 1.
    h.dropProducerFrame((f) => f.entries.some((e) => e.seq === 2))
    h.appendAuthor({ n: 2 })
    expect(h.applied.map((e) => e.seq)).toEqual([1]) // 2 dropped
    // The next append resends from the peer's ack (1), carrying 2 and 3 together.
    h.appendAuthor({ n: 3 })
    expect(h.applied.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('recovers via an explicit nack when a gap is exposed with no further push', () => {
    const h = makeHarness()
    // Author holds 1..4; reader has already applied 1..2.
    for (let i = 1; i <= 4; i++) h.seedFeedOnly({ n: i })
    h.presetLocalCursor(FEED, 2)
    // A batch arrives with seq 4 (seq 3's frame was lost). No further append or
    // tick will come — the consumer must nack [3..3] itself to recover.
    h.consumer.onEntries({
      kind: 'feed-entries',
      officeId: OFFICE,
      feedKey: FEED,
      entries: [{ seq: 4, hlc: '4'.padStart(16, '0'), fid: 'fid-4', type: 'msg', payload: { n: 4 }, ts: 4 }],
      upToSeq: 4,
      more: false,
    })
    // producer.onNack resent seq 3 → 3 applies, then buffered 4 applies.
    expect(h.applied.map((e) => e.seq)).toEqual([3, 4])
  })

  it('recovers a fully-lost frame via the retransmit backstop', () => {
    const h = makeHarness()
    h.consumer.subscribe(FEED)
    // Drop the only frame carrying seq 1 entirely; the consumer never learns of it.
    h.dropProducerFrame((f) => f.entries.some((e) => e.seq === 1))
    h.appendAuthor({ n: 1 })
    expect(h.applied).toHaveLength(0)
    // Backstop: producer resends from the peer's ack (still 0) on the tick.
    h.producer.retransmitTick()
    expect(h.applied.map((e) => e.seq)).toEqual([1])
  })
})

describe('feed sync — idempotency & ordering', () => {
  it('dedups a duplicate entry (retransmit after ack)', () => {
    const h = makeHarness()
    h.consumer.subscribe(FEED)
    h.appendAuthor({ n: 1 })
    // The backstop must not resend an already-acked entry (peer is caught up)...
    h.producer.retransmitTick()
    // ...and even a stray duplicate frame must not double-apply.
    h.consumer.onEntries({
      kind: 'feed-entries',
      officeId: OFFICE,
      feedKey: FEED,
      entries: [{ seq: 1, hlc: '0'.repeat(16), fid: 'fid-1', type: 'msg', payload: { n: 1 }, ts: 1 }],
      upToSeq: 1,
      more: false,
    })
    expect(h.applied.map((e) => e.seq)).toEqual([1])
  })

  it('buffers out-of-order entries and applies contiguously', () => {
    const h = makeHarness()
    // Feed a single frame with a gap: 1, 3 (2 missing). Only 1 applies; 3 buffers.
    h.consumer.onEntries({
      kind: 'feed-entries',
      officeId: OFFICE,
      feedKey: FEED,
      entries: [
        { seq: 1, hlc: '1'.padStart(16, '0'), fid: 'f1', type: 'msg', payload: {}, ts: 1 },
        { seq: 3, hlc: '3'.padStart(16, '0'), fid: 'f3', type: 'msg', payload: {}, ts: 3 },
      ],
      upToSeq: 3,
      more: false,
    })
    expect(h.applied.map((e) => e.seq)).toEqual([1])
    // The missing 2 arrives → 2 then the buffered 3 apply.
    h.consumer.onEntries({
      kind: 'feed-entries',
      officeId: OFFICE,
      feedKey: FEED,
      entries: [{ seq: 2, hlc: '2'.padStart(16, '0'), fid: 'f2', type: 'msg', payload: {}, ts: 2 }],
      upToSeq: 3,
      more: false,
    })
    expect(h.applied.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('re-applies an entry evicted from the gap buffer when the producer resends it', () => {
    // Regression: a fid table recorded at ADMISSION poisoned this path — the
    // evicted entry's resend came back "already seen" and was dropped forever,
    // stalling the feed at the hole (and, on the ctrl plane, stranding every
    // later turn-complete behind it). Only the seq cursor may dedup.
    const h = makeHarness(64, 2) // gap buffer bound = 2
    // Author holds 1..5; the reader has applied 1. Seqs 3,4,5 arrive while 2 is
    // still missing → the overflow bound evicts the furthest-ahead entry (5).
    for (let i = 1; i <= 5; i++) h.seedFeedOnly({ n: i })
    h.presetLocalCursor(FEED, 1)
    h.consumer.onEntries({
      kind: 'feed-entries',
      officeId: OFFICE,
      feedKey: FEED,
      entries: [3, 4, 5].map((n) => ({
        seq: n, hlc: String(n).padStart(16, '0'), fid: `fid-${n}`, type: 'msg', payload: { n }, ts: n,
      })),
      upToSeq: 5,
      more: false,
    })
    // The consumer's own nacks drive recovery through the producer: the gap fill
    // (2) unlocks 2..4, and the resend of the EVICTED 5 must apply too.
    expect(h.applied.map((e) => e.seq)).toEqual([2, 3, 4, 5])
  })
})

describe('feed sync — windowed streaming', () => {
  it('streams a backlog larger than one batch via ack-driven windows', () => {
    const h = makeHarness(2) // batchMax = 2
    for (let i = 1; i <= 5; i++) h.appendAuthor({ n: i })
    h.consumer.subscribe(FEED)
    expect(h.applied.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('feed sync — deferred apply', () => {
  it('defers on a throwing apply and retries later without losing order', () => {
    const h = makeHarness()
    h.consumer.subscribe(FEED)
    h.failApplyForSeq(2) // seq 2 will throw the first time
    h.appendAuthor({ n: 1 })
    h.appendAuthor({ n: 2 }) // applies 1, defers at 2
    expect(h.applied.map((e) => e.seq)).toEqual([1])
    h.failApplyForSeq(null) // recover
    h.producer.retransmitTick() // resend from ack (1) → 2 retries, then 3 flows
    h.appendAuthor({ n: 3 })
    expect(h.applied.map((e) => e.seq)).toEqual([1, 2, 3])
  })
})

describe('feed sync — lost-subscribe self-heal', () => {
  // Regression for the production incident: a member joined mid-run, its one-shot
  // feed-subscribe never registered at the producer, and every directed entry sat
  // undelivered for hours while presence/replication/activity all looked healthy.
  // The two heals below each recover it independently.

  it('producer.ensureSubscribed registers a peer that never sent a subscribe', () => {
    const h = makeHarness()
    // Author holds a backlog; the reader never subscribed (its frame was lost), so
    // nothing has been pushed and the retransmit backstop has no one to resend to.
    h.appendAuthor({ n: 1 })
    h.appendAuthor({ n: 2 })
    expect(h.applied).toHaveLength(0)

    // The always-on primary heal: an inbound frame (e.g. a heartbeat) drives the
    // producer to register the peer and stream the tail — no subscribe required.
    const added = h.producer.ensureSubscribed(READER, FEED)
    expect(added).toBe(true)
    expect(h.applied.map((e) => e.seq)).toEqual([1, 2])

    // Idempotent: a second call is a no-op (retransmit owns any later catch-up).
    expect(h.producer.ensureSubscribed(READER, FEED)).toBe(false)
    // A later append still flows to the healed subscriber.
    h.appendAuthor({ n: 3 })
    expect(h.applied.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('ensureSubscribed streams only the tail above a persisted cursor (no rewind)', () => {
    const h = makeHarness()
    for (let i = 1; i <= 3; i++) h.seedFeedOnly({ n: i })
    // The peer previously acked up to seq 2 (persisted), then its subscription was
    // dropped. Healing must resend only seq 3, never replay 1..2.
    h.producer.onAck(READER, FEED, 2)
    h.producer.dropPeer(READER)
    h.presetLocalCursor(FEED, 2)

    const added = h.producer.ensureSubscribed(READER, FEED)
    expect(added).toBe(true)
    expect(h.applied.map((e) => e.seq)).toEqual([3])
  })

  it('consumer.resubscribeStale re-drives a lost subscribe until a batch arrives', () => {
    const h = makeHarness()
    h.appendAuthor({ n: 1 }) // backlog the reader should eventually get
    h.dropNextSubscribes(2) // the first two subscribe attempts are lost

    h.consumer.subscribe(FEED) // attempt #1 — dropped, producer never registers us
    expect(h.applied).toHaveLength(0)

    h.consumer.resubscribeStale() // attempt #2 — dropped
    expect(h.applied).toHaveLength(0)

    h.consumer.resubscribeStale() // attempt #3 — gets through → producer registers + pushes
    expect(h.applied.map((e) => e.seq)).toEqual([1])
  })

  it('resubscribeStale stops once a batch has arrived (no unbounded re-drive)', () => {
    const h = makeHarness()
    h.appendAuthor({ n: 1 })
    h.consumer.subscribe(FEED) // succeeds immediately → batch delivered
    expect(h.applied.map((e) => e.seq)).toEqual([1])

    // With the feed already flowing, the tick has nothing to re-drive.
    expect(h.consumer.resubscribeStale()).toEqual([])
  })

  it('resubscribeStale gives up after the attempt budget for a genuinely empty feed', () => {
    const h = makeHarness()
    // A subscribed feed the author has never written to yields no batch. The
    // consumer must not re-ask forever — the budget bounds it.
    h.dropNextSubscribes(1) // lose the initial subscribe so we enter the re-drive path
    h.consumer.subscribe(FEED)
    let redriveTicks = 0
    for (let i = 0; i < 20; i++) {
      if (h.consumer.resubscribeStale().length === 0) break
      redriveTicks += 1
    }
    // Bounded: RESUBSCRIBE_MAX_ATTEMPTS (6) re-drives, then it stops.
    expect(redriveTicks).toBe(6)
    expect(h.consumer.resubscribeStale()).toEqual([])
  })
})
