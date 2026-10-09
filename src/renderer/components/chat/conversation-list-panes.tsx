/**
 * The conversation list's height-resizable panes (pinned, digital humans):
 * a drag hook and its handle. The pane filling the rest of the column is
 * marked `data-fill-pane` and keeps its header plus one row under any resize.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'
import { useConversationListPrefs, type ResizablePane } from '../../stores/conversation-list-prefs.store'

export const ROW_HEIGHT = 32
/** Pane heights before the user drags them; past this the pane scrolls on its own. */
const PANE_DEFAULT_HEIGHT: Record<ResizablePane, number> = {
  pinned: 5 * ROW_HEIGHT,
  'digital-humans': 8 * ROW_HEIGHT,
}
/** Room the filling pane keeps under a drag: its header plus one row. */
const FILL_PANE_MIN_HEIGHT = 36 + ROW_HEIGHT

/**
 * Space a pane may grow into: the column's unused height, plus whatever the
 * filling pane holds beyond its minimum.
 */
function growRoom(column: HTMLElement): number {
  let used = 0
  let fillSpare = 0
  for (const child of Array.from(column.children) as HTMLElement[]) {
    used += child.offsetHeight
    if (child.hasAttribute('data-fill-pane')) fillSpare = Math.max(0, child.offsetHeight - FILL_PANE_MIN_HEIGHT)
  }
  return Math.max(0, column.clientHeight - used) + fillSpare
}

interface PaneDrag {
  pointerId: number
  startY: number
  startHeight: number
  limit: number
  latest: number | null
}

/**
 * Drag (pointer: mouse, pen or touch) or arrow-key a pane's bottom edge to set
 * its height. The pane is never made taller than its own content, nor into the
 * room the filling pane keeps. A click without movement saves nothing, so the
 * default height still follows the content.
 */
export function usePaneResize(
  pane: ResizablePane,
  paneRef: React.RefObject<HTMLElement | null>,
  columnRef: React.RefObject<HTMLElement | null>,
  contentHeight: () => number,
) {
  const savedHeight = useConversationListPrefs(s => s.paneHeights[pane])
  const setPaneHeight = useConversationListPrefs(s => s.setPaneHeight)
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const drag = useRef<PaneDrag | null>(null)
  const frame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const bounds = () => {
    const paneEl = paneRef.current
    const column = columnRef.current
    if (!paneEl || !column) return null
    const current = paneEl.clientHeight
    return { current, limit: Math.max(ROW_HEIGHT, Math.min(contentHeight(), current + growRoom(column))) }
  }
  const clamp = (height: number, limit: number) => Math.round(Math.min(limit, Math.max(ROW_HEIGHT, height)))

  const end = (save: boolean) => {
    const current = drag.current
    drag.current = null
    cancelAnimationFrame(frame.current)
    frame.current = 0
    if (save && current?.latest != null) setPaneHeight(pane, current.latest)
    setDragHeight(null)
  }

  const handleProps = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (!e.isPrimary || e.button !== 0) return
      const b = bounds()
      if (!b) return
      e.preventDefault()
      drag.current = { pointerId: e.pointerId, startY: e.clientY, startHeight: b.current, limit: b.limit, latest: null }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const current = drag.current
      if (!current || current.pointerId !== e.pointerId) return
      current.latest = clamp(current.startHeight + e.clientY - current.startY, current.limit)
      // One state update per frame: each re-renders the whole list.
      if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; setDragHeight(drag.current?.latest ?? null) })
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      if (drag.current?.pointerId === e.pointerId) end(true)
    },
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => {
      if (drag.current?.pointerId === e.pointerId) end(false)
    },
    onLostPointerCapture: (e: React.PointerEvent<HTMLElement>) => {
      if (drag.current?.pointerId === e.pointerId) end(false)
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return
      const b = bounds()
      if (!b) return
      e.preventDefault()
      const step = (e.shiftKey ? 3 : 1) * ROW_HEIGHT
      const next = e.key === 'Home' ? ROW_HEIGHT
        : e.key === 'End' ? b.limit
          : b.current + (e.key === 'ArrowDown' ? step : -step)
      setPaneHeight(pane, clamp(next, b.limit))
    },
    onDoubleClick: () => setPaneHeight(pane, undefined),
  }

  return {
    height: dragHeight ?? savedHeight ?? PANE_DEFAULT_HEIGHT[pane],
    dragging: dragHeight !== null,
    handleProps,
  }
}

/**
 * A pane's bottom edge, doubling as its resize handle: drag or arrow keys
 * resize, double-click restores the default height.
 */
export function PaneResizeHandle({ label, height, dragging, handleProps }: {
  /** What it resizes, already translated */
  label: string
  height: number
  dragging: boolean
  handleProps: ReturnType<typeof usePaneResize>['handleProps']
}) {
  const { t } = useTranslation()
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuemin={ROW_HEIGHT}
      aria-valuenow={Math.round(height)}
      tabIndex={0}
      title={t('Drag to resize. Double-click to reset.')}
      {...handleProps}
      className={cn(
        'absolute inset-x-0 -bottom-[3px] z-20 h-1.5 cursor-row-resize touch-none select-none transition-colors hover:bg-primary/50',
        'focus-visible:bg-primary/50 focus-visible:outline-none',
        dragging && 'bg-primary/50'
      )}
    />
  )
}
