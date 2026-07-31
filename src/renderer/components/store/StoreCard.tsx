/**
 * Store Card
 *
 * Compact card showing app summary in the store grid.
 * Clicking the card navigates to the detail view; the action button gives the
 * install/installed/update state and does not bubble to the card.
 */

import { memo } from 'react'
import { Star, Download, User, Check } from 'lucide-react'
import { api } from '../../api'
import type { RegistryEntry } from '../../../shared/store/store-types'
import { getEntryInstalls, isEntryFeatured } from '../../../shared/store/store-meta'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveEntryI18n } from '../../utils/spec-i18n'
import { useMarketplaceCapabilities } from '../../hooks/useMarketplaceCapabilities'
import { useCategoryLabel } from '../../hooks/useStoreCategories'
import { useStoreEntryInstallState } from '../../hooks/useStoreEntryInstallState'
import { AppTypeTag } from './AppTypeTag'
import { AppTypeIcon } from './AppTypeIcon'
import { installedVerb } from './install-verb'

interface StoreCardProps {
  entry: RegistryEntry
  onClick: () => void
  /** Which surface the card is rendered on, for funnel analytics. */
  source?: string
}

/** Max number of tags displayed on the card */
const MAX_VISIBLE_TAGS = 3


const compactFormatters = new Map<string, Intl.NumberFormat>()
function formatCompact(value: number, locale: string): string {
  let fmt = compactFormatters.get(locale)
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
    compactFormatters.set(locale, fmt)
  }
  return fmt.format(value)
}

function StoreCardBase({ entry, onClick, source }: StoreCardProps) {
  const { t } = useTranslation()
  const locale = getCurrentLanguage()
  const { name, description } = resolveEntryI18n(entry, locale)
  const visibleTags = entry.tags.slice(0, MAX_VISIBLE_TAGS)
  const featured = isEntryFeatured(entry)
  // The download stat only makes sense where the store tracks installs. When the
  // backend advertises that capability an app with none reads as 0; otherwise the
  // stat is hidden entirely rather than showing a misleading 0 on every card.
  const capabilities = useMarketplaceCapabilities()
  const showInstalls = capabilities?.installs === true
  const installsLabel = formatCompact(getEntryInstalls(entry) ?? 0, locale)
  const categoryLabel = useCategoryLabel(entry.type, entry.category)
  const { installedApp } = useStoreEntryInstallState(entry, entry.registryId ?? null)

  const openDetail = () => {
    void api.trackEvent('mkt_card_click', { appId: entry.slug, appType: entry.type, source })
    onClick()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openDetail()
    }
  }

  return (
    <>
    <div
      role="button"
      tabIndex={0}
      onClick={openDetail}
      onKeyDown={handleKeyDown}
      className="flex flex-col gap-2.5 w-full text-left p-4 rounded-[10px] border border-border/60 bg-background transition-all cursor-pointer hover:border-border hover:shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
    >
      {/* Top: shaped type icon + name / author */}
      <div className="flex items-start gap-3">
        <AppTypeIcon type={entry.type} icon={entry.icon} name={name} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm font-semibold text-foreground truncate min-w-0">
              {name}
            </span>
            <AppTypeTag type={entry.type} />
            {featured && source === 'grid' && (
              <span
                className="flex items-center gap-0.5 flex-shrink-0 px-1.5 py-px rounded bg-amber-500/10 text-amber-500 text-[10.5px]"
                title={t('Featured')}
              >
                <Star className="w-3 h-3 fill-current" />
                {t('Featured')}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-[3px] truncate">
            {entry.category && entry.category !== 'other' ? categoryLabel : t('Other')}
          </p>
        </div>
        <span className="flex-shrink-0 text-[11px] text-muted-foreground/70">v{entry.version}</span>
      </div>

      {/* Description (2 lines max) */}
      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2 min-h-[2.5rem]">
        {description}
      </p>

      {/* Tags — small squared bordered chips */}
      {visibleTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {visibleTags.map(tag => (
            <span
              key={tag}
              className="text-[10.5px] leading-4 px-1.5 py-px rounded bg-muted/40 text-muted-foreground/70 whitespace-nowrap"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Foot: author · install count · version. Cards are a browse surface —
          the action (hire/add/connect/update) lives on the detail page. */}
      <div className="flex items-center gap-1.5 mt-auto text-xs text-muted-foreground">
        <span className="flex items-center gap-0.5 min-w-0" title={entry.author}>
          <User className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{entry.author}</span>
        </span>
        {showInstalls && (
          <>
            <span aria-hidden="true">·</span>
            <span className="flex items-center gap-0.5 flex-shrink-0" title={t('Installs')}>
              <Download className="w-3 h-3" />
              {installsLabel}
            </span>
          </>
        )}
        {installedApp && (
          <span className="ml-auto flex items-center gap-0.5 flex-shrink-0 text-muted-foreground/60">
            <Check className="w-3 h-3" />
            {installedVerb(t, entry.type)}
          </span>
        )}
      </div>
    </div>
    </>
  )
}

// Memoized so a card does not re-render when its grid parent re-renders (scroll,
// sibling hover, list refresh) while its own data is unchanged — the main cost
// being the per-card AppTypeIcon/AutomationAvatar. `onClick` is a fresh closure
// each parent render but its behavior is fully derived from `entry` (it selects
// entry.slug), so the comparator intentionally ignores it and compares only the
// data that actually changes what's rendered. Install-state/caps updates still
// re-render via the internal hooks.
export const StoreCard = memo(StoreCardBase, (a, b) => a.entry === b.entry && a.source === b.source)
