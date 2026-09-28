/**
 * Bounds how much of a long transcript React has to build, without taking
 * scrolling away from the browser.
 *
 * Only the newest `initial` rows are mounted at first. When the reader scrolls
 * to within `preloadMargin` of the oldest mounted row, the next `page` older
 * rows are mounted above it. Rows are only ever added, never unmounted, so
 * there is nothing to measure or estimate for rows that are not in the DOM —
 * the failure mode of list virtualization. Rows that are mounted but off-screen
 * are left to `content-visibility` (see `row.ts`).
 *
 * Rows must carry `data-transcript-index={absoluteIndex}`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface HistoryWindowOptions {
  /** Rows mounted when the transcript first appears. */
  initial?: number
  /** Rows mounted per step when scrolling up. */
  page?: number
  /** Distance in px above the viewport at which the next page is mounted. */
  preloadMargin?: number
}

export interface HistoryWindow {
  /** Absolute index of the oldest mounted row. */
  start: number
  /** Attach to an empty element placed above the first mounted row. */
  sentinelRef: (el: HTMLElement | null) => void
  /**
   * Mount row `index` if needed, then hand its element over once it is in the
   * DOM. Used to jump to a message (search results).
   */
  reveal: (index: number, onMounted: (el: HTMLElement) => void) => void
}

/** Rows kept above a revealed row, so it does not land against the loading edge. */
const REVEAL_CONTEXT = 5

/**
 * Where the window starts once the row count changes. Appends keep the start,
 * so the window grows with the conversation; only a list that was empty (first
 * load) or shrank below the window (cleared) starts again from the tail.
 * Shrinking otherwise — a placeholder row filtered out mid-turn — must not
 * unmount rows the reader may be looking at.
 */
export function windowStartAfterCountChange(prev: { start: number; count: number }, count: number, initial: number): number {
  const fresh = prev.count === 0 || prev.start >= count
  return fresh ? Math.max(0, count - initial) : prev.start
}

function rowAt(scroller: HTMLElement, index: number): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`[data-transcript-index="${index}"]`)
}

export function useHistoryWindow(
  count: number,
  scroller: HTMLElement | null,
  { initial = 40, page = 30, preloadMargin = 1500 }: HistoryWindowOptions = {}
): HistoryWindow {
  const [windowState, setWindowState] = useState(() => ({ start: Math.max(0, count - initial), count }))

  let start = windowState.start
  if (windowState.count !== count) {
    start = windowStartAfterCountChange(windowState, count, initial)
    setWindowState({ start, count })
  }
  const startRef = useRef(start)
  startRef.current = start

  const [sentinel, setSentinel] = useState<HTMLElement | null>(null)
  const pendingAnchor = useRef<{ el: HTMLElement | null; top: number } | null>(null)
  const pendingReveal = useRef<{ index: number; onMounted: (el: HTMLElement) => void } | null>(null)
  const recheckFrame = useRef(0)

  const loadOlder = useCallback(() => {
    if (!scroller || startRef.current <= 0 || pendingAnchor.current) return
    const first = rowAt(scroller, startRef.current)
    pendingAnchor.current = { el: first, top: first?.getBoundingClientRect().top ?? 0 }
    setWindowState(s => ({ ...s, start: Math.max(0, s.start - page) }))
  }, [scroller, page])

  const sentinelInRange = useCallback(() => {
    if (!scroller || !sentinel) return false
    return sentinel.getBoundingClientRect().bottom >= scroller.getBoundingClientRect().top - preloadMargin
  }, [scroller, sentinel, preloadMargin])

  // Keep what the reader is looking at still while rows appear above it, by
  // measuring the same row before and after. Done here, synchronously with the
  // commit, so the insertion never paints at the wrong offset.
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current
    if (anchor && scroller) {
      pendingAnchor.current = null
      if (anchor.el?.isConnected) {
        const delta = anchor.el.getBoundingClientRect().top - anchor.top
        if (delta !== 0) scroller.scrollTop += delta
      }
      // The observer only fires on changes; if the new rows were too short to
      // push the sentinel out of range, keep going.
      cancelAnimationFrame(recheckFrame.current)
      recheckFrame.current = requestAnimationFrame(() => {
        if (sentinelInRange()) loadOlder()
      })
    }

    const reveal = pendingReveal.current
    if (reveal && scroller && reveal.index >= start) {
      const el = rowAt(scroller, reveal.index)
      if (el) {
        pendingReveal.current = null
        reveal.onMounted(el)
      }
    }
  }, [start, scroller, sentinelInRange, loadOlder])

  useEffect(() => () => cancelAnimationFrame(recheckFrame.current), [])

  useEffect(() => {
    if (!scroller || !sentinel) return
    const observer = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) loadOlder() },
      { root: scroller, rootMargin: `${preloadMargin}px 0px 0px 0px` }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [scroller, sentinel, preloadMargin, loadOlder])

  const reveal = useCallback((index: number, onMounted: (el: HTMLElement) => void) => {
    if (index < 0) return
    if (index >= startRef.current) {
      const el = scroller && rowAt(scroller, index)
      if (el) onMounted(el)
      return
    }
    pendingReveal.current = { index, onMounted }
    setWindowState(s => ({ ...s, start: Math.max(0, index - REVEAL_CONTEXT) }))
  }, [scroller])

  return { start, sentinelRef: setSentinel, reveal }
}
