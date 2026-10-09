/**
 * DetailSwitcher — the list beside one item's detail page (a digital human, a
 * skill, an MCP server), so moving to a sibling is one click instead of a
 * round trip through the card wall. Callers keep a stable order: rows must not
 * shift under the cursor while switching. Resizable by its right edge and
 * folds to an icon strip (by button, or by dragging it narrow); width and
 * fold state are one preference shared by every detail page.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'

/** Below this many rows the list is short enough to scan without search. */
const SEARCH_MIN_ITEMS = 8
const MIN_WIDTH = 180
const MAX_WIDTH = 320
/** Dragged narrower than this, the list folds to its icon strip. */
const DRAG_COLLAPSE_THRESHOLD = 100

export interface DetailSwitcherItem {
  id: string
  name: string
  /** 26px icon or avatar. */
  icon: React.ReactNode
  /** Right edge of the row: a status dot or count badge. */
  trailing?: React.ReactNode
  /**
   * Waiting on the user — marked on the folded strip, where trailing is hidden.
   * `alert` is the severe kind (stopped until the user acts), `attention` the rest.
   */
  flag?: 'attention' | 'alert'
  /** Turned off; rendered faded. */
  dimmed?: boolean
  /** Shown on the folded strip's hover card, under the name. */
  description?: string
  /** Shown on the hover card's last line, e.g. a status dot and label. */
  status?: React.ReactNode
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
  const storedWidth = useAppsPageStore(s => s.switcherWidth)
  const setCollapsed = (value: boolean) => useAppsPageStore.setState({ switcherCollapsed: value })
  const [query, setQuery] = useState('')

