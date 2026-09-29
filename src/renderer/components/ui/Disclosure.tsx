/**
 * Disclosure — a foldable settings row: a full-width header that shows or
 * hides one block of content.
 *
 * The header looks the same everywhere — title, chevron, and an optional
 * one-line hint while collapsed — so a fold is recognizable across settings
 * pages and dialogs; the box around it and the content inside belong to the
 * page. Collapsed by default; `persistKey` opts into remembering it was opened.
 */

import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'

interface DisclosureProps {
  /** Header label. */
  title: string
  /** One short line beside the title, shown only while collapsed. */
  hint?: string
  /** Starts open. Ignored when `persistKey` is set. */
  defaultOpen?: boolean
  /**
   * localStorage key: once opened here, later mounts start open. A one-way
   * ratchet rather than a remembered open/closed state — closing the fold
   * while scanning the page must not hide it from the person who uses it.
   */
  persistKey?: string
  /** Fires after a toggle, e.g. to scroll the opened block into view. */
  onOpenChange?: (open: boolean) => void
  /** Internal rhythm of the content, where the page's spacing differs. */
  contentClassName?: string
  children: React.ReactNode
}

export function Disclosure({
  title,
  hint,
  defaultOpen = false,
  persistKey,
  onOpenChange,
  contentClassName,
  children,
}: DisclosureProps) {
  const [open, setOpen] = useState(() =>
    persistKey ? localStorage.getItem(persistKey) === 'true' : defaultOpen
  )
  const contentId = useId()

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && persistKey) localStorage.setItem(persistKey, 'true')
    onOpenChange?.(next)
  }

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={contentId}
        className="group flex w-full items-center gap-1.5 rounded text-left text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <span className="flex-shrink-0">{title}</span>
        {hint && !open && (
          <span className="min-w-0 truncate text-xs font-normal text-muted-foreground/70">{hint}</span>
        )}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'ml-auto h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground',
            open && 'rotate-90'
          )}
        />
      </button>
      {open && (
        <div id={contentId} className={cn('mt-4 space-y-5', contentClassName)}>
          {children}
        </div>
      )}
    </>
  )
}
