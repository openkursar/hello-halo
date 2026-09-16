/**
 * Per-category app counts for the category filter chips.
 *
 * Each number is the `total` of that chip's own query, which the main process
 * resolves against the whole catalog — mirror sources by SQL COUNT, proxy
 * sources by the total their API reports. Tallying one fetched page instead
 * degrades to a sample of that page on any source bigger than it, which is
 * exactly the catalog where the number carries information: a 139k-skill
 * source rendered as "Content 7" next to an accurate "All 139697".
 *
 * A count is reported only when its query answered for the whole catalog, so a
 * missing key means unknown and renders no number. A partial answer must never
 * reach a chip: a store query succeeds with whatever sources replied, so one
 * timed-out registry silently subtracts its share from `total` and the chip
 * shows a smaller number just as confidently.
 *
 * Memoized per (type, taxonomy) for the session: switching tabs back and forth
 * costs nothing, and the probes carry `pageSize: 1` so a miss is cheap too.
 */

import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AppType } from '../../shared/apps/spec-types'
import type { CategoryDef, StoreQueryResponse } from '../../shared/store/store-types'

export interface StoreCategoryCounts {
  /** Entries of this type (the "All" chip). Undefined until resolved. */
  total?: number
  /** categoryId → entry count. A missing key means unknown, never zero. */
  byCategory: Record<string, number>
}

/**
 * Probes are federated queries that fan out to every registry serving the type,
 * so releasing a whole taxonomy at once bursts a dozen requests at one host.
 * The reply to a rate-limited probe is a source error, which is precisely the
 * answer this hook has to throw away — the burst buys nothing.
 */
const PROBE_CONCURRENCY = 3

const EMPTY: StoreCategoryCounts = { byCategory: {} }
const cache = new Map<string, StoreCategoryCounts>()

async function countOf(type: AppType, category?: string): Promise<number> {
  const res = await api.storeQuery({ type, category, page: 1, pageSize: 1 })
  if (!res.success) throw new Error(res.error ?? 'store query failed')

  const data = res.data as StoreQueryResponse
  const failed = data.sources?.find(s => s.status === 'error')
  if (failed) throw new Error(`registry ${failed.registryId}: ${failed.error ?? 'query failed'}`)
  if (data.total === undefined) throw new Error('response carried no total')

  return data.total
}

/** Resolved counts by task index; `undefined` where the probe did not answer. */
async function probeBounded(
  tasks: Array<() => Promise<number>>,
  isCancelled: () => boolean,
): Promise<Array<number | undefined>> {
  const results = new Array<number | undefined>(tasks.length)
  const failures: string[] = []
  let next = 0

  const worker = async (): Promise<void> => {
    while (next < tasks.length && !isCancelled()) {
      const index = next++
      try {
        results[index] = await tasks[index]()
      } catch (e) {
        failures.push((e as Error).message)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, tasks.length) }, worker),
  )

  if (failures.length > 0) {
    console.warn(`[StoreCategoryCounts] ${failures.length}/${tasks.length} probes unresolved:`, failures)
  }
  return results
}

export function useStoreCategoryCounts(type: AppType | null, categories: CategoryDef[]): StoreCategoryCounts {
  // `categories` is a fresh array each render; the joined ids are what actually
  // changes, so they carry both the effect dependency and the cache identity.
  const categoryIds = categories.map(c => c.id).join(',')
  const cacheKey = `${type}|${categoryIds}`

  const [counts, setCounts] = useState<StoreCategoryCounts>(() => cache.get(cacheKey) ?? EMPTY)

  useEffect(() => {
    if (!type) {
      setCounts(EMPTY)
      return
    }
    const cached = cache.get(cacheKey)
    if (cached) {
      setCounts(cached)
      return
    }
    setCounts(EMPTY)

    let cancelled = false
    const ids = categoryIds ? categoryIds.split(',') : []

    void probeBounded(
      [() => countOf(type), ...ids.map(id => () => countOf(type, id))],
      () => cancelled,
    ).then(([total, ...perCategory]) => {
      if (cancelled) return

      const byCategory: Record<string, number> = {}
      perCategory.forEach((count, i) => {
        if (count !== undefined) byCategory[ids[i]] = count
      })

      const resolved: StoreCategoryCounts = { total, byCategory }
      // Cached only when something was learned: a run where every probe failed
      // would otherwise pin a blank chip row for the rest of the session, since
      // a cache hit is what stops the next visit from retrying.
      if (total !== undefined || Object.keys(byCategory).length > 0) {
        cache.set(cacheKey, resolved)
      }
      setCounts(resolved)
    })

    return () => {
      cancelled = true
    }
  }, [type, cacheKey, categoryIds])

  return counts
}
