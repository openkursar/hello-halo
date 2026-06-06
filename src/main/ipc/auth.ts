/**
 * Auth IPC Handlers (v2)
 *
 * Generic authentication handlers that work with any OAuth provider.
 * Provider types are configured in product.json and loaded dynamically.
 *
 * Channels:
 * - auth:start-login (providerType) - Start OAuth login for a provider
 * - auth:open-login-window (providerType, loginUrl, redirectUri) - Open BrowserWindow for redirect OAuth (PKCE)
 * - auth:complete-login (providerType, state) - Complete OAuth login
 * - auth:refresh-token (sourceId) - Refresh token for a source (by ID)
 * - auth:check-token (sourceId) - Check token status (by ID)
 * - auth:logout (sourceId) - Logout from a source (by ID)
 * - auth:get-providers - Get list of available auth providers
 * - auth:get-builtin-providers - Get list of built-in providers
 */

import { BrowserWindow, nativeTheme, session } from 'electron'
import { getAISourceManager, getEnabledAuthProviderConfigs } from '../services/ai-sources'
import { BUILTIN_PROVIDERS } from '../../shared/constants'
import { buildLoginLoadingPage, buildLoginErrorPage, loginPageBg } from '../services/browser-login-pages'
import type { ProviderId } from '../../shared/types'
import { authRpc } from '../../shared/rpc/contracts/auth.contract'
import { registerRawRpcHandlers } from './rpc'

/** Timeout for OAuth redirect window (10 minutes) */
const LOGIN_WINDOW_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Register all authentication IPC handlers
 */
