import { rpcMethod } from '../define'
import type { OrgSignInResult, OrgSignInState } from '../../types/enterprise-identity'

/**
 * Organization sign-in. Nothing here carries a proof, ticket or credential.
 * State changes are also pushed on the `enterprise-identity:changed` event.
 */
export const enterpriseIdentityRpc = {
  /** Current state; in a configured build the first call starts loading the provider. */
  enterpriseIdentityState: rpcMethod<[], OrgSignInState>('enterprise-identity:state'),
  /** Opens the provider's page in an isolated window (desktop only) and resolves when that attempt ends. */
  enterpriseIdentitySignIn: rpcMethod<[], OrgSignInResult>('enterprise-identity:sign-in'),
  enterpriseIdentityRetry: rpcMethod<[], OrgSignInState>('enterprise-identity:retry'),
  enterpriseIdentitySignOut: rpcMethod<[input: { scope: 'session' | 'device' }], OrgSignInState>('enterprise-identity:sign-out'),
}

/** Event channel carrying the new `OrgSignInState`. */
export const ENTERPRISE_IDENTITY_CHANGED_EVENT = 'enterprise-identity:changed'
