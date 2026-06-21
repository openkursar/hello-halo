/**
 * Store Card
 *
 * Compact card showing app summary in the store grid.
 * Clicking navigates to the detail view.
 */

import { Star } from 'lucide-react'
import type { RegistryEntry } from '../../../shared/store/store-types'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveEntryI18n } from '../../utils/spec-i18n'
import { AppTypeBadge } from './AppTypeBadge'

interface StoreCardProps {
  entry: RegistryEntry
  onClick: () => void
}

/** Max number of tags displayed on the card */
const MAX_VISIBLE_TAGS = 3

export function StoreCard({ entry, onClick }: StoreCardProps) {
  const { t } = useTranslation()
  const { name, description } = resolveEntryI18n(entry, getCurrentLanguage())
  const visibleTags = entry.tags.slice(0, MAX_VISIBLE_TAGS)
  const featured = Boolean(entry.meta?.featured)

  return (
    <button
      onClick={onClick}
      className="w-full text-left p-4 rounded-xl border border-border hover:border-primary/40 hover:bg-secondary/50 transition-colors cursor-pointer"
    >
      {/* First line: icon + name + type badge + version */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {entry.icon && (
            <span className="text-base flex-shrink-0">{entry.icon}</span>
          )}
          <span className="text-sm font-medium text-foreground truncate min-w-0">
            {name}
          </span>
          <AppTypeBadge type={entry.type} />
          {featured && (
            <span
              className="flex items-center gap-0.5 flex-shrink-0 px-1.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-500 text-xs"
              title={t('Featured')}
            >
              <Star className="w-3 h-3 fill-current" />
              {t('Featured')}
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground flex-shrink-0">
          v{entry.version}
        </span>
      </div>

      {/* Author */}
      <p className="text-xs text-muted-foreground mt-1">
        {t('by')} {entry.author}
      </p>

      {/* Description (2 lines max) */}
      <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
        {description}
      </p>

      {/* Tags */}
      {visibleTags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-3">
          {visibleTags.map(tag => (
            <span
              key={tag}
              className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}
