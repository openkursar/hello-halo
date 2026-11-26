import { enterpriseIdentityRpc } from '../../shared/rpc/contracts/enterprise-identity.contract'
import { getEnterpriseIdentityState, retryEnterpriseIdentity, signInEnterpriseIdentity, signOutEnterpriseIdentity } from '../services/enterprise-identity'
import { registerRpcHandlers } from './rpc'

export function registerEnterpriseIdentityHandlers(): void {
  registerRpcHandlers(
    enterpriseIdentityRpc,
    {
      enterpriseIdentityState: getEnterpriseIdentityState,
      enterpriseIdentitySignIn: signInEnterpriseIdentity,
      enterpriseIdentityRetry: retryEnterpriseIdentity,
      enterpriseIdentitySignOut: input => {
        if (input?.scope !== 'session' && input?.scope !== 'device') throw new Error('Invalid organization sign-out scope')
        return signOutEnterpriseIdentity(input.scope)
      },
    },
    'EnterpriseIdentity',
  )
}
