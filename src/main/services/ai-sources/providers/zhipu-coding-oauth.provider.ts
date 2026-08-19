/**
 * Zhipu GLM Coding Plan OAuth Provider (ZCode login)
 *
 * Signs the user into a Zhipu (BigModel, China mainland) GLM Coding Plan through
 * the ZCode OAuth flow, resolves the coding-plan API key on the user's behalf,
 * and exposes GLM models through the OpenAI-compatible coding endpoint — so the
 * user never has to create or paste an API key manually.
 *
 * Flow (BigModel / open.bigmodel.cn):
 * 1. startLogin(): start a loopback HTTP server, open the system browser to
 *    `bigmodel.cn/login?redirect=http://127.0.0.1:<port>/callback&appId=zcode`.
 * 2. The user authorizes in the browser; BigModel redirects back to the loopback
 *    listener with an `authCode`.
 * 3. completeLogin(): wait for the loopback callback, exchange the code at the
 *    ZCode `oauth/token` endpoint for a BigModel access token, then resolve the
 *    coding-plan key — enumerate the account's orgs/projects and reuse the key
 *    that actually carries plan quota (the team plan's quota is bound to the
 *    account's `member-*` key, not to an arbitrary new key).
 * 4. getBackendConfig(): route requests to `open.bigmodel.cn/api/coding/paas/v4`.
 *
 * Auth scheme: the Coding Plan is an OpenAI-compatible endpoint billed only on
 * `/api/coding/paas/v4` (the generic `/api/anthropic` endpoint does NOT draw from
 * the plan). The key is a Bearer token, so `apiType` is chat_completions and the
 * router adds `Authorization: Bearer <key>` when no Authorization header is set.
 *
 * The key is long-lived and the flow returns no refresh token; when it is revoked
 * the user logs in again. `refreshTokenWithConfig` is therefore intentionally not
 * implemented so the manager skips token refresh.
 */

import http from 'http'
import { randomBytes } from 'crypto'
import open from 'open'
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

/** Provider type key — also the AISource.provider value and product.json entry. */
const PROVIDER_TYPE = 'zhipu-coding-oauth'

/** ZCode OAuth base. The token-exchange endpoint is derived from it. */
const ZCODE_OAUTH_BASE = 'https://zcode.z.ai/api/v1'

/** BigModel browser-redirect login endpoint and the ZCode application id. */
const BIGMODEL_LOGIN_URL = 'https://bigmodel.cn/login'
const BIGMODEL_APP_ID = 'zcode'

/** BigModel business API host — used to provision the coding-plan key. */
const BIGMODEL_BIZ_BASE = 'https://bigmodel.cn'

/**
 * Coding-plan inference endpoint. The Coding Plan is billed ONLY on the dedicated
 * `/api/coding/paas/v4` OpenAI-compatible endpoint; the generic `/api/anthropic`
 * endpoint does not draw from the plan (every request returns 1113 "no resource
 * pack"). The router composes the OpenAI /chat/completions call from this URL.
 */
const CODING_API_BASE = 'https://open.bigmodel.cn/api/coding/paas/v4'
const CODING_CHAT_URL = `${CODING_API_BASE}/chat/completions`

/**
 * API key name the official ZCode client provisions. Reusing it means a re-login
 * finds and reuses the same key instead of creating duplicates.
 */
const MINT_KEY_NAME = 'zcode-api-key'

/** Account default organization / project names (matched to prefer the default). */
const DEFAULT_ORG_NAME = '默认机构'
const DEFAULT_PROJECT_NAME = '默认项目'

/** How long to wait for the user to complete the browser authorization. */
const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000

/** Retries for the transient 5xx the ZCode token exchange occasionally returns. */
const TOKEN_EXCHANGE_MAX_ATTEMPTS = 3

/**
 * GLM coding-plan model catalog served by the coding endpoint. Offline default;
 * the user can switch models in the UI.
 */
