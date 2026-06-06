/**
 * Security-policy RPC contract. Auto-envelope: the handler returns the raw
 * renderer-safe policy and the registrar wraps it in the response envelope.
 *
 * The policy shape is intentionally inlined here (a closed set of plain
 * booleans) to keep this shared contract free of any main/renderer type
 * coupling; `getPublicSecurityPolicy()` is the single source on the main side.
 */
import { rpcMethod } from '../define'

export interface PublicSecurityPolicyDTO {
  tunnelSafe: boolean
}

export const securityRpc = {
  getSecurityPolicy: rpcMethod<[], PublicSecurityPolicyDTO>('security:get-public-policy'),
}
