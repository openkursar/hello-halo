/**
 * Claude OAuth Provider
 *
 * OAuth 2.0 Authorization Code with PKCE (RFC 7636) for Claude Pro/Max.
 *
 * Flow:
 * 1. Generate PKCE code_verifier + code_challenge (S256)
 * 2. Open BrowserWindow to the authorize endpoint
 * 3. User logs in → redirected to callback with `code`
 * 4. Exchange code for access_token + refresh_token
 * 5. Use Bearer token for API calls with required headers
 *
 * Notes:
 * - The authorization code returned by the server may carry the state via
 *   '#' separator → split on '#' before exchange
 * - `anthropic-beta` is computed per model (see buildBetaHeaders)
 * - Authentication uses Authorization: Bearer (no x-api-key)
 * - User-Agent is not set here. The downstream HTTP layer already emits a
 *   canonical UA; setting it here once produced a duplicate value at the
 *   undici layer (case-insensitive merge of `User-Agent` + `user-agent`).
 * - The /v1/messages URL deliberately omits ?beta=true; the SDK appends it
 *   itself and the router forwards it through.
 */

import { randomBytes, createHash, randomUUID } from 'crypto'
import { proxyFetch } from '../../proxy-fetch'
import type {
  OAuthAISourceProvider,
  ProviderResult
} from '../../../../shared/interfaces'
import type {
  AISourceType,
  AISourcesConfig,
  BackendRequestConfig,
  OAuthSourceConfig,
  OAuthStartResult,
  OAuthCompleteResult,
  AISourceUserInfo
} from '../../../../shared/types'
import { DEFAULT_MODEL, resolveModelId } from '../../../../shared/types'
import { CLAUDE_SUBSCRIPTION_MODELS } from '../../../../shared/constants/claude-models'

// ============================================================================
// Constants
// ============================================================================

/** OAuth client_id for the bundled Claude Code CLI (production). */
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/** OAuth endpoints (canonical platform.claude.com / claude.com hosts). */
const CLAUDE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLAUDE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'

/**
 * OAuth scopes.
 *
 * - `CLAUDE_AI_OAUTH_SCOPES` — Claude Pro/Max inference scopes. Used on token
 *   refresh, which narrows the token by dropping `org:create_api_key`.
 *
 * - `CLAUDE_AUTHORIZE_SCOPES` — the superset sent at the initial authorize
 *   request. Sending a smaller subset would cause server-side feature gates
 *   (sessions, MCP, file upload) to fail.
 */
const CLAUDE_AI_OAUTH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]
const CLAUDE_AUTHORIZE_SCOPES = ['org:create_api_key', ...CLAUDE_AI_OAUTH_SCOPES].join(' ')

/** API endpoint */
const CLAUDE_API_BASE = 'https://api.anthropic.com'

/** Token refresh threshold — refresh 5 minutes before expiry */
const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000
const TOKEN_REQUEST_TIMEOUT_MS = 15_000
const PROFILE_TIMEOUT_MS = 10_000
const CLAUDE_PROFILE_URL = `${CLAUDE_API_BASE}/api/oauth/profile`

// ============================================================================
// Model Catalog
// ============================================================================

const CLAUDE_MODELS = CLAUDE_SUBSCRIPTION_MODELS

// ============================================================================
// Beta Header Builder
// ============================================================================

/**
 * Build the anthropic-beta header value for a given model.
 *
 * Runtime profile assumed:
 *   - first-party Anthropic API
 *   - OAuth subscriber (Pro/Max)
 *   - claude-4+ / claude-5 models
 *   - agentic workload (multi-turn tool use)
 *
 * Under that profile the betas below apply unconditionally; 1M context is
 * gated on the [1m] suffix.
 */