export function registerAuthHandlers(): void {
  const manager = getAISourceManager()

  registerRawRpcHandlers(authRpc, {
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

    /**
     * Start OAuth login flow for a provider
     */
    authStartLogin: async (providerType: ProviderId) => {
      try {
        console.log(`[Auth IPC] Starting login for provider: ${providerType}`)
        const result = await manager.startOAuthLogin(providerType)
        return result
      } catch (error: unknown) {
        const err = error as Error
        console.error(`[Auth IPC] Start login error for ${providerType}:`, err)
        return { success: false, error: err.message }
      }
    },

    /**
     * Open a BrowserWindow for standard redirect OAuth (PKCE flow).
     * Used by Claude OAuth — intercepts the callback redirect to extract the code
     * and automatically completes the login flow.
     *
     * Flow:
     * 1. Open BrowserWindow pointing to loginUrl
     * 2. Monitor will-redirect / will-navigate events for the redirectUri
     * 3. Extract code from redirect URL query params
     * 4. Call manager.completeOAuthLogin(providerType, code)
     * 5. Close window and return result
     */
    authOpenLoginWindow: async (providerType: ProviderId, loginUrl: string, redirectUri: string) => {
      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        const mainWindow = BrowserWindow.getAllWindows()[0]
        const isDark = nativeTheme.shouldUseDarkColors

        console.log(`[Auth IPC] Opening login window for ${providerType}: ${loginUrl}`)

        // ── Create login BrowserWindow ──────────────────────────────────────
        const loginWindow = new BrowserWindow({
          width: 520,
          height: 680,
          show: false,
          modal: false,
          parent: mainWindow || undefined,
          backgroundColor: loginPageBg(isDark),
          title: 'Sign in to Claude',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          }
        })

        // Show loading page instantly before network request
        loginWindow.loadURL(buildLoginLoadingPage(loginUrl, 'Sign in to Claude', isDark))

        loginWindow.once('ready-to-show', () => {
          loginWindow.show()
          // Navigate to actual OAuth URL after window is visible
          loginWindow.loadURL(loginUrl).catch((err) => {
            console.error('[Auth IPC] Failed to load login URL:', err)
            loginWindow.loadURL(buildLoginErrorPage(loginUrl, String(err), isDark))
          })
        })

        // ── Timeout guard ───────────────────────────────────────────────────
        const timeout = setTimeout(() => {
          console.warn(`[Auth IPC] Login window timeout for ${providerType}`)
          if (!loginWindow.isDestroyed()) loginWindow.close()
          resolve({ success: false, error: 'Login timed out' })
        }, LOGIN_WINDOW_TIMEOUT_MS)

        const cleanup = () => {
          clearTimeout(timeout)
        }

        // ── Redirect intercept ─────────────────────────────────────────────
        /**
         * Intercept navigations to the redirectUri to extract the auth code.
         * Anthropic's redirect: https://platform.claude.com/oauth/code/callback?code=...
         * The code may contain '#' — split on '#' and use the first part as the actual code.
         */
        const handleRedirect = (url: string): boolean => {
          if (!url.startsWith(redirectUri)) return false

          console.log(`[Auth IPC] OAuth redirect intercepted for ${providerType}`)

          try {
            const parsed = new URL(url)
            const code = parsed.searchParams.get('code')

            if (!code) {
              console.error('[Auth IPC] No code in redirect URL')
              cleanup()
              if (!loginWindow.isDestroyed()) loginWindow.close()
              resolve({ success: false, error: 'No authorization code in callback' })
              return true
            }

            // Close window immediately — user doesn't need to see the callback page
            if (!loginWindow.isDestroyed()) loginWindow.close()

            // Complete login with the code (async, don't block the event handler)
            manager.completeOAuthLogin(providerType, code)
              .then((result) => {
                cleanup()
                if (result.success) {
                  // Notify renderer of completion
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('auth:login-progress', {
                      provider: providerType,
                      status: 'completed'
                    })
                  }
                  resolve({ success: true })
                } else {
                  resolve({ success: false, error: result.error || 'Login failed' })
                }
              })
              .catch((err) => {
                cleanup()
                resolve({ success: false, error: String(err) })
              })

          } catch (err) {
            console.error('[Auth IPC] Error parsing redirect URL:', err)
            cleanup()
            if (!loginWindow.isDestroyed()) loginWindow.close()
            resolve({ success: false, error: String(err) })
          }

          return true
        }

        // Monitor both will-redirect (server redirects) and will-navigate (JS navigation)
        loginWindow.webContents.on('will-redirect', (_e, url) => {
          if (handleRedirect(url)) {
            // Prevent Electron from actually navigating to the callback URL
            _e.preventDefault()
          }
        })

        loginWindow.webContents.on('will-navigate', (_e, url) => {
          if (handleRedirect(url)) {
            _e.preventDefault()
          }
        })

        // ── Window closed by user ──────────────────────────────────────────
        loginWindow.on('closed', () => {
          cleanup()
          // Only resolve if not already resolved by redirect handler
          resolve({ success: false, error: 'Login window closed' })
        })
      })
    },

    /**
     * Complete OAuth login flow for a provider
     */
    authCompleteLogin: async (providerType: ProviderId, state: string) => {
      try {
        console.log(`[Auth IPC] Completing login for provider: ${providerType}`)
        const mainWindow = BrowserWindow.getAllWindows()[0]

        // The manager's completeOAuthLogin handles everything including config save
        const result = await manager.completeOAuthLogin(providerType, state)

        // Send progress update on completion
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (result.success) {
            mainWindow.webContents.send('auth:login-progress', {
              provider: providerType,
              status: 'completed'
            })
          }
        }

        return result
      } catch (error: unknown) {
        const err = error as Error
        console.error(`[Auth IPC] Complete login error for ${providerType}:`, err)
        return { success: false, error: err.message }
      }
    },

    /**
     * Refresh token for a source (by source ID)
     */
    authRefreshToken: async (sourceId: string) => {
      try {
        const result = await manager.ensureValidToken(sourceId)
        return result
      } catch (error: unknown) {
        const err = error as Error
        console.error(`[Auth IPC] Refresh token error for ${sourceId}:`, err)
        return { success: false, error: err.message }
      }
    },

    /**
     * Check token status for a source (by source ID)
     */
    authCheckToken: async (sourceId: string) => {
      try {
        const result = await manager.ensureValidToken(sourceId)
        if (result.success) {
          return { success: true, data: { valid: true, needsRefresh: false } }
        } else {
          return { success: true, data: { valid: false, reason: result.error } }
        }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    /**
     * Logout from a source (by source ID)
     */
    authLogout: async (sourceId: string) => {
      try {
        const result = await manager.logout(sourceId)
        return result
      } catch (error: unknown) {
        const err = error as Error
        console.error(`[Auth IPC] Logout error for ${sourceId}:`, err)
        return { success: false, error: err.message }
      }
    },
  })

  console.log('[Auth IPC] Registered auth handlers')
}
