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
 * When the list itself grows at the front (older history read in from the
 * source), the window follows the rows it was showing and the view stays on the
 * same row, exactly as when it mounts older rows it already has.
 *
 * Rows must carry `data-transcript-index={absoluteIndex}` and be keyed by a
 * stable row key, so an older page does not rebuild the rows below it.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface HistoryWindowOptions {
  /** Rows mounted when the transcript first appears. */
  initial?: number
  /** Rows mounted per step when scrolling up. */
  page?: number
  /** Distance in px above the viewport at which the next page is mounted. */
  preloadMargin?: number
  /**
   * The reader reached the oldest mounted row and nothing older is left to
   * mount: ask the source for more. Pass only while more exists.
   */
  onReachStart?: () => void
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

/**
 * The window after the list changed. A list that grew at the front keeps the
 * window on the rows it showed (`prepended` is how many rows arrived in front);
 * anything else follows `windowStartAfterCountChange`.
 */
export function windowAfterKeysChange(
  prev: { start: number; count: number; firstKey: string | null },
  keys: readonly string[],
  initial: number
): { start: number; count: number; firstKey: string | null; prepended: number } {
  const firstKey: string | null = keys.length > 0 ? keys[0] : null
  const prependedAt = prev.count > 0 && prev.firstKey !== null && firstKey !== prev.firstKey
    ? keys.indexOf(prev.firstKey)
    : -1
  if (prependedAt > 0 && prev.start < prev.count) {
    return { start: prev.start + prependedAt, count: keys.length, firstKey, prepended: prependedAt }
  }
  return { start: windowStartAfterCountChange(prev, keys.length, initial), count: keys.length, firstKey, prepended: 0 }
}

function rowAt(scroller: HTMLElement, index: number): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`[data-transcript-index="${index}"]`)
}

export function useHistoryWindow(
  keys: readonly string[],
  scroller: HTMLElement | null,
  { initial = 40, page = 30, preloadMargin = 1500, onReachStart }: HistoryWindowOptions = {}
): HistoryWindow {
  const count = keys.length
  const firstKey: string | null = keys.length > 0 ? keys[0] : null
  const [windowState, setWindowState] = useState(() => ({ start: Math.max(0, count - initial), count, firstKey }))
  const pendingAnchor = useRef<{ el: HTMLElement | null; top: number } | null>(null)

  let start = windowState.start
  if (windowState.count !== count || windowState.firstKey !== firstKey) {
    const next = windowAfterKeysChange(windowState, keys, initial)
    if (next.prepended > 0 && scroller && !pendingAnchor.current) {
      // Older rows are about to appear above the first mounted one: remember
      // where it is so the layout effect can put the view back on it.
      const first = rowAt(scroller, windowState.start)
      pendingAnchor.current = { el: first, top: first?.getBoundingClientRect().top ?? 0 }
    }
    start = next.start
    setWindowState({ start: next.start, count: next.count, firstKey: next.firstKey })
  }
  const startRef = useRef(start)
  startRef.current = start
  const onReachStartRef = useRef(onReachStart)
  onReachStartRef.current = onReachStart

  const [sentinel, setSentinel] = useState<HTMLElement | null>(null)
  const pendingReveal = useRef<{ index: number; onMounted: (el: HTMLElement) => void } | null>(null)
  const recheckFrame = useRef(0)

  const loadOlder = useCallback(() => {
    if (!scroller || pendingAnchor.current) return
    if (startRef.current <= 0) {
      onReachStartRef.current?.()
      return
    }
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
