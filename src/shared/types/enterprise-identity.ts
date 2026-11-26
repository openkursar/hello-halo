/**
 * Organization sign-in — what the renderer sees (see
 * services/enterprise-identity/DESIGN.md). Never carries a proof, ticket or
 * credential.
 */

export type OrgSignInStatus =
  /** The build has no organization sign-in. Nothing is shown. */
  | 'unconfigured'
  /** The provider is being loaded. */
  | 'loading'
  /** The provider could not be loaded or speaks another contract version. */
  | 'unavailable'
  /** The provider is recovering an earlier sign-in; not yet known whether it holds. */
  | 'restoring'
  | 'signed-out'
  /** At least one capability was obtained; see each capability's own status. */
  | 'active'

export type OrgCapabilityStatus = 'ready' | 'expired' | 'missing'

export interface OrgCapabilityView {
  id: string
  label: string
  status: OrgCapabilityStatus
  expiresAt?: number
}

export interface OrgBoundToolView {
  toolId: string
  capability: string
  access: 'ready' | 'none' | 'maybe-still-valid'
}

export interface OrgSignInState {
  status: OrgSignInStatus
  /** Display name of the sign-in, chosen by the build. */
  name?: string
  account?: { displayName: string }
  /** Every capability the provider offers, in its order. */
  capabilities: OrgCapabilityView[]
  boundTools: OrgBoundToolView[]
  /** A sign-in window is open. */
  signingIn: boolean
  /** Whether "remove this device" is offered. */
  canUnbindDevice: boolean
  /** A bound tool has no valid issued credential after an issue failure. */
  credentialFailed?: boolean
  /** Earlier credentials could not be isolated from their launchers. */
  withdrawalPending?: true
  unavailableReason?: 'incompatible' | 'temporary'
}

export type OrgSignInResult = 'succeeded' | 'cancelled' | 'expired' | 'failed' | 'busy'

/** Ready, expired or missing capability counts, for compact displays. */
export function summarizeOrgSignIn(state: OrgSignInState): { ready: number; attention: number } {
  let ready = 0
  let attention = 0
  for (const capability of state.capabilities) {
    if (capability.status === 'ready') ready++
    else attention++
  }
  return { ready, attention }
}
