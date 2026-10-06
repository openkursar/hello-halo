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
 * re-render it on every frame. Between steps it keeps the latest measurement
 * for the next render; pixel-accurate consumers must measure their own bounds.
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

  return latest.current.width
}

/** Layout steps of the changes view by its own width. */
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

export const MIN_PANEL_WIDTH = 220
export const MAX_PANEL_WIDTH = 480
export const MIN_MAIN_WIDTH = 480

export function panelWidthBounds(containerWidth: number): { min: number; max: number } {
  return {
    min: MIN_PANEL_WIDTH,
    max: containerWidth > 0 ? Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, containerWidth - MIN_MAIN_WIDTH)) : MAX_PANEL_WIDTH,
  }
}

export function clampPanelWidth(containerWidth: number, preferredWidth?: number): number {
  const fallback = containerWidth >= 980 || containerWidth <= 0 ? 300 : 260
  const requested = preferredWidth !== undefined && Number.isFinite(preferredWidth) ? preferredWidth : fallback
  const { min, max } = panelWidthBounds(containerWidth)
  return Math.max(min, Math.min(max, requested))
}

export function changesLayout(width: number, preferredPanelWidth?: number): ChangesLayout {
  const known = width > 0
  return {
    width,
    hideMinorStats: known && width < 980,
    // A little under the 760px step, so a canvas of "about 760" still gets the docked list.
    dockedPanel: !known || width >= 740,
    panelWidth: clampPanelWidth(width, preferredPanelWidth),
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
export function mainWidth(width: number, panelOpen: boolean, preferredPanelWidth?: number): number {
  const layout = changesLayout(width, preferredPanelWidth)
  return width - (layout.dockedPanel && panelOpen ? layout.panelWidth : 0)
}

/** Every width step the changes view lays out by, as one comparable value. */
export function layoutStep(width: number, panelOpen: boolean, preferredPanelWidth?: number): string {
  const { hideMinorStats, dockedPanel, compactTools, stacked } = changesLayout(width, preferredPanelWidth)
  const main = mainWidth(width, panelOpen, preferredPanelWidth)
  return [
    width > 0, hideMinorStats, dockedPanel, compactTools, stacked,
    main >= MIN_SIDE_BY_SIDE_WIDTH, main >= OVERVIEW_KPI_ROW_WIDTH, main >= OVERVIEW_TWO_COLUMNS_WIDTH,
  ].join()
}
