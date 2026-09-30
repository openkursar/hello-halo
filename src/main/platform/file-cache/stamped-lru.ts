/**
 * Bounded cache of values derived from files, valid while the file is
 * unchanged.
 *
 * A value is stored with the stamp (size + mtime + inode) of the file it was
 * derived from and served only while a fresh stat still matches. That makes the
 * cache correct for an append-only log that grows under a running turn without
 * anyone having to invalidate it: the first read after an append re-derives.
 * Eviction is least-recently-used, bounded by entry count and by total weight
 * (file bytes, a stand-in for the derived value's memory).
 */

import { statSync } from 'fs'

export interface StampedLruOptions {
  maxEntries: number
  maxWeight: number
}

interface Entry<T> {
  stamp: string
  weight: number
  value: T
}

export interface StampedLru<T> {
  /** Value derived by `derive`, reused while the file at `path` is unchanged; null when the file is unreadable. */
  get(path: string, derive: () => T | null): T | null
  delete(path: string): void
  clear(): void
  readonly size: number
}

/** Paths already reported unreadable: every read asks again, the log says it once. */
const reportedUnreadable = new Set<string>()

function stampOf(path: string): { stamp: string; weight: number } | null {
  try {
    const st = statSync(path)
    return { stamp: `${st.size}:${st.mtimeMs}:${st.ino}`, weight: st.size }
  } catch (error) {
    // A missing file is an ordinary answer ("nothing written yet"); anything
    // else would otherwise read as an empty file with no trace of why.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !reportedUnreadable.has(path)) {
      reportedUnreadable.add(path)
      console.warn(`[FileCache] Cannot stat ${path}; treating it as unreadable:`, error)
    }
    return null
  }
}

export function createStampedLru<T>({ maxEntries, maxWeight }: StampedLruOptions): StampedLru<T> {
  // Map iteration order is insertion order; re-inserting on hit keeps it LRU.
  const entries = new Map<string, Entry<T>>()
  let totalWeight = 0

  function drop(path: string): void {
    const existing = entries.get(path)
    if (!existing) return
    totalWeight -= existing.weight
    entries.delete(path)
  }

  function evict(): void {
    // The newest entry always stays, even alone over budget: dropping it would
    // make a single oversized file re-parse on every read for no memory gain.
    while (entries.size > 1 && (entries.size > maxEntries || totalWeight > maxWeight)) {
      const oldest = entries.keys().next().value as string
      drop(oldest)
    }
  }

  return {
    get(path, derive) {
      const current = stampOf(path)
      if (!current) {
        drop(path)
        return null
      }
      const hit = entries.get(path)
      if (hit && hit.stamp === current.stamp) {
        entries.delete(path)
        entries.set(path, hit)
        return hit.value
      }
      drop(path)
      const value = derive()
      if (value === null) return null
      entries.set(path, { stamp: current.stamp, weight: current.weight, value })
      totalWeight += current.weight
      evict()
      return value
    },
    delete: drop,
    clear() {
      entries.clear()
      totalWeight = 0
    },
    get size() {
      return entries.size
    },
  }
}
