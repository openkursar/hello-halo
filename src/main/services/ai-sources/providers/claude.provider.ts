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

// ============================================================================
// Model Catalog
// ============================================================================

/**
 * Claude OAuth model catalog (same models as regular Anthropic API).
 * [1m] suffix indicates 1M context window variant (stripped before API call).
 */
const CLAUDE_MODELS: Record<string, string> = {
  'claude-mythos-preview': 'Claude Mythos (Preview)',
  'claude-fable-5': 'Claude Fable 5',
  'claude-fable-5[1m]': 'Claude Fable 5 (1M context)',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-opus-4-8[1m]': 'Claude Opus 4.8 (1M context)',
  'claude-opus-4-7': 'Claude Opus 4.7',
  'claude-opus-4-7[1m]': 'Claude Opus 4.7 (1M context)',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-opus-4-6[1m]': 'Claude Opus 4.6 (1M context)',
  'claude-opus-4-5-20251101': 'Claude Opus 4.5',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-sonnet-4-6[1m]': 'Claude Sonnet 4.6 (1M context)',
  'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5'
}

// ============================================================================
// Beta Header Builder
// ============================================================================

/**
 * Build the anthropic-beta header value for a given model.
 *
 * Runtime profile assumed:
 *   - first-party Anthropic API
 *   - OAuth subscriber (Pro/Max)
 *   - claude-4+ / claude-mythos models
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

/** Current pending authorization (one at a time) */
let pendingAuth: PendingClaudeAuth | null = null

// ============================================================================
// Claude OAuth Provider Implementation
// ============================================================================

class ClaudeProvider implements OAuthAISourceProvider {
  readonly type: AISourceType = 'claude'
  readonly displayName = 'Claude'

  // ── Configuration ──────────────────────────────────────────────────────────

  isConfigured(config: AISourcesConfig): boolean {
    const c = config['claude'] as OAuthSourceConfig | undefined
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
    const c = config['claude'] as OAuthSourceConfig | undefined
    if (!c?.loggedIn || !c?.accessToken) {
      return null
    }

    const rawModel = c.model || 'claude-sonnet-4-6'
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
      url,
      key: c.accessToken,
      model,
      headers,
      apiType: 'anthropic_passthrough'
    }
  }

  getCurrentModel(config: AISourcesConfig): string | null {
    const c = config['claude'] as OAuthSourceConfig | undefined
    return c?.model || null
  }

  // ── Available Models ────────────────────────────────────────────────────────

  async getAvailableModels(_config: AISourcesConfig): Promise<string[]> {
    return Object.keys(CLAUDE_MODELS)
  }

  getUserInfo(config: AISourcesConfig): AISourceUserInfo | null {
    const c = config['claude'] as OAuthSourceConfig | undefined
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

      pendingAuth = {
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
    if (!pendingAuth) {
      return { success: false, error: 'No pending authentication' }
    }

    try {
      console.log('[Claude] Exchanging authorization code for tokens')

      // The 'state' parameter here is actually the authorization code from the callback
      const code = state

      // splits[0] = authorization code, splits[1] = state echoed by the server
      // (which must equal the state we sent in startLogin).
      const splits = code.split('#')

      const response = await proxyFetch(CLAUDE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: splits[0],
          redirect_uri: CLAUDE_REDIRECT_URI,
          client_id: CLAUDE_CLIENT_ID,
          code_verifier: pendingAuth.verifier,
          state: splits[1] || pendingAuth.state
        })
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        console.error('[Claude] Token exchange failed:', response.status, errorText)
        pendingAuth = null
        return {
          success: false,
          error: `Token exchange failed: ${response.status}`
        }
      }

      const json = await response.json() as {
        access_token: string
        refresh_token: string
        expires_in: number
      }

      const accessToken = json.access_token
      const refreshToken = json.refresh_token
      const expiresAt = Date.now() + json.expires_in * 1000

      pendingAuth = null

      console.log('[Claude] Token exchange successful, expires in', json.expires_in, 'seconds')

      // Get available models
      const models = await this.getAvailableModels({} as AISourcesConfig)
      const modelNames = CLAUDE_MODELS
      const defaultModel = 'claude-sonnet-4-6'

      const result: OAuthCompleteResult & {
        _tokenData: { accessToken: string; refreshToken: string; expiresAt: number; uid: string }
        _availableModels: string[]
        _modelNames: Record<string, string>
        _defaultModel: string
      } = {
        success: true,
        user: {
          name: 'Claude User',
          uid: ''
        },
        _tokenData: {
          accessToken,
          refreshToken,
          expiresAt,
          uid: ''
        },
        _availableModels: models,
        _modelNames: modelNames,
        _defaultModel: defaultModel
      }

      return { success: true, data: result }
    } catch (error) {
      console.error('[Claude] Complete login error:', error)
      pendingAuth = null
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to complete login'
      }
    }
  }

  async refreshToken(): Promise<ProviderResult<void>> {
    return { success: true }
  }

  async checkToken(): Promise<ProviderResult<{ valid: boolean; expiresIn?: number }>> {
    return { success: true, data: { valid: true } }
  }

  async logout(): Promise<ProviderResult<void>> {
    pendingAuth = null
    return { success: true }
  }

  // ── Token Management ────────────────────────────────────────────────────────

  /**
   * Check token validity for the manager's ensureValidToken() flow.
   */
  checkTokenWithConfig(config: AISourcesConfig): { valid: boolean; expiresIn?: number; needsRefresh: boolean } {
    const c = config['claude'] as OAuthSourceConfig | undefined
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
    const c = config['claude'] as OAuthSourceConfig | undefined
    if (!c?.refreshToken) {
      return { success: false, error: 'No refresh token available' }
    }

    try {
      console.log('[Claude] Refreshing OAuth token')

      const response = await proxyFetch(CLAUDE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: c.refreshToken,
          client_id: CLAUDE_CLIENT_ID,
          // Narrows from the authorize-time superset (drops org:create_api_key).
          scope: CLAUDE_AI_OAUTH_SCOPES.join(' ')
        })
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        console.error('[Claude] Token refresh failed:', response.status, errorText)
        return {
          success: false,
          error: `Token refresh failed: ${response.status}`
        }
      }

      const json = await response.json() as {
        access_token: string
        refresh_token: string
        expires_in: number
      }

      console.log('[Claude] Token refreshed, expires in', json.expires_in, 'seconds')

      return {
        success: true,
        data: {
          accessToken: json.access_token,
          refreshToken: json.refresh_token,
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
    const c = config['claude'] as OAuthSourceConfig | undefined
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
        }
      }
    } catch (error) {
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
