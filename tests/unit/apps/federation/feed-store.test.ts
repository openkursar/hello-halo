/**
 * Unit tests for FeedStore: feed_log append/read/prune, delivery + apply
 * cursors, the viewer cache, and per-feed high-water marks. Uses :memory:
 * databases and exercises the app_federation v6 migration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { FeedStore } from '../../../../src/main/apps/federation/feed-store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/federation/migrations'
import type { FeedEntryRecord } from '../../../../src/main/apps/federation/types'

const OFFICE = 'office-a'
const FEED = 'node-1\u0000ctrl'

function makeEntry(seq: number, overrides?: Partial<FeedEntryRecord>): FeedEntryRecord {
  const now = Date.now()
  return {
    officeId: OFFICE,
    feedId: FEED,
    seq,
    hlc: seq.toString(16).padStart(16, '0'),
    fid: `fid-${seq}`,
    type: 'msg',
    payload: { n: seq },
    ts: now,
    createdAt: now,
    ...overrides,
  }
}

describe('FeedStore', () => {
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

  describe('feed_log', () => {
    it('appends and reads the tail after a seq', () => {
      store.appendEntry(makeEntry(1))
      store.appendEntry(makeEntry(2))
      store.appendEntry(makeEntry(3))
      expect(store.getMaxSeq(OFFICE, FEED)).toBe(3)
      expect(store.getMinSeq(OFFICE, FEED)).toBe(1)
      const tail = store.listAfter(OFFICE, FEED, 1, 10)
      expect(tail.map((e) => e.seq)).toEqual([2, 3])
      expect(tail[0].payload).toEqual({ n: 2 })
    })

    it('caps a read at the limit', () => {
      for (let i = 1; i <= 5; i++) store.appendEntry(makeEntry(i))
      expect(store.listAfter(OFFICE, FEED, 0, 2).map((e) => e.seq)).toEqual([1, 2])
    })

    it('enforces (office,feed,seq) uniqueness', () => {
      store.appendEntry(makeEntry(1))
      expect(() => store.appendEntry(makeEntry(1, { fid: 'other' }))).toThrow()
    })

    it('enforces (office,feed,fid) idempotency', () => {
      store.appendEntry(makeEntry(1, { fid: 'dup' }))
      expect(() => store.appendEntry(makeEntry(2, { fid: 'dup' }))).toThrow()
      expect(store.hasFid(OFFICE, FEED, 'dup')).toBe(true)
      expect(store.hasFid(OFFICE, FEED, 'nope')).toBe(false)
    })

    it('isolates feeds and offices', () => {
      store.appendEntry(makeEntry(1))
      store.appendEntry(makeEntry(1, { feedId: 'node-2\u0000ctrl' }))
      store.appendEntry(makeEntry(1, { officeId: 'office-b' }))
      expect(store.getMaxSeq(OFFICE, FEED)).toBe(1)
      expect(store.getMaxSeq(OFFICE, 'node-2\u0000ctrl')).toBe(1)
      expect(store.getMaxSeq('office-b', FEED)).toBe(1)
    })

    it('prunes entries at or below a seq', () => {
      for (let i = 1; i <= 5; i++) store.appendEntry(makeEntry(i))
      expect(store.pruneBefore(OFFICE, FEED, 3)).toBe(3)
      expect(store.getMinSeq(OFFICE, FEED)).toBe(4)
      expect(store.getMaxSeq(OFFICE, FEED)).toBe(5)
    })

    it('enumerates the distinct authored feed ids per office', () => {
      store.appendEntry(makeEntry(1))
      store.appendEntry(makeEntry(2))
      store.appendEntry(makeEntry(1, { feedId: 'node-1\u0000session:k1' }))
      store.appendEntry(makeEntry(1, { officeId: 'office-b', feedId: 'node-9\u0000ctrl' }))
      expect(store.listLogFeedIds(OFFICE).sort()).toEqual([FEED, 'node-1\u0000session:k1'].sort())
      expect(store.listLogFeedIds('office-b')).toEqual(['node-9\u0000ctrl'])
      expect(store.listLogFeedIds('empty')).toEqual([])
    })
  })

  describe('cursors', () => {
    it('tracks a per-peer delivery watermark and its minimum', () => {
      expect(store.getPeerCursor(OFFICE, FEED, 'peer-1')).toBe(0)
      store.setPeerCursor(OFFICE, FEED, 'peer-1', 5, Date.now())
      store.setPeerCursor(OFFICE, FEED, 'peer-2', 3, Date.now())
      expect(store.getPeerCursor(OFFICE, FEED, 'peer-1')).toBe(5)
      expect(store.getMinPeerCursor(OFFICE, FEED)).toBe(3)
      expect(store.getMinPeerCursor(OFFICE, 'unknown')).toBeNull()
    })

    it('tracks the local applied watermark', () => {
      expect(store.getLocalCursor(OFFICE, FEED)).toBe(0)
      store.setLocalCursor(OFFICE, FEED, 7, Date.now())
      expect(store.getLocalCursor(OFFICE, FEED)).toBe(7)
    })
  })

  describe('feed_cache', () => {
    it('stores, upserts and reads the tail', () => {
      store.putCache(OFFICE, FEED, 1, '{"a":1}')
      store.putCache(OFFICE, FEED, 2, '{"a":2}')
      store.putCache(OFFICE, FEED, 2, '{"a":22}') // upsert
      expect(store.getCacheMaxSeq(OFFICE, FEED)).toBe(2)
      expect(store.listCache(OFFICE, FEED, 1, 10)).toEqual([{ seq: 2, entryJson: '{"a":22}' }])
    })

    it('enumerates the distinct cached feed ids per office', () => {
      store.putCache(OFFICE, 'node-2\u0000session:k1', 1, '{}')
      store.putCache(OFFICE, 'node-2\u0000session:k1', 2, '{}')
      store.putCache(OFFICE, 'node-3\u0000session:k2', 1, '{}')
      store.putCache('office-b', 'node-2\u0000session:k1', 1, '{}')
      expect(store.listCacheFeedIds(OFFICE).sort()).toEqual(
        ['node-2\u0000session:k1', 'node-3\u0000session:k2'].sort()
      )
      expect(store.listCacheFeedIds('empty')).toEqual([])
    })
  })

  describe('feed_meta', () => {
    it('records the retention floor', () => {
      store.setTruncatedBefore(OFFICE, FEED, 4)
      expect(store.getMeta(OFFICE, FEED)?.truncatedBeforeSeq).toBe(4)
    })

    it('persists hlc high-water and exposes the office maximum', () => {
      store.setHlcHigh(OFFICE, FEED, '0000000000010000')
      store.setHlcHigh(OFFICE, 'node-2\u0000act', '0000000000020000')
      expect(store.getMeta(OFFICE, FEED)?.hlcHigh).toBe('0000000000010000')
      expect(store.getOfficeHlcHigh(OFFICE)).toBe('0000000000020000')
      expect(store.getOfficeHlcHigh('empty')).toBeNull()
    })

    it('keeps truncation and hlc_high independent on the same row', () => {
      store.setHlcHigh(OFFICE, FEED, '0000000000010000')
      store.setTruncatedBefore(OFFICE, FEED, 9)
      const meta = store.getMeta(OFFICE, FEED)
      expect(meta?.hlcHigh).toBe('0000000000010000')
      expect(meta?.truncatedBeforeSeq).toBe(9)
    })
  })
})
