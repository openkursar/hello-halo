/**
 * Bounds how much of a long transcript React has to build, without taking
 * scrolling away from the browser.
 *
 * Only the newest `initial` rows are mounted at first. When the reader scrolls
 * to within `preloadMargin` of the oldest mounted row, the next `page` older
 * rows are mounted above it. There is nothing to measure or estimate for rows
 * that were never in the DOM — the failure mode of list virtualization. Rows
 * that are mounted but off-screen are left to `content-visibility` (see
 * `row.ts`).
 *
 * At most `maxLive` rows are live. Past that, rows farthest from the reader
 * are retired: measured, then rendered as empty placeholders of that height
 * (`placeholderHeight`), and mounted again as the reader nears them — from
 * above through the top sentinel, from below through the bottom one.
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
  /** Rows mounted per step when scrolling. */
  page?: number
  /** Most rows live at once; the rest of the mounted range are placeholders. */
  maxLive?: number
  /** Distance in px beyond the viewport at which the next page is mounted. */
  preloadMargin?: number
  /**
   * The reader reached the oldest mounted row and nothing older is left to
   * mount: ask the source for more. Pass only while more exists.
   */
  onReachStart?: () => void
}

export interface HistoryWindow {
  /** Absolute index of the oldest mounted row (live or placeholder). */
  start: number
  /** Live rows are `liveStart <= index < liveEnd`; the other mounted rows are placeholders. */
  liveStart: number
  liveEnd: number
  /** Measured height of a retired row, or undefined if it never rendered. */
  placeholderHeight: (key: string) => number | undefined
  /** Attach to an empty element placed right above the first live row. */
  sentinelRef: (el: HTMLElement | null) => void
  /** Attach to an empty element placed right after the last live row, while `liveEnd < count`. */
  endSentinelRef: (el: HTMLElement | null) => void
  /**
   * Mount row `index` if needed, then hand its element over once it is in the
   * DOM. Used to jump to a message (search results).
   */
  reveal: (index: number, onMounted: (el: HTMLElement) => void) => void
  /** Make the newest rows live (before scrolling to the end). */
  toEnd: () => void
}

/** Rows kept above a revealed row, so it does not land against the loading edge. */
const REVEAL_CONTEXT = 5

export const MAX_LIVE_ROWS = 300

/** Mounted range: `start` oldest mounted row; live rows `[liveStart, liveEnd)`, `liveEnd` null = through the end. */
export interface LiveRange {
  start: number
  liveStart: number
  liveEnd: number | null
}

const endOf = (range: LiveRange, count: number): number => range.liveEnd ?? count

function normalized(range: LiveRange, count: number): LiveRange {
  const start = Math.max(0, Math.min(range.start, count))
  const liveStart = Math.max(start, Math.min(range.liveStart, count))
  const liveEnd = range.liveEnd === null || range.liveEnd >= count ? null : Math.max(liveStart, range.liveEnd)
  return { start, liveStart, liveEnd }
}

/** Keep the rows near the top of the live range; retire from the bottom. */
function capFromTop(range: LiveRange, count: number, maxLive: number): LiveRange {
  if (endOf(range, count) - range.liveStart <= maxLive) return normalized(range, count)
  return normalized({ ...range, liveEnd: range.liveStart + maxLive }, count)
}

/** Keep the rows near the bottom of the live range; retire from the top. */
function capFromBottom(range: LiveRange, count: number, maxLive: number): LiveRange {
  const end = endOf(range, count)
  if (end - range.liveStart <= maxLive) return normalized(range, count)
  return normalized({ ...range, liveStart: end - maxLive }, count)
}

/** The reader nears the top of the live rows: bring back retired rows above, else mount older ones. */
export function pageUp(range: LiveRange, count: number, page: number, maxLive: number): LiveRange {
  const next = range.liveStart > range.start
    ? { ...range, liveStart: Math.max(range.start, range.liveStart - page) }
    : { ...range, start: Math.max(0, range.start - page), liveStart: Math.max(0, range.start - page) }
  return capFromTop(next, count, maxLive)
}

/** The reader nears the bottom of the live rows while newer rows are retired. */
export function pageDown(range: LiveRange, count: number, page: number, maxLive: number): LiveRange {
  if (range.liveEnd === null) return range
  return capFromBottom({ ...range, liveEnd: range.liveEnd + page }, count, maxLive)
}