const GLM_MODELS: Record<string, string> = {
  'glm-4.6': 'GLM-4.6',
  'glm-4.7': 'GLM-4.7',
  'glm-4.5': 'GLM-4.5',
  'glm-4.5-air': 'GLM-4.5-Air',
  'glm-5': 'GLM-5',
  'glm-5-turbo': 'GLM-5-Turbo',
  'glm-5.1': 'GLM-5.1',
  'glm-5.2': 'GLM-5.2'
}
const DEFAULT_MODEL = 'glm-4.6'

// ============================================================================
// Module-level pending-authorization state (one login at a time)
// ============================================================================

interface PendingAuth {
  /** CSRF state echoed back on the loopback redirect. */
  state: string
  /** Loopback redirect URI registered with BigModel. */
  redirectUri: string
  /** Running loopback callback server (closed when the flow settles). */
  server: http.Server
  /** Resolves with the authorization code captured by the loopback callback. */
  resolveCode: (code: string) => void
  /** Rejects when the callback carried an OAuth error instead of a code. */
  rejectCode: (err: Error) => void
  /** Awaited by completeLogin. */
  codePromise: Promise<string>
  createdAt: number
}

let pendingAuth: PendingAuth | null = null

// ============================================================================
// Response envelope helpers
// ============================================================================

interface Envelope {
  code?: number | string
  msg?: string
  data?: unknown
}

/** A ZCode/BigModel business envelope is successful when code is 0 or 200. */
function isEnvelopeOk(code: number | string | undefined): boolean {
  if (code === undefined || code === null) return true
  const s = String(code)
  return s === '' || s === '0' || s === '200'
}

// ============================================================================
// Provider implementation
// ============================================================================

class ZhipuCodingOAuthProvider implements OAuthAISourceProvider {
  readonly type: AISourceType = PROVIDER_TYPE
  readonly displayName = 'Zhipu GLM Coding Plan'

  /**
   * Read this provider's slice from the legacy v1 config the manager builds via
   * buildLegacyOAuthConfig(). Typed access avoids a string-index error on the
   * v2 AISourcesConfig type, which has no index signature.
   */
  private conf(config: AISourcesConfig): OAuthSourceConfig | undefined {
    return (config as unknown as Record<string, OAuthSourceConfig | undefined>)[PROVIDER_TYPE]
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  isConfigured(config: AISourcesConfig): boolean {
    const c = this.conf(config)
    return !!(c?.loggedIn && c?.accessToken)
  }

  /**
   * Build the BackendRequestConfig for each outgoing request.
   *
   * The Coding Plan is an OpenAI-compatible endpoint authenticated with a Bearer
   * token, so `apiType` is chat_completions (the router converts the Anthropic
   * request from the SDK to OpenAI) and no Authorization header is set here — the
   * router adds `Authorization: Bearer <key>` when none is present.
   */
  getBackendConfig(config: AISourcesConfig): BackendRequestConfig | null {
    const c = this.conf(config)
    if (!c?.loggedIn || !c?.accessToken) {
      return null
    }
    return {
      url: CODING_CHAT_URL,
      key: c.accessToken,
      model: c.model || DEFAULT_MODEL,
      apiType: 'chat_completions'
    }
  }

  getCurrentModel(config: AISourcesConfig): string | null {
    const c = this.conf(config)
    return c?.model || null
  }

  async getAvailableModels(_config: AISourcesConfig): Promise<string[]> {
    return Object.keys(GLM_MODELS)
  }

  getUserInfo(config: AISourcesConfig): AISourceUserInfo | null {
    const c = this.conf(config)
    return c?.user || null
  }

  // ── OAuth flow ──────────────────────────────────────────────────────────────

  /**
   * Start the BigModel browser-redirect login: bind a loopback callback server,
   * open the system browser to the authorize URL, and register the pending flow.
   * Returns no userCode/verificationUri so the renderer uses the generic
   * start → complete path (completeLogin blocks on the loopback callback).
   */
  async startLogin(): Promise<ProviderResult<OAuthStartResult>> {
    try {
      this.cleanupPending()

      const state = randomBytes(16).toString('hex')

      let resolveCode!: (code: string) => void
      let rejectCode!: (err: Error) => void
      const codePromise = new Promise<string>((resolve, reject) => {
        resolveCode = resolve
        rejectCode = reject
      })
      // A pending promise with no synchronous consumer would raise an
      // unhandledRejection if the server errors before completeLogin awaits it.
      codePromise.catch(() => {})

      const server = http.createServer()
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })

      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        return { success: false, error: 'Failed to bind loopback callback port' }
      }
      const redirectUri = `http://127.0.0.1:${addr.port}/callback`

