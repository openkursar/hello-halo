/**
 * useStoreCapabilities — renderer-side accessor for the build's store
 * capability flags.
 *
 * Capabilities are resolved in the main process from product.json plus the
 * store backend's advertised features, and shared across callers via a
 * time-boxed cached resource. The cache is dropped on network recovery (the
 * `online` event) so a probe that degraded while offline recovers without an
 * app restart rather than staying frozen for the whole session.
 *
 * The gate is a UX layer, not a security boundary. It therefore fails
 * permissive: read capabilities (browse/search/install) never degrade, and
 * while the first fetch is in flight or after it fails, write/operational
 * surfaces resolve to their conservative default (hidden) rather than flashing.
 * Any real restriction is enforced by the backend.
 */

import { api } from '../api'
import { createCachedResource } from '../lib/cached-resource'
import type { StoreCapabilities } from '../../shared/store/store-types'

/**
 * Default applied while capabilities are loading or on fetch failure. Read
 * capability stays on; every backend/identity-gated surface stays hidden until
 * proven available.
 */
const CONSERVATIVE_DEFAULT: StoreCapabilities = {
  catalog: true,
  installs: false,
  publish: false,
  reviewWorkflow: false,
  identity: 'none',
}

// Re-fetch on a fresh mount once the cache is older than this, so a degraded
// result does not outlive the main-process probe's own retry cadence.
const CAPABILITIES_TTL_MS = 60 * 1000

function coerce(value: Partial<StoreCapabilities> | undefined): StoreCapabilities {
  if (!value || typeof value !== 'object') return CONSERVATIVE_DEFAULT
  const identity = value.identity
  return {
    catalog: true,
    installs: value.installs === true,
    publish: value.publish === true,
    reviewWorkflow: value.reviewWorkflow === true,
    identity: identity === 'account' || identity === 'shared' ? identity : 'none',
  }
}

async function fetchCapabilities(): Promise<StoreCapabilities> {
  try {
    const res = await api.storeGetCapabilities()
    if (res.success && res.data && typeof res.data === 'object') {
      return coerce(res.data as Partial<StoreCapabilities>)
    }
    console.warn('[useStoreCapabilities] Empty/invalid response, using conservative default')
    return CONSERVATIVE_DEFAULT
  } catch (error) {
    console.error('[useStoreCapabilities] Fetch failed, using conservative default:', error)
    return CONSERVATIVE_DEFAULT
  }
}

const capabilitiesResource = createCachedResource(fetchCapabilities, { ttlMs: CAPABILITIES_TTL_MS })

// Network recovery: drop the cache and re-fetch so identity/backend-gated
// surfaces that went dark while offline come back without an app restart.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => capabilitiesResource.invalidate())
}

/**
 * Returns the store capabilities, seeded with the conservative default
 * (read surfaces on, gated surfaces off) until the first fetch resolves.
 *
 * ```tsx
 * const caps = useStoreCapabilities()
 * if (caps.publish) return <PublishButton />
 * ```
 */
export function useStoreCapabilities(): StoreCapabilities {
  return capabilitiesResource.useValue(CONSERVATIVE_DEFAULT)
}
