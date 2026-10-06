/**
 * Auth IPC Handlers (v2)
 *
 * Generic authentication handlers that work with any OAuth provider.
 * Provider types are configured in product.json and loaded dynamically.
 *
 * Channels:
 * - auth:start-login (providerType, sourceId?) - Add or reauthenticate an OAuth account
 * - auth:open-login-window (providerType, loginId) - Open the manager-owned redirect flow
 * - auth:complete-login (providerType, stateOrCode, loginId) - Complete OAuth login
 * - auth:cancel-login (providerType, loginId) - Cancel only the owned pending login
 * - auth:refresh-token (sourceId) - Refresh token for a source (by ID)
 * - auth:check-token (sourceId) - Check token status (by ID)
 * - auth:logout (sourceId) - Logout from a source (by ID)
 * - auth:get-providers - Get list of available auth providers
 * - auth:get-builtin-providers - Get list of built-in providers
 * - auth:get-quota (sourceId) - Report metered quota for a source (by ID)
 * - auth:delegated-status - Login state of the bundled CLI's credential slot
 * - auth:delegated-activate - Create/refresh the delegated source after login
 */

import { BrowserWindow, nativeTheme } from 'electron'
import { randomUUID } from 'crypto'
import { getAISourceManager, getEnabledAuthProviderConfigs } from '../services/ai-sources'
import { BUILTIN_PROVIDERS } from '../../shared/constants'
import { buildLoginLoadingPage, buildLoginErrorPage, loginPageBg } from '../services/browser-login-pages'
import { readCliAuthState } from '../services/agent/cli-auth'
import { buildCliLoginCommand } from '../services/agent/sdk-config'
import type { OAuthCompleteResult, ProviderId } from '../../shared/types'
import type { RpcHandlers, RpcResponse } from '../../shared/rpc/define'
import * as authController from '../controllers/auth.controller'
import { authRpc } from '../../shared/rpc/contracts/auth.contract'
import { registerRawRpcHandlers } from './rpc'

/** Timeout for OAuth redirect window (10 minutes) */
const LOGIN_WINDOW_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Register all authentication IPC handlers
 */
