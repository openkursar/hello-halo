/**
 * useMarketplaceCapabilities — renderer-side accessor for the build's
 * marketplace capability flags.
 *
 * Capabilities are resolved in the main process from product.json plus the
 * store backend's advertised features. They are stable for a session, so the
 * hook fetches once and caches the result in a module-level promise shared by
 * all callers.
 *
 * The gate is a UX layer, not a security boundary. It therefore fails
 * permissive: read capabilities (browse/search/install) never degrade, and
 * while the first fetch is in flight or after it fails, write/operational
 * surfaces resolve to their conservative default (hidden) rather than flashing.
 * Any real restriction is enforced by the backend.
 */

import { useEffect, useState } from 'react'
import { api } from '../api'
import type { MarketplaceCapabilities } from '../../shared/store/store-types'

/**
 * Default applied while capabilities are loading or on fetch failure. Read
 * capability stays on; every backend/identity-gated surface stays hidden until
 * proven available.
 */
const CONSERVATIVE_DEFAULT: MarketplaceCapabilities = {
  catalog: true,
  installs: false,
  publish: false,
  reviewWorkflow: false,
  identity: 'none',
}

let cached: Promise<MarketplaceCapabilities> | null = null

function coerce(value: Partial<MarketplaceCapabilities> | undefined): MarketplaceCapabilities {
  if (!value || typeof value !== 'object') return CONSERVATIVE_DEFAULT
  const identity = value.identity
  return {
    catalog: true,
    installs: value.installs === true,
    publish: value.publish === true,
    reviewWorkflow: value.reviewWorkflow === true,
    identity: identity === 'um' || identity === 'local' ? identity : 'none',
  }
}

async function fetchCapabilities(): Promise<MarketplaceCapabilities> {
  try {
    const res = await api.storeGetCapabilities()
    if (res.success && res.data && typeof res.data === 'object') {
      return coerce(res.data as Partial<MarketplaceCapabilities>)
    }
    console.warn('[useMarketplaceCapabilities] Empty/invalid response, using conservative default')
    return CONSERVATIVE_DEFAULT
  } catch (error) {
    console.error('[useMarketplaceCapabilities] Fetch failed, using conservative default:', error)
    return CONSERVATIVE_DEFAULT
  }
}

/**
 * Returns the marketplace capabilities.
 *
 * `null` means "still loading on first call this session". Treat `null` as the
 * conservative default in render code — read surfaces on, gated surfaces off:
 *
 * ```tsx
 * const caps = useMarketplaceCapabilities()
 * if (caps?.publish) return <PublishButton />
 * ```
 */
export function useMarketplaceCapabilities(): MarketplaceCapabilities | null {
  const [capabilities, setCapabilities] = useState<MarketplaceCapabilities | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!cached) {
      cached = fetchCapabilities()
    }
    cached.then((value) => {
      if (!cancelled) setCapabilities(value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return capabilities
}
