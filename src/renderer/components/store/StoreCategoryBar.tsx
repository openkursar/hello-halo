/**
 * Store Category Bar
 *
 * Category filter chips for a specific app-type tab. Rendered inside the gray
 * content area (not the header) so the white/card chips read as a distinct
 * toolbar band, matching the marketplace layout. Hidden on Discover, where no
 * single type scopes the catalog.
 */

import { useCallback, useEffect, useRef } from 'react'
import { api } from '../../api'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useStoreCategories, categoryDisplay } from '../../hooks/useStoreCategories'
import { useStoreCategoryCounts } from '../../hooks/useStoreCategoryCounts'
import { useTranslation } from '../../i18n'

function categoryChipClass(active: boolean): string {
  return `flex-shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 text-xs rounded-full border transition-colors ${
    active
      ? 'bg-primary text-primary-foreground border-primary font-medium'
      : 'bg-background text-muted-foreground border-border/60 hover:text-foreground hover:border-muted-foreground/40'
  }`
}

/** A filter chip with an optional trailing count, styled per the mockup
 * (muted number, lighter on the active/blue chip). */
function CategoryChip({ active, label, count, onClick }: {
  active: boolean
  label: string
  count?: number
  onClick: () => void
}) {
  return (
    <button onClick={onClick} className={categoryChipClass(active)}>
      {label}
      {count !== undefined && (
        <span className={`font-mono text-[11px] ${active ? 'text-primary-foreground/75' : 'text-muted-foreground/60'}`}>
          {count}
        </span>
      )}
    </button>
  )
}

export function StoreCategoryBar() {
  const { t } = useTranslation()
  const storeTypeFilter = useAppsPageStore(state => state.storeTypeFilter)
  const storeCategory = useAppsPageStore(state => state.storeCategory)
  const setStoreCategory = useAppsPageStore(state => state.setStoreCategory)
  const loadStoreApps = useAppsPageStore(state => state.loadStoreApps)
  const categories = useStoreCategories(storeTypeFilter)
  const counts = useStoreCategoryCounts(storeTypeFilter)

  const handleCategoryClick = useCallback((categoryId: string | null) => {
    setStoreCategory(categoryId)
    const state = useAppsPageStore.getState()
    void api.trackEvent('mkt_cat_filter', { cat: categoryId ?? 'all', appType: state.storeTypeFilter ?? 'discover' })
    loadStoreApps({
      search: state.storeSearchQuery || undefined,
      category: categoryId ?? undefined,
      type: state.storeTypeFilter ?? undefined,
    })
  }, [setStoreCategory, loadStoreApps])

  // Translate vertical wheel into horizontal scroll so a plain mouse can pan the
  // chips. Native non-passive listener is required to preventDefault.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || e.deltaY === 0) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  if (storeTypeFilter === null) return null

  return (
    <div ref={scrollRef} className="flex items-center gap-2 overflow-x-auto scrollbar-none px-4 pt-3 pb-3">
      <CategoryChip
        active={storeCategory === null}
        label={t('All')}
        count={counts.ready ? counts.total : undefined}
        onClick={() => handleCategoryClick(null)}
      />
      {categories.map(cat => (
        <CategoryChip
          key={cat.id}
          active={storeCategory === cat.id}
          label={categoryDisplay(cat, t)}
          count={counts.ready ? (counts.byCategory[cat.id] ?? 0) : undefined}
          onClick={() => handleCategoryClick(cat.id)}
        />
      ))}
    </div>
  )
}
