/**
 * Whether the space's resource rail steps aside for the canvas right now
 * (rules in utils/rail-yield). Measures the width the canvas and the rail
 * share, and re-renders only when the answer changes, never per resize frame.
 */

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  canvasTooNarrow,
  choiceIn,
  railContext,
  railMayAutoOpen,
  railYields,
  userSetRail,
  type RailChoice,
} from '../utils/rail-yield'

interface RailYieldOptions {
  /** Desktop, with the canvas open beside the chat. */
  canvasOpen: boolean
  activeTabId: string | null
  /** The active tab's viewer shows a file list of its own. */
  bringsFileList: boolean
  /** The row that ends with the rail. */
  rowRef: RefObject<HTMLElement | null>
  /** The canvas's box in that row, just before the rail. */
  canvasRef: RefObject<HTMLElement | null>
}

export interface RailYield {
  /** The rail is held closed for the canvas; the user's own setting is unchanged. */
  yielded: boolean
  /** Files the AI touched may open the rail. */
  mayAutoOpen: boolean
  /** The user opened (or resized) the rail, or closed it. */
  userSet: (open: boolean) => void
  /** The width the rail takes when open, as the rail reports it. */
  setRailWidth: (width: number) => void
}

export function useRailYield({ canvasOpen, activeTabId, bringsFileList, rowRef, canvasRef }: RailYieldOptions): RailYield {
  const context = railContext(canvasOpen, activeTabId)
  const [stored, setStored] = useState<RailChoice>({ context, kept: false })
  const choice = choiceIn(stored, context)
  // Dropped as soon as the context changes, so going back to that tab does not bring it back.
  if (choice !== stored) setStored(choice)

  const [tooNarrow, setTooNarrow] = useState(false)
  const tooNarrowRef = useRef(false)
  const railWidth = useRef<number | null>(null)
  const openRef = useRef(canvasOpen)
  openRef.current = canvasOpen

  const measure = useCallback(() => {
    const row = rowRef.current
    const box = canvasRef.current
    if (!openRef.current || !row || !box || railWidth.current === null) return
    const shared = row.getBoundingClientRect().right - box.getBoundingClientRect().left
    const next = canvasTooNarrow(shared, railWidth.current)
    if (next === tooNarrowRef.current) return
    tooNarrowRef.current = next
    setTooNarrow(next)
  }, [rowRef, canvasRef])

  // Measured before paint when the canvas opens, so a rail that has to step aside never shows squeezing it.
  useLayoutEffect(() => {
    if (!canvasOpen) return
    measure()
    const row = rowRef.current
    const box = canvasRef.current
    if (!row || !box) return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    observer.observe(box)
    return () => observer.disconnect()
  }, [canvasOpen, measure, rowRef, canvasRef])

  const setRailWidth = useCallback((width: number) => {
    railWidth.current = width
    measure()
  }, [measure])

  const userSet = useCallback((open: boolean) => {
    setStored((current) => userSetRail(choiceIn(current, context), open))
  }, [context])

  const room = { canvasOpen, bringsFileList, tooNarrow }
  return {
    yielded: railYields(choice, room),
    mayAutoOpen: railMayAutoOpen(choice, room),
    userSet,
    setRailWidth,
  }
}
