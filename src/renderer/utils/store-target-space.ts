import type { Space } from '../types'

interface StoreTargetSpaces {
  readonly spaces: readonly Space[]
  readonly currentSpace: Space | null
  readonly haloSpace: Space | null
}

/**
 * The space a store skill opens in when the user presses "Use". The built-in
 * Halo space is tracked apart from `spaces`, so it is matched explicitly and is
 * the last fallback.
 */
export function resolveStoreTargetSpace(
  installedSpaceId: string | null,
  { spaces, currentSpace, haloSpace }: StoreTargetSpaces,
): Space | null {
  return (installedSpaceId ? spaces.find(space => space.id === installedSpaceId) : null) ??
    (installedSpaceId === haloSpace?.id ? haloSpace : null) ??
    currentSpace ??
    spaces[0] ??
    haloSpace ??
    null
}
