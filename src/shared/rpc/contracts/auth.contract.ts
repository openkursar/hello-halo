/**
 * Auth RPC contract (passthrough). Generic OAuth provider login lifecycle and
 * token management. Handler return shapes are preserved verbatim.
 */
import { rawRpcMethod } from '../define'

export const authRpc = {
  authGetProviders: rawRpcMethod('auth:get-providers'),
  authGetBuiltinProviders: rawRpcMethod('auth:get-builtin-providers'),
  authStartLogin: rawRpcMethod('auth:start-login'),
  authOpenLoginWindow: rawRpcMethod('auth:open-login-window'),
  authCompleteLogin: rawRpcMethod('auth:complete-login'),
  authRefreshToken: rawRpcMethod('auth:refresh-token'),
  authCheckToken: rawRpcMethod('auth:check-token'),
  authLogout: rawRpcMethod('auth:logout'),
  authGetQuota: rawRpcMethod('auth:get-quota'),
  authDelegatedStatus: rawRpcMethod('auth:delegated-status'),
  authDelegatedActivate: rawRpcMethod('auth:delegated-activate'),
}
