/**
 * DetailSwitcher — the list beside one item's detail page (a digital human, a
 * skill, an MCP server), so moving to a sibling is one click instead of a
 * round trip through the card wall. Callers keep a stable order: rows must not
 * shift under the cursor while switching. Folds to an icon strip; the folded
 * state is one preference shared by every detail page.
 */

import { useEffect, useRef, useState } from 'react'
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'

/** Below this many rows the list is short enough to scan without search. */
const SEARCH_MIN_ITEMS = 8

export interface DetailSwitcherItem {
  id: string
  name: string
  /** 26px icon or avatar. */
  icon: React.ReactNode
  /** Right edge of the row: a status dot or count badge. */
  trailing?: React.ReactNode
  /** Waiting on the user — marked on the folded strip, where trailing is hidden. */
  flagged?: boolean
  /** Turned off; rendered faded. */
  dimmed?: boolean
}

interface DetailSwitcherProps {
  title: string
  searchPlaceholder: string
  items: DetailSwitcherItem[]
  selectedId: string
  onSelect: (id: string) => void
}

export function DetailSwitcher({ title, searchPlaceholder, items, selectedId, onSelect }: DetailSwitcherProps) {
  const { t } = useTranslation()
  const collapsed = useAppsPageStore(s => s.switcherCollapsed)
  const setCollapsed = (value: boolean) => useAppsPageStore.setState({ switcherCollapsed: value })
  const [query, setQuery] = useState('')

  // Opening a detail from elsewhere (a card, a deep link) can land on a row
  // below the fold of a long list.
  const selectedRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, collapsed])

  const trimmed = query.trim().toLowerCase()
  const listed = trimmed ? items.filter(item => item.name.toLowerCase().includes(trimmed)) : items

  if (collapsed) {
    return (
      <div className="flex w-14 flex-shrink-0 flex-col items-center border-r border-border">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title={t('Expand')}
          aria-label={t('Expand')}
          className="mt-2 mb-1 flex h-8 w-8 items-center justify-center rounded-sm text-subtle-foreground hover:bg-secondary hover:text-foreground transition-colors ease-halo"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto py-1">
          {items.map(item => (
            <button
              key={item.id}
              ref={item.id === selectedId ? selectedRef : undefined}
              type="button"
              onClick={() => onSelect(item.id)}
              title={item.name}
              aria-label={item.name}
              aria-current={item.id === selectedId}
              className={cn(
                'relative flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md transition-colors ease-halo',
                item.id === selectedId ? 'bg-primary/[0.12] ring-1 ring-primary/40' : 'hover:bg-secondary',
                item.dimmed && 'opacity-60'
              )}
            >
              {item.icon}
              {item.flagged && (
                <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-halo-warning ring-2 ring-background" />
              )}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex w-[220px] flex-shrink-0 flex-col border-r border-border">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="flex-1 text-xs font-medium text-subtle-foreground">
          {title} <span className="tabular-nums">{items.length}</span>
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title={t('Collapse')}
          aria-label={t('Collapse')}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-subtle-foreground hover:bg-secondary hover:text-foreground transition-colors ease-halo"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>
      {items.length >= SEARCH_MIN_ITEMS && (
        <div className="px-2.5 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle-foreground" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="h-8 w-full rounded-sm border border-border bg-secondary pl-7 pr-2.5 text-xs outline-none focus:border-primary transition-colors ease-halo"
            />
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {listed.map(item => {
          const active = item.id === selectedId
          return (
            <button
              key={item.id}
              ref={active ? selectedRef : undefined}
              type="button"
              onClick={() => onSelect(item.id)}
              aria-current={active}
              className={cn(
                'relative flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] transition-colors ease-halo',
                active ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                item.dimmed && !active && 'opacity-60'
              )}
            >
              {active && <span className="absolute left-0 top-[7px] bottom-[7px] w-[2.5px] rounded-[2px] bg-primary" />}
              <span className="flex-shrink-0">{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.trailing}
            </button>
          )
        })}
        {trimmed && listed.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t('No matching results found')}</p>
        )}
      </div>
    </div>
  )
}
