import { useEffect, useState, useSyncExternalStore } from 'react'
import { api } from '../api'
import { getRemoteServerUrl, getServerUrl, isCapacitor, isElectron, onServerUrlChange, onWsStateChange } from '../api/transport'

type Runtime = { serverMode: boolean }
const desktop: Runtime = { serverMode: false }
const noSubscription = () => () => {}
const noServer = () => null
const currentServer = () => isCapacitor() ? getServerUrl() : getRemoteServerUrl()
let pending: { url: string; request: Promise<Runtime | null> } | undefined

function readRuntime(url: string): Promise<Runtime | null> {
  if (pending?.url === url) return pending.request
  const request: Promise<Runtime | null> = api.getRuntimeInfo().then(result => {
    if (result.success && typeof result.data?.serverMode === 'boolean') return result.data
    console.warn('[Runtime] Backend capabilities unavailable:', result.error ?? 'Invalid response')
    return null
  }).catch(error => {
    console.warn('[Runtime] Backend capabilities unavailable:', error)
    return null
  }).finally(() => { if (pending?.request === request) pending = undefined })
  pending = { url, request }
  return request
}

/** An unknown backend grants no server-only controls. Retry when the view opens or its connection returns. */
export function useBackendRuntime(enabled = true): Runtime | null {
  const remote = enabled && !isElectron()
  const url = useSyncExternalStore(remote && isCapacitor() ? onServerUrlChange : noSubscription, remote ? currentServer : noServer, noServer)
  const [answer, setAnswer] = useState<{ url: string; runtime: Runtime | null } | null>(null)
  useEffect(() => {
    if (!url) return
    let active = true
    const refresh = () => {
      void readRuntime(url).then(runtime => { if (active) setAnswer({ url, runtime }) })
    }
    refresh()
    const unsubscribe = onWsStateChange(state => { if (state === 'connected') refresh() })
    return () => { active = false; unsubscribe() }
  }, [url])
  if (!enabled) return null
  return remote ? (url && answer?.url === url ? answer.runtime : null) : desktop
}

export function useServerBackend(): boolean {
  return useBackendRuntime()?.serverMode === true
}
