/**
 * Popover — reusable floating content panel.
 *
 * Compound component API (Popover + PopoverTrigger + PopoverContent).
 * Supports controlled and uncontrolled open state.
 *
 * Features:
 *   - Portal rendering (escapes stacking context)
 *   - Viewport collision detection with auto-flip
 *   - Click-outside and Escape to dismiss
 *   - Keyboard accessible trigger (Enter / Space)
 *   - Scale-in entry animation
 *   - Configurable alignment and side offset
 */

import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'

// ============================================
// Context
// ============================================

interface PopoverContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  triggerRef: React.RefObject<HTMLDivElement>
}

const PopoverCtx = createContext<PopoverContextValue | null>(null)

function usePopoverCtx() {
  const ctx = useContext(PopoverCtx)
  if (!ctx) throw new Error('Popover compound components must be used within <Popover>')
  return ctx
}

// ============================================
// Popover (root)
// ============================================

interface PopoverProps {
  /** Controlled open state */
  open?: boolean
  /** Callback when open state changes */
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}

export function Popover({ open: controlled, onOpenChange, children }: PopoverProps) {
  const [internal, setInternal] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null!)

  const open = controlled ?? internal
  const setOpen = onOpenChange ?? setInternal

  return (
    <PopoverCtx.Provider value={{ open, setOpen, triggerRef }}>
      {children}
    </PopoverCtx.Provider>
  )
}

// ============================================
// PopoverTrigger
// ============================================

interface PopoverTriggerProps {
  children: ReactNode
  className?: string
  /** Tooltip text; also used as the accessible name for icon-only triggers */
  title?: string
}

export function PopoverTrigger({ children, className, title }: PopoverTriggerProps) {
  const { setOpen, open, triggerRef } = usePopoverCtx()

  return (
    <div
      ref={triggerRef}
      role="button"
      tabIndex={0}
      title={title}
      aria-label={title}
      onClick={() => setOpen(!open)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setOpen(!open)
        }
      }}
      className={cn('inline-flex', className)}
    >
      {children}
    </div>
  )
}

// ============================================
// PopoverContent
// ============================================

interface PopoverContentProps {
  children: ReactNode
  /** Horizontal alignment relative to trigger */
  align?: 'start' | 'center' | 'end'
  /** Which side of the trigger to appear on */
  side?: 'top' | 'bottom'
  /** Gap between trigger and content (px) */
  sideOffset?: number
  className?: string
}

export function PopoverContent({
  children,
  align = 'start',
  side = 'bottom',
  sideOffset = 4,
  className,
}: PopoverContentProps) {
  const { open, setOpen, triggerRef } = usePopoverCtx()
  const contentRef = useRef<HTMLDivElement>(null!)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const [ready, setReady] = useState(false)

  // Calculate position synchronously before paint
  useLayoutEffect(() => {
    if (!open) {
      setReady(false)
      return
    }
    const trigger = triggerRef.current
    const content = contentRef.current
    if (!trigger || !content) return

    const tr = trigger.getBoundingClientRect()
    const cr = content.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const margin = 8

    // Vertical: preferred side, flip if overflowing
    let top: number
    if (side === 'bottom') {
      top = tr.bottom + sideOffset
      if (top + cr.height > vh - margin) {
        top = tr.top - cr.height - sideOffset
      }
    } else {
      top = tr.top - cr.height - sideOffset
      if (top < margin) {
        top = tr.bottom + sideOffset
      }
    }

    // Horizontal: align relative to trigger
    let left: number
    if (align === 'start') {
      left = tr.left
    } else if (align === 'end') {
      left = tr.right - cr.width
    } else {
      left = tr.left + (tr.width - cr.width) / 2
    }

    // Clamp to viewport
    top = Math.max(margin, Math.min(top, vh - cr.height - margin))
    left = Math.max(margin, Math.min(left, vw - cr.width - margin))

    setPos({ top, left })
    setReady(true)
  }, [open, side, align, sideOffset])

  // Dismiss on click outside or Escape
  useEffect(() => {
    if (!open) return

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        contentRef.current && !contentRef.current.contains(target) &&
        triggerRef.current && !triggerRef.current.contains(target)
      ) {
        setOpen(false)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, setOpen])

  if (!open) return null

  return createPortal(
    <div
      ref={contentRef}
      role="dialog"
      className={cn(
        'fixed z-50 rounded-lg border border-border bg-popover text-popover-foreground shadow-lg outline-none',
        ready ? 'animate-scale-in' : 'opacity-0',
        className,
      )}
      style={{ top: pos.top, left: pos.left }}
    >
      {children}
    </div>,
    document.body,
  )
}
