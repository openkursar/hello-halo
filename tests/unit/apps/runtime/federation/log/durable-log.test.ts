/**
 * Unit tests for DurableFeedLog: monotonic seq allocation, increasing HLC,
 * unique fids, restart clock-seed no-regress (the fix for in-memory seq/clock
 * reset that let viewers drop post-restart frames), and truncation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../../src/main/platform/store/types'
import { FeedStore } from '../../../../../../src/main/apps/federation/feed-store'
import {
  MIGRATION_NAMESPACE,
  migrations,
} from '../../../../../../src/main/apps/federation/migrations'
import { createDurableFeedLog } from '../../../../../../src/main/apps/runtime/federation/log/durable-log'
import { compareHlc } from '../../../../../../src/main/apps/runtime/federation/log/hlc'

const OFFICE = 'office-1'
const FEED = 'node-self\u0000ctrl'

describe('DurableFeedLog', () => {
  let dbManager: DatabaseManager
  let store: FeedStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new FeedStore(db)
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  it('allocates monotonic seq and strictly increasing HLC with unique fids', () => {
    let wall = 1000
    const log = createDurableFeedLog({ store, officeId: OFFICE, now: () => wall })
    const a = log.append(FEED, 'msg', { i: 1 })
    const b = log.append(FEED, 'msg', { i: 2 })
    wall = 1001
    const c = log.append(FEED, 'msg', { i: 3 })

    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
    expect(compareHlc(a.hlc, b.hlc)).toBe(-1)
    expect(compareHlc(b.hlc, c.hlc)).toBe(-1)
    expect(new Set([a.fid, b.fid, c.fid]).size).toBe(3)
    expect(log.latestSeq(FEED)).toBe(3)
  })

  it('reads back the tail as light entries', () => {
    const log = createDurableFeedLog({ store, officeId: OFFICE })
    log.append(FEED, 'msg', { i: 1 })
    log.append(FEED, 'msg', { i: 2 })
    const tail = log.read(FEED, 1, 10)
    expect(tail.map((e) => e.seq)).toEqual([2])
    expect(tail[0].payload).toEqual({ i: 2 })
  })

  it('does not reset seq or regress the clock after a restart', () => {
    let wall = 5000
    const log1 = createDurableFeedLog({ store, officeId: OFFICE, now: () => wall })
    const first = log1.append(FEED, 'msg', {})
    const second = log1.append(FEED, 'msg', {})
    expect(second.seq).toBe(2)

    // Simulate a process restart: brand-new log over the SAME store, wall clock
    // now behind the persisted high-water (e.g. suspend/resume skew).
    wall = 100
    const log2 = createDurableFeedLog({ store, officeId: OFFICE, now: () => wall })
    const third = log2.append(FEED, 'msg', {})
    expect(third.seq).toBe(3) // seq continues, not reset to 1
    expect(compareHlc(third.hlc, second.hlc)).toBe(1) // clock did not regress
  })

  it('merges an observed remote HLC forward', () => {
    const wall = 1000
    const log = createDurableFeedLog({ store, officeId: OFFICE, now: () => wall })
    const local = log.append(FEED, 'msg', {})
    // A remote entry a little ahead of local wall time but within the drift guard.
    const remote = (wall + 500).toString(16).padStart(12, '0') + '0000'
    log.observeHlc(remote)
    const afterObserve = log.append(FEED, 'msg', {})
    expect(compareHlc(afterObserve.hlc, local.hlc)).toBe(1)
    expect(compareHlc(afterObserve.hlc, remote)).toBe(1)
  })

  it('truncates and records the retention floor', () => {
    const log = createDurableFeedLog({ store, officeId: OFFICE })
    for (let i = 0; i < 5; i++) log.append(FEED, 'msg', {})
    expect(log.truncate(FEED, 3)).toBe(3)
    expect(store.getMeta(OFFICE, FEED)?.truncatedBeforeSeq).toBe(3)
    expect(log.read(FEED, 0, 10).map((e) => e.seq)).toEqual([4, 5])
  })

  it('continues seq monotonically after the feed is fully pruned', () => {
    const log = createDurableFeedLog({ store, officeId: OFFICE })
    for (let i = 0; i < 5; i++) log.append(FEED, 'msg', {})
    // A fully-acked low-traffic feed gets pruned to empty...
    log.truncate(FEED, 5)
    expect(store.getMaxSeq(OFFICE, FEED)).toBe(0)
    // ...the next append must NOT reuse seq 1 (a consumer at cursor 5 would drop it).
    const next = log.append(FEED, 'msg', {})
    expect(next.seq).toBe(6)
  })
})
