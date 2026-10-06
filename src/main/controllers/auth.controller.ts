/**
 * Auth Controller — OAuth account lifecycle shared by the IPC and HTTP transports.
 *
 * Validates transport input and returns only public fields: providers may
 * attach credentials to their results, and none of them may leave the main
 * process. The desktop login window is not here; it lives in ipc/auth.ts.
 */

import { getAISourceManager } from '../services/ai-sources'
import {
  isAuthRequestString,
  toPublicOAuthCompleteResult,
  toPublicOAuthStartResult,
  type OAuthCompleteResult,
  type ProviderId
} from '../../shared/types/ai-sources'
import type { OAuthLoginStart } from '../../shared/rpc/contracts/auth.contract'
import type { RpcResponse } from '../../shared/rpc/define'

/** Error text of a request rejected before reaching the account manager; HTTP answers it with 400. */
export const INVALID_AUTH_REQUEST = 'Invalid authentication request'

/** Authorization codes from redirect flows can be long; identifiers cannot. */
const MAX_AUTH_CODE_LENGTH = 32768

/** Exception text from OAuth requests can echo codes or tokens; logs keep only its type. */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function rejectInvalid<T>(operation: string): RpcResponse<T> {
  console.warn(`[Auth] Rejected ${operation}: invalid request fields`)
  return { success: false, error: INVALID_AUTH_REQUEST }
}

export async function startLogin(providerType: unknown, sourceId?: unknown): Promise<RpcResponse<OAuthLoginStart>> {
  if (!isAuthRequestString(providerType) || (sourceId !== undefined && !isAuthRequestString(sourceId))) {
    return rejectInvalid('start-login')
  }
  try {
    const result = await getAISourceManager().startOAuthLogin(providerType as ProviderId, sourceId)
    const loginId = result.data?.loginId
    if (!result.success || !result.data) return { success: false, error: result.error || 'Failed to start login' }
    if (!loginId) {
      console.warn(`[Auth] Discarded login start without a login id: provider=${providerType}`)
      return { success: false, error: 'Failed to start login' }
    }
    return { success: true, data: { ...toPublicOAuthStartResult(result.data), loginId } }
  } catch (error) {
    console.error(`[Auth] Start login threw: provider=${providerType} (${errorKind(error)})`)
    return { success: false, error: 'Failed to start login' }
  }
}

export async function completeLogin(
  providerType: unknown,
  stateOrCode: unknown,
  loginId: unknown
): Promise<RpcResponse<OAuthCompleteResult>> {
  if (!isAuthRequestString(providerType) || !isAuthRequestString(stateOrCode, MAX_AUTH_CODE_LENGTH) ||
    !isAuthRequestString(loginId)) {
    return rejectInvalid('complete-login')
  }
  try {
    const result = await getAISourceManager().completeOAuthLogin(providerType as ProviderId, stateOrCode, loginId)
    return {
      success: result.success,
      error: result.error,
      data: result.data ? toPublicOAuthCompleteResult(result.data) : undefined
    }
  } catch (error) {
    console.error(`[Auth] Complete login threw: provider=${providerType} (${errorKind(error)})`)
    return { success: false, error: 'Login failed' }
  }
}

export async function cancelLogin(providerType: unknown, loginId: unknown): Promise<RpcResponse<void>> {
  if (!isAuthRequestString(providerType) || !isAuthRequestString(loginId)) {
    return rejectInvalid('cancel-login')
  }
  try {
    const result = await getAISourceManager().cancelOAuthLogin(providerType as ProviderId, loginId)
    return { success: result.success, error: result.error }
  } catch (error) {
    console.error(`[Auth] Cancel login threw: provider=${providerType} (${errorKind(error)})`)
    return { success: false, error: 'Unable to cancel login' }
  }
}

export async function refreshToken(sourceId: unknown): Promise<RpcResponse<void>> {
  if (!isAuthRequestString(sourceId)) return rejectInvalid('refresh-token')
  try {
    const result = await getAISourceManager().ensureValidToken(sourceId)
    return { success: result.success, error: result.error }
  } catch (error) {
    console.error(`[Auth] Refresh token threw: source=${sourceId} (${errorKind(error)})`)
    return { success: false, error: 'Unable to refresh authentication' }
  }
}

export async function checkToken(
  sourceId: unknown
): Promise<RpcResponse<{ valid: boolean; needsRefresh?: boolean; reason?: string }>> {
  if (!isAuthRequestString(sourceId)) return rejectInvalid('check-token')
  try {
    const result = await getAISourceManager().ensureValidToken(sourceId)
    return {
      success: true,
      data: result.success ? { valid: true, needsRefresh: false } : { valid: false, reason: result.error }
    }
  } catch (error) {
    console.error(`[Auth] Check token threw: source=${sourceId} (${errorKind(error)})`)
    return { success: false, error: 'Unable to check authentication' }
  }
}

export async function logout(sourceId: unknown): Promise<RpcResponse<void>> {
  if (!isAuthRequestString(sourceId)) return rejectInvalid('logout')
  try {
    const result = await getAISourceManager().logout(sourceId)
    return { success: result.success, error: result.error }
  } catch (error) {
    console.error(`[Auth] Logout threw: source=${sourceId} (${errorKind(error)})`)
    return { success: false, error: 'Unable to sign out' }
  }
}
