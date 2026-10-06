/**
 * Auth RPC contract (passthrough). Generic OAuth provider login lifecycle and
 * token management. Handler return shapes are preserved verbatim.
 */
import { rawRpcMethod, type RpcResponse } from '../define'
import type { OAuthStartResult, OAuthCompleteResult, ProviderId, AuthQuotaSnapshot } from '../../types/ai-sources'

/** Every successful start names the login it created; later calls must present it. */
export type OAuthLoginStart = OAuthStartResult & { loginId: string }

export const authRpc = {
  authGetProviders: rawRpcMethod('auth:get-providers'),
  authGetBuiltinProviders: rawRpcMethod('auth:get-builtin-providers'),
  authStartLogin: rawRpcMethod<[providerType: ProviderId, sourceId?: string], RpcResponse<OAuthLoginStart>>('auth:start-login'),
  authOpenLoginWindow: rawRpcMethod<[providerType: ProviderId, loginId: string], RpcResponse<OAuthCompleteResult>>('auth:open-login-window'),
  authCompleteLogin: rawRpcMethod<[providerType: ProviderId, stateOrCode: string, loginId: string], RpcResponse<OAuthCompleteResult>>('auth:complete-login'),
  authCancelLogin: rawRpcMethod<[providerType: ProviderId, loginId: string], RpcResponse<void>>('auth:cancel-login'),
  authRefreshToken: rawRpcMethod<[sourceId: string], RpcResponse<void>>('auth:refresh-token'),
  authCheckToken: rawRpcMethod<[sourceId: string], RpcResponse<{ valid: boolean; needsRefresh?: boolean; reason?: string }>>('auth:check-token'),
  authLogout: rawRpcMethod<[sourceId: string], RpcResponse<void>>('auth:logout'),
  authGetQuota: rawRpcMethod<[sourceId: string], RpcResponse<AuthQuotaSnapshot | null>>('auth:get-quota'),
  authDelegatedStatus: rawRpcMethod('auth:delegated-status'),
  authDelegatedActivate: rawRpcMethod('auth:delegated-activate'),
}