/** Make row `index` live, with a little context above it. */
export function liveAround(range: LiveRange, count: number, index: number, maxLive: number): LiveRange {
  const from = Math.max(0, index - REVEAL_CONTEXT)
  return capFromTop({ start: Math.min(range.start, from), liveStart: from, liveEnd: from + maxLive }, count, maxLive)
}

/** Make the newest rows live. */
export function liveAtEnd(range: LiveRange, count: number, maxLive: number): LiveRange {
  return capFromBottom({ ...range, liveEnd: null }, count, maxLive)
}

/** What the reader's viewport shows, read from the DOM after a scroll or a list change. */
export interface ViewportProbe {
  /** Some live row intersects the viewport. */
  showsLive: boolean
  /** Index of the row (live or placeholder) at the viewport's top edge, if any. */
  rowAtTop: number | null
  /** The viewport is at the end of the transcript. */
  atEnd: boolean
}

/**
 * The live range that puts real rows under the viewport, or null when it
 * already does. A reader who reaches the end (scrollbar drag, End key) gets
 * the newest rows live, so appended rows render and following resumes; one
 * who lands in the middle of placeholders gets the rows there.
 */
export function recoverViewport(range: LiveRange, count: number, probe: ViewportProbe, maxLive: number): LiveRange | null {
  if (range.liveEnd !== null && probe.atEnd) return liveAtEnd(range, count, maxLive)
  if (probe.showsLive) return null
  if (probe.rowAtTop !== null) return liveAround(range, count, probe.rowAtTop, maxLive)
  return range.liveEnd !== null ? liveAtEnd(range, count, maxLive) : null
}

/**
 * The first row in `[first, last]` whose bottom edge is below `y`: the row at
 * that height. Geometry only (a binary search over measured row edges), so an
 * overlay above the transcript — a floating button, a sticky header — cannot
 * hide the row. Null when `y` is below every row or a row is missing.
 */
export function rowIndexAt(first: number, last: number, bottomOf: (index: number) => number | null, y: number): number | null {
  if (first > last) return null
  const lastBottom = bottomOf(last)
  if (lastBottom === null || lastBottom <= y) return null
  let lo = first
  let hi = last
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const bottom = bottomOf(mid)
    if (bottom === null) return null
    if (bottom > y) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * Whether rows retired from the top while following the end are on screen:
 * the top sentinel (right above the first live row) sits below the viewport's
 * top edge. A reader parked at the top then sees placeholders; a reader at the
 * end does not, and must not be moved.
 */
export function retiredRowsOnScreen(range: LiveRange, sentinelBottom: number | null, viewTop: number): boolean {
  return range.liveEnd === null && range.liveStart > range.start && sentinelBottom !== null && sentinelBottom > viewTop
}

/** Distance from the end that counts as "at the end" (the follower re-attaches at 2 px). */
const AT_END_PX = 24

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

interface WindowState extends LiveRange {
  count: number
  firstKey: string | null
}

/** The live range after the list changed, following `windowAfterKeysChange` for the mounted start. */
export function liveRangeAfterKeysChange(
  prev: WindowState,
  keys: readonly string[],
  initial: number,
  maxLive: number
): WindowState & { prepended: number } {
  const next = windowAfterKeysChange(prev, keys, initial)
  const count = keys.length
  let range: LiveRange
  if (next.prepended > 0) {
    range = {
      start: next.start,
      liveStart: prev.liveStart + next.prepended,
      liveEnd: prev.liveEnd === null ? null : prev.liveEnd + next.prepended,
    }
  } else if (next.start !== prev.start) {
    range = { start: next.start, liveStart: next.start, liveEnd: null }
  } else {
    range = { start: next.start, liveStart: prev.liveStart, liveEnd: prev.liveEnd }
  }
  // Following the end, new rows push the oldest live ones out.
  range = range.liveEnd === null ? capFromBottom(range, count, maxLive) : normalized(range, count)
  return { ...range, count, firstKey: next.firstKey, prepended: next.prepended }
}

function rowAt(scroller: HTMLElement, index: number): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`[data-transcript-index="${index}"]`)
}