function buildBetaHeaders(model: string, is1mContext: boolean): string[] {
  const betas = [
    // Required by the OAuth API gateway for subscriber tokens.
    'oauth-2025-04-20',
    // Thinking-block preservation across turns.
    'context-management-2025-06-27',
    // Global-scope prompt cache (no-op without cache_control fields).
    'prompt-caching-scope-2026-01-05',
    // Interleaved thinking.
    'interleaved-thinking-2025-05-14',
    // Agentic-workload marker.
    'claude-code-20250219',
  ]

  // 1M context window — only for [1m] model variants.
  if (is1mContext) {
    betas.push('context-1m-2025-08-07')
  }

  return betas
}

// ============================================================================
// PKCE Implementation (replaces @openauthjs/openauth/pkce dependency)
// ============================================================================

/**
 * Generate PKCE code_verifier and code_challenge (S256).
 * Follows RFC 7636 specification.
 */
function generatePKCE(): { verifier: string; challenge: string } {
  // Generate 32 bytes of random data for code_verifier (43-128 chars in base64url)
  const verifier = randomBytes(32)
    .toString('base64url')

  // S256: SHA-256 hash of verifier, base64url-encoded
  const challenge = createHash('sha256')
    .update(verifier)
    .digest('base64url')

  return { verifier, challenge }
}

// ============================================================================
// Module-level State
// ============================================================================

interface PendingClaudeAuth {
  /** PKCE code_verifier — needed for token exchange */
  verifier: string
  /** OAuth state — independent from verifier, echoed back by the server */
  state: string
  /** The full authorize URL opened in the browser */
  authorizeUrl: string
  /** Timestamp when this auth request was created */
  createdAt: number
}

interface ClaudeTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  account?: { uuid?: string; email_address?: string }
}

interface ClaudeProfile {
  account?: { uuid?: string; email?: string; display_name?: string }
}

// ============================================================================
// Claude OAuth Provider Implementation
// ============================================================================

class ClaudeProvider implements OAuthAISourceProvider {
  readonly type: AISourceType = 'claude'
  readonly displayName = 'Claude'

  private pendingAuth: PendingClaudeAuth | null = null

