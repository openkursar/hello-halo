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
  onEvent,
  setAuthToken,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'

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

  authStartLogin: async (providerType: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authStartLogin(providerType)
    }
    return httpRequest('POST', '/api/auth/start-login', { providerType })
  },

  authOpenLoginWindow: async (providerType: string, loginUrl: string, redirectUri: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authOpenLoginWindow(providerType, loginUrl, redirectUri)
    }
    // Web mode: not supported, fall back to completing with URL
    return { success: false, error: 'Login window not supported in web mode' }
  },

  authCompleteLogin: async (providerType: string, state: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authCompleteLogin(providerType, state)
    }
    return httpRequest('POST', '/api/auth/complete-login', { providerType, state })
  },

  authRefreshToken: async (providerType: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authRefreshToken(providerType)
    }
    return httpRequest('POST', '/api/auth/refresh-token', { providerType })
  },

  authCheckToken: async (providerType: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authCheckToken(providerType)
    }
    return httpRequest('GET', `/api/auth/check-token?providerType=${providerType}`)
  },

  authLogout: async (providerType: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.authLogout(providerType)
    }
    return httpRequest('POST', '/api/auth/logout', { providerType })
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

  onAuthLoginProgress: (callback: (data: { provider: string; status: string }) => void) =>
    onEvent('auth:login-progress', callback),

}
