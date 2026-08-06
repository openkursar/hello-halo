/**
 * End-to-end integration test for FeedService: two per-office services (an
 * author node and a reader node) exchange sync frames through an in-memory
 * routing bus backed by REAL FeedStore persistence. Proves the assembled unit
 * delivers reliably across a link drop, survives an author "restart" (new
 * service over the same store, no seq reset), and routes a consumer's control
 * frames to the correct author.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../../src/main/platform/store/types'
import { FeedStore } from '../../../../../../src/main/apps/federation/feed-store'
import {
  MIGRATION_NAMESPACE,
  migrations,
} from '../../../../../../src/main/apps/federation/migrations'
import { createFeedService, type FeedService } from '../../../../../../src/main/apps/runtime/federation/log/feed-service'
import type { FeedEntry, FeedSyncFrame } from '../../../../../../src/main/apps/runtime/federation/log/types'

const OFFICE = 'office-1'
const AUTHOR = 'node-author'
const READER = 'node-reader'

interface Bus {
  authorSvc: FeedService
  readerSvc: FeedService
  applied: FeedEntry[]
  /** Drop the next frame delivered to a node whose predicate matches. */
  dropOnce: (to: string, pred: (f: FeedSyncFrame) => boolean) => void
  rebuildAuthor: () => void
}

function makeBus(store: FeedStore): Bus {
  const applied: FeedEntry[] = []
  let drop: { to: string; pred: (f: FeedSyncFrame) => boolean } | null = null

  // Route a frame to the destination node's service; `from` is the sender.
  function deliver(to: string, from: string, frame: FeedSyncFrame): void {
    if (drop && drop.to === to && drop.pred(frame)) {
      drop = null
      return
    }
    const wire = JSON.parse(JSON.stringify(frame)) as FeedSyncFrame
    if (to === AUTHOR) authorSvc.handleInbound(from, wire)
    else readerSvc.handleInbound(from, wire)
  }

  let authorSvc: FeedService = buildAuthor()
  const readerSvc: FeedService = createFeedService({
    store,
    officeId: OFFICE,
    selfNodeId: READER,
    sendToPeer: (peer, frame) => deliver(peer, READER, frame),
    apply: (_feedKey, entry) => {
      applied.push(entry)
    },
    retransmitIntervalMs: 0,
  })

  function buildAuthor(): FeedService {
    return createFeedService({
      store,
      officeId: OFFICE,
      selfNodeId: AUTHOR,
      sendToPeer: (peer, frame) => deliver(peer, AUTHOR, frame),
      apply: () => {
        /* author consumes nothing in this test */
      },
      retransmitIntervalMs: 0,
    })
  }

  const bus: Bus = {
    // Getter so `bus.authorSvc` always resolves the current (possibly rebuilt) service.
    get authorSvc() {
      return authorSvc
    },
    readerSvc,
    applied,
    dropOnce: (to, pred) => {
      drop = { to, pred }
    },
    rebuildAuthor: () => {
      authorSvc = buildAuthor()
    },
  }
  return bus
}

describe('FeedService end-to-end', () => {
  let dbManager: DatabaseManager
  let store: FeedStore
  let bus: Bus

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new FeedStore(db)
    bus = makeBus(store)
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  it('delivers authored ctrl entries to a subscribed reader', () => {
    bus.readerSvc.subscribeRemote(AUTHOR, 'ctrl')
    bus.authorSvc.appendLocal('ctrl', 'msg', { n: 1 })
    bus.authorSvc.appendLocal('ctrl', 'msg', { n: 2 })
    expect(bus.applied.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('recovers from a dropped delivery via the retransmit backstop', () => {
    bus.readerSvc.subscribeRemote(AUTHOR, 'ctrl')
    // Drop the first entries frame headed to the reader entirely.
    bus.dropOnce(READER, (f) => f.kind === 'feed-entries')
    bus.authorSvc.appendLocal('ctrl', 'msg', { n: 1 })
    expect(bus.applied).toHaveLength(0)
    bus.authorSvc.retransmitTick()
    expect(bus.applied.map((e) => e.payload)).toEqual([{ n: 1 }])
  })

  it('persists the delivery watermark so an author restart does not reset seq', () => {
    bus.readerSvc.subscribeRemote(AUTHOR, 'ctrl')
    bus.authorSvc.appendLocal('ctrl', 'msg', { n: 1 })
    bus.authorSvc.appendLocal('ctrl', 'msg', { n: 2 })
    expect(bus.applied).toHaveLength(2)

    // Author process restarts: a brand-new service over the SAME store.
    bus.rebuildAuthor()
    const third = bus.authorSvc.appendLocal('ctrl', 'msg', { n: 3 })
    expect(third.seq).toBe(3) // continues, not reset to 1

    // Reader re-subscribes from its persisted watermark and gets only the tail.
    bus.readerSvc.subscribeRemote(AUTHOR, 'ctrl')
    expect(bus.applied.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('producer heals a lost subscribe via ensurePeerSubscribed (heartbeat-driven)', () => {
    // Reader subscribes but the subscribe frame is lost — the author never
    // registers it, so appends are neither pushed nor retransmitted (the exact
    // production stall: a member joined mid-run, its wakes sat undelivered).
    bus.dropOnce(AUTHOR, (f) => f.kind === 'feed-subscribe')
    bus.readerSvc.subscribeRemote(AUTHOR, 'ctrl')
    bus.authorSvc.appendLocal('ctrl', 'msg', { n: 1 })
    bus.authorSvc.appendLocal('ctrl', 'msg', { n: 2 })
    expect(bus.applied).toHaveLength(0)

    // An inbound frame from the reader (a heartbeat, in production) drives the
    // author to register it and stream the backlog — no subscribe needed.
    const added = bus.authorSvc.ensurePeerSubscribed('ctrl', READER)
    expect(added).toBe(true)
    expect(bus.applied.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }])
    // Idempotent on later heartbeats.
    expect(bus.authorSvc.ensurePeerSubscribed('ctrl', READER)).toBe(false)
  })

  it('consumer heals a lost subscribe via the retransmit tick (resubscribeStale)', () => {
    bus.dropOnce(AUTHOR, (f) => f.kind === 'feed-subscribe')
    bus.readerSvc.subscribeRemote(AUTHOR, 'ctrl') // subscribe #1 lost
    bus.authorSvc.appendLocal('ctrl', 'msg', { n: 1 })
    expect(bus.applied).toHaveLength(0)

    // The reader's own tick re-drives the subscribe; it now reaches the author,
    // which registers the reader and streams the backlog.
    bus.readerSvc.retransmitTick()
    expect(bus.applied.map((e) => e.payload)).toEqual([{ n: 1 }])
  })

  it('keeps distinct feed kinds independent', () => {
    bus.readerSvc.subscribeRemote(AUTHOR, 'ctrl')
    bus.readerSvc.subscribeRemote(AUTHOR, 'act')
    bus.authorSvc.appendLocal('ctrl', 'msg', { plane: 'ctrl' })
    bus.authorSvc.appendLocal('act', 'frame', { plane: 'act' })
    const planes = bus.applied.map((e) => (e.payload as { plane: string }).plane).sort()
    expect(planes).toEqual(['act', 'ctrl'])
  })
})
