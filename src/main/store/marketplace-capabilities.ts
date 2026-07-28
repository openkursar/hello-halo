/**
 * Marketplace capabilities — the single source of truth for which marketplace
 * surfaces a build may show.
 *
 * A capability is derived from two inputs:
 *   1. product.json (publish target) — known at startup.
 *   2. The official store backend's `GET /capabilities` probe — resolved at
 *      runtime and cached, so the same client adapts to a full store server, a
 *      static mirror (no endpoint → catalog-only), or no server at all.
 *
 * This module owns the merge and exposes only the renderer-safe
 * {@link MarketplaceCapabilities} slice (mirrors the security-policy pattern:
 * main computes → IPC projects → renderer hook gates UI). Read capabilities
 * never degrade; backend-gated surfaces stay off until the probe proves them.
 */

import { resolvePublishTarget } from './publish'
import { getOfficialRegistryUrl } from './registry.service'
import { fetchWithTimeout } from './adapters/halo.adapter'
import { getMarketplaceIdentityProvider } from '../foundation/product-config'
import type { MarketplaceCapabilities, MarketplaceIdentityMode } from '../../shared/store/store-types'

/** Feature advertisement shape returned by `GET /capabilities`. */
interface ServerFeatures {
  installs: boolean
  featured: boolean
  collections: boolean
  reviewWorkflow: boolean
  identityBinding: string
}

// Probe cadence matches the store sync cadence: entering the marketplace
// usually hits the cache, so capability detection adds no first-screen wait.
const PROBE_TTL_MS = 60 * 60 * 1000
// A transient backend fault (5xx/429/network) must not lock the read-only
// baseline in for a full hour — keep the last-known result but retry soon.
const PROBE_RETRY_MS = 5 * 60 * 1000
let probeCache: { features: ServerFeatures | null; expiresAt: number } | null = null

/**
 * Probe the official registry's capabilities, cached with a TTL. The failure
 * handling distinguishes a genuinely absent endpoint from a transient fault:
 *   - 404/501 (static mirror / OSS source with no such endpoint) → cache the
 *     read-only baseline for the full TTL; re-probing sooner would be wasteful.
 *   - any other non-2xx (5xx/429/…) or a network error → keep the last-known
 *     features (stale but not broken) and retry after a short TTL, so a passing
 *     backend blip doesn't strip backend-gated surfaces for a whole hour.
 */
async function probeServerFeatures(): Promise<ServerFeatures | null> {
  const now = Date.now()
  if (probeCache && probeCache.expiresAt > now) return probeCache.features

  const base = getOfficialRegistryUrl()
  if (!base) {
    probeCache = { features: null, expiresAt: now + PROBE_TTL_MS }
    return null
  }
  try {
    const url = `${base}/capabilities`
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) {
      const endpointAbsent = res.status === 404 || res.status === 501
      if (endpointAbsent) {
        probeCache = { features: null, expiresAt: now + PROBE_TTL_MS }
        return null
      }
      const stale = probeCache?.features ?? null
      probeCache = { features: stale, expiresAt: now + PROBE_RETRY_MS }
      return stale
    }
    const body = (await res.json()) as { features?: Partial<ServerFeatures> }
    const f = body.features ?? {}
    const features: ServerFeatures = {
      installs: f.installs === true,
      featured: f.featured === true,
      collections: f.collections === true,
      reviewWorkflow: f.reviewWorkflow === true,
      identityBinding: typeof f.identityBinding === 'string' ? f.identityBinding : 'none',
    }
    probeCache = { features, expiresAt: now + PROBE_TTL_MS }
    return features
  } catch (error) {
    console.warn('[MarketplaceCapabilities] /capabilities probe failed:', (error as Error).message)
    const stale = probeCache?.features ?? null
    probeCache = { features: stale, expiresAt: now + PROBE_RETRY_MS }
    return stale
  }
}

function mapIdentity(binding: string | undefined): MarketplaceIdentityMode {
  switch (binding) {
    case 'um':
      return 'um'
    case 'shared-token':
      return 'local'
    default:
      return 'none'
  }
}

/**
 * Achievable creator-identity strength: the server's binding intersected with
 * whether this build declares an identity provider. Strong identity ('um') is
 * only reachable when the client has a provider to authenticate with; without
 * one we report 'none' so the UI never offers a um flow the client cannot
 * fulfil (which would otherwise submit anonymously).
 */
function resolveIdentity(binding: string | undefined): MarketplaceIdentityMode {
  const server = mapIdentity(binding)
  if (server === 'um' && getMarketplaceIdentityProvider() == null) return 'none'
  return server
}

/**
 * Whether the official store enforces strong (um) identity binding, read from
 * the raw server probe (not the client-intersected {@link resolveIdentity}).
 * The sign-in gate uses this to refuse a provider-less build's anonymous
 * submission to a store that requires an account.
 */
export async function serverRequiresIdentity(): Promise<boolean> {
  const features = await probeServerFeatures()
  return mapIdentity(features?.identityBinding) === 'um'
}

/**
 * Compute the renderer-safe marketplace capabilities: publish comes from product
 * config; every backend-gated surface follows the server probe (off when the
 * probe is absent, so a static source or an offline backend degrades cleanly).
 */
export async function getMarketplaceCapabilities(): Promise<MarketplaceCapabilities> {
  const publish = resolvePublishTarget() !== null
  const features = await probeServerFeatures()
  return {
    catalog: true,
    installs: features?.installs === true,
    publish,
    reviewWorkflow: features?.reviewWorkflow === true,
    identity: resolveIdentity(features?.identityBinding),
  }
}
