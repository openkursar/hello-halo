import { enterpriseIdentityRpc } from '../../shared/rpc/contracts/enterprise-identity.contract'
import {
  beginEnterpriseLogin,
  cancelEnterpriseLogin,
  getEnterpriseIdentityState,
  pollEnterpriseLogin,
  signOutEnterpriseIdentity,
} from '../services/enterprise-identity'
import { registerRpcHandlers } from './rpc'

export function registerEnterpriseIdentityHandlers(): void {
  registerRpcHandlers(
    enterpriseIdentityRpc,
    {
      enterpriseIdentityState: () => getEnterpriseIdentityState(),
      enterpriseIdentityBegin: input => beginEnterpriseLogin(String(input?.methodId ?? '')),
      enterpriseIdentityPoll: input => pollEnterpriseLogin(String(input?.flowId ?? '')),
      enterpriseIdentityCancel: input => cancelEnterpriseLogin(String(input?.flowId ?? '')),
      enterpriseIdentitySignOut: () => signOutEnterpriseIdentity(),
    },
    'EnterpriseIdentity',
  )
}
