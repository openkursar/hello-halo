import { ENTERPRISE_IDENTITY_CHANGED_EVENT, type enterpriseIdentityRpc } from '../../shared/rpc/contracts/enterprise-identity.contract'
import type { RpcClient } from '../../shared/rpc/define'
import type { OrgSignInState } from '../../shared/types/enterprise-identity'
import { httpRequest, isElectron, onEvent } from './_shared'
import { ensureExtendedServicesReady } from './bootstrap-ready'

async function desktop<T>(operation: () => Promise<T>): Promise<T> {
  await ensureExtendedServicesReady()
  return operation()
}

const requests: RpcClient<typeof enterpriseIdentityRpc> = {
  enterpriseIdentityState: () => isElectron() ? desktop(() => window.halo.enterpriseIdentityState()) : httpRequest('POST', '/api/enterprise-identity/state', {}),
  enterpriseIdentitySignIn: () => isElectron() ? desktop(() => window.halo.enterpriseIdentitySignIn()) : httpRequest('POST', '/api/enterprise-identity/sign-in', {}),
  enterpriseIdentityRetry: () => isElectron() ? desktop(() => window.halo.enterpriseIdentityRetry()) : httpRequest('POST', '/api/enterprise-identity/retry', {}),
  enterpriseIdentitySignOut: input => isElectron() ? desktop(() => window.halo.enterpriseIdentitySignOut(input)) : httpRequest('POST', '/api/enterprise-identity/sign-out', input),
}

export function onEnterpriseIdentityChanged(callback: (state: OrgSignInState) => void): () => void {
  return onEvent(ENTERPRISE_IDENTITY_CHANGED_EVENT, callback)
}

export const enterpriseIdentityApi = { ...requests, onEnterpriseIdentityChanged }
