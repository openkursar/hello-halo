/**
 * Store View
 *
 * Main container for the App Store tab. Handles layout coordination
 * between the header (search/filter), grid/detail views, and install dialog.
 */

import { useEffect, useRef } from 'react'
import { AlertCircle } from 'lucide-react'
import { api } from '../../api'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { StoreHeader } from './StoreHeader'
import { StoreCategoryBar } from './StoreCategoryBar'
import { StoreGrid } from './StoreGrid'
import { StoreDiscover } from './StoreDiscover'
import { StoreDetail } from './StoreDetail'
import { StoreMine } from './StoreMine'
import { StoreSkeletonGrid } from './StoreSkeletonGrid'
import { useTranslation } from '../../i18n'

export function StoreView() {
  const { t } = useTranslation()
  const storeLoading = useAppsPageStore(state => state.storeLoading)
  const storeError = useAppsPageStore(state => state.storeError)
  const storeSelectedSlug = useAppsPageStore(state => state.storeSelectedSlug)
  const storeMineOpen = useAppsPageStore(state => state.storeMineOpen)
  const storeApps = useAppsPageStore(state => state.storeApps)
  const storeTypeFilter = useAppsPageStore(state => state.storeTypeFilter)
  const storeSearchQuery = useAppsPageStore(state => state.storeSearchQuery)
  const loadStoreApps = useAppsPageStore(state => state.loadStoreApps)
  const checkUpdates = useAppsPageStore(state => state.checkUpdates)
  const didInitRef = useRef(false)

  // Store funnel: entering the store and every tab switch.
  useEffect(() => {
    void api.trackEvent('store.view', { tab: storeTypeFilter ?? 'discover' })
  }, [storeTypeFilter])

  // Load store apps and update badges on mount.
  // Skip the load if one is already in flight — this happens when an external
  // caller (e.g. openMarketplaceFilteredBy from Home or empty-state CTAs) has
  // already kicked off a fetch before StoreView mounted. The in-flight call
  // is the authoritative one; firing a second request here would double the
  // network traffic for no benefit.
  useEffect(() => {
    if (didInitRef.current) return
    didInitRef.current = true

    if (storeApps.length === 0 && !storeLoading) {
      void loadStoreApps()
    }
    void checkUpdates()
  }, [storeApps.length, storeLoading, loadStoreApps, checkUpdates])

  // Error state
  if (storeError && !storeLoading && storeApps.length === 0) {
    return (
      <div className="flex-1 flex flex-col">
        <StoreHeader />
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="w-12 h-12 rounded-xl bg-red-500/10 flex items-center justify-center">
            <AlertCircle className="w-6 h-6 text-red-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              {t('Failed to load store')}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {storeError}
            </p>
          </div>
          <button
            onClick={() => loadStoreApps()}
            className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            {t('Retry')}
          </button>
        </div>
      </div>
    )
  }

  // Loading state (initial load only) — skeleton grid over a bare spinner so
  // the first paint reads as content arriving.
  if (storeLoading && storeApps.length === 0) {
    return (
      <div className="flex-1 flex flex-col">
        <StoreHeader />
        <div className="flex-1 overflow-y-auto bg-muted/20">
          <StoreSkeletonGrid />
        </div>
      </div>
    )
  }

  // Detail view
  if (storeSelectedSlug) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <StoreDetail />
      </div>
    )
  }

  // My Publications second-level view
  if (storeMineOpen) {
    return <StoreMine />
  }

  const showDiscover = storeTypeFilter === null && !storeSearchQuery

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <StoreHeader />
      {showDiscover ? (
        <div className="flex-1 overflow-y-auto bg-muted/20">
          <StoreDiscover />
        </div>
      ) : (
        // Category bar stays fixed; only the grid scrolls beneath it.
        <div className="flex-1 flex flex-col overflow-hidden bg-muted/20">
          <StoreCategoryBar />
          <div className="flex-1 overflow-y-auto">
            <StoreGrid />
          </div>
        </div>
      )}
    </div>
  )
}
