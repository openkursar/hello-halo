import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/**
 * Network reachability via `navigator.onLine` + online/offline events.
 *
 * `false` reliably means there is no network — used to pre-empt store installs
 * that would otherwise hang fetching spec/files from the registry. A `true`
 * value does NOT guarantee the registry is reachable; that failure surfaces as
 * an install error rather than being blocked here.
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true)
}