  private conf(config: AISourcesConfig): OAuthSourceConfig | undefined {
    return (config as unknown as Record<string, OAuthSourceConfig | undefined>)['claude']
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  isConfigured(config: AISourcesConfig): boolean {
    const c = this.conf(config)
    return !!(c?.loggedIn && c?.accessToken)
  }

  /**
   * Build the BackendRequestConfig for each outgoing API request.
   *
   * Headers set here:
   * - Authorization: Bearer <access_token>
   * - anthropic-beta — per-model, see buildBetaHeaders(). The router merges
   *   this with any anthropic-beta from the SDK layer (deduplicated).
   * - x-client-request-id — fresh UUID per request. The downstream HTTP layer
   *   skips emitting this header when the base URL is not first-party, so
   *   this provider is the sole emitter and there is no duplication.
   *
   * Headers intentionally NOT set:
   * - user-agent / User-Agent — owned by the downstream HTTP layer. Setting
   *   it here once produced a `User-Agent: X, X` duplicate at the undici
   *   layer (case-insensitive merge of `User-Agent` and `user-agent`).
   *
   * URL: plain `/v1/messages`. The SDK appends `?beta=true` itself and the
   * router forwards the query string through.
   */
  getBackendConfig(config: AISourcesConfig): BackendRequestConfig | null {
    const c = this.conf(config)
    if (!c?.loggedIn || !c?.accessToken) {
      return null
    }

    const rawModel = resolveModelId(c.model)
    const is1mContext = /\[1m\]$/i.test(rawModel)
    // Preserve the [1m] suffix on the propagated model id. The embedded
    // Claude SDK relies on this suffix for its internal has1mContext() /
    // getContextWindowForModel() detection — without it, the SDK's local
    // context window stays at the 200K default and auto-compact triggers
    // long before the 1M wire window is exhausted.
    //
    // [1m] is stripped at the wire boundary inside the anthropic_passthrough
    // handler (openai-compat-router/server/request-handler.ts) before the
    // request body is forwarded to the Anthropic API, which only accepts
    // canonical model ids.
    const model = rawModel

    const betas = buildBetaHeaders(model, is1mContext)

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${c.accessToken}`,
      // Web Headers API serializes array-valued headers as ', '-joined.
      'anthropic-beta': betas.join(', '),
      'x-client-request-id': randomUUID()
    }

    const url = `${CLAUDE_API_BASE}/v1/messages`

    return {
      sourceId: c.sourceId,
      url,
      key: c.accessToken,
      model,
      headers,
      apiType: 'anthropic_passthrough'
    }
  }

  getCurrentModel(config: AISourcesConfig): string | null {
    const c = this.conf(config)
    return c?.model || null
  }

  // ── Available Models ────────────────────────────────────────────────────────

  async getAvailableModels(_config: AISourcesConfig): Promise<string[]> {
    return Object.keys(CLAUDE_MODELS)
  }

  getUserInfo(config: AISourcesConfig): AISourceUserInfo | null {
    const c = this.conf(config)
    return c?.user || null
  }

  // ── OAuth PKCE Flow ────────────────────────────────────────────────────────

  /**
   * Start the OAuth login flow.
   * Generates PKCE challenge and returns the authorize URL for the BrowserWindow.
   *
   * Authorize params: code=true, client_id, response_type=code, redirect_uri,
   * scope, code_challenge, code_challenge_method=S256, state.
   *
   * `state` is generated as an independent 32-byte random value (RFC 6749 §10.12
   * — CSRF protection). It MUST NOT be derived from `code_verifier`: a fixed
   * relationship between the two values is observable across logins.
   *
   * The redirectUri is returned so the renderer can hand it to the
   * `auth:open-login-window` IPC without duplicating the constant.
   */
  async startLogin(): Promise<ProviderResult<OAuthStartResult>> {
    try {
      console.log('[Claude] Starting OAuth PKCE flow')

      const pkce = generatePKCE()
      // Independent CSRF state — see docstring; must not reuse pkce.verifier.
      const state = randomBytes(32).toString('base64url')

      const url = new URL(CLAUDE_AUTHORIZE_URL)
      url.searchParams.set('code', 'true')
      url.searchParams.set('client_id', CLAUDE_CLIENT_ID)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('redirect_uri', CLAUDE_REDIRECT_URI)
      url.searchParams.set('scope', CLAUDE_AUTHORIZE_SCOPES)
      url.searchParams.set('code_challenge', pkce.challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('state', state)

      const authorizeUrl = url.toString()

      this.pendingAuth = {
        verifier: pkce.verifier,
        state,
        authorizeUrl,
        createdAt: Date.now()
      }

      console.log('[Claude] OAuth authorize URL generated')

      return {
        success: true,
        data: {
          loginUrl: authorizeUrl,
          state,
          redirectUri: CLAUDE_REDIRECT_URI
        }
      }
    } catch (error) {
      console.error('[Claude] Start login error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start login'
      }
    }
  }

  /**
   * Complete the OAuth login flow.
   * The `state` parameter here actually carries the callback string —
   * `code[#state]` — pasted by the user (or read from the redirect URL).
   *
   * Token exchange:
   * - POST to CLAUDE_TOKEN_URL with JSON body
   * - Split on '#': splits[0] = authorization code, splits[1] = echoed state
   * - Body field order: grant_type, code, redirect_uri, client_id,
   *   code_verifier, state.
   */
  async completeLogin(state: string): Promise<ProviderResult<OAuthCompleteResult>> {
    const pending = this.pendingAuth
    if (!pending) {
      console.warn('[Claude] Login completion rejected: no pending authentication')
      return { success: false, error: 'No pending authentication' }
    }

    const parts = state.trim().split('#')
    if (!parts[0] || parts.length > 2 || (parts.length === 2 && parts[1] !== pending.state)) {
      console.warn('[Claude] Login completion rejected: invalid callback or state mismatch')
      return { success: false, error: 'Authentication state mismatch or missing code' }
    }

    try {
      const response = await proxyFetch(CLAUDE_TOKEN_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: parts[0],
          redirect_uri: CLAUDE_REDIRECT_URI,
          client_id: CLAUDE_CLIENT_ID,
          code_verifier: pending.verifier,
          state: pending.state
        })
      })

      if (!response.ok) {
        console.error('[Claude] Token exchange failed:', response.status)
        return { success: false, error: `Token exchange failed: ${response.status}` }
      }

      const json = await response.json() as ClaudeTokenResponse
      if (typeof json.access_token !== 'string' || !json.access_token ||
          !Number.isFinite(json.expires_in) || json.expires_in <= 0) {
        console.warn('[Claude] Token exchange rejected: missing token or invalid expiry')
        return { success: false, error: 'Invalid token response' }
      }

      if (this.pendingAuth !== pending) {
        console.warn('[Claude] Token exchange discarded: authorization cancelled or replaced')
        return { success: false, error: 'Authentication cancelled' }
      }
      const user = await this.resolveUser(json)
      if (this.pendingAuth !== pending) {
        console.warn('[Claude] Login completion discarded: authorization cancelled or replaced')
        return { success: false, error: 'Authentication cancelled' }
      }

      const result: OAuthCompleteResult & {
        _tokenData: { accessToken: string; refreshToken: string; expiresAt: number; uid: string }
        _availableModels: string[]
        _modelNames: Record<string, string>
        _defaultModel: string
      } = {
        success: true,
        user,
        _tokenData: {
          accessToken: json.access_token,
          refreshToken: json.refresh_token || '',
          expiresAt: Date.now() + json.expires_in * 1000,
          uid: user.uid || ''
        },
        _availableModels: Object.keys(CLAUDE_MODELS),
        _modelNames: CLAUDE_MODELS,
        _defaultModel: DEFAULT_MODEL
      }

      console.log('[Claude] OAuth login completed')
      return { success: true, data: result }
    } catch (error) {
      console.error('[Claude] Complete login error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to complete login'
      }
    } finally {
      if (this.pendingAuth === pending) this.pendingAuth = null
    }
  }

