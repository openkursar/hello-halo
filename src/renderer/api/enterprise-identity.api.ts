import type { RpcClient } from '../../shared/rpc/define'
import type { enterpriseIdentityRpc } from '../../shared/rpc/contracts/enterprise-identity.contract'
import { httpRequest, isElectron } from './_shared'
import { ensureExtendedServicesReady } from './bootstrap-ready'

async function desktop<T>(operation: () => Promise<T>): Promise<T> {
  await ensureExtendedServicesReady()
  return operation()
}

export const enterpriseIdentityApi: RpcClient<typeof enterpriseIdentityRpc> = {
  enterpriseIdentityState: () => isElectron() ? desktop(() => window.halo.enterpriseIdentityState()) : httpRequest('POST', '/api/enterprise-identity/state', {}),
  enterpriseIdentityBegin: input => isElectron() ? desktop(() => window.halo.enterpriseIdentityBegin(input)) : httpRequest('POST', '/api/enterprise-identity/begin', { ...input }),
  enterpriseIdentityPoll: input => isElectron() ? desktop(() => window.halo.enterpriseIdentityPoll(input)) : httpRequest('POST', '/api/enterprise-identity/poll', { ...input }),
  enterpriseIdentityCancel: input => isElectron() ? desktop(() => window.halo.enterpriseIdentityCancel(input)) : httpRequest('POST', '/api/enterprise-identity/cancel', { ...input }),
  enterpriseIdentitySignOut: () => isElectron() ? desktop(() => window.halo.enterpriseIdentitySignOut()) : httpRequest('POST', '/api/enterprise-identity/sign-out', {}),
}
