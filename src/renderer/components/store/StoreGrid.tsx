/**
 * Store Grid
 *
 * Responsive grid layout of StoreCard components.
 * Handles empty/loading states for the grid area.
 * Supports paginated loading with "Load More" button.
 */

import { useEffect } from 'react'
import { api } from '../../api'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { StoreCard } from './StoreCard'
import { StoreNotice } from './StoreNotice'
import { useTranslation } from '../../i18n'
import { Package, Loader2 } from 'lucide-react'

/**
 * `embedded` drops the grid's own outer padding for use inside a discover
 * section that already provides `px-4 pt-4` + a section label, so the
 * title-to-cards spacing matches the other discover blocks.
 */
export function StoreGrid({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation()
  const storeApps = useAppsPageStore(state => state.storeApps)
  const storeHasMore = useAppsPageStore(state => state.storeHasMore)
  const storeLoading = useAppsPageStore(state => state.storeLoading)
  const storeSearchQuery = useAppsPageStore(state => state.storeSearchQuery)
  const selectStoreApp = useAppsPageStore(state => state.selectStoreApp)
  const loadMoreStoreApps = useAppsPageStore(state => state.loadMoreStoreApps)

  const isEmpty = storeApps.length === 0
  useEffect(() => {
    if (isEmpty) {
      void api.trackEvent('mkt_empty_state', { scene: storeSearchQuery ? 'search_no_result' : 'list_empty' })
    }
  }, [isEmpty, storeSearchQuery])

  if (isEmpty) {
    return (
      <StoreNotice
        icon={<Package className="w-6 h-6 text-muted-foreground" />}
        title={t('No apps found')}
        desc={t('Try adjusting your search or filters')}
      />
    )
  }

  return (
    <div className="flex flex-col">
      <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 ${embedded ? '' : 'p-4'}`}>
        {storeApps.map(entry => (
          <StoreCard
            key={entry.slug}
            entry={entry}
            source={embedded ? 'discover' : 'grid'}
            onClick={() => selectStoreApp(entry.slug)}
          />
        ))}
      </div>
      {storeHasMore && (
        <div className="flex justify-center pb-6">
          <button
            onClick={loadMoreStoreApps}
            disabled={storeLoading}
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {storeLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : null}
            {t('Load more')}
          </button>
        </div>
      )}
    </div>
  )
}
