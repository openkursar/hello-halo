/**
 * The floating bar under a selection: "Comment" and "Add to chat".
 *
 * Pressing it must not clear the selection it acts on, so mousedown is
 * cancelled; the buttons still take keyboard focus.
 */

import { useLayoutEffect, useRef, useState } from 'react'
import { MessageSquarePlus, Plus } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { ADD_SHORTCUT_LABEL, type SelectionRect } from './selection'

const GAP = 8
const EDGE = 8

/** Below the selection, centered, kept inside the viewport; above it when there is no room below. */
export function placeUnder(rect: SelectionRect, width: number, height: number): { left: number; top: number } {
  const centerX = (rect.left + rect.right) / 2
  const left = Math.max(EDGE, Math.min(centerX - width / 2, window.innerWidth - width - EDGE))
  let top = rect.bottom + GAP
  if (top + height > window.innerHeight - EDGE) top = rect.top - GAP - height
  return { left, top: Math.max(EDGE, top) }
}

interface SelectionBarProps {
  rect: SelectionRect
  onComment: () => void
  onAdd: () => void
}

export function SelectionBar({ rect, onComment, onAdd }: SelectionBarProps) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPosition(placeUnder(rect, el.offsetWidth, el.offsetHeight))
  }, [rect])

  const button = `inline-flex h-9 sm:h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-foreground
    transition-colors ease-halo hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50`

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={t('Selection actions')}
      data-reference-layer=""
      onMouseDown={e => e.preventDefault()}
      className="fixed z-[60] flex items-center gap-0.5 rounded-[10px] border border-border bg-popover p-[3px] shadow-pop animate-pop-in"
      style={position ? { left: position.left, top: position.top } : { left: -9999, top: -9999 }}
    >
      <button type="button" className={button} onClick={onComment}>
        <MessageSquarePlus size={14} className="text-muted-foreground" aria-hidden />
        {t('Comment')}
      </button>
      <button type="button" className={button} onClick={onAdd}>
        <Plus size={14} className="text-muted-foreground" aria-hidden />
        {t('Add to chat')}
        <kbd className="hidden sm:inline rounded border border-border px-1 font-mono text-[10.5px] leading-4 text-subtle-foreground">
          {ADD_SHORTCUT_LABEL}
        </kbd>
      </button>
    </div>
  )
}
