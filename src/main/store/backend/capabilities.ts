/**
 * Store capabilities — the single source of truth for which store surfaces a
 * build may show.
 *
 * A capability is derived from two inputs:
 *   1. product.json (publish target) — known at startup.
 *   2. The primary source's capability handshake — performed and cached by its
 *      adapter, so the same client adapts to a full store backend, a static
 *      mirror (no such endpoint → catalog-only), or no source at all.
 *
 * This module owns the merge and exposes only the renderer-safe
 * {@link StoreCapabilities} slice (mirrors the security-policy pattern:
 * main computes → IPC projects → renderer hook gates UI). Read capabilities
 * never degrade; backend-gated surfaces stay off until the handshake proves them.
 */

import { resolvePublishTarget } from '../publish'
import { getPrimaryRegistry } from '../registry.service'
import { getAdapter } from '../adapters'
import { getStoreIdentityProvider } from '../../foundation/product-config'
import type {
  StoreCapabilities,
  StoreIdentityMode,
  ServerFeatures,
} from '../../../shared/store/store-types'

/**
 * Handshake with the primary source. Null when there is no enabled primary
 * source, or its driver has no handshake (catalog-only protocol). Caching and
 * failure policy belong to the driver — see DESIGN.md §3.3.
 */
async function primaryFeatures(): Promise<ServerFeatures | null> {
  const primary = getPrimaryRegistry()
  if (!primary) return null
  return (await getAdapter(primary).serverFeatures?.(primary)) ?? null
}

/**
 * Achievable creator-identity strength: the server's binding intersected with
 * whether this build declares an identity provider. Account-level identity is
 * only reachable when the client has a provider to authenticate with; without
 * one we report 'none' so the UI never offers a sign-in flow the client cannot
 * fulfil (which would otherwise submit anonymously).
 */
function resolveIdentity(binding: StoreIdentityMode | undefined): StoreIdentityMode {
  if (binding == null) return 'none'
  if (binding === 'account' && getStoreIdentityProvider() == null) return 'none'
  return binding
}

/**
 * Whether the store enforces account-level identity binding, read from the raw
 * server handshake (not the client-intersected {@link resolveIdentity}). The
 * sign-in gate uses this to refuse a provider-less build's anonymous submission
 * to a store that requires an account.
 */
export async function serverRequiresIdentity(): Promise<boolean> {
  return (await primaryFeatures())?.identityBinding === 'account'
}

/**
 * Compute the renderer-safe store capabilities: publish comes from product
 * config; every backend-gated surface follows the handshake (off when it is
 * absent, so a static source or an offline backend degrades cleanly).
 */
export async function getStoreCapabilities(): Promise<StoreCapabilities> {
  const publish = resolvePublishTarget() !== null
  const features = await primaryFeatures()
  return {
    catalog: true,
    installs: features?.installs === true,
    publish,
    reviewWorkflow: features?.reviewWorkflow === true,
    identity: resolveIdentity(features?.identityBinding),
  }
}
