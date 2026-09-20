/**
 * Store Page
 *
 * Independent top-level destination for browsing/installing from the
 * marketplace — separate from AppsPage (digital humans = what I already
 * own; store = getting something new). StoreView already owns its full
 * layout (search, category filter, grid/detail, publish dialog); this
 * page only supplies the shared Header chrome, matching AppsPage's own
 * Header usage.
 */

import { Header } from '../components/layout/Header'
import { SearchIcon } from '../components/search/SearchIcon'
import { StoreView } from '../components/store/StoreView'
import { useSearchStore } from '../stores/search.store'
import { useAppsPageStore } from '../stores/apps-page.store'
import { useTranslation } from '../i18n'

export function StorePage() {
  const { t } = useTranslation()
  const { openSearch } = useSearchStore()
  // Detail view and "My Publications" are their own self-contained screens
  // (own back button, own title) — the browse-page title/lead below them
  // would be a second, redundant "you're exploring the store" header on top
  // of a screen that isn't the browse list anymore.
  const isSubView = useAppsPageStore(state => !!state.storeSelectedSlug || state.storeMineOpen)

  return (
    <div className="h-full flex flex-col bg-background">
      {/* .header.plain: page title in the left slot, before
          search — matches prototype's `.page-title` + `.hsearch` order.
          Search replaces the settings button (settings is in NavRail).
          Prototype's `.hsearch` has no `chat-only` class, so it's the same
          position in both chat and plain header modes. */}
      <Header
        left={
          isSubView ? undefined : (
            <>
              <span className="text-sm font-semibold text-foreground whitespace-nowrap">{t('Explore · Store')}</span>
              <SearchIcon onClick={() => openSearch('global')} />
            </>
          )
        }
      />
      {/* Page title/lead — outer container only; StoreView keeps owning its
          own tab bar / grid / detail layout. No segmented "Store / Activity"
          switch here (prototype `.ex-switch`): that toggles to an H5
          points/check-in marketing page that doesn't exist in this app at
          all, so adding the switch alone would be a dead control with
          nothing to switch to — see the restoration report. */}
      {!isSubView && (
        <div className="px-6 sm:px-10 pt-5 sm:pt-7 flex-shrink-0">
          <h1 className="text-xl font-semibold mb-1">{t('Explore · Store')}</h1>
          <p className="text-[13px] text-muted-foreground mb-5">
            {t('Discover community-curated capabilities and participate in activities to earn free quota.')}
          </p>
        </div>
      )}
      <StoreView />
    </div>
  )
}
