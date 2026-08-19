/**
 * Binds the store's freshness check to the two moments the user is not
 * navigating: arriving at the store, and the window regaining focus after they
 * changed something elsewhere. Tab switches trigger it from the tab row itself.
 */

import { useEffect } from 'react'
import { useAppsPageStore } from '../stores/apps-page.store'

export function useStoreRevalidation(active: boolean): void {
  const revalidateStore = useAppsPageStore(state => state.revalidateStore)

  useEffect(() => {
    if (!active) return
    const run = () => { void revalidateStore() }
    run()
    window.addEventListener('focus', run)
    return () => window.removeEventListener('focus', run)
  }, [active, revalidateStore])
}
