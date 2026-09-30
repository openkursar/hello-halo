/**
 * Hover tooltip styled like the app's own popovers. Used instead of the native
 * `title` attribute, which takes about a second to appear and can't be themed.
 *
 * NavRail keeps its own inline copy: its bubble also reacts to `focus-visible`,
 * which requires the hover group to *be* the focusable element rather than a
 * wrapper around it.
 */

import { useId, type ReactNode } from 'react'

export function Tooltip({
  label,
  shortcut,
  side = 'top',
  align = 'center',
  className = '',
  children,
}: {
  label: string
  /** Keyboard hint rendered as a badge after the label, e.g. "⌘K". */
  shortcut?: string
  side?: 'top' | 'bottom'
  /** `end` pins the bubble's right edge to the trigger, for triggers at the window's right edge. */
  align?: 'center' | 'end'
  className?: string
  children: ReactNode
}) {
  const id = useId()

  return (
    <span className={`group/tooltip relative inline-flex min-w-0 ${className}`}>
      <span aria-describedby={id} className="inline-flex min-w-0">{children}</span>
      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none absolute z-[60] flex items-center gap-1.5 whitespace-nowrap
          rounded-[6px] border border-border bg-secondary px-2 py-1 text-xs text-foreground
          opacity-0 shadow-soft transition-opacity ease-halo group-hover/tooltip:opacity-100
          ${align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2'}
          ${side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}
      >
        {label}
        {shortcut && (
          <kbd className="font-sans text-[10px] leading-[15px] text-muted-foreground border border-border rounded px-1">
            {shortcut}
          </kbd>
        )}
      </span>
    </span>
  )
}
