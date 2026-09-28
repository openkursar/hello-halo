/**
 * ComposerMenu — the "+" panel of the chat composer.
 *
 * It spans the composer card's full width and rises from its edge, so it reads
 * as the composer opening up rather than a popup appearing. The width is what
 * lets every row explain itself in a line (name, then a quiet description),
 * which is why the panel needs no tooltips.
 *
 * Rows are actions (run, then close) or switches (flip, stay open). Hover and
 * keyboard share one highlight, as in a native menu. Rendered inside the
 * composer card (positioned relative), never portaled, so it moves with it.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'

export interface ComposerMenuItem {
  id: string
  icon: ReactNode
  label: string
  description: string
  /** Replaces the description and disables the row — why it cannot be used now. */
  disabledReason?: string | null
  /** Right-aligned status for action rows, e.g. an attachment count. */
  meta?: string
  /** Action row: runs and closes the panel. */
  onSelect?: () => void
  /** Switch row: flips and keeps the panel open. */
  toggle?: { checked: boolean; onChange: () => void }
  /** Draws the eye once, e.g. the switch the AI asked the user to turn on. */
  attention?: boolean
}

export interface ComposerMenuSection {
  id: string
  title: string
  items: ComposerMenuItem[]
}

interface ComposerMenuProps {
  sections: ComposerMenuSection[]
  /** The composer card: the panel matches its width and measures room from its edges. */
  anchorRef: RefObject<HTMLElement>
  /** Clicks on the trigger are its own toggle, not an outside click. */
  triggerRef: RefObject<HTMLElement>
  /** 'escape' hands focus back to the textarea; 'outside' leaves it where the user clicked. */
  onClose: (reason: 'select' | 'escape' | 'outside') => void
  /** Matches the card's corner radius. */
  radiusClassName: string
}

const EDGE_GAP = 8
/** Keeps the panel clear of the window's title strip when it opens upward. */
const TOP_RESERVE = 56
const PREFERRED_HEIGHT = 440
const MIN_COMFORTABLE_HEIGHT = 260

type Placement = { side: 'above' | 'below'; maxHeight: number }

function measure(anchor: HTMLElement): Placement {
  const rect = anchor.getBoundingClientRect()
  const above = rect.top - EDGE_GAP - TOP_RESERVE
  const below = window.innerHeight - rect.bottom - EDGE_GAP * 2
  const side = above >= Math.min(PREFERRED_HEIGHT, MIN_COMFORTABLE_HEIGHT) || above >= below ? 'above' : 'below'
  return { side, maxHeight: Math.max(160, Math.min(PREFERRED_HEIGHT, side === 'above' ? above : below)) }
}

