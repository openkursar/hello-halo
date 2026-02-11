/**
 * useLazyVisible - IntersectionObserver-based lazy rendering hook
 *
 * Returns [ref, isVisible] — attach the ref to a placeholder div.
 * Once the element enters the viewport (with rootMargin buffer),
 * isVisible flips to true permanently (no unmount on scroll-away).
 *
 * This is cheaper than virtual scrolling:
 * - No scroll event handlers
 * - No height measurement or position calculation
 * - No mount/unmount cycles — elements stay in DOM once rendered
 * - Browser-native IntersectionObserver runs off main thread
 */

import { useRef, useState, useEffect, type RefObject } from 'react'

/**
 * @param rootMargin - Buffer around viewport to pre-load items (default '200px')
 * @param root - Scroll container ref (default: viewport). Pass the scrollable
 *               container's ref so observation works within overflow:auto divs.
 * @param initialVisible - If true, start visible immediately (skip IO). Once
 *                         visible, stays visible permanently via useState — so
 *                         even if the caller later passes false, no flicker.
 */
export function useLazyVisible(
  rootMargin = '200px',
  root?: RefObject<Element | null>,
  initialVisible = false,
): [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [isVisible, setIsVisible] = useState(initialVisible)

  useEffect(() => {
    if (isVisible) return // Already visible, no need to observe

    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      {
        root: root?.current ?? null,
        rootMargin,
      }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [isVisible, rootMargin, root])

  return [ref, isVisible]
}
