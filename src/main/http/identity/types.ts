/**
 * Portable identity primitives for the HTTP transport layer.
 *
 * Design stance: identity follows the person, not the deployment or the
 * authentication method. One owner has exactly one stable Identity that does
 * not reset across LAN / central / internet. Device-key, SSO, and future
 * internet credentials are merely different ways to *prove* it is them; each
 * proof method is one pluggable IdentityResolver that resolves to the same
 * Identity. Only the device-key resolver is implemented so far.
 */

/**
 * Stable, portable identity. Deliberately does NOT encode deployment,
 * authentication method, or any device/node. The id stays identical across
 * networks; displayName is for UI display only.
 */
export interface Identity {
  /** Globally unique, deployment-independent, stable across LAN/central/internet. */
  id: string
  /** Real name, UI display only. */
  displayName: string
}

/**
 * A pluggable proof presented by some authentication method. Each method maps
 * to one resolver; `method` selects the resolver that interprets the rest.
 */
export interface AuthProof {
  /** 'device-key' today (the only method implemented). */
  method: string
  [k: string]: unknown
}

/**
 * Resolves a proof into the stable Identity it vouches for, or null when the
 * proof is invalid. Future authentication methods add a new resolver without
 * changing the identity model.
 */
export interface IdentityResolver {
  readonly method: string
  resolve(proof: AuthProof): Identity | null
}
