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
  side = 'top',
  className = '',
  children,
}: {
  label: string
  side?: 'top' | 'bottom'
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
        className={`pointer-events-none absolute left-1/2 z-[60] -translate-x-1/2 whitespace-nowrap
          rounded-[6px] border border-border bg-secondary px-2 py-1 text-xs text-foreground
          opacity-0 shadow-soft transition-opacity ease-halo group-hover/tooltip:opacity-100
          ${side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}
      >
        {label}
      </span>
    </span>
  )
}
