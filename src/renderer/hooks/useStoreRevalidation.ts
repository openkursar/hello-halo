/**
 * useStoreRevalidation — keeps an open store from going stale.
 *
 * Everything the store shows is cached for the session, so without this a
 * client left running all day never sees newly published apps or an operator's
 * layout change. Revalidating when the user arrives at the store, and when the
 * window regains focus, covers the moments they are about to look at it.
 *
 * The check itself is conditional requests end to end, so an unchanged store
 * costs a few 304s. The discover page is always re-read because ops config can
 * change without the index moving; the browse list is only dropped when the
 * index actually did.
 */

import { useEffect, useRef } from 'react'
import { api } from '../api'
import { discoverPageResource, categoryTaxonomyResource } from '../lib/store-resources'
import { useAppsPageStore } from '../stores/apps-page.store'

/** Floor between checks, so rapid focus changes do not each trigger a round trip. */
const MIN_INTERVAL_MS = 30_000

export function useStoreRevalidation(active: boolean): void {
  const clearListCache = useAppsPageStore(state => state.clearStoreListCache)
  const lastRunRef = useRef(0)
  const inFlightRef = useRef(false)

  useEffect(() => {
    if (!active) return

    const revalidate = async () => {
      const now = Date.now()
      if (inFlightRef.current || now - lastRunRef.current < MIN_INTERVAL_MS) return
      inFlightRef.current = true
      lastRunRef.current = now
      try {
        const res = await api.storeRevalidate()
        if (!res.success) return
        if (res.data?.changed) clearListCache()
        discoverPageResource.invalidate()
        categoryTaxonomyResource.invalidate()
      } catch (error) {
        console.warn('[useStoreRevalidation] check failed:', error)
      } finally {
        inFlightRef.current = false
      }
    }

    void revalidate()
    window.addEventListener('focus', revalidate)
    return () => window.removeEventListener('focus', revalidate)
  }, [active, clearListCache])
}
