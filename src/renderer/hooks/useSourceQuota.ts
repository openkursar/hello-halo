/**
 * useSourceQuota — sole owner of metered-quota fetching + refresh policy.
 *
 * Probes `auth:get-quota` for the given source and exposes a display-ready
 * snapshot. Refresh triggers:
 *
 *   1. Source switch      — re-probe when `sourceId` changes.
 *   2. Generation finish  — refresh on the current session's isGenerating
 *                           true→false edge (the main cause of quota change).
 *   3. Popover open        — the consumer calls refresh() on mount.
 *   4. Window refocus      — DOM `visibilitychange` → visible.
 *   5. Safety-net poll     — every 5 minutes, only while supported & visible
 *                           (catches out-of-band changes like invite rewards).
 *
 * A provider with no quota concept returns `data: null` on first probe → the
 * hook latches `supported = false` and never requests again. A failed refresh
 * keeps the previous snapshot and sets `stale`.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '../api'
import { useIsGenerating } from '../stores/chat.store'
import type { AuthQuotaSnapshot } from '../../shared/types'

export interface SourceQuotaState {
  snapshot: AuthQuotaSnapshot | null
  /** Probe result; once false, no further requests are made. */
  supported: boolean
  /** Last refresh failed — UI keeps the old value and shows a warning. */
  stale: boolean
  /** Only true during the first probe of a source. */
  loading: boolean
  /** The single public entry point for an on-demand refresh. */
  refresh: () => void
}

/** Safety-net poll interval; fixed by design (not configurable). */
const FALLBACK_POLL_MS = 5 * 60 * 1000

function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

export function useSourceQuota(sourceId: string | undefined): SourceQuotaState {
  const [snapshot, setSnapshot] = useState<AuthQuotaSnapshot | null>(null)
  const [supported, setSupported] = useState(true)
  const [stale, setStale] = useState(false)
  const [loading, setLoading] = useState(false)

  // Refs mirror the latest values so the stable refresh() callback and the
  // interval can read them without re-subscribing.
  const sourceIdRef = useRef(sourceId)
  const supportedRef = useRef(supported)
  // The source id of the request currently in flight, or null. Tracking the id
  // (rather than a plain boolean) dedupes repeat probes of the SAME source
  // without letting an in-flight request for the OLD source suppress the fresh
  // probe fired when the user switches sources.
  const inFlightIdRef = useRef<string | null>(null)
  supportedRef.current = supported

  const refresh = useCallback(async () => {
    const id = sourceIdRef.current
    if (!id || !supportedRef.current || isPageHidden()) return
    if (inFlightIdRef.current === id) return // dedupe same-source probes only

    inFlightIdRef.current = id
    try {
      const res = await api.authGetQuota(id)
      // Discard if the active source changed while the request was in flight.
      if (sourceIdRef.current !== id) return

      if (res.success) {
        const data = (res.data ?? null) as AuthQuotaSnapshot | null
        if (data === null) {
          // Unsupported: latch off and stop all future requests.
          setSupported(false)
          setSnapshot(null)
          setStale(false)
        } else {
          setSnapshot(data)
          setStale(false)
        }
      } else {
        // Keep the previous snapshot; flag it as possibly out of date.
        setStale(true)
      }
    } catch {
      setStale(true)
    } finally {
      // Only release the slot / settle loading if we still own them: a newer
      // probe for a switched-to source may have taken over in the meantime.
      if (inFlightIdRef.current === id) inFlightIdRef.current = null
      if (sourceIdRef.current === id) setLoading(false)
    }
  }, [])

  // Trigger 1 (source switch) + safety-net poll + visibility refocus.
  useEffect(() => {
    sourceIdRef.current = sourceId

    // Reset probe state for the new source.
    setSupported(true)
    supportedRef.current = true
    setSnapshot(null)
    setStale(false)

    if (!sourceId) {
      setLoading(false)
      return
    }

    setLoading(true)
    void refresh()

    const interval = window.setInterval(() => { void refresh() }, FALLBACK_POLL_MS)
    const onVisibility = () => { if (!isPageHidden()) void refresh() }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [sourceId, refresh])

  // Trigger 2: refresh on the current session's generation-finish edge.
  const isGenerating = useIsGenerating()
  const prevGeneratingRef = useRef(isGenerating)
  useEffect(() => {
    if (prevGeneratingRef.current && !isGenerating) void refresh()
    prevGeneratingRef.current = isGenerating
  }, [isGenerating, refresh])

  return { snapshot, supported, stale, loading, refresh }
}
