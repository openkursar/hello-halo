/**
 * authApi — auth domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  clearAuthToken,
  connectWebSocket,
  disconnectWebSocket,
  getAuthToken,
  httpRequest,
  isCapacitor,
  isElectron,
  setAuthToken,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'
import type { OAuthCompleteResult } from '../../shared/types/ai-sources'
import type { OAuthLoginStart } from '../../shared/rpc/contracts/auth.contract'

export const authApi = {
  // ===== Authentication (remote only) =====
  isRemoteMode: () => !isElectron(),
  isCapacitorMode: () => isCapacitor(),
  isAuthenticated: () => !!getAuthToken(),

  login: async (token: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return { success: true }
    }

    const result = await httpRequest<void>('POST', '/api/remote/login', { token })
    if (result.success) {
      setAuthToken(token)
      connectWebSocket()
    }
    return result
  },

  logout: () => {
    clearAuthToken()
    disconnectWebSocket()
  },

  // ===== Generic Auth (provider-agnostic) =====
  authGetProviders: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authGetProviders()
    }
    return httpRequest('GET', '/api/auth/providers')
  },

  authStartLogin: async (providerType: string, sourceId?: string): Promise<ApiResponse<OAuthLoginStart>> => {
    if (isElectron()) {
      return window.halo.authStartLogin(providerType, sourceId)
    }
    return httpRequest('POST', '/api/auth/start-login', { providerType, sourceId })
  },

  authOpenLoginWindow: async (providerType: string, loginId: string): Promise<ApiResponse<OAuthCompleteResult>> => {
    if (isElectron()) {
      return window.halo.authOpenLoginWindow(providerType, loginId)
    }
    return { success: false, error: 'Login window not supported in web mode' }
  },

  authCompleteLogin: async (providerType: string, stateOrCode: string, loginId: string): Promise<ApiResponse<OAuthCompleteResult>> => {
    if (isElectron()) {
      return window.halo.authCompleteLogin(providerType, stateOrCode, loginId)
    }
    return httpRequest('POST', '/api/auth/complete-login', { providerType, state: stateOrCode, loginId })
  },

  authCancelLogin: async (providerType: string, loginId: string): Promise<ApiResponse<void>> => {
    if (isElectron()) {
      return window.halo.authCancelLogin(providerType, loginId)
    }
    return httpRequest('POST', '/api/auth/cancel-login', { providerType, loginId })
  },

  authRefreshToken: async (sourceId: string): Promise<ApiResponse<void>> => {
    if (isElectron()) {
      return window.halo.authRefreshToken(sourceId)
    }
    return httpRequest('POST', '/api/auth/refresh-token', { sourceId })
  },

  authCheckToken: async (sourceId: string): Promise<ApiResponse<{ valid: boolean; needsRefresh?: boolean; reason?: string }>> => {
    if (isElectron()) {
      return window.halo.authCheckToken(sourceId)
    }
    return httpRequest('GET', `/api/auth/check-token?sourceId=${encodeURIComponent(sourceId)}`)
  },

  authLogout: async (sourceId: string): Promise<ApiResponse<void>> => {
    if (isElectron()) {
      return window.halo.authLogout(sourceId)
    }
    return httpRequest('POST', '/api/auth/logout', { sourceId })
  },

  /**
   * Report the current metered quota for a source. Desktop-only for now: no HTTP
   * route is exposed yet, so non-Electron transports report "unsupported"
   * (data: null) rather than 404-ing. The capability itself runs in the main
   * process and is reachable over HTTP — add a route here when remote clients
   * need quota.
   */
  authGetQuota: async (sourceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authGetQuota(sourceId)
    }
    return { success: true, data: null }
  },

  /**
   * Login state of the bundled CLI's credential slot, plus the command that
   * signs it in. Desktop-only: the login runs in a local terminal session, so
   * remote clients report "not signed in" rather than offering a flow they
   * cannot complete.
   */
  authDelegatedStatus: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authDelegatedStatus()
    }
    return { success: true, data: { loggedIn: false, account: '', loginCommand: '', supported: false } }
  },

  authDelegatedActivate: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authDelegatedActivate()
    }
    return { success: false, error: 'Delegated login requires the desktop app' }
  },

}
