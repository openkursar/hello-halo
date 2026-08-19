/**
 * A module-level, session-shared async resource.
 *
 * One in-flight fetch is shared by every mounted consumer; the resolved value is
 * pushed to all subscribers, and `invalidate()` drops the cache and re-fetches
 * (used after a store refresh, or on reconnect). This is the single home for the
 * `let cached` + listener-set pattern the store hooks previously hand-rolled.
 *
 * `ttlMs`, when set, re-fetches on the next mount once the cached value is older
 * than the TTL — so a value resolved while degraded (e.g. offline) is not frozen
 * for the whole session.
 *
 * There is no error channel: a fetcher that rejects leaves consumers on their
 * `initial` value and the failure is not cached, so the next mount retries.
 * A fetcher that wants a degraded value rendered must resolve to it itself.
 */

import { useEffect, useState } from 'react'

export interface CachedResource<T> {
  /**
   * Subscribe to the resource, seeded with `initial` until the first load
   * resolves. `enabled: false` skips loading (for gated consumers).
   */
  useValue: (initial: T, enabled?: boolean) => T
  /** Drop the cache and re-fetch, pushing the fresh value to mounted consumers. */
  invalidate: () => void
}

export function createCachedResource<T>(
  fetcher: () => Promise<T>,
  options: { ttlMs?: number } = {},
): CachedResource<T> {
  const { ttlMs } = options
  let cache: { at: number; promise: Promise<T> } | null = null
  const listeners = new Set<(value: T) => void>()

  function load(force = false): Promise<T> {
    const now = Date.now()
    const fresh = cache && (ttlMs == null || now - cache.at < ttlMs)
    if (!force && fresh) return cache!.promise
    const promise = fetcher()
    cache = { at: now, promise }
    void promise.then(
      (value) => {
        // Ignore a resolution a newer load has already superseded.
        if (cache?.promise === promise) listeners.forEach((notify) => notify(value))
      },
      (error) => {
        // A rejected fetch must not become the cached answer: without a TTL it
        // would be re-served for the rest of the session, leaving every consumer
        // stuck on `initial` with no way back. Drop it so the next mount retries.
        if (cache?.promise === promise) cache = null
        console.error('[cached-resource] fetch failed, cache dropped:', error)
      },
    )
    return promise
  }

  function invalidate(): void {
    cache = null
    void load(true)
  }

  function useValue(initial: T, enabled = true): T {
    const [value, setValue] = useState<T>(initial)
    useEffect(() => {
      if (!enabled) return
      let cancelled = false
      const apply = (next: T) => { if (!cancelled) setValue(next) }
      listeners.add(apply)
      // Rejections are logged and dropped by `load`; the consumer holds `initial`.
      void load().then(apply, () => {})
      return () => {
        cancelled = true
        listeners.delete(apply)
      }
    }, [enabled])
    return value
  }

  return { useValue, invalidate }
}
