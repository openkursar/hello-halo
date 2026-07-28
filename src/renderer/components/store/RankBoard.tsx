/**
 * A ranked install-count leaderboard: a titled card listing its entries with a
 * crown on the top three. The entries are supplied by the caller (a discover
 * section resolves them from its query), so the same board renders any ranking.
 */

import { Download, User } from 'lucide-react'
import { api } from '../../api'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { getEntryInstalls } from '../../../shared/store/store-meta'
import { resolveEntryI18n } from '../../utils/spec-i18n'
import { getCurrentLanguage } from '../../i18n'
import { AppTypeIcon } from './AppTypeIcon'
import type { RegistryEntry } from '../../../shared/store/store-types'

const RANK_COLORS = ['#f5b800', '#9aa6b8', '#c9803e'] // gold / silver / bronze for the top three

/** Minimum number of apps with real installs before a leaderboard is shown. */
export const MIN_RANK_ENTRIES = 3

/** The subset of entries eligible for the leaderboard: only those with installs.
 * A board is meaningful only when at least MIN_RANK_ENTRIES qualify. */
export function rankBoardEntries(entries: RegistryEntry[]): RegistryEntry[] {
  return entries.filter(entry => (getEntryInstalls(entry) ?? 0) > 0)
}

function formatInstalls(value: number): string {
  return new Intl.NumberFormat(getCurrentLanguage(), { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function RankBadge({ index }: { index: number }) {
  const topThree = index < 3
  return (
    <div
      className={`w-7 flex-shrink-0 text-center text-[15px] text-muted-foreground ${topThree ? 'font-bold italic' : ''}`}
      style={topThree ? { color: RANK_COLORS[index] } : undefined}
    >
      {index + 1}
    </div>
  )
}

function RankRow({ entry, index, onOpen }: { entry: RegistryEntry; index: number; onOpen: () => void }) {
  const name = resolveEntryI18n(entry, getCurrentLanguage()).name
  const installs = getEntryInstalls(entry)
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-lg px-1 py-2.5 text-left hover:bg-secondary/40 transition-colors"
    >
      <RankBadge index={index} />
      <AppTypeIcon type={entry.type} icon={entry.icon} name={name} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[13.5px] font-semibold text-foreground truncate">{name}</span>
        </div>
        {entry.category && <div className="text-[11.5px] text-muted-foreground truncate mt-0.5">{entry.category}</div>}
      </div>
      <div className="flex-shrink-0 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-0.5 max-w-[72px] min-w-0">
          <User className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{entry.author}</span>
        </span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-0.5">
          <Download className="w-3 h-3" />
          {installs !== null ? formatInstalls(installs) : 0}
        </span>
      </div>
    </button>
  )
}

export function RankBoard({ title, entries }: { title?: string; entries: RegistryEntry[] }) {
  const selectStoreApp = useAppsPageStore(state => state.selectStoreApp)

  const ranked = rankBoardEntries(entries)
  if (ranked.length < MIN_RANK_ENTRIES) return null

  const open = (entry: RegistryEntry) => {
    void api.trackEvent('mkt_card_click', { appId: entry.slug, appType: entry.type, source: 'rank' })
    selectStoreApp(entry.slug)
  }

  return (
    <div className="rounded-xl border border-border/60 bg-background px-4 pt-2.5 pb-2">
      {title && (
        <div className="px-1 pb-2.5 mb-1 border-b border-border/60 text-[13px] font-bold text-foreground">{title}</div>
      )}
      {ranked.map((entry, i) => (
        <RankRow key={entry.slug} entry={entry} index={i} onOpen={() => open(entry)} />
      ))}
    </div>
  )
}
