/**
 * SlashCommandMenu - Autocomplete popup for "/" quick-input in the chat input area.
 *
 * Behaviour:
 *  - Appears above the textarea when the user types "/" at the start of the input.
 *  - Receives a pre-filtered, pre-sorted list from InputArea — rendering only.
 *  - Groups items into two sections: Skills / Built-in.
 *  - The selected row is highlighted; selection is driven by the parent via `selectedIndex`.
 *  - Clicking a row calls `onSelect`; clicking outside calls `onClose`.
 *  - The menu scrolls the selected row into view automatically.
 *  - Never renders when items is empty — parent controls visibility.
 *
 * Keyboard navigation is intentionally delegated to InputArea so that the textarea
 * keeps focus throughout — this component is purely presentational.
 *
 * Design:
 *  - Same shell as the composer's "+" panel: spans the composer card's width,
 *    matches its corner radius, and rises from its top edge.
 *  - Selected row: subtle bg-primary/10 + left accent bar (border-l-2 border-primary).
 *  - Hover: hover:bg-muted/50 — matches InputArea's attachment menu items.
 *  - Category badge: neutral muted pill, no bright colours.
 */

import { useEffect, useRef } from 'react'
import type { SlashCommandItem } from '../../types/slash-command'
import { useTranslation } from '../../i18n'

// Maximum rows visible without scrolling
const MAX_VISIBLE_ROWS = 8

interface SlashCommandMenuProps {
  /** Pre-filtered, pre-sorted list of commands — computed by InputArea, not here */
  items: SlashCommandItem[]
  /** Index into `items` that is currently selected */
  selectedIndex: number
  /** Called when the user clicks or presses Enter/Tab on a row */
  onSelect: (item: SlashCommandItem) => void
  /** Called when the user clicks outside or presses Escape */
  onClose: () => void
  /** The composer card's corner radius, so the menu reads as part of it. */
  radiusClassName?: string
}

// Category label map — neutral labels only, no per-category colour
const CATEGORY_LABEL: Record<SlashCommandItem['category'], string> = {
  skill: 'Skill',
  builtin: 'Built-in',
}

/**
 * Filter and sort the command list by the current filter string.
 * Exported so InputArea can compute filtered length for keyboard-nav wrap-around.
 *
 * Matching logic:
 *  1. If filter is empty, show all items (skills first, then builtins).
 *  2. Otherwise, include items whose command or label contains the filter (case-insensitive).
 *     Items whose command *starts with* the filter rank above partial matches.
 */
export function filterSlashCommands(items: SlashCommandItem[], filter: string): SlashCommandItem[] {
  const q = filter.toLowerCase().trim()

  if (!q) {
    const order: SlashCommandItem['category'][] = ['skill', 'builtin']
    return [...items].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category))
  }

  const matched = items.filter(
    (item) => item.command.toLowerCase().includes(q) || item.label.toLowerCase().includes(q)
  )

  return matched.sort((a, b) => {
    const aStarts = a.command.toLowerCase().startsWith('/' + q) ? 0 : 1
    const bStarts = b.command.toLowerCase().startsWith('/' + q) ? 0 : 1
    if (aStarts !== bStarts) return aStarts - bStarts
    return a.command.localeCompare(b.command)
  })
}

export function SlashCommandMenu({
  items,
  selectedIndex,
  onSelect,
  onClose,
  radiusClassName = 'rounded-xl',
}: SlashCommandMenuProps) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const selectedRowRef = useRef<HTMLButtonElement>(null)

  // Scroll the selected row into view whenever selectedIndex changes
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Click-outside closes the menu
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Parent guarantees items.length > 0 before rendering this component.
  // Guard defensively to avoid an empty popup flash on edge cases.
  if (items.length === 0) return null

  // Build row list with section headers inserted before each category change
  const rows: Array<
    | { type: 'header'; category: SlashCommandItem['category'] }
    | { type: 'item'; item: SlashCommandItem; index: number }
  > = []
  let lastCategory: SlashCommandItem['category'] | null = null
  items.forEach((item, idx) => {
    if (item.category !== lastCategory) {
      rows.push({ type: 'header', category: item.category })
      lastCategory = item.category
    }
    rows.push({ type: 'item', item, index: idx })
  })

  return (
    <div
      ref={menuRef}
      className={`absolute bottom-full -inset-x-px mb-2
        bg-popover border border-border/70 ${radiusClassName} shadow-soft z-30
        overflow-hidden animate-composer-rise`}
      style={{ maxHeight: `${MAX_VISIBLE_ROWS * 42 + 36}px` }}
    >
      {/* Scrollable item list */}
      <div className="overflow-y-auto scrollbar-thin" style={{ maxHeight: `${MAX_VISIBLE_ROWS * 42}px` }}>
        <div className="py-1">
          {rows.map((row) => {
            if (row.type === 'header') {
              return (
                <div
                  key={`header-${row.category}`}
                  className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider
                    text-muted-foreground/50 select-none"
                >
                  {t(CATEGORY_LABEL[row.category])}
                </div>
              )
            }

            const { item, index } = row
            const isSelected = index === selectedIndex

            return (
              <button
                key={item.id}
                ref={isSelected ? selectedRowRef : null}
                onMouseDown={(e) => {
                  // mousedown keeps focus on the textarea
                  e.preventDefault()
                  onSelect(item)
                }}
                className={`
                  w-full flex items-center gap-2 text-left
                  transition-colors duration-75 min-h-[38px]
                  border-l-2
                  ${isSelected
                    ? 'bg-primary/10 border-primary pl-2.5 pr-3'
                    : 'border-transparent pl-2.5 pr-3 hover:bg-muted/50'
                  }
                `}
              >
                {/* Command — monospace, primary colour */}
                <span className={`font-mono text-sm shrink-0 truncate
                  ${isSelected ? 'text-primary' : 'text-primary/80'}`}>
                  {item.command}
                  {item.argumentHint && (
                    <span className="text-muted-foreground/50 ml-1 font-normal">{item.argumentHint}</span>
                  )}
                </span>

                {/* Description — secondary, truncated */}
                {item.description && (
                  <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                    {item.description}
                  </span>
                )}

                {/* Category pill — neutral, right-aligned */}
                <span className="ml-auto shrink-0 text-[10px] font-medium
                  text-muted-foreground/60 bg-muted/60 rounded px-1.5 py-0.5">
                  {t(CATEGORY_LABEL[item.category])}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Footer keyboard hint */}
      <div className="border-t border-border/40 px-3 py-1.5 flex items-center gap-3
        text-[10px] text-muted-foreground/40 select-none">
        <span>↑↓ {t('navigate')}</span>
        <span>↵ {t('select')}</span>
        <span>Esc {t('close')}</span>
      </div>
    </div>
  )
}