  // Live width while dragging; committed to the persisted store on release.
  const containerRef = useRef<HTMLDivElement>(null)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragWidthRef = useRef<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  useEffect(() => {
    if (!isDragging) return
    const handleMouseMove = (e: MouseEvent) => {
      const left = containerRef.current?.getBoundingClientRect().left ?? 0
      const next = e.clientX - left
      // The store persists on every set; only write when the fold flips.
      const shouldCollapse = next < DRAG_COLLAPSE_THRESHOLD
      if (useAppsPageStore.getState().switcherCollapsed !== shouldCollapse) {
        useAppsPageStore.setState({ switcherCollapsed: shouldCollapse })
      }
      if (shouldCollapse) return
      const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next))
      dragWidthRef.current = clamped
      setDragWidth(clamped)
    }
    const handleMouseUp = () => {
      setIsDragging(false)
      if (dragWidthRef.current !== null) useAppsPageStore.setState({ switcherWidth: dragWidthRef.current })
      dragWidthRef.current = null
      setDragWidth(null)
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])
  const width = dragWidth ?? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, storedWidth))
  const dragHandle = (
    <div
      className={cn(
        'absolute right-0 top-0 bottom-0 z-20 w-1.5 cursor-col-resize transition-colors hover:bg-primary/50',
        isDragging && 'bg-primary/50'
      )}
      onMouseDown={e => { e.preventDefault(); setIsDragging(true) }}
      title={t('Drag to resize width')}
    />
  )

  // Opening a detail from elsewhere (a card, a deep link) can land on a row
  // below the fold of a long list.
  const selectedRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, collapsed])

  // Hovering a row shows who it is (the folded strip has only faces; the list
  // truncates names). Fixed and portaled: the list scrolls and would clip it.
  // Keyed by id, not a copy of the row: the card follows live status, and
  // goes away if the row does (filtered out, removed) without a mouseleave.
  const [hovered, setHovered] = useState<{ id: string; top: number; left: number } | null>(null)
  const hoveredItem = hovered ? items.find(item => item.id === hovered.id) : undefined
  const cardRef = useRef<HTMLDivElement>(null)
  const cardId = useId()
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el || !hovered) return
    const margin = 8
    el.style.top = `${Math.min(Math.max(hovered.top - el.offsetHeight / 2, margin), window.innerHeight - el.offsetHeight - margin)}px`
  }, [hovered, hoveredItem])
  const hideCard = () => {
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = null
    setHovered(null)
  }
  useEffect(() => hideCard, [])
  // The hovered row went away without a mouseleave (filtered out, removed):
  // forget it, so it can't pop back up if the row returns.
  useEffect(() => { if (hovered && !hoveredItem) hideCard() }, [hovered, hoveredItem])
  useEffect(() => { hideCard() }, [collapsed])
  // A short delay keeps the card from flashing on every row the pointer
  // crosses; once one is up, moving to a neighbour switches at once.
  const showCard = (id: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const next = { id, top: r.top + r.height / 2, left: r.right + 8 }
    if (openTimer.current) clearTimeout(openTimer.current)
    if (hovered) {
      setHovered(next)
      return
    }
    openTimer.current = setTimeout(() => {
      openTimer.current = null
      setHovered(next)
    }, 300)
  }
  const cardHandlers = (id: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => showCard(id, e.currentTarget),
    onMouseLeave: hideCard,
    onFocus: (e: React.FocusEvent<HTMLElement>) => showCard(id, e.currentTarget),
    onBlur: hideCard,
    'aria-describedby': hovered?.id === id ? cardId : undefined,
  })

  const hoverCard = hovered && hoveredItem && createPortal(
    <div
      ref={cardRef}
      id={cardId}
      role="tooltip"
      style={{ top: hovered.top, left: hovered.left }}
      className="pointer-events-none fixed z-[60] w-[240px] rounded-lg border border-border-faint bg-popover px-3.5 py-3 shadow-lg"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex-shrink-0">{hoveredItem.icon}</span>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{hoveredItem.name}</span>
      </div>
      {hoveredItem.description && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground line-clamp-3">{hoveredItem.description}</p>
      )}
      {hoveredItem.status && <div className="mt-2 flex items-center gap-1.5 text-xs">{hoveredItem.status}</div>}
    </div>,
    document.body
  )

  const trimmed = query.trim().toLowerCase()
  const listed = trimmed ? items.filter(item => item.name.toLowerCase().includes(trimmed)) : items

  if (collapsed) {
    return (
      <div ref={containerRef} className="relative flex w-14 flex-shrink-0 flex-col items-center border-r border-border-faint">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title={t('Expand')}
          aria-label={t('Expand')}
          className="mt-2 mb-1 flex h-8 w-8 items-center justify-center rounded-sm text-faint-foreground hover:bg-secondary hover:text-foreground transition-colors ease-halo"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto py-1">
          {items.map(item => {
            const active = item.id === selectedId
            // The open item is the only one at full size and opacity; the rest
            // recede (further still when turned off). The flag stays outside
            // the fade so a waiting item is never muted.
            return (
              <button
                key={item.id}
                ref={active ? selectedRef : undefined}
                type="button"
                onClick={() => onSelect(item.id)}
                {...cardHandlers(item.id)}
                aria-label={item.name}
                aria-current={active}
                className="group relative flex h-9 w-9 flex-shrink-0 items-center justify-center"
              >
                <span className={cn(
                  'flex items-center justify-center transition-[opacity,transform] ease-halo',
                  active
                    ? item.dimmed ? 'opacity-60' : 'opacity-100'
                    : cn('scale-[0.8] group-hover:scale-90 group-hover:opacity-100', item.dimmed ? 'opacity-30 dark-ui:opacity-50' : 'opacity-50 dark-ui:opacity-70', 'dark-ui:group-hover:opacity-100')
                )}>
                  {item.icon}
                </span>
                {item.flag && (
                  <span className={cn(
                    'absolute rounded-full ring-2 ring-background transition-all ease-halo',
                    // Scaled with its face: the receded ones are drawn smaller.
                    active ? 'right-0.5 top-0.5 h-2 w-2' : 'right-1 top-1 h-1.5 w-1.5 group-hover:right-0.5 group-hover:top-0.5 group-hover:h-2 group-hover:w-2',
                    item.flag === 'alert' ? 'bg-halo-error' : 'bg-halo-warning'
                  )} />
                )}
              </button>
            )
          })}
        </div>
        {dragHandle}
        {hoverCard}
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative flex flex-shrink-0 flex-col border-r border-border-faint" style={{ width }}>
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="flex-1 text-xs font-medium text-subtle-foreground">
          {title} <span className="tabular-nums">{items.length}</span>
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title={t('Collapse')}
          aria-label={t('Collapse')}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-faint-foreground hover:bg-secondary hover:text-foreground transition-colors ease-halo"
        >
          <ChevronLeft className="h-4 w-4" />
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
              {...cardHandlers(item.id)}
              aria-current={active}
              className={cn(
                'relative flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] transition-colors ease-halo',
                active ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                item.dimmed && !active && 'opacity-60'
              )}
            >
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
      {dragHandle}
      {hoverCard}
    </div>
  )
}
