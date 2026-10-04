/**
 * Width of an element, kept current with a ResizeObserver owned by the
 * viewer's resource store. The canvas can be narrow on a wide window (beside
 * the chat), so layout follows the element, not the window breakpoints.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import { useViewerResources } from '../../../viewer-resources'

/**
 * The element's width, re-rendering only when `step(width)` changes: the view
 * lays out by a few width steps, and dragging the canvas edge would otherwise
 * re-render it on every frame. Between steps the returned width may lag; it is
 * always within the same step as the real one.
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>, step: (width: number) => string): number {
  const resources = useViewerResources()
  const [width, setWidth] = useState(0)
  const latest = useRef({ width: 0, step })
  latest.current.step = step

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const scope = resources.scope()
    const place = (next: number) => {
      const previous = latest.current.width
      latest.current.width = next
      if (previous === 0 || latest.current.step(next) !== latest.current.step(previous)) setWidth(next)
    }
    place(element.getBoundingClientRect().width)
    let frame = 0
    const observer = scope.add(new ResizeObserver(([entry]) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => place(entry.contentRect.width))
    }))
    scope.add(() => cancelAnimationFrame(frame))
    observer.observe(element)
    return () => scope.dispose()
  }, [ref, resources])

  // The steps themselves move (the file list docked or not): place the real width again.
  useEffect(() => {
    if (step(latest.current.width) !== step(width)) setWidth(latest.current.width)
  })

  return width
}

/** Layout steps of the changes view by its own width (see the design checklist §14). */
export interface ChangesLayout {
  width: number
  /** Hide the file count and the branch name in the top bar. */
  hideMinorStats: boolean
  /** File list docked beside the diffs rather than a drawer. */
  dockedPanel: boolean
  panelWidth: number
  /** Fold toggles go into the "More options" menu. */
  compactTools: boolean
  /** Two-row top bar; change navigation also in "More options". */
  stacked: boolean
}

export function changesLayout(width: number): ChangesLayout {
  const known = width > 0
  return {
    width,
    hideMinorStats: known && width < 980,
    // A little under the 760px step, so a canvas of "about 760" still gets the docked list.
    dockedPanel: !known || width >= 740,
    panelWidth: width >= 980 || !known ? 300 : 260,
    compactTools: known && width < 740,
    stacked: known && width < 560,
  }
}

/** Side by side needs this much room for the diff area itself. */
export const MIN_SIDE_BY_SIDE_WIDTH = 640
/** Overview page width from which the four key numbers share one row (two by two below). */
export const OVERVIEW_KPI_ROW_WIDTH = 640
/** Overview page width from which the folders and the review card sit side by side. */
export const OVERVIEW_TWO_COLUMNS_WIDTH = 860

/** The width the diffs (or the overview) get beside a docked file list. */
export function mainWidth(width: number, panelOpen: boolean): number {
  const layout = changesLayout(width)
  return width - (layout.dockedPanel && panelOpen ? layout.panelWidth : 0)
}

/** Every width step the changes view lays out by, as one comparable value. */
export function layoutStep(width: number, panelOpen: boolean): string {
  const { hideMinorStats, dockedPanel, panelWidth, compactTools, stacked } = changesLayout(width)
  const main = mainWidth(width, panelOpen)
  return [
    width > 0, hideMinorStats, dockedPanel, panelWidth, compactTools, stacked,
    main >= MIN_SIDE_BY_SIDE_WIDTH, main >= OVERVIEW_KPI_ROW_WIDTH, main >= OVERVIEW_TWO_COLUMNS_WIDTH,
  ].join()
}
