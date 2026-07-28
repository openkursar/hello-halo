/**
 * useStoreCollections — fetches curated scene collections (场景专题) once per
 * session, gated by the `enabled` flag (set when the discover layout includes a
 * collections section). Returns an empty list until loaded or when unavailable,
 * so the discover page simply omits the collections block with no server.
 */

import { useEffect, useState } from 'react'
import { api } from '../api'
import type { StoreCollection } from '../../shared/store/store-types'

let cached: Promise<StoreCollection[]> | null = null
const reloadListeners = new Set<() => void>()

/** Drop the session cache and re-fetch, pushing the fresh list to consumers —
 * so an operator's new/edited 场景专题 shows after a store refresh. */
export function invalidateStoreCollectionsCache(): void {
  cached = null
  reloadListeners.forEach(reload => reload())
}

async function fetchCollections(): Promise<StoreCollection[]> {
  try {
    const res = await api.storeGetCollections()
    return res.success ? ((res.data as StoreCollection[]) ?? []) : []
  } catch {
    return []
  }
}

export function useStoreCollections(enabled: boolean): StoreCollection[] {
  const [collections, setCollections] = useState<StoreCollection[]>([])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const reload = () => {
      if (!cached) cached = fetchCollections()
      cached.then(value => {
        if (!cancelled) setCollections(value)
      })
    }
    reload()
    reloadListeners.add(reload)
    return () => {
      cancelled = true
      reloadListeners.delete(reload)
    }
  }, [enabled])

  return collections
}
