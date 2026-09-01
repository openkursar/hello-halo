/**
 * useIsMobile - Shared hook for detecting mobile viewport
 *
 * Uses Tailwind's sm breakpoint (640px) as the threshold.
 * Components using this hook will re-render when crossing the breakpoint.
 *
 * Usage:
 *   const isMobile = useIsMobile()
 *   // isMobile is true when viewport width < 640px
 */

import { useState, useEffect } from 'react'
import { isElectron, isCapacitor } from '../api/transport'

/** Mobile breakpoint matching Tailwind's sm: 640px */
export const MOBILE_BREAKPOINT = 640

/**
 * Hook to detect if viewport is mobile-sized
 * @returns true if viewport width is less than 640px
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.innerWidth < MOBILE_BREAKPOINT
  })

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return isMobile
}

/**
 * True only when the narrow layout is real, not a side effect of desktop
 * zoom. Electron enforces a `minWidth` on the BrowserWindow (900 DIP, see
 * `main/index.ts`), so the real window can never be narrower than that —
 * but `--display-scale` zoom (up to 1.5x) shrinks the *CSS* viewport
 * independently of real window size, so a zoomed-in desktop window can
 * report a CSS width under `MOBILE_BREAKPOINT` while the physical window
 * is nowhere near mobile-sized. `useIsMobile()` alone can't tell those
 * apart. Capacitor is unconditionally narrow (no window to measure);
 * remote web / a plain browser tab has no enforced minimum, so its
 * `useIsMobile()` reading is trustworthy as-is.
 */
export function useIsNarrowShell(): boolean {
  const isMobile = useIsMobile()
  if (isCapacitor()) return true
  if (isElectron()) return false
  return isMobile
}
