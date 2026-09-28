/**
 * Keeps a native scroll container pinned to its end while the reader is
 * following, and lets go the moment they reach for older content.
 *
 * Following is driven by size, not by data: a ResizeObserver on the content and
 * the viewport re-pins whenever either changes size, so every source of growth
 * (streamed tokens, late markdown/highlight passes, images decoding, a panel
 * arriving at the tail, the composer shrinking the viewport) is covered without
 * enumerating it. The observer runs after layout and before paint, so a pin
 * never shows an intermediate frame.
 *
 * Growth the reader caused is the exception. Expanding a panel they clicked
 * must not slide it out from under the pointer, so for a moment after a click
 * or key inside the transcript, content growth is left in place — and if it
 * pushed the end out of reach, the reader is no longer following. While a turn
 * is live the stream wins: the reader is watching it arrive.
 *
 * When not following, this hook is also the transcript's scroll anchor: the
 * content under the top edge of the view stays put while anything above it
 * changes size (an off-screen row rendering at its real height instead of its
 * estimate). The browser's own anchoring is turned off because its choice of
 * anchor is not ours to make — contained rows are not always eligible, and it
 * can settle on the live area at the end and turn a detached reader into a
 * follower.
 *
 * Detaching is driven by intent. Chromium animates wheel scrolling over several
 * frames; if the next pin landed mid-animation it would cancel the reader's
 * scroll and the view would feel stuck. So an upward wheel, touch drag, key or a
 * grab of the scrollbar detaches immediately, before any scroll happens.
 * Reaching the very end again re-attaches.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Within this distance of the end, a scroll counts as "back at the end" and re-attaches. */
const REATTACH_PX = 2

/** How long after a click or key inside the transcript its growth is attributed to the reader. */
const INTERACTION_MS = 1000

/** Probe points below the viewport's top edge when looking for the anchor. */
const ANCHOR_PROBES = [1, 16, 48, 96, 160, 240, 360]

const UPWARD_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

export type ScrollMotion = 'auto' | 'smooth'

export interface StickToBottomOptions {
  /**
   * How far from the end still counts as "at the end" for `onAtBottomChange`
   * (the jump-to-latest affordance). Following itself only re-attaches at the
   * very end.
   */
  nearEndThreshold?: number
  onAtBottomChange?: (atBottom: boolean) => void
  /** A turn is streaming in; content growth always follows. */
  live?: boolean
}

export interface StickToBottom {
  /** Attach to the element with `overflow-y: auto`. */
  scrollerRef: (el: HTMLElement | null) => void
  /** Attach to the element wrapping everything that scrolls. */
  contentRef: (el: HTMLElement | null) => void
  scroller: HTMLElement | null
  scrollToBottom: (behavior?: ScrollMotion) => void
  /** Stop following, e.g. before jumping to an older message. */
  detach: () => void
  isFollowing: () => boolean
}

function distanceToEnd(el: HTMLElement): number {
  return el.scrollHeight - el.clientHeight - el.scrollTop
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

/**
 * Whether an upward gesture starting at `target` scrolls a nested container
 * (a capped thought panel, a code block) rather than the transcript. Those
 * gestures must not detach the transcript.
 */
function nestedScrollerTakesUpward(target: EventTarget | null, root: HTMLElement): boolean {
  let node = target instanceof Element ? target : null
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.scrollTop > 0 && node.scrollHeight > node.clientHeight) {
      const overflowY = getComputedStyle(node).overflowY
      if (overflowY === 'auto' || overflowY === 'scroll') return true
    }
    node = node.parentElement
  }
  return false
}

