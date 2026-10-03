/**
 * Event dedup cache: TTL expiry, refresh on repeat, capacity eviction, and
 * pruning that touches only expired entries.
 */

import { describe, it, expect } from 'vitest'
import { createDedupCache } from '../../../../src/main/apps/runtime/event-dedup'

describe('createDedupCache', () => {
  it('flags repeats within the TTL and forgets them after', () => {
    const cache = createDedupCache({ ttlMs: 1000, maxSize: 100 })
    expect(cache.isDuplicate('a', 0)).toBe(false)
    expect(cache.isDuplicate('a', 500)).toBe(true)
    // The repeat refreshed the entry.
    expect(cache.isDuplicate('a', 1400)).toBe(true)
    expect(cache.isDuplicate('a', 2500)).toBe(false)
  })

  it('prunes expired entries on insert, keeping live ones', () => {
    const cache = createDedupCache({ ttlMs: 1000, maxSize: 100 })
    for (let i = 0; i < 50; i++) cache.isDuplicate(`old-${i}`, i)
    cache.isDuplicate('live', 900)
    cache.isDuplicate('refreshed', 10)
    cache.isDuplicate('refreshed', 950)
    cache.isDuplicate('new', 1100)
    expect(cache.size()).toBe(3)
    expect(cache.isDuplicate('live', 1200)).toBe(true)
    expect(cache.isDuplicate('refreshed', 1200)).toBe(true)
  })

  it('evicts the oldest entries beyond capacity', () => {
    const cache = createDedupCache({ ttlMs: 0, maxSize: 3 })
    for (const key of ['a', 'b', 'c', 'd']) cache.isDuplicate(key, 1)
    expect(cache.size()).toBe(3)
    expect(cache.isDuplicate('a', 2)).toBe(false)
    expect(cache.isDuplicate('d', 2)).toBe(true)
  })
})