export function ComposerMenu({ sections, anchorRef, triggerRef, onClose, radiusClassName }: ComposerMenuProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)

  const items = useMemo(() => sections.flatMap((s) => s.items), [sections])
  const enabledIndexes = useMemo(
    () => items.map((item, index) => (item.disabledReason ? -1 : index)).filter((index) => index >= 0),
    [items]
  )
  const [activeIndex, setActiveIndex] = useState(() => items.findIndex((item) => item.attention))

  // A parent's ref attaches after its children's layout effects on first
  // mount, so the panel's own parent (the card) stands in until then.
  useLayoutEffect(() => {
    const anchor = anchorRef.current ?? panelRef.current?.parentElement
    if (!anchor) return
    const update = () => setPlacement(measure(anchor))
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [anchorRef])

  // Focus moves in once visible (a hidden element cannot take focus) so the
  // arrow keys work straight away.
  const placed = placement !== null
  useEffect(() => {
    if (placed) panelRef.current?.focus({ preventScroll: true })
  }, [placed])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      onClose('outside')
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, triggerRef])

  useEffect(() => {
    if (activeIndex < 0) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-menu-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const activate = useCallback((item: ComposerMenuItem) => {
    if (item.disabledReason) return
    if (item.toggle) {
      item.toggle.onChange()
      return
    }
    item.onSelect?.()
    onClose('select')
  }, [onClose])

  const move = (step: 1 | -1) => {
    if (enabledIndexes.length === 0) return
    setActiveIndex((current) => {
      const position = enabledIndexes.indexOf(current)
      const next = position === -1
        ? (step === 1 ? 0 : enabledIndexes.length - 1)
        : (position + step + enabledIndexes.length) % enabledIndexes.length
      return enabledIndexes[next]
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        move(-1)
        break
      case 'Home':
        e.preventDefault()
        if (enabledIndexes.length) setActiveIndex(enabledIndexes[0])
        break
      case 'End':
        e.preventDefault()
        if (enabledIndexes.length) setActiveIndex(enabledIndexes[enabledIndexes.length - 1])
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (items[activeIndex]) activate(items[activeIndex])
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        onClose('escape')
        break
      case 'Tab':
        e.preventDefault()
        onClose('escape')
        break
    }
  }

  let runningIndex = 0
  const rises = placement?.side !== 'below'

  return (
    <div
      ref={panelRef}
      role="menu"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onMouseLeave={() => setActiveIndex(-1)}
      className={`absolute -inset-x-px z-30 flex flex-col overflow-hidden outline-none
        border border-border/70 bg-popover text-popover-foreground shadow-soft
        ${radiusClassName}
        ${rises ? 'bottom-full mb-2 animate-composer-rise' : 'top-full mt-2 animate-pop-in'}
        ${placement ? '' : 'invisible'}`}
      style={placement ? { maxHeight: placement.maxHeight } : undefined}
    >
      <div ref={listRef} className="overflow-y-auto overscroll-contain p-1.5 scrollbar-thin">
        {sections.map((section) => (
          <div key={section.id} role="group" aria-label={section.title} className="[&+&]:mt-1.5">
            <div className="px-2.5 pt-1.5 pb-0.5 text-xs leading-5 text-subtle-foreground select-none">
              {section.title}
            </div>
            {section.items.map((item) => {
              const index = runningIndex++
              return (
                <MenuRow
                  key={item.id}
                  item={item}
                  index={index}
                  active={index === activeIndex}
                  onHover={() => setActiveIndex(item.disabledReason ? -1 : index)}
                  onActivate={() => activate(item)}
                />
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

interface MenuRowProps {
  item: ComposerMenuItem
  index: number
  active: boolean
  onHover: () => void
  onActivate: () => void
}

function MenuRow({ item, index, active, onHover, onActivate }: MenuRowProps) {
  const disabled = !!item.disabledReason
  return (
    <button
      type="button"
      role={item.toggle ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={item.toggle ? item.toggle.checked : undefined}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      data-menu-index={index}
      onMouseMove={onHover}
      // mousedown keeps focus in the panel, so keyboard use can continue after a click
      onMouseDown={(e) => e.preventDefault()}
      onClick={onActivate}
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 sm:py-0 min-h-[44px] sm:min-h-8 rounded-[10px]
        text-left transition-colors duration-100
        ${disabled ? 'cursor-default' : 'cursor-pointer'}
        ${active ? 'bg-secondary' : ''}
        ${item.attention ? 'animate-composer-attention' : ''}`}
    >
      <span className={`w-5 shrink-0 flex items-center justify-center ${disabled ? 'text-muted-foreground/40' : 'text-muted-foreground'}`}>
        {item.icon}
      </span>
      <span className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-baseline sm:gap-2">
        <span className={`shrink-0 text-[13.5px] leading-5 ${disabled ? 'text-muted-foreground/60' : 'text-foreground/90'}`}>
          {item.label}
        </span>
        <span className="min-w-0 line-clamp-2 sm:line-clamp-none sm:truncate text-xs sm:text-[13px] leading-[18px] sm:leading-5 text-subtle-foreground">
          {item.disabledReason || item.description}
        </span>
      </span>
      {item.meta && !item.toggle && (
        <span className="shrink-0 text-xs tabular-nums text-subtle-foreground">{item.meta}</span>
      )}
      {item.toggle && <SwitchMark checked={item.toggle.checked} />}
    </button>
  )
}

/**
 * The row is the control; this only shows its state. Kept in the panel's own
 * gray scale, never the brand color or full contrast: switches that are on by
 * default would otherwise be the loudest thing every time the panel opens.
 */
function SwitchMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={`relative shrink-0 inline-flex h-4 w-[26px] rounded-full transition-colors duration-150
        ${checked
          ? 'bg-foreground/25 [.light_&]:bg-foreground/60'
          : 'bg-foreground/[0.08] [.light_&]:bg-foreground/[0.12]'}`}
    >
      <span
        className={`absolute top-[2px] h-3 w-3 rounded-full transition-[transform,background-color] duration-150 ease-halo
          [.light_&]:bg-background [.light_&]:shadow-sm
          ${checked ? 'translate-x-3 bg-foreground/85' : 'translate-x-[2px] bg-foreground/35'}`}
      />
    </span>
  )
}
