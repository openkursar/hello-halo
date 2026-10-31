import { useEffect, useState } from 'react'
import { api } from '../api'
import { useAppStore } from '../stores/app.store'
import type { EngineAvailabilityReport } from '../types'

/**
 * Which engines can run on this computer, read only while `enabled`. Read
 * again when the selected Claude Code installation changes, so connecting
 * one in Settings clears what depended on it, and whenever `refresh` changes
 * (a turn that just failed for its engine knows better than an earlier read).
 */
export function useEngineAvailability(enabled: boolean, refresh?: unknown): EngineAvailabilityReport | null {
  const [report, setReport] = useState<EngineAvailabilityReport | null>(null)
  const ccPath = useAppStore(state => state.config?.agent?.ccRuntime?.selectedPath)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void api.getEngineAvailability().then(response => {
      if (cancelled) return
      if (response.success && response.data) setReport(response.data as EngineAvailabilityReport)
      else console.warn('[EngineAvailability] Could not be read', { error: response.error?.slice(0, 300) })
    }).catch(error => {
      if (!cancelled) console.warn('[EngineAvailability] Request failed', { reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown' })
    })
    return () => { cancelled = true }
  }, [enabled, ccPath, refresh])
  return enabled ? report : null
}
