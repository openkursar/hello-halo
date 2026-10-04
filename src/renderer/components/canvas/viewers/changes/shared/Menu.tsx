/**
 * Dropdown menu for the changes view's pickers (repository, compare scope,
 * commit options, review again). Opens below its trigger (above when there is
 * no room), takes focus, walks items with the arrow keys, and closes on Esc,
 * Tab, a pick or a click outside — Esc stays its own, so the canvas does not
 * collapse with it. Focus goes back to the trigger when the menu closes with
 * it inside, unless the pick moved it somewhere else.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'

interface MenuProps {
  open: boolean
  onClose: () => void
  anchorRef: RefObject<HTMLElement | null>
  label: string
  align?: 'start' | 'end'
  className?: string
  children: ReactNode
}

const ITEM_SELECTOR = '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"])'

export function Menu({ open, onClose, anchorRef, label, align = 'start', className = '', children }: MenuProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  // A focused element that is removed sends no blur, so whether focus was inside is tracked here.
  const focusInside = useRef(false)

  useEffect(() => {
    if (!open) return
    // Closed or unmounted (a picker that closes itself) while an item had focus: that item is gone.
    return () => {
      if (focusInside.current && (!document.activeElement || document.activeElement === document.body)) {
        anchorRef.current?.focus()
      }
      focusInside.current = false
    }
  }, [open, anchorRef])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return
    const a = anchor.getBoundingClientRect()
    const p = panel.getBoundingClientRect()
    const margin = 8
    let top = a.bottom + 4
    if (top + p.height > window.innerHeight - margin && a.top - p.height - 4 >= margin) top = a.top - p.height - 4
    let left = align === 'end' ? a.right - p.width : a.left
    left = Math.max(margin, Math.min(left, window.innerWidth - p.width - margin))
    top = Math.max(margin, Math.min(top, window.innerHeight - p.height - margin))
    setPosition({ top, left })
  }, [open, align, anchorRef])

  useEffect(() => {
    if (!open || !position) return
    const first = panelRef.current?.querySelector<HTMLElement>(`input, ${ITEM_SELECTOR}`)
    first?.focus()
  }, [open, position])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open, onClose, anchorRef])

  if (!open) return null

  const close = (refocus: boolean) => {
    onClose()
    if (refocus) anchorRef.current?.focus()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    }
    if (e.key === 'Tab') {
      // From the trigger, the browser then moves on to what comes after it.
      focusInside.current = false
      anchorRef.current?.focus()
      onClose()
      return
    }
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])]
    if (items.length === 0) return
    // In the search box only ↓ belongs to the menu; the other keys move the caret.
    if (e.target instanceof HTMLInputElement) {
      if (e.key !== 'ArrowDown') return
      e.preventDefault()
      items[0].focus()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? items.length - 1
        : e.key === 'ArrowDown' ? (index + 1) % items.length
          : (index <= 0 ? items.length - 1 : index - 1)
    items[next].focus()
  }

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      onKeyDown={handleKeyDown}
      onFocus={() => {
        focusInside.current = true
      }}
      className={`fixed z-50 max-h-[min(70vh,480px)] min-w-[220px] max-w-[min(92vw,380px)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-pop ${position ? 'animate-pop-in' : 'opacity-0'} ${className}`}
      style={position ?? { top: 0, left: 0 }}
    >
      {children}
    </div>,
    document.body
  )
}

interface MenuItemProps {
  onSelect: () => void
  disabled?: boolean
  /** Shown as a radio item with a check when set. */
  checked?: boolean
  description?: ReactNode
  icon?: ReactNode
  children: ReactNode
}

export function MenuItem({ onSelect, disabled = false, checked, description, icon, children }: MenuItemProps) {
  const radio = checked !== undefined
  return (
    <button
      type="button"
      role={radio ? 'menuitemradio' : 'menuitem'}
      aria-checked={radio ? checked : undefined}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      onClick={() => {
        if (!disabled) onSelect()
      }}
      className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-colors focus-visible:bg-secondary ${
        disabled ? 'cursor-default opacity-50' : 'hover:bg-secondary'
      }`}
    >
      {radio ? (
        <Check size={14} className={`mt-0.5 shrink-0 ${checked ? 'text-primary' : 'invisible'}`} aria-hidden />
      ) : icon ? (
        <span className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden>{icon}</span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-foreground">{children}</span>
        {description && <span className="block text-xs text-subtle-foreground">{description}</span>}
      </span>
    </button>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-subtle-foreground">{children}</div>
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />
}

export function MenuNote({ children }: { children: ReactNode }) {
  return <p className="px-2 pb-1.5 pt-1 text-[11.5px] leading-snug text-subtle-foreground">{children}</p>
}
