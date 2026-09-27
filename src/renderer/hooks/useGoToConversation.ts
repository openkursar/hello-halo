/**
 * useGoToConversation - shared "go to the conversation" action
 *
 * Used by both NavRail and NarrowNavSheet (its narrow-layout replacement,
 * since NavRail hides there) so the halo-temp fallback logic lives in
 * exactly one place instead of drifting between two copies.
 */

import { useAppStore } from '../stores/app.store'
import { useSpaceStore } from '../stores/space.store'

export function useGoToConversation(): () => void {
  const navigate = useAppStore(s => s.navigate)
  const currentSpace = useSpaceStore(s => s.currentSpace)

  return () => {
    // currentSpace should already be resolved (startup / space deletion both
    // pick a fallback), but guard anyway: halo-temp always exists, so this
    // never needs the full selectDefaultSpace() lookup — just use it directly.
    if (!currentSpace) {
      const fallback = useSpaceStore.getState().haloSpace
      if (fallback) useSpaceStore.getState().setCurrentSpace(fallback)
    }
    navigate('space')
  }
}