      server.on('request', (req, res) => {
        this.handleLoopbackRequest(req, res, state)
      })
      // Guard against the user abandoning the browser tab.
      server.setTimeout(AUTHORIZE_TIMEOUT_MS)

      const url = new URL(BIGMODEL_LOGIN_URL)
      url.searchParams.set('redirect', redirectUri)
      url.searchParams.set('appId', BIGMODEL_APP_ID)
      url.searchParams.set('state', state)
      const loginUrl = url.toString()

      pendingAuth = {
        state,
        redirectUri,
        server,
        resolveCode,
        rejectCode,
        codePromise,
        createdAt: Date.now()
      }

      console.log('[ZhipuCodingOAuth] Login started, loopback callback on', redirectUri)

      // Open the system browser; failure is non-fatal (user can open manually).
      open(loginUrl).catch((err) => {
        console.warn('[ZhipuCodingOAuth] Failed to open system browser:', err)
      })

      return {
        success: true,
        data: { loginUrl, state }
      }
    } catch (error) {
      console.error('[ZhipuCodingOAuth] Start login error:', error)
      this.cleanupPending()
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start login'
      }
    }
  }

  /**
   * Complete the login: wait for the loopback authorization code, exchange it for
   * a BigModel access token, mint the coding-plan key, and return the token data.
   */
  async completeLogin(state: string): Promise<ProviderResult<OAuthCompleteResult>> {
    const pending = pendingAuth
    if (!pending) {
      return { success: false, error: 'No pending authentication' }
    }
    if (pending.state !== state) {
      return { success: false, error: 'Authentication state mismatch' }
    }

    try {
      console.log('[ZhipuCodingOAuth] Waiting for browser authorization...')
      const code = await this.awaitAuthorizationCode(pending)

      console.log('[ZhipuCodingOAuth] Exchanging authorization code for access token')
      const bigModelToken = await this.exchangeBigModelCode(code, pending)

      console.log('[ZhipuCodingOAuth] Resolving coding-plan accounts')
      const accounts = await this.resolveAccounts(bigModelToken)
      if (accounts.length === 0) {
        throw new Error('no coding-plan key with quota on this account')
      }
      console.log('[ZhipuCodingOAuth] Accounts:', accounts.map(a => a.label).join(', '))

      const models = Object.keys(GLM_MODELS)
      const primary = accounts[0]
      const result: OAuthCompleteResult & {
        _tokenData: { accessToken: string; refreshToken: string; expiresAt: number; uid: string }
        _accounts: Array<{ key: string; label: string; id: string }>
        _availableModels: string[]
        _modelNames: Record<string, string>
        _defaultModel: string
      } = {
        success: true,
        user: { name: primary.label, uid: primary.id },
        _tokenData: { accessToken: primary.key, refreshToken: '', expiresAt: 0, uid: primary.id },
        // One entry per organization that owns the plan; the manager creates a
        // source per entry so the user can switch organizations from the list.
        _accounts: accounts.map(a => ({ key: a.key, label: a.label, id: a.id })),
        _availableModels: models,
        _modelNames: GLM_MODELS,
        _defaultModel: DEFAULT_MODEL
      }

      console.log('[ZhipuCodingOAuth] Login successful')
      return { success: true, data: result }
    } catch (error) {
      console.error('[ZhipuCodingOAuth] Complete login error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to complete login'
      }
    } finally {
      this.cleanupPending()
    }
  }

  async refreshToken(): Promise<ProviderResult<void>> {
    return { success: true }
  }

  async checkToken(): Promise<ProviderResult<{ valid: boolean; expiresIn?: number }>> {
    return { success: true, data: { valid: true } }
  }

  async logout(): Promise<ProviderResult<void>> {
    this.cleanupPending()
    return { success: true }
  }

  /**
   * Token status for the manager's ensureValidToken() flow. The minted key is
   * long-lived and there is no refresh grant, so it never needs a proactive
   * refresh. `refreshTokenWithConfig` is intentionally omitted so the manager
   * skips refreshing (it requires both methods to be present).
   */
  checkTokenWithConfig(config: AISourcesConfig): { valid: boolean; expiresIn?: number; needsRefresh: boolean } {
    const c = this.conf(config)
    return { valid: !!c?.accessToken, needsRefresh: false }
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /** Wait for the loopback callback code, bounded by the authorize timeout. */
  private awaitAuthorizationCode(pending: PendingAuth): Promise<string> {
    const remaining = Math.max(0, AUTHORIZE_TIMEOUT_MS - (Date.now() - pending.createdAt))
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Authorization timed out'))
      }, remaining)
      pending.codePromise.then(
        (code) => {
          clearTimeout(timer)
          resolve(code)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        }
      )
    })
  }

  /**
   * Loopback callback handler: extracts `authCode` (or `code`) and `state` from
   * the redirect, validates the state, and settles the pending flow.
   */
  private handleLoopbackRequest(req: http.IncomingMessage, res: http.ServerResponse, expectedState: string): void {
    let code = ''
    let stateParam = ''
    let errParam = ''
    try {
      const parsed = new URL(req.url || '', 'http://127.0.0.1')
      if (!parsed.pathname.startsWith('/callback')) {
        res.statusCode = 404
        res.end('Not found')
        return
      }
      code = (parsed.searchParams.get('authCode') || parsed.searchParams.get('code') || '').trim()
      stateParam = (parsed.searchParams.get('state') || '').trim()
      errParam = (parsed.searchParams.get('error') || parsed.searchParams.get('error_description') || '').trim()
    } catch {
      // fall through to the error handling below
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(
      '<!doctype html><html><body style="font-family:sans-serif;padding:40px;text-align:center">' +
      '<h2>Authorization received</h2><p>You can close this tab and return to Halo.</p></body></html>'
    )

    if (!pendingAuth) return
    if (errParam) {
      pendingAuth.rejectCode(new Error(`Authorization failed: ${errParam}`))
      return
    }
    if (!code || stateParam !== expectedState) {
      pendingAuth.rejectCode(new Error('Authorization callback missing code or state mismatch'))
      return
    }
    pendingAuth.resolveCode(code)
  }

  /**
   * Exchange the BigModel authorization code for an access token via the ZCode
   * oauth/token endpoint (the same exchange the official client performs).
   * Retried a few times because the endpoint occasionally returns a transient
   * 5xx while validating the code with BigModel.
   */
  private async exchangeBigModelCode(code: string, pending: PendingAuth): Promise<string> {
    const body = JSON.stringify({
      provider: 'bigmodel',
      code,
      redirect_uri: pending.redirectUri,
      state: pending.state
    })

    let lastErr: Error | null = null
    for (let attempt = 1; attempt <= TOKEN_EXCHANGE_MAX_ATTEMPTS; attempt++) {
      try {
        const data = await this.postEnvelope(`${ZCODE_OAUTH_BASE}/oauth/token`, body)
        const token = this.extractAccessToken(data)
        if (!token) {
          throw new Error('token exchange returned no access token')
        }
        return token
      } catch (error) {
        lastErr = error instanceof Error ? error : new Error(String(error))
        console.warn(`[ZhipuCodingOAuth] Token exchange attempt ${attempt}/${TOKEN_EXCHANGE_MAX_ATTEMPTS} failed:`, lastErr.message)
        if (attempt < TOKEN_EXCHANGE_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, attempt * 1000))
        }
      }
    }
    throw new Error(`BigModel token exchange failed: ${lastErr?.message || 'unknown error'}`)
  }

  /** Pull the access token out of the various shapes the exchange may return. */
  private extractAccessToken(data: unknown): string {
    const d = (data || {}) as Record<string, any>
    const candidates = [
      d?.bigmodel?.access_token,
      d?.bigmodel?.accessToken,
      d?.access_token,
      d?.accessToken
    ]
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim()
    }
    return ''
  }

  /**
   * Resolve one coding-plan account per organization on the account.
   *
   * No quota probing: an account can span several organizations (a personal
   * "默认机构" plus one or more enterprise orgs) and the plan lives in specific
   * ones, but which org to use is the user's choice, not something worth a slow
   * login-time probe. We list every organization and expose one source each
   * (enterprise orgs first so the default selection lands on a team plan); the
   * user picks the org, and an org without quota simply surfaces the upstream
   * error the first time it is used.
   */
  private async resolveAccounts(accessToken: string): Promise<Array<{ key: string; label: string; id: string }>> {
    const ci = await this.getEnvelope(`${BIGMODEL_BIZ_BASE}/api/biz/customer/getCustomerInfo`, accessToken) as {
      organizations?: Array<{
        organizationId?: string
        organizationName?: string
        projects?: Array<{ projectId?: string; projectName?: string }>
      }>
    }
    const orgs = ci?.organizations || []
    if (orgs.length === 0) {
      throw new Error('no organization on account (no active coding plan?)')
    }

    // Enterprise orgs first so the default-selected source is a team plan, not
    // the personal default org.
    const ordered = [...orgs].sort((a, b) => {
      const ad = (a.organizationName || '').includes(DEFAULT_ORG_NAME) ? 1 : 0
      const bd = (b.organizationName || '').includes(DEFAULT_ORG_NAME) ? 1 : 0
      return ad - bd
    })
    console.log('[ZhipuCodingOAuth] Organizations:', ordered.map(o => o.organizationName || o.organizationId).join(', '))

    // One account per org, resolved in parallel.
    const resolved = await Promise.all(ordered.map(async (org) => {
      try {
        return await this.resolveOrgAccount(org, accessToken)
      } catch (error) {
        console.warn(`[ZhipuCodingOAuth] Resolve org failed (${org.organizationName || org.organizationId}):`, error instanceof Error ? error.message : error)
        return null
      }
    }))

    return resolved.filter((a): a is { key: string; label: string; id: string } => a !== null)
  }

  /**
   * Resolve one key for an organization, without probing quota. Reuses the
   * account's own member key (`member-*`, which carries the team-plan quota) when
   * present, else any existing key, else creates a `zcode-api-key`. Scans projects
   * (default project first) and picks the first project that yields a key.
   */
  private async resolveOrgAccount(
    org: { organizationId?: string; organizationName?: string; projects?: Array<{ projectId?: string; projectName?: string }> },
    accessToken: string
  ): Promise<{ key: string; label: string; id: string } | null> {
    const orgId = (org.organizationId || '').trim()
    if (!orgId) return null
    const label = (org.organizationName || '').trim() || orgId

    // Prefer the default project within the org; keep the rest as fallback.
    const projects = [...(org.projects || [])].sort((a, b) => {
      const ad = (a.projectName || '').includes(DEFAULT_PROJECT_NAME) ? 0 : 1
      const bd = (b.projectName || '').includes(DEFAULT_PROJECT_NAME) ? 0 : 1
      return ad - bd
    })

    let firstProjectId = ''
    for (const proj of projects) {
      const projId = (proj.projectId || '').trim()
      if (!projId) continue
      if (!firstProjectId) firstProjectId = projId
      const keysUrl = `${BIGMODEL_BIZ_BASE}/api/biz/v1/organization/${orgId}/projects/${projId}/api_keys`
      let keys: Array<{ name?: string; apiKey?: string }> = []
      try {
        const list = await this.getEnvelope(keysUrl, accessToken)
        if (Array.isArray(list)) keys = list as Array<{ name?: string; apiKey?: string }>
      } catch (error) {
        console.warn('[ZhipuCodingOAuth] List API keys failed:', error instanceof Error ? error.message : error)
        continue
      }
      // Member key carries the team-plan quota; otherwise any existing key.
      const pick = keys.find(k => (k.name || '').startsWith('member')) || keys[0]
      if (pick?.apiKey) {
        const key = await this.appendSecret(keysUrl, pick.apiKey, accessToken)
        if (key) return { key, label, id: orgId }
      }
    }

    // No existing key in any project — create one in the first project.
    if (firstProjectId) {
      const keysUrl = `${BIGMODEL_BIZ_BASE}/api/biz/v1/organization/${orgId}/projects/${firstProjectId}/api_keys`
      try {
        const res = await this.postEnvelope(keysUrl, JSON.stringify({ name: MINT_KEY_NAME }), accessToken) as { apiKey?: string }
        const key = await this.appendSecret(keysUrl, res?.apiKey, accessToken)
        if (key) return { key, label, id: orgId }
      } catch (error) {
        console.warn('[ZhipuCodingOAuth] Create API key failed:', error instanceof Error ? error.message : error)
      }
    }
    return null
  }

  /** Copy a key's secret and return `apiKey[.secretKey]`. Returns '' if apiKey is empty. */
  private async appendSecret(keysUrl: string, apiKey: string | undefined, accessToken: string): Promise<string> {
    const id = (apiKey || '').trim()
    if (!id) return ''
    let secretKey = ''
    try {
      const copy = await this.getEnvelope(`${keysUrl}/copy/${encodeURIComponent(id)}`, accessToken) as { secretKey?: string }
      secretKey = (copy?.secretKey || '').trim()
    } catch (error) {
      console.warn('[ZhipuCodingOAuth] Copy secret key failed, using bare apiKey:', error instanceof Error ? error.message : error)
    }
    return secretKey ? `${id}.${secretKey}` : id
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────────

  /** GET a business endpoint and unwrap the {code,msg,data} envelope. */
  private async getEnvelope(url: string, authorization?: string): Promise<unknown> {
    return this.requestEnvelope('GET', url, undefined, authorization)
  }

  /** POST a business endpoint and unwrap the {code,msg,data} envelope. */
  private async postEnvelope(url: string, body: string, authorization?: string): Promise<unknown> {
    return this.requestEnvelope('POST', url, body, authorization)
  }

  private async requestEnvelope(method: 'GET' | 'POST', url: string, body: string | undefined, authorization?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
    if (authorization) headers['Authorization'] = authorization

    const resp = await proxyFetch(url, { method, headers, body })
    const text = await resp.text().catch(() => '')
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`)
    }
    let env: Envelope
    try {
      env = JSON.parse(text) as Envelope
    } catch {
      throw new Error('invalid JSON response')
    }
    if (!isEnvelopeOk(env.code)) {
      throw new Error(env.msg?.trim() || `business error ${env.code}`)
    }
    return env.data
  }

  /** Release the loopback server and clear pending state. Idempotent. */
  private cleanupPending(): void {
    if (pendingAuth) {
      try {
        pendingAuth.server.close()
      } catch {
        // ignore close errors
      }
      pendingAuth = null
    }
  }
}

// ============================================================================
// Singleton export
// ============================================================================

let providerInstance: ZhipuCodingOAuthProvider | null = null

export function getZhipuCodingOAuthProvider(): ZhipuCodingOAuthProvider {
  if (!providerInstance) {
    providerInstance = new ZhipuCodingOAuthProvider()
  }
  return providerInstance
}

export { ZhipuCodingOAuthProvider }