export function useHistoryWindow(
  keys: readonly string[],
  scroller: HTMLElement | null,
  { initial = 40, page = 30, maxLive = MAX_LIVE_ROWS, preloadMargin = 1500, onReachStart }: HistoryWindowOptions = {}
): HistoryWindow {
  const count = keys.length
  const firstKey: string | null = keys.length > 0 ? keys[0] : null
  const [windowState, setWindowState] = useState<WindowState>(() => {
    const start = Math.max(0, count - initial)
    return { start, liveStart: start, liveEnd: null, count, firstKey }
  })
  const pendingAnchor = useRef<{ el: HTMLElement | null; top: number } | null>(null)
  const heights = useRef(new Map<string, number>())
  const keysRef = useRef(keys)
  keysRef.current = keys

  /**
   * Record the height of every row live in `prev` that `next` retires. `prev`
   * indices are what the DOM carries now; `shift` maps them to `next` indices.
   */
  const measureRetired = useCallback((prev: LiveRange, prevCount: number, next: LiveRange, nextCount: number, shift = 0) => {
    if (!scroller) return
    const prevEnd = endOf(prev, prevCount)
    const nextEnd = endOf(next, nextCount)
    for (let index = prev.liveStart; index < prevEnd; index++) {
      const moved = index + shift
      if (moved >= next.liveStart && moved < nextEnd) continue
      const key = keysRef.current[moved]
      const row = key !== undefined ? rowAt(scroller, index) : null
      if (row) heights.current.set(key, row.getBoundingClientRect().height)
    }
  }, [scroller])

  let current: WindowState = windowState
  if (windowState.count !== count || windowState.firstKey !== firstKey) {
    const next = liveRangeAfterKeysChange(windowState, keys, initial, maxLive)
    if (next.prepended > 0 && scroller && !pendingAnchor.current) {
      // Older rows are about to appear above the first live one: remember
      // where it is so the layout effect can put the view back on it.
      const first = rowAt(scroller, windowState.liveStart)
      pendingAnchor.current = { el: first, top: first?.getBoundingClientRect().top ?? 0 }
    }
    measureRetired(windowState, windowState.count, next, count, next.prepended)
    current = { start: next.start, liveStart: next.liveStart, liveEnd: next.liveEnd, count: next.count, firstKey: next.firstKey }
    setWindowState(current)
  }
  const currentRef = useRef(current)
  currentRef.current = current
  const onReachStartRef = useRef(onReachStart)
  onReachStartRef.current = onReachStart

  const [sentinel, setSentinel] = useState<HTMLElement | null>(null)
  const [endSentinel, setEndSentinel] = useState<HTMLElement | null>(null)
  const pendingReveal = useRef<{ index: number; onMounted: (el: HTMLElement) => void } | null>(null)
  const recheckFrame = useRef(0)

  const moveTo = useCallback((next: LiveRange) => {
    const prev = currentRef.current
    measureRetired(prev, prev.count, next, prev.count)
    setWindowState(s => ({ ...s, ...next }))
  }, [measureRetired])

  const loadOlder = useCallback(() => {
    if (!scroller || pendingAnchor.current) return
    const prev = currentRef.current
    if (prev.liveStart <= 0) {
      onReachStartRef.current?.()
      return
    }
    const first = rowAt(scroller, prev.liveStart)
    pendingAnchor.current = { el: first, top: first?.getBoundingClientRect().top ?? 0 }
    moveTo(pageUp(prev, prev.count, page, maxLive))
  }, [scroller, page, maxLive, moveTo])

  const loadNewer = useCallback(() => {
    const prev = currentRef.current
    if (!scroller || prev.liveEnd === null) return
    moveTo(pageDown(prev, prev.count, page, maxLive))
  }, [scroller, page, maxLive, moveTo])

  const inRange = useCallback((el: HTMLElement | null, edge: 'top' | 'bottom') => {
    if (!scroller || !el) return false
    const view = scroller.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    return edge === 'top' ? box.bottom >= view.top - preloadMargin : box.top <= view.bottom + preloadMargin
  }, [scroller, preloadMargin])

  // The sentinels only see a reader who scrolls gradually. Anyone who jumps
  // (scrollbar drag, End/Home, a click in the track) can land beyond them, on
  // placeholders only; bring the rows under the viewport back instead.
  const checkViewport = useCallback(() => {
    const prev = currentRef.current
    if (!scroller || pendingAnchor.current) return
    if (prev.liveStart === prev.start && prev.liveEnd === null) return
    const view = scroller.getBoundingClientRect()
    const first = rowAt(scroller, prev.liveStart)
    const last = rowAt(scroller, endOf(prev, prev.count) - 1)
    const showsLive = !!first && !!last
      && first.getBoundingClientRect().top < view.bottom && last.getBoundingClientRect().bottom > view.top
    const rowAtTop = rowIndexAt(prev.start, prev.count - 1, (index) => rowAt(scroller, index)?.getBoundingClientRect().bottom ?? null, view.top + 1)
    const hit = rowAtTop === null ? null : rowAt(scroller, rowAtTop)
    const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= AT_END_PX
    const next = recoverViewport(prev, prev.count, { showsLive, rowAtTop, atEnd }, maxLive)
    if (!next) return
    if (hit && rowAtTop !== null) pendingAnchor.current = { el: hit, top: hit.getBoundingClientRect().top }
    moveTo(next)
  }, [scroller, maxLive, moveTo])

  useEffect(() => {
    if (!scroller) return
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        checkViewport()
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [scroller, checkViewport])

  const { start, liveStart, liveEnd } = current

  // Rows appended while the reader sits at the end must not arrive retired.
  useEffect(() => {
    if (liveEnd === null) return
    const frame = requestAnimationFrame(checkViewport)
    return () => cancelAnimationFrame(frame)
  }, [count, liveEnd, checkViewport])

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
      // The observers only fire on changes; if the rows just mounted were too
      // short to push a sentinel out of range, keep going.
      cancelAnimationFrame(recheckFrame.current)
      recheckFrame.current = requestAnimationFrame(() => {
        if (inRange(sentinel, 'top')) loadOlder()
      })
    } else if (liveEnd !== null && scroller) {
      cancelAnimationFrame(recheckFrame.current)
      recheckFrame.current = requestAnimationFrame(() => {
        if (inRange(endSentinel, 'bottom')) loadNewer()
      })
    } else if (liveStart > start && scroller) {
      // Following the end retires the oldest live rows as new ones arrive; the
      // top sentinel stayed in range, so its observer does not fire again.
      cancelAnimationFrame(recheckFrame.current)
      recheckFrame.current = requestAnimationFrame(() => {
        const range = currentRef.current
        const sentinelBottom = sentinel?.getBoundingClientRect().bottom ?? null
        if (retiredRowsOnScreen(range, sentinelBottom, scroller.getBoundingClientRect().top)) loadOlder()
      })
    }

    const reveal = pendingReveal.current
    if (reveal && scroller && reveal.index >= liveStart && reveal.index < (liveEnd ?? count)) {
      const el = rowAt(scroller, reveal.index)
      if (el) {
        pendingReveal.current = null
        reveal.onMounted(el)
      }
    }
  }, [start, liveStart, liveEnd, count, scroller, sentinel, endSentinel, inRange, loadOlder, loadNewer])

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

  useEffect(() => {
    if (!scroller || !endSentinel) return
    const observer = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) loadNewer() },
      { root: scroller, rootMargin: `0px 0px ${preloadMargin}px 0px` }
    )
    observer.observe(endSentinel)
    return () => observer.disconnect()
  }, [scroller, endSentinel, preloadMargin, loadNewer])

  const reveal = useCallback((index: number, onMounted: (el: HTMLElement) => void) => {
    if (index < 0) return
    const prev = currentRef.current
    if (index >= prev.liveStart && index < endOf(prev, prev.count)) {
      const el = scroller && rowAt(scroller, index)
      if (el) onMounted(el)
      return
    }
    pendingReveal.current = { index, onMounted }
    moveTo(liveAround(prev, prev.count, index, maxLive))
  }, [scroller, maxLive, moveTo])

  const toEnd = useCallback(() => {
    const prev = currentRef.current
    if (prev.liveEnd !== null) moveTo(liveAtEnd(prev, prev.count, maxLive))
  }, [maxLive, moveTo])

  const placeholderHeight = useCallback((key: string) => heights.current.get(key), [])

  return {
    start,
    liveStart,
    liveEnd: liveEnd ?? count,
    placeholderHeight,
    sentinelRef: setSentinel,
    endSentinelRef: setEndSentinel,
    reveal,
    toEnd,
  }
}
