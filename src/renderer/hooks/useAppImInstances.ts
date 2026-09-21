/**
 * Bound IM channel instances for one digital human.
 *
 * Shared by the detail header (does an "External sessions" tab exist at all?)
 * and the sessions tab itself (which instance's sessions to browse), so both
 * surfaces agree on what "bound" means. Refetches when this app's IM sessions
 * move (the only binding-adjacent push the renderer receives); a binding made
 * in Settings is picked up on remount when the user navigates back.
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { ImChannelInstanceStatus } from '../../shared/types/im-channel'

export function useAppImInstances(appId: string, enabled = true): { instances: ImChannelInstanceStatus[]; loading: boolean } {
  const [instances, setInstances] = useState<ImChannelInstanceStatus[]>([])
  const [loading, setLoading] = useState(enabled)

  const fetchInstances = useCallback(async () => {
    try {
      const res = await api.imChannelsStatus()
      if (res.success && Array.isArray(res.data)) {
        setInstances((res.data as ImChannelInstanceStatus[]).filter(instance => instance.appId === appId))
      }
    } catch (error) {
      console.warn('[useAppImInstances] Channel status unavailable', { appId, error })
    } finally {
      setLoading(false)
    }
  }, [appId])

  useEffect(() => {
    if (!enabled) return
    setLoading(true)
    void fetchInstances()
    const unsubscribe = api.onImSessionUpdated?.((data: unknown) => {
      if ((data as { appId?: string }).appId === appId) void fetchInstances()
    })
    return () => { unsubscribe?.() }
  }, [enabled, appId, fetchInstances])

  return { instances, loading }
}
