/**
 * Marketplace creator-identity token resolution.
 *
 * Bridges the product-config declaration (`identityProvider`) to the signed-in
 * OAuth token held by the AI-source manager, so publish attribution and "my
 * publications" can authenticate to an identity-bound store server. The generic
 * core names no specific provider — it forwards whatever product.json declares.
 */

import { getMarketplaceIdentityProvider } from '../foundation/product-config'
import { getAISourceManager } from '../services/ai-sources'
import { serverRequiresIdentity } from './marketplace-capabilities'
import type { ProviderId } from '../../shared/types/ai-sources'
import type { MarketplaceSignInStatus } from '../../shared/store/store-types'

/**
 * Resolve the marketplace identity token, or null when no identity provider is
 * configured or its provider is not signed in (identity-bound calls then
 * degrade to anonymous rather than failing).
 */
export async function getMarketplaceIdentityToken(): Promise<string | null> {
  const providerType = getMarketplaceIdentityProvider()
  if (!providerType) return null
  return getAISourceManager().getOAuthAccessToken(providerType as ProviderId)
}

/** Creator identity used to prefill the publish author in um mode. `uid` is the
 * stable ASCII-safe id (drives the slug, matches server ownership); `name` is
 * the display label. Null when no provider is configured or it is not signed in. */
export interface MarketplaceIdentity {
  uid: string
  name: string
}

export function getMarketplaceIdentity(): MarketplaceIdentity | null {
  const providerType = getMarketplaceIdentityProvider() as ProviderId | undefined
  if (!providerType) return null
  const user = getAISourceManager().getOAuthIdentity(providerType)
  if (!user) return null
  return { uid: user.uid ?? '', name: user.name ?? '' }
}

/**
 * Ensure the identity provider is signed in, launching its OAuth flow (system
 * browser) when no token is held yet. Returns true once a token is available,
 * false if login could not be started or the user did not complete it.
 *
 * A build with no identity provider is only cleared to publish when the store
 * does not enforce strong identity; if the store requires an account, a
 * provider-less build cannot authenticate and must be refused rather than allowed
 * to submit anonymously.
 */
export async function ensureMarketplaceIdentity(): Promise<boolean> {
  const providerType = getMarketplaceIdentityProvider() as ProviderId | undefined
  if (!providerType) return !(await serverRequiresIdentity())

  const manager = getAISourceManager()
  if (await manager.getOAuthAccessToken(providerType)) return true

  const start = await manager.startOAuthLogin(providerType)
  if (!start.success || !start.data) return false
  const done = await manager.completeOAuthLogin(providerType, start.data.state)
  return done.success
}

/**
 * Classify whether a creator sign-in is possible, so the renderer can show a
 * misconfiguration explanation instead of a dead sign-in button when the store
 * requires an account but this build declares no identity provider.
 */
export async function getMarketplaceSignInStatus(): Promise<MarketplaceSignInStatus> {
  const providerType = getMarketplaceIdentityProvider() as ProviderId | undefined
  if (providerType) {
    const token = await getAISourceManager().getOAuthAccessToken(providerType)
    return token ? 'signed-in' : 'available'
  }
  return (await serverRequiresIdentity()) ? 'unavailable' : 'not-required'
}
