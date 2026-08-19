/**
 * Per-category app counts for the category filter chips.
 *
 * The registry list endpoint has no facet counts, so we fetch the current
 * type's entries once (category-unfiltered) and tally them client-side —
 * mirroring the mockup, whose chip counts are per-type and ignore the active
 * search/category. A module cache keeps the numbers stable while switching
 * back and forth; each type change still re-fetches to pick up new listings.
 */

import { useEffect, useState } from 'react'
import { api } from '../api'
import type { RegistryEntry } from '../../shared/store/store-types'
import type { AppType } from '../../shared/apps/spec-types'

export interface StoreCategoryCounts {
  /** Total entries of this type (the "All" chip count). */
  total: number
  /** categoryId → entry count. Missing keys mean zero. */
  byCategory: Record<string, number>
  /** False until the first fetch resolves, so chips can hold back "0" flicker. */
  ready: boolean
}

const EMPTY: StoreCategoryCounts = { total: 0, byCategory: {}, ready: false }
const cache = new Map<AppType, StoreCategoryCounts>()

export function useStoreCategoryCounts(type: AppType | null): StoreCategoryCounts {
  const [counts, setCounts] = useState<StoreCategoryCounts>(
    () => (type ? cache.get(type) : undefined) ?? EMPTY,
  )

  useEffect(() => {
    if (!type) {
      setCounts(EMPTY)
      return
    }
    setCounts(cache.get(type) ?? EMPTY)
    let cancelled = false
    // pageSize far above any realistic per-type catalog so one page holds the
    // whole type; total drives the "All" count even if that ever overflows.
    api
      .storeQuery({ type, page: 1, pageSize: 1000 })
      .then(res => {
        if (cancelled || !res.success) return
        const data = res.data as { items?: RegistryEntry[]; total?: number }
        const items = data.items ?? []
        const byCategory: Record<string, number> = {}
        for (const e of items) {
          const key = e.category || 'other'
          byCategory[key] = (byCategory[key] ?? 0) + 1
        }
        const result: StoreCategoryCounts = { total: data.total ?? items.length, byCategory, ready: true }
        cache.set(type, result)
        if (!cancelled) setCounts(result)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [type])

  return counts
}