export function registerAuthHandlers(): void {
  const manager = getAISourceManager()

  const loginWindows = new Map<string, () => void>()
  const loginWindowResults = new Map<string, Promise<RpcResponse<OAuthCompleteResult>>>()

  const handlers: RpcHandlers<typeof authRpc> = {
    /**
     * Get list of available authentication providers (OAuth)
     */
    authGetProviders: async () => {
      try {
        const providers = getEnabledAuthProviderConfigs()
        return { success: true, data: providers }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Auth IPC] Get providers error:', err)
        return { success: false, error: err.message }
      }
    },

    /**
     * Get list of built-in providers (for UI display)
     */
    authGetBuiltinProviders: async () => {
      try {
        return { success: true, data: BUILTIN_PROVIDERS }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Auth IPC] Get builtin providers error:', err)
        return { success: false, error: err.message }
      }
    },

    authStartLogin: (providerType: ProviderId, sourceId?: string) =>
      authController.startLogin(providerType, sourceId),

    authOpenLoginWindow: async (providerType: ProviderId, loginId: string) => {
      try {
        const context = typeof loginId === 'string' && loginId
          ? manager.getOAuthLoginContext(providerType, loginId)
          : null
        if (!context || context.loginId !== loginId || !context.redirectUri) {
          console.warn(`[Auth IPC] Rejected login window for ${providerType}: no matching redirect flow`)
          return { success: false, error: 'No active redirect login. Please start login again.' }
        }
        const existing = loginWindowResults.get(loginId)
        if (existing) return existing

        const loginUrl = new URL(context.loginUrl)
        const redirectUrl = new URL(context.redirectUri)
        if (!['http:', 'https:'].includes(loginUrl.protocol) || !['http:', 'https:'].includes(redirectUrl.protocol)) {
          console.warn(`[Auth IPC] Rejected login window for ${providerType}: invalid URL protocol`)
          return { success: false, error: 'Invalid login URL' }
        }

        const result = new Promise<RpcResponse<OAuthCompleteResult>>((resolve) => {
          const mainWindow = BrowserWindow.getAllWindows().find(window => !window.isDestroyed())
          const isDark = nativeTheme.shouldUseDarkColors
          const title = manager.getProvider(providerType)?.displayName || providerType
          const loginWindow = new BrowserWindow({
            width: 520,
            height: 680,
            show: false,
            modal: false,
            parent: mainWindow,
            backgroundColor: loginPageBg(isDark),
            title,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              partition: `oauth-${randomUUID()}`,
            }
          })

          const loginSession = loginWindow.webContents.session
          let settled = false
          let completing = false
          let cancelling = false
          const finish = (result: RpcResponse<OAuthCompleteResult>) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            loginWindows.delete(loginId)
            void loginSession.clearStorageData().catch(() => {
              console.warn(`[Auth IPC] Could not clear ephemeral login storage for ${providerType}`)
            })
            resolve(result)
            if (!loginWindow.isDestroyed()) loginWindow.close()
          }
          const cancel = async (error: string) => {
            if (settled || cancelling) return
            cancelling = true
            completing = true
            clearTimeout(timeout)
            if (!loginWindow.isDestroyed()) loginWindow.close()
            try {
              const result = await manager.cancelOAuthLogin(providerType, loginId)
              if (!result.success) console.warn(`[Auth IPC] Window cancellation failed for ${providerType}`)
            } catch {
              console.error(`[Auth IPC] Window cancellation threw for ${providerType}`)
            }
            finish({ success: false, error })
          }
          const timeout = setTimeout(() => {
            console.warn(`[Auth IPC] Login window timed out for ${providerType}`)
            void cancel('Login timed out')
          }, LOGIN_WINDOW_TIMEOUT_MS)
          loginWindows.set(loginId, () => finish({ success: false, error: 'Login cancelled' }))

          const handleRedirect = (url: string): boolean => {
            let parsed: URL
            try {
              parsed = new URL(url)
            } catch {
              return false
            }
            if (parsed.origin !== redirectUrl.origin || parsed.pathname !== redirectUrl.pathname) return false
            if (settled || completing) return true

            const code = parsed.searchParams.get('code')
            const queryState = parsed.searchParams.get('state')
            const codeState = code?.split('#')[1]
            const callbackState = queryState ?? codeState ?? (parsed.hash ? parsed.hash.slice(1) : undefined)
            if (!code || (context.state && callbackState !== context.state) || (queryState && codeState && queryState !== codeState)) {
              console.warn(`[Auth IPC] Rejected OAuth callback for ${providerType}: ${code ? 'state mismatch' : 'missing code'}`)
              void cancel(code ? 'Invalid OAuth state' : 'No authorization code in callback')
              return true
            }

            // Mark completion before closing: Electron emits closed synchronously.
            completing = true
            if (!loginWindow.isDestroyed()) loginWindow.close()
            const stateOrCode = callbackState && !code.includes('#') ? `${code}#${callbackState}` : code
            void authController.completeLogin(providerType, stateOrCode, loginId)
              .then(result => {
                if (!cancelling) finish(result)
              })
              .catch(() => {
                console.error(`[Auth IPC] OAuth window completion threw for ${providerType}`)
                void cancel('Login failed')
              })
            return true
          }

          loginWindow.webContents.on('will-redirect', (event, url) => {
            if (handleRedirect(url)) event.preventDefault()
          })
          loginWindow.webContents.on('will-navigate', (event, url) => {
            if (handleRedirect(url)) event.preventDefault()
          })
          loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
          loginWindow.on('closed', () => {
            if (settled || completing) return
            console.info(`[Auth IPC] Login window closed by user for ${providerType}`)
            void cancel('Login window closed')
          })
          loginWindow.once('ready-to-show', () => {
            if (settled || completing || loginWindow.isDestroyed()) return
            loginWindow.show()
            void loginWindow.loadURL(context.loginUrl).catch(() => {
              if (settled || completing || loginWindow.isDestroyed()) return
              console.warn(`[Auth IPC] Failed to load login page for ${providerType}`)
              void loginWindow.loadURL(buildLoginErrorPage(context.loginUrl, 'Unable to load login page', isDark)).catch(() => {
                if (settled || completing) return
                console.error(`[Auth IPC] Failed to load login error page for ${providerType}`)
                void cancel('Unable to load login page')
              })
            })
          })
          void loginWindow.loadURL(buildLoginLoadingPage(context.loginUrl, title, isDark)).catch(() => {
            if (settled || completing) return
            console.error(`[Auth IPC] Failed to load login loading page for ${providerType}`)
            void cancel('Unable to load login page')
          })
        })
        loginWindowResults.set(loginId, result)
        try { return await result }
        finally { if (loginWindowResults.get(loginId) === result) loginWindowResults.delete(loginId) }
      } catch {
        console.error(`[Auth IPC] Could not open login window for ${providerType}`)
        return { success: false, error: 'Unable to open login window' }
      }
    },

    authCompleteLogin: (providerType: ProviderId, stateOrCode: string, loginId: string) =>
      authController.completeLogin(providerType, stateOrCode, loginId),

    authCancelLogin: async (providerType: ProviderId, loginId: string) => {
      const result = await authController.cancelLogin(providerType, loginId)
      if (result.success) loginWindows.get(loginId)?.()
      return result
    },

    authRefreshToken: (sourceId: string) => authController.refreshToken(sourceId),

    authCheckToken: (sourceId: string) => authController.checkToken(sourceId),

    authLogout: (sourceId: string) => authController.logout(sourceId),

    /**
     * Report the current metered quota for a source. Returns
     * { success: true, data: null } when the provider has no quota concept.
     */
    authGetQuota: async (sourceId: string) => {
      try {
        return await manager.getSourceQuota(sourceId)
      } catch (error: unknown) {
        const err = error as Error
        console.error(`[Auth IPC] Get quota error for ${sourceId}:`, err)
        return { success: false, error: err.message }
      }
    },

    /**
     * Login state of the bundled CLI's credential slot, with the command that
     * signs it in. `supported` is false where the credential store layout is
     * unverified, which is also where the source is not registered.
     */
    authDelegatedStatus: async () => {
      try {
        const supported = process.platform === 'darwin'
        const state = readCliAuthState()
        return {
          success: true,
          data: {
            supported,
            loggedIn: state.loggedIn,
            account: state.account,
            configDir: state.configDir,
            loginCommand: supported ? buildCliLoginCommand() : ''
          }
        }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Auth IPC] Delegated status error:', err)
        return { success: false, error: err.message }
      }
    },

    /**
     * Turn a completed CLI login into a usable source. Verifies the slot first:
     * the renderer polls this after the user runs the login command, and a
     * source created before the login lands would fail on its first turn.
     */
    authDelegatedActivate: async () => {
      try {
        const state = readCliAuthState()
        if (!state.loggedIn) {
          return { success: false, error: 'Claude Code CLI is not signed in yet' }
        }
        const source = manager.upsertDelegatedSource(state.account)
        return { success: true, data: { sourceId: source.id, account: state.account } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Auth IPC] Delegated activate error:', err)
        return { success: false, error: err.message }
      }
    },
  }
  registerRawRpcHandlers(authRpc, handlers)

  console.log('[Auth IPC] Registered auth handlers')
}
