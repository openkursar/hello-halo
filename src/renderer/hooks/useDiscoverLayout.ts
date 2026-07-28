/**
 * useDiscoverLayout — resolves the config-driven discover-page layout.
 *
 * The layout is resolved in the main process (`server ?? built-in`) and fetched
 * once per session, cached in a shared module-level promise. Until it loads — or
 * if it fails — the built-in catalog-only layout is used, so the discover page
 * always renders. Refresh invalidates the cache and pushes the fresh layout to
 * mounted consumers.
 */

import { useEffect, useState } from 'react'
import { api } from '../api'
import { BUILTIN_DISCOVER_LAYOUT } from '../../shared/store/store-types'
import type { DiscoverLayout } from '../../shared/store/store-types'

let cached: Promise<DiscoverLayout> | null = null
const reloadListeners = new Set<() => void>()

/** Drop the session cache and re-fetch, pushing the fresh layout to consumers. */
export function invalidateDiscoverLayoutCache(): void {
  cached = null
  reloadListeners.forEach((reload) => reload())
}

export function useDiscoverLayout(): DiscoverLayout {
  const [layout, setLayout] = useState<DiscoverLayout>(BUILTIN_DISCOVER_LAYOUT)

  useEffect(() => {
    let cancelled = false
    const reload = () => {
      if (!cached) cached = fetchLayout()
      cached.then((value) => {
        if (!cancelled) setLayout(value)
      })
    }
    reload()
    reloadListeners.add(reload)
    return () => {
      cancelled = true
      reloadListeners.delete(reload)
    }
  }, [])

  return layout
}

async function fetchLayout(): Promise<DiscoverLayout> {
  try {
    const res = await api.storeGetDiscoverLayout()
    if (res.success && res.data && Array.isArray((res.data as DiscoverLayout).nodes)) {
      const layout = res.data as DiscoverLayout
      if (layout.nodes.length > 0) return layout
    }
    return BUILTIN_DISCOVER_LAYOUT
  } catch (error) {
    console.error('[useDiscoverLayout] Fetch failed, using built-in layout:', error)
    return BUILTIN_DISCOVER_LAYOUT
  }
}