  private async resolveUser(tokens: ClaudeTokenResponse): Promise<AISourceUserInfo> {
    let uid = tokens.account?.uuid?.trim() || ''
    let name = tokens.account?.email_address?.trim() || ''
    if (!uid || !name) {
      const profile = await this.fetchProfile(tokens.access_token)
      const profileUid = profile?.account?.uuid?.trim() || ''
      if (uid && profileUid && uid !== profileUid) {
        console.warn('[Claude] Profile enrichment ignored: token and profile accounts differ')
      } else if (profile) {
        uid ||= profileUid
        name ||= profile.account?.email?.trim() || profile.account?.display_name?.trim() || ''
      }
    }
    if (!uid) console.warn('[Claude] Login completed without verified account identity')
    return { name: name || 'Claude User', uid }
  }

  /** Account identity of a stored credential, for sources saved before identities were recorded. */
  async getAccountId(config: AISourcesConfig): Promise<string | null> {
    const token = this.conf(config)?.accessToken
    if (!token) return null
    const profile = await this.fetchProfile(token)
    return profile?.account?.uuid?.trim() || null
  }

  private async fetchProfile(accessToken: string): Promise<ClaudeProfile | null> {
    try {
      const response = await proxyFetch(CLAUDE_PROFILE_URL, {
        method: 'GET',
        signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      })
      if (!response.ok) {
        console.warn('[Claude] Profile unavailable:', response.status)
        return null
      }
      return await response.json() as ClaudeProfile
    } catch {
      console.warn('[Claude] Profile unavailable: request failed or timed out')
      return null
    }
  }

