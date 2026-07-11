/**
 * Portable identity seam.
 *
 * A stable Identity plus a registry of pluggable IdentityResolvers. Only one
 * resolver ships today (device-key); future authentication methods (SSO,
 * internet-based) register a new resolver via registerIdentityResolver without
 * changing this file's dispatch logic — authentication is pluggable, the
 * identity model is not.
 */

import type { AuthProof, Identity, IdentityResolver } from './types'
import { ensureLocalIdentity } from './device-key'
import { DeviceKeyResolver } from './device-key-resolver'

const LOG_TAG = '[Identity]'

// Registry keyed by proof method. Each method is interpreted by exactly one
// resolver; dispatch is data-driven so adding a method never edits this logic.
const resolvers = new Map<string, IdentityResolver>()

/**
 * Register a resolver for its method. Later registrations for the same method
 * override earlier ones (last writer wins) — intended for extension, not for
 * silent collisions.
 */
export function registerIdentityResolver(resolver: IdentityResolver): void {
  if (resolvers.has(resolver.method)) {
    console.warn(`${LOG_TAG} replacing existing resolver for method '${resolver.method}'`)
  }
  resolvers.set(resolver.method, resolver)
  console.log(`${LOG_TAG} registered resolver for method '${resolver.method}'`)
}

/**
 * Initialize the identity seam: ensure the local node identity exists and
 * register the built-in device-key resolver. Idempotent.
 */
export function initIdentity(): void {
  ensureLocalIdentity()
  if (!resolvers.has('device-key')) {
    registerIdentityResolver(new DeviceKeyResolver())
  }
}

/**
 * Dispatch a proof to the resolver matching its method. An unknown method
 * returns null (never throws) so callers treat it as an authentication failure.
 */
export function resolveIdentity(proof: AuthProof): Identity | null {
  const resolver = resolvers.get(proof.method)
  if (!resolver) {
    console.warn(`${LOG_TAG} no resolver for method '${proof.method}'`)
    return null
  }
  return resolver.resolve(proof)
}

export {
  getLocalIdentity,
  getLocalPublicKeyPem,
  signWithLocalKey,
  setLocalDisplayName,
  deriveIdentityId,
} from './device-key'

export { DeviceKeyResolver } from './device-key-resolver'
export type { AuthProof, Identity, IdentityResolver } from './types'
