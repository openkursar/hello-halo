import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useAppsStore } from '../stores/apps.store'
import type { CapabilityInventory } from '../../shared/apps/capability-inventory'

export function useCapabilityInventory() {
  const apps = useAppsStore(state => state.apps)
  const [data, setData] = useState<CapabilityInventory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api.appGetCapabilityInventory().then(response => {
      if (cancelled) return
      if (!response.success || !response.data) throw new Error(response.error || 'Unable to load capability usage')
      setData(response.data)
    }).catch(err => {
      if (cancelled) return
      console.warn('[CapabilityInventory] Failed to load resource impact')
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [apps, revision])
  return { data, loading, error, reload }
}