  async refreshToken(): Promise<ProviderResult<void>> {
    return { success: true }
  }

  async checkToken(): Promise<ProviderResult<{ valid: boolean; expiresIn?: number }>> {
    return { success: true, data: { valid: true } }
  }

  async cancelLogin(): Promise<ProviderResult<void>> {
    this.pendingAuth = null
    return { success: true }
  }

  async logout(_config?: AISourcesConfig): Promise<ProviderResult<void>> {
    return { success: true }
  }

  // ── Token Management ────────────────────────────────────────────────────────

  /**
   * Check token validity for the manager's ensureValidToken() flow.
   */
  checkTokenWithConfig(config: AISourcesConfig): { valid: boolean; expiresIn?: number; needsRefresh: boolean } {
    const c = this.conf(config)
    if (!c?.accessToken) {
      return { valid: false, needsRefresh: false }
    }

    const now = Date.now()
    const expiresAt = c.tokenExpires || 0
    const needsRefresh = expiresAt <= now + TOKEN_REFRESH_THRESHOLD_MS

    return {
      valid: true,
      expiresIn: Math.max(0, expiresAt - now),
      needsRefresh
    }
  }

  /**
   * Refresh the OAuth token using the refresh_token grant.
   *
   * - POST to CLAUDE_TOKEN_URL with JSON body
   * - Body field order: grant_type, refresh_token, client_id, scope
   * - `scope` narrows the refreshed token to inference scopes (drops
   *   `org:create_api_key`)
   * - Response: { access_token, refresh_token, expires_in }
   */
  async refreshTokenWithConfig(config: AISourcesConfig): Promise<ProviderResult<{
    accessToken: string
    refreshToken: string
    expiresAt: number
  }>> {
    const c = this.conf(config)
    const refreshToken = c?.refreshToken
    if (!refreshToken) {
      console.warn('[Claude] Token refresh rejected: no refresh token')
      return { success: false, error: 'No refresh token available' }
    }

    try {
      const response = await proxyFetch(CLAUDE_TOKEN_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: CLAUDE_CLIENT_ID,
          // Narrows from the authorize-time superset (drops org:create_api_key).
          scope: CLAUDE_AI_OAUTH_SCOPES.join(' ')
        })
      })

      if (!response.ok) {
        console.error('[Claude] Token refresh failed:', response.status)
        return {
          success: false,
          error: `Token refresh failed: ${response.status}`
        }
      }

      const json = await response.json() as ClaudeTokenResponse
      if (typeof json.access_token !== 'string' || !json.access_token ||
          !Number.isFinite(json.expires_in) || json.expires_in <= 0) {
        console.warn('[Claude] Token refresh rejected: missing token or invalid expiry')
        return { success: false, error: 'Invalid token response' }
      }

      return {
        success: true,
        data: {
          accessToken: json.access_token,
          refreshToken: json.refresh_token || refreshToken,
          expiresAt: Date.now() + json.expires_in * 1000
        }
      }
    } catch (error) {
      console.error('[Claude] Token refresh error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to refresh token'
      }
    }
  }

  async refreshConfig(config: AISourcesConfig): Promise<ProviderResult<Partial<AISourcesConfig>>> {
    const c = this.conf(config)
    if (!c?.accessToken) {
      return { success: false, error: 'Not logged in' }
    }

    try {
      const models = await this.getAvailableModels(config)
      return {
        success: true,
        data: {
          'claude': {
            ...c,
            availableModels: models,
            modelNames: CLAUDE_MODELS
          }
        } as unknown as Partial<AISourcesConfig>
      }
    } catch (error) {
      console.warn('[Claude] Model catalog refresh failed')
      return { success: false, error: String(error) }
    }
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let providerInstance: ClaudeProvider | null = null

export function getClaudeProvider(): ClaudeProvider {
  if (!providerInstance) {
    providerInstance = new ClaudeProvider()
  }
  return providerInstance
}

export { ClaudeProvider }