export function useStickToBottom({ nearEndThreshold = 100, onAtBottomChange, live = false }: StickToBottomOptions = {}): StickToBottom {
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const [content, setContent] = useState<HTMLElement | null>(null)
  const following = useRef(true)
  const lastTop = useRef(0)
  const reportedAtBottom = useRef<boolean | null>(null)
  const onAtBottomChangeRef = useRef(onAtBottomChange)
  onAtBottomChangeRef.current = onAtBottomChange
  const liveRef = useRef(live)
  liveRef.current = live
  const interactedUntil = useRef(0)
  const anchor = useRef<{ el: Element; top: number } | null>(null)

  const report = useCallback((el: HTMLElement) => {
    const atBottom = following.current || distanceToEnd(el) <= nearEndThreshold
    if (atBottom === reportedAtBottom.current) return
    reportedAtBottom.current = atBottom
    onAtBottomChangeRef.current?.(atBottom)
  }, [nearEndThreshold])

  const pin = useCallback((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
    anchor.current = null
  }, [])

  /**
   * Remember the first element that starts inside the view. An element that
   * straddles the top edge is a poor anchor: if it is a skipped row still at
   * its estimated height, holding its top in place lets the rows below it — the
   * ones actually being read — move when it renders.
   */
  const captureAnchor = useCallback((el: HTMLElement, root: HTMLElement | null) => {
    anchor.current = null
    if (following.current || !root) return
    const box = el.getBoundingClientRect()
    const x = box.left + box.width / 2
    let straddling: Element | null = null
    for (const dy of ANCHOR_PROBES) {
      if (dy >= box.height) break
      const hit = document.elementFromPoint(x, box.top + dy)
      if (!hit || hit === root || !root.contains(hit)) continue
      const top = hit.getBoundingClientRect().top
      if (top >= box.top - 0.5) {
        anchor.current = { el: hit, top }
        return
      }
      straddling ??= hit
    }
    if (straddling) anchor.current = { el: straddling, top: straddling.getBoundingClientRect().top }
  }, [])

  // Pin before the first paint so a transcript never flashes its top.
  useLayoutEffect(() => {
    if (!scroller) return
    lastTop.current = scroller.scrollTop
    if (following.current) pin(scroller)
    report(scroller)
  }, [scroller, content, pin, report])

  useEffect(() => {
    if (!scroller) return
    const previousAnchoring = scroller.style.overflowAnchor
    scroller.style.overflowAnchor = 'none'
    return () => { scroller.style.overflowAnchor = previousAnchoring }
  }, [scroller])

  useEffect(() => {
    if (!scroller) return
    const observer = new ResizeObserver((entries) => {
      if (following.current) {
        const viewportChanged = entries.some(e => e.target === scroller)
        const readerCaused = !liveRef.current && performance.now() < interactedUntil.current
        if (viewportChanged || !readerCaused) pin(scroller)
        else if (distanceToEnd(scroller) > nearEndThreshold) following.current = false
      } else if (anchor.current?.el.isConnected) {
        const delta = anchor.current.el.getBoundingClientRect().top - anchor.current.top
        if (Math.abs(delta) >= 0.5) {
          scroller.scrollTop += delta
          lastTop.current = scroller.scrollTop
        }
      }
      captureAnchor(scroller, content)
      report(scroller)
    })
    observer.observe(scroller)
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [scroller, content, pin, captureAnchor, report, nearEndThreshold])

  useEffect(() => {
    if (!scroller) return
    const canScroll = () => scroller.scrollHeight > scroller.clientHeight

    const onScroll = () => {
      const top = scroller.scrollTop
      if (distanceToEnd(scroller) <= REATTACH_PX) following.current = true
      else if (top < lastTop.current - 1) following.current = false
      lastTop.current = top
      captureAnchor(scroller, content)
      report(scroller)
    }

    const onWheel = (e: WheelEvent) => {
      if (!following.current || e.deltaY >= 0 || e.ctrlKey || !canScroll()) return
      if (nestedScrollerTakesUpward(e.target, scroller)) return
      following.current = false
    }

    let touchY: number | null = null
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? null }
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY
      if (!following.current || touchY === null || y === undefined || y <= touchY + 2 || !canScroll()) return
      if (nestedScrollerTakesUpward(e.target, scroller)) return
      following.current = false
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const upward = UPWARD_KEYS.has(e.key) || (e.key === ' ' && e.shiftKey)
      if (upward && !isEditable(e.target) && canScroll()) following.current = false
      else interactedUntil.current = performance.now() + INTERACTION_MS
    }

    // A press on the scroller itself (not a descendant) is a press on its
    // scrollbar. Hold still while it is grabbed; decide on release.
    const onPointerUp = () => {
      window.removeEventListener('pointerup', onPointerUp)
      if (distanceToEnd(scroller) <= REATTACH_PX) following.current = true
      report(scroller)
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.target !== scroller) {
        interactedUntil.current = performance.now() + INTERACTION_MS
        return
      }
      if (!canScroll()) return
      following.current = false
      window.addEventListener('pointerup', onPointerUp)
    }

    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: true })
    scroller.addEventListener('keydown', onKeyDown)
    scroller.addEventListener('pointerdown', onPointerDown)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('keydown', onKeyDown)
      scroller.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [scroller, content, captureAnchor, report])

  const scrollToBottom = useCallback((behavior: ScrollMotion = 'auto') => {
    following.current = true
    interactedUntil.current = 0
    if (!scroller) return
    if (behavior === 'auto') pin(scroller)
    else scroller.scrollTo({ top: scroller.scrollHeight, behavior })
    report(scroller)
  }, [scroller, pin, report])

  const detach = useCallback(() => {
    following.current = false
    if (scroller) captureAnchor(scroller, content)
  }, [scroller, content, captureAnchor])
  const isFollowing = useCallback(() => following.current, [])

  return { scrollerRef: setScroller, contentRef: setContent, scroller, scrollToBottom, detach, isFollowing }
}
