/**
 * useScrollableFade - Track whether a scrollable element has more content hidden below.
 *
 * Returns a ref to attach to the scroll container plus a boolean that is true
 * when the container overflows and the user has not scrolled to the bottom.
 * Useful for showing a bottom-edge fade hint when the scrollbar alone is too
 * subtle to signal cut-off content (see .scroll-fade-down in globals.css).
 *
 * Usage:
 *   const [scrollRef, canScrollDown] = useScrollableFade<HTMLDivElement>()
 *   <div ref={scrollRef} className={canScrollDown ? 'scroll-fade-down' : ''}>...
 */

import { useEffect, useRef, useState, type MutableRefObject } from 'react'

export function useScrollableFade<T extends HTMLElement>(): [MutableRefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const [canScrollDown, setCanScrollDown] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    let rafId = 0
    const update = () => {
      rafId = 0
      const hasOverflow = el.scrollHeight - el.clientHeight > 1
      const isAtBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 1
      setCanScrollDown(hasOverflow && !isAtBottom)
    }
    // Coalesce rapid DOM/layout changes (live task updates) into one check per frame
    const scheduleUpdate = () => {
      if (!rafId) rafId = requestAnimationFrame(update)
    }

    scheduleUpdate()
    el.addEventListener('scroll', scheduleUpdate, { passive: true })
    const resizeObserver = new ResizeObserver(scheduleUpdate)
    resizeObserver.observe(el)
    // Content can grow/shrink without resizing the container (e.g. task list changes)
    const mutationObserver = new MutationObserver(scheduleUpdate)
    mutationObserver.observe(el, { subtree: true, childList: true })

    return () => {
      el.removeEventListener('scroll', scheduleUpdate)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])

  return [ref, canScrollDown]
}
