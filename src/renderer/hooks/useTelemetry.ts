/**
 * useTelemetry Hook
 *
 * Renderer-side telemetry instrumentation. Mounted once in App.tsx.
 * Tracks:
 *   - session.start (on mount)
 *   - session.end (on beforeunload)
 *   - page.view (on view change)
 *
 * All calls are fire-and-forget via api.trackEvent(). No content or
 * identifying info is included — only structural identifiers (view name,
 * session duration).
 */

import { useEffect, useRef } from 'react'
import { api } from '../api'

/**
 * Track renderer session lifecycle and page navigation.
 *
 * @param view - Current top-level view name (e.g. 'space', 'settings')
 */
export function useTelemetry(view: string): void {
  const sessionStartRef = useRef<number>(Date.now())
  const prevViewRef = useRef<string | null>(null)

  // session.start on mount, session.end on unload
  useEffect(() => {
    const startTs = Date.now()
    sessionStartRef.current = startTs

    api.trackEvent('session.start', {
      startedAt: startTs,
    })

    const handleUnload = (): void => {
      const durationMs = Date.now() - sessionStartRef.current
      api.trackEvent('session.end', {
        durationMs,
      })
    }

    window.addEventListener('beforeunload', handleUnload)
    return () => {
      window.removeEventListener('beforeunload', handleUnload)
    }
  }, [])

  // page.view on view change
  useEffect(() => {
    // Skip the initial render — session.start already covers it
    if (prevViewRef.current === null) {
      prevViewRef.current = view
      return
    }

    if (view !== prevViewRef.current) {
      prevViewRef.current = view
      api.trackEvent('page.view', {
        view,
      })
    }
  }, [view])
}
