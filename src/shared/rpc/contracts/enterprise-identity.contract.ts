import { rpcMethod } from '../define'
import type { EnterpriseIdentityState, EnterpriseLoginPollResult } from '../../types/enterprise-identity'

/**
 * Company sign-in for command-line tools. The renderer drives the QR dialog;
 * nothing here ever carries a proof, ticket or credential.
 */
export const enterpriseIdentityRpc = {
  enterpriseIdentityState: rpcMethod<[], EnterpriseIdentityState>('enterprise-identity:state'),
  enterpriseIdentityBegin: rpcMethod<[input: { methodId: string }], EnterpriseIdentityState>('enterprise-identity:begin'),
  /** Waits a bounded time; repeat while the outcome is pending or scanned. */
  enterpriseIdentityPoll: rpcMethod<[input: { flowId: string }], EnterpriseLoginPollResult>('enterprise-identity:poll'),
  enterpriseIdentityCancel: rpcMethod<[input: { flowId: string }], EnterpriseIdentityState>('enterprise-identity:cancel'),
  enterpriseIdentitySignOut: rpcMethod<[], EnterpriseIdentityState>('enterprise-identity:sign-out'),
}
