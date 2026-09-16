/**
 * ChatGPT Subscription OAuth Provider
 *
 * Signs the user in with their ChatGPT account and routes inference through the
 * Codex backend, so a paid plan can be used without an API key.
 *
 * Source of truth is the open-source Codex CLI (`openai/codex`, Apache-2.0), not
 * a third-party reimplementation: the backend fingerprints the client, and stale
 * values are exactly how a port starts looking like something other than the
 * official client. Every constant, header name and body field below is taken
 * from `codex-rs/...` at the release this source emulates
 * ({@link CODEX_CLI_VERSION}, which deliberately leads the Codex engine's own
 * package pin — see codex-models.ts); re-check them when that release moves.
 * Deliberate divergences are called out inline.
 *
 * Flow:
 * 1. startLogin() — PKCE S256, bind the loopback callback the CLI uses
 *    (127.0.0.1:1455, falling back to 1457), open the system browser.
 * 2. The user signs in; ChatGPT redirects to the loopback listener with `code`.
 * 3. completeLogin() — exchange the code for tokens, read the account id out of
 *    the id_token, hand the tokens to the manager.
 * 4. getBackendConfig() — route to the Codex Responses endpoint with the bearer
 *    token, plus the provider adapter that reshapes the body for this backend.
 *
 * The credential lives in Halo's config rather than the bundled CLI's
 * `auth.json`. This is an AI source, so it has to be readable by every engine,
 * and only Halo's own sources are. Nothing here touches CODEX_HOME.
 */

import http from 'http'
import { readFileSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
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
import { CHATGPT_PROVIDER_ID } from '../../../../shared/constants'
import {
  CODEX_ADAPTER_ID,
  CODEX_CLI_VERSION,
  CODEX_SUBSCRIPTION_MODELS,
  CODEX_DEFAULT_MODEL
} from '../../../../shared/constants/codex-models'
import { setCodexModelCapabilities } from '../../../openai-compat-router/server/codex-capabilities'

// ============================================================================
// Constants (openai/codex — the release named by CODEX_CLI_VERSION)
// ============================================================================

/** OAuth issuer. `codex-rs/login/src/server.rs` DEFAULT_ISSUER. */
const ISSUER = 'https://auth.openai.com'
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`
const TOKEN_URL = `${ISSUER}/oauth/token`
const REVOKE_URL = `${ISSUER}/oauth/revoke`

/** Public client id of the Codex CLI. `codex-rs/login/src/auth/manager.rs` CLIENT_ID. */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/**
 * Authorize scopes. The two `api.connectors.*` entries govern server-side
 * connector invocation; dropping them is a documented cause of tool-calling
 * failures on this backend, so they must stay.
 * `codex-rs/login/src/server.rs` build_authorize_url.
 */
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'

/** Client identity the backend keys on. `codex-rs/login/src/auth/default_client.rs`. */
const ORIGINATOR = 'codex_cli_rs'

/** Loopback callback the CLI binds, and its single fallback port. */
const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/auth/callback'
const DEFAULT_CALLBACK_PORT = 1455
const FALLBACK_CALLBACK_PORT = 1457

/** Codex Responses endpoint for subscription auth. */
const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

/**
 * Model catalog for this account. The CLI reads it here rather than shipping a
 * fixed list — the backend decides which slugs the account's plan covers, so
 * the client only ever renders what this returns.
 */
const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'

/** Claim namespace carrying the ChatGPT account id. `codex-rs/login/src/token_data.rs`. */
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const JWT_PROFILE_PATH = 'https://api.openai.com/profile'

/** Refresh once the access token is within this window of expiring. */
const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000

/** How long to wait for the user to finish signing in in the browser. */
const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000

/** Upper bound on a catalog read, which also happens inside the login flow. */
const CATALOG_TIMEOUT_MS = 15_000

// ============================================================================
// Pending authorization (one login at a time)
// ============================================================================

interface PendingAuth {
  /** PKCE code_verifier — needed at token exchange. */
  verifier: string
  /** CSRF state echoed back on the loopback redirect. */
  state: string
  redirectUri: string
  /** Running loopback callback server, closed when the flow settles. */
  server: http.Server
  resolveCode: (code: string) => void
  rejectCode: (err: Error) => void
  /** Awaited by completeLogin. */
  codePromise: Promise<string>
  createdAt: number
}

let pendingAuth: PendingAuth | null = null

// ============================================================================
// PKCE / JWT helpers
// ============================================================================

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

/**
 * PKCE S256 pair. The verifier is 64 random bytes, matching the CLI
 * (`codex-rs/login/src/pkce.rs`) — not the 32 the RFC minimum would allow.
 */
function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(64))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** Decode a JWT payload without verifying it — we only read our own claims. */
function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((p) => !p)) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function readAccountId(idToken: string | undefined, accessToken?: string): string {
  for (const token of [idToken, accessToken]) {
    const payload = decodeJwtPayload(token)
    const claims = payload?.[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined
    const accountId = claims?.chatgpt_account_id
    if (typeof accountId === 'string' && accountId) return accountId
  }
  return ''
}

function readEmail(idToken: string | undefined): string {
  const payload = decodeJwtPayload(idToken)
  if (!payload) return ''
  const direct = payload.email
  if (typeof direct === 'string' && direct) return direct
  const profile = payload[JWT_PROFILE_PATH] as { email?: string } | undefined
  return typeof profile?.email === 'string' ? profile.email : ''
}

/**
 * Expiry from the access token's own `exp`. The token endpoint does not return
 * `expires_in`, so the JWT is the only source — the CLI reads it the same way.
 * Returns 0 when unreadable, which the manager treats as "no proactive refresh".
 */
function readExpiresAt(accessToken: string | undefined): number {
  const exp = decodeJwtPayload(accessToken)?.exp
  return typeof exp === 'number' && exp > 0 ? exp * 1000 : 0
}

// ============================================================================
// User agent
// ============================================================================

/**
 * `os_info::Type` display names, for the distribution ids `os_info` recognizes
 * (its `linux/file_release.rs` matcher). An id it does not list resolves to
 * `Type::Linux`, which renders "Linux" — the same fallback used here.
 */
const LINUX_DISTRIBUTION_NAMES: Record<string, string> = {
  almalinux: 'AlmaLinux',
  alpaquita: 'Alpaquita Linux',
  alpine: 'Alpine Linux',
  amzn: 'Amazon Linux AMI',
  aosc: 'AOSC OS',
  arch: 'Arch Linux',
  archarm: 'Arch Linux',
  artix: 'Artix Linux',
  bluefin: 'Bluefin',
  cachyos: 'CachyOS Linux',
  centos: 'CentOS',
  debian: 'Debian',
  fedora: 'Fedora',
  kali: 'Kali Linux',
  'manjaro-arm': 'Manjaro',
  linuxmint: 'Linux Mint',
  mariner: 'Mariner',
  nixos: 'NixOS',
  nobara: 'Nobara Linux',
  ol: 'Oracle Linux',
  openEuler: 'EulerOS',
  opencloudos: 'OpenCloudOS',
  opensuse: 'openSUSE',
  'opensuse-leap': 'openSUSE',
  'opensuse-microos': 'openSUSE',
  'opensuse-tumbleweed': 'openSUSE',
  rhel: 'Red Hat Enterprise Linux',
  rocky: 'Rocky Linux',
  sled: 'SUSE Linux Enterprise Server',
  sles: 'SUSE Linux Enterprise Server',
  sles_sap: 'SUSE Linux Enterprise Server',
  ubuntu: 'Ubuntu',
  ultramarine: 'Ultramarine Linux',
  Uos: 'UOS',
  void: 'Void Linux'
}

/**
 * `os_info::Version::from_string`: a numeric version pads to three components
 * ("15.1" -> "15.1.0"), anything longer or non-numeric is kept verbatim.
 */
function normalizeVersion(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'Unknown'
  const parts = trimmed.split('.')
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return trimmed
  while (parts.length < 3) parts.push('0')
  return parts.join('.')
}

/** `ID` and `VERSION_ID` from os-release, which is what `os_info` reads on Linux. */
function readOsRelease(): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    let text: string
    try {
      text = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (match) fields[match[1]] = match[2].replace(/^"|"$/g, '')
    }
    break
  }
  return fields
}

/**
 * OS name and version in the form `os_info` reports them for this host.
 *
 * `process.getSystemVersion()` is the value Electron reads from the same sources
 * `os_info` does (`sw_vers -productVersion` on macOS, the Windows version API,
 * the kernel elsewhere), so the macOS and Windows segments are the real strings.
 */
function hostOs(): { name: string; version: string } {
  if (process.platform === 'darwin') {
    return { name: 'Mac OS', version: normalizeVersion(process.getSystemVersion()) }
  }
  if (process.platform === 'win32') {
    return { name: 'Windows', version: normalizeVersion(process.getSystemVersion()) }
  }
  const release = readOsRelease()
  return {
    name: LINUX_DISTRIBUTION_NAMES[release.ID] ?? 'Linux',
    version: normalizeVersion(release.VERSION_ID ?? '')
  }
}

/** Terminal token, following the CLI's probe order and its `unknown` fallback. */
function terminalToken(): string {
  const program = process.env.TERM_PROGRAM
  if (program) {
    const version = process.env.TERM_PROGRAM_VERSION
    return version ? `${program}/${version}` : program
  }
  return process.env.TERM || 'unknown'
}

/**
 * The CLI's user agent, assembled the way the CLI assembles it:
 * `{originator}/{version} ({os_type} {os_version}; {arch}) {terminal}` — see
 * `codex-rs/login/src/auth/default_client.rs`, whose own macOS test asserts
 * exactly this shape.
 *
 * Every segment is read from the host at request time; none is a fixed string.
 */
function buildUserAgent(): string {
  const { name, version } = hostOs()
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch
  return `${ORIGINATOR}/${CODEX_CLI_VERSION} (${name} ${version}; ${arch}) ${terminalToken()}`
}

// ============================================================================
// Provider implementation
// ============================================================================

interface TokenSet {
  idToken: string
  accessToken: string
  refreshToken: string
}

/** The fields of the catalog this provider reads, per `ModelInfo` on the wire. */
interface CatalogModel {
  slug: string
  display_name?: string
  /** `list` is what the picker shows; `hide` and `none` are filtered out. */
  visibility?: string
  priority?: number
  /** `["text", "image"]` when the model accepts images. */
  input_modalities?: string[]
  /** The model's real context window, which Halo has no other way to learn. */
  context_window?: number
  supports_reasoning_summary_parameter?: boolean
  use_responses_lite?: boolean
}

/**
 * Catalog entries rendered as the picker expects them.
 *
 * `context_window` is load-bearing, not decoration: it drives auto-compaction,
 * and Halo's preset table has no entry for these slugs — `gpt-5.6-sol` and
 * friends fall onto the `gpt-5` family pattern, whose window is not theirs.
 * These values ride on `ModelOption`, which outranks a family pattern in
 * `modelCapabilitiesService.resolve`, and are replaced on every catalog
 * refresh so they track the backend instead of freezing at first write.
 *
 * They deliberately do not go into `modelOverrides`: that map is the user's
 * own edits. Writing there would mark every model as user-customised, offer
 * "Reset to preset" for values the user never set, and pin them above every
 * future refresh.
 */
function toModelOptions(models: CatalogModel[]): {
  availableModels: string[]
  modelNames: Record<string, string>
  modelCapabilities: Record<string, { contextWindow?: number }>
  modelVision: Record<string, boolean>
} {
  const modelCapabilities: Record<string, { contextWindow?: number }> = {}
  const modelVision: Record<string, boolean> = {}
  for (const model of models) {
    if (model.input_modalities) {
      modelVision[model.slug] = model.input_modalities.includes('image')
    }
    if (typeof model.context_window === 'number' && model.context_window > 0) {
      modelCapabilities[model.slug] = { contextWindow: model.context_window }
    }
  }
  return {
    availableModels: models.map((model) => model.slug),
    modelNames: Object.fromEntries(models.map((model) => [model.slug, model.display_name || model.slug])),
    modelCapabilities,
    modelVision
  }
}

/**
 * Overlay the backend's catalog on the shipped one, the way the CLI does.
 *
 * The response is an overlay, not a full catalog: it carries the entries the
 * backend wants to correct or add, and every model it stays silent about keeps
 * its shipped values — priority included. Replacing the list with the response
 * drops every model the backend did not re-send, which is most of them.
 *
 * Filtering happens after the merge so that a backend hiding a shipped model
 * hides it here too.
 */
function mergeCatalog(remote: CatalogModel[]): CatalogModel[] {
  const merged = new Map<string, CatalogModel>()
  for (const shipped of CODEX_SUBSCRIPTION_MODELS) {
    merged.set(shipped.slug, {
      slug: shipped.slug,
      display_name: shipped.name,
      priority: shipped.priority,
      visibility: 'list'
    })
  }
  for (const model of remote) {
    if (!model?.slug) continue
    merged.set(model.slug, { ...merged.get(model.slug), ...model })
  }
  return Array.from(merged.values())
    .filter((model) => model.visibility === 'list')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
}

/**
 * Tell the manager the fetch produced nothing usable, so it keeps the models
 * already stored instead of writing an empty list over them. The manager returns
 * on `degraded` before reading anything else, so this carries nothing else.
 */
function degradedCatalog(): Partial<AISourcesConfig> {
  return { [CHATGPT_PROVIDER_ID]: { degraded: true } } as unknown as Partial<AISourcesConfig>
}

class ChatGPTProvider implements OAuthAISourceProvider {
  readonly type: AISourceType = CHATGPT_PROVIDER_ID
  readonly displayName = 'ChatGPT'

  /**
   * Read this provider's slice from the legacy v1 config the manager builds via
   * buildLegacyOAuthConfig(). Typed access avoids a string-index error on the
   * v2 AISourcesConfig type, which has no index signature.
   */
  private conf(config: AISourcesConfig): OAuthSourceConfig | undefined {
    return (config as unknown as Record<string, OAuthSourceConfig | undefined>)[CHATGPT_PROVIDER_ID]
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  isConfigured(config: AISourcesConfig): boolean {
    const c = this.conf(config)
    return !!(c?.loggedIn && c?.accessToken)
  }

  /**
   * Build the BackendRequestConfig for each outgoing request.
   *
   * The header set is the CLI's, verbatim: `ChatGPT-Account-ID` (that exact
   * casing), `originator`, and the bearer token. Two things are deliberately
   * absent — `OpenAI-Beta: responses=experimental`, which the CLI no longer
   * sends on HTTP at all, and a `system`-role message in the body, which the
   * adapter moves to top-level `instructions`.
   *
   * `adapterId` selects the request reshape; it is passed explicitly so the
   * adapter applies even when the engine reaches us over the local router.
   */
  getBackendConfig(config: AISourcesConfig): BackendRequestConfig | null {
    const c = this.conf(config)
    if (!c?.loggedIn || !c?.accessToken) {
      return null
    }

    return {
      url: RESPONSES_URL,
      key: c.accessToken,
      model: c.model || CODEX_DEFAULT_MODEL,
      apiType: 'responses',
      // The Codex backend only serves streamed responses.
      forceStream: true,
      adapterId: CODEX_ADAPTER_ID,
      headers: { ...this.backendHeaders(c.accessToken, c.user?.uid || ''), 'Accept': 'text/event-stream' }
    }
  }

  /**
   * Identity and auth headers the CLI's HTTP client attaches to every request to
   * the Codex backend — inference and catalog alike.
   *
   * `ChatGPT-Account-ID` is only set when known: the backend rejects the request
   * without it, and an empty value would not help.
   */
  private backendHeaders(accessToken: string, accountId: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
      'originator': ORIGINATOR,
      'User-Agent': buildUserAgent(),
      'version': CODEX_CLI_VERSION
    }
    if (accountId) headers['ChatGPT-Account-ID'] = accountId
    return headers
  }

  /**
   * The account's catalog as picker options, or the shipped list alone when the
   * backend cannot be reached. Never throws: this runs inside login and inside
   * refresh, and neither should fail over an unreachable catalog.
   */
  private async catalogOrFallback(
    accessToken: string,
    accountId: string
  ): Promise<ReturnType<typeof toModelOptions>> {
    try {
      const catalog = await this.fetchCatalog(accessToken, accountId)
      if (catalog.length > 0) return toModelOptions(mergeCatalog(catalog))
      console.warn('[ChatGPT] Catalog came back empty, using the shipped list')
    } catch (error) {
      console.warn('[ChatGPT] Catalog fetch failed, using the shipped list:', error)
    }
    return toModelOptions(mergeCatalog([]))
  }

  /**
   * Pull this account's model catalog from the backend.
   *
   * Returns the response unfiltered and unordered: it is an overlay that
   * {@link mergeCatalog} applies over the shipped list, which is also where the
   * CLI's `visibility: "list"` filter and `priority` ordering live.
   *
   * Throws on transport or HTTP failure; the caller degrades to the shipped
   * catalog rather than clearing the user's list.
   */
  private async fetchCatalog(accessToken: string, accountId: string): Promise<CatalogModel[]> {
    // Bounded because this also runs inside completeLogin: an unresponsive
    // backend must not hold the login flow open indefinitely.
    const response = await proxyFetch(`${MODELS_URL}?client_version=${CODEX_CLI_VERSION}`, {
      method: 'GET',
      headers: this.backendHeaders(accessToken, accountId),
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS)
    })
    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`)
    }

    const body = await response.json() as { models?: CatalogModel[] }
    const raw = body.models || []

    // Log the whole overlay, not the merged result: "why is model X missing" is
    // answered by what the backend sent, and once it is merged into the shipped
    // list there is no way to tell which entries came from where.
    console.log(
      '[ChatGPT] Catalog overlay:',
      raw.map((m) => `${m.slug}:${m.visibility ?? 'unspecified'}`).join(', ') || '(none)'
    )

    // The adapter shapes the request from these; they must be recorded even for
    // models the picker hides, since a hidden one can still be selected by config.
    setCodexModelCapabilities(raw)

    return raw
  }

  getCurrentModel(config: AISourcesConfig): string | null {
    return this.conf(config)?.model || null
  }

  /**
   * The shipped catalog — what login seeds the picker with, and the base
   * {@link refreshConfig} merges the account's own list onto.
   */
  async getAvailableModels(_config: AISourcesConfig): Promise<string[]> {
    return CODEX_SUBSCRIPTION_MODELS.map((model) => model.slug)
  }

  getUserInfo(config: AISourcesConfig): AISourceUserInfo | null {
    return this.conf(config)?.user || null
  }

  /**
   * Rebuild this account's list by merging the backend's overlay onto the
   * shipped catalog.
   *
   * A failed fetch answers `degraded` instead of an empty list: the manager
   * reads that as "keep what is stored", so an offline launch or a transient
   * backend error does not wipe the picker down to nothing.
   */
  async refreshConfig(config: AISourcesConfig): Promise<ProviderResult<Partial<AISourcesConfig>>> {
    const c = this.conf(config)
    if (!c?.accessToken) {
      return { success: false, error: 'Not logged in' }
    }

    try {
      const catalog = await this.fetchCatalog(c.accessToken, c.user?.uid || '')
      if (catalog.length === 0) {
        console.warn('[ChatGPT] Catalog came back empty, keeping stored models')
        return { success: true, data: degradedCatalog() }
      }

      return {
        success: true,
        data: { [CHATGPT_PROVIDER_ID]: { ...c, ...toModelOptions(mergeCatalog(catalog)) } } as unknown as Partial<AISourcesConfig>
      }
    } catch (error) {
      console.warn('[ChatGPT] Catalog fetch failed, keeping stored models:', error)
      return { success: true, data: degradedCatalog() }
    }
  }

  // ── OAuth flow ──────────────────────────────────────────────────────────────

  /**
   * Bind the loopback callback and open the browser.
   *
   * Returns neither `userCode` nor `redirectUri`: the loopback server owns the
   * callback, so the renderer takes the generic start → complete path and
   * completeLogin blocks until the redirect arrives. That also keeps the
   * Claude-specific PKCE dialog out of the picture entirely.
   */
  async startLogin(): Promise<ProviderResult<OAuthStartResult>> {
    try {
      this.cleanupPending()

      const pkce = createPkce()
      // Independent CSRF state (RFC 6749 §10.12) — never derived from the verifier.
      const state = base64Url(randomBytes(32))

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
      const port = await this.bindCallbackServer(server)
      const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`

      server.on('request', (req, res) => {
        this.handleLoopbackRequest(req, res, state)
      })
      // Guard against the user abandoning the browser tab.
      server.setTimeout(AUTHORIZE_TIMEOUT_MS)

      const url = new URL(AUTHORIZE_URL)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', CLIENT_ID)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('scope', SCOPE)
      url.searchParams.set('code_challenge', pkce.challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('id_token_add_organizations', 'true')
      url.searchParams.set('codex_cli_simplified_flow', 'true')
      url.searchParams.set('state', state)
      url.searchParams.set('originator', ORIGINATOR)
      const loginUrl = url.toString()

      pendingAuth = {
        verifier: pkce.verifier,
        state,
        redirectUri,
        server,
        resolveCode,
        rejectCode,
        codePromise,
        createdAt: Date.now()
      }

      console.log('[ChatGPT] Login started, loopback callback on', redirectUri)

      // Failure is non-fatal: the flow still completes if the user opens the
      // authorize URL in any other browser, since the callback is a local socket.
      open(loginUrl).catch((err) => {
        console.warn('[ChatGPT] Failed to open system browser:', err)
      })

      return { success: true, data: { loginUrl, state } }
    } catch (error) {
      console.error('[ChatGPT] Start login error:', error)
      this.cleanupPending()
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start login'
      }
    }
  }

  /** Wait for the loopback code, exchange it, and hand the tokens to the manager. */
  async completeLogin(state: string): Promise<ProviderResult<OAuthCompleteResult>> {
    const pending = pendingAuth
    if (!pending) {
      return { success: false, error: 'No pending authentication' }
    }
    if (pending.state !== state) {
      return { success: false, error: 'Authentication state mismatch' }
    }

    try {
      console.log('[ChatGPT] Waiting for browser authorization...')
      const code = await this.awaitAuthorizationCode(pending)

      console.log('[ChatGPT] Exchanging authorization code for tokens')
      const tokens = await this.exchangeCode(code, pending)

      const accountId = readAccountId(tokens.idToken, tokens.accessToken)
      if (!accountId) {
        throw new Error('access token carries no ChatGPT account id')
      }
      const email = readEmail(tokens.idToken)
      const expiresAt = readExpiresAt(tokens.accessToken)

      // Read the account's real catalog before handing back a source, so the
      // picker is right the first time it opens rather than after a manual
      // refresh. The shipped constant stands in only when the backend cannot be
      // reached — a failed fetch must not fail a login that already succeeded.
      const models = await this.catalogOrFallback(tokens.accessToken, accountId)

      const result: OAuthCompleteResult & {
        _tokenData: { accessToken: string; refreshToken: string; expiresAt: number; uid: string }
        _availableModels: string[]
        _modelNames: Record<string, string>
        _modelCapabilities?: Record<string, { contextWindow?: number }>
        _modelVision?: Record<string, boolean>
        _defaultModel: string
      } = {
        success: true,
        user: { name: email || 'ChatGPT', uid: accountId },
        _tokenData: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt,
          uid: accountId
        },
        _availableModels: models.availableModels,
        _modelNames: models.modelNames,
        _modelCapabilities: models.modelCapabilities,
        _modelVision: models.modelVision,
        _defaultModel: CODEX_DEFAULT_MODEL
      }

      console.log('[ChatGPT] Login successful')
      return { success: true, data: result }
    } catch (error) {
      console.error('[ChatGPT] Complete login error:', error)
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

  /**
   * Token status for the manager's ensureValidToken() flow, which runs before
   * every chat request.
   *
   * The expiry comes from the access token's own `exp` — this issuer returns no
   * `expires_in`, unlike Claude's. An unreadable one therefore reads as 0 and
   * lands on `needsRefresh`, the same direction the Claude provider's check
   * takes: refreshing a live token is cheap, serving an expired one is not.
   */
  checkTokenWithConfig(config: AISourcesConfig): { valid: boolean; expiresIn?: number; needsRefresh: boolean } {
    const c = this.conf(config)
    if (!c?.accessToken) {
      return { valid: false, needsRefresh: false }
    }
    const now = Date.now()
    const expiresAt = c.tokenExpires || 0
    return {
      valid: true,
      expiresIn: Math.max(0, expiresAt - now),
      needsRefresh: expiresAt <= now + TOKEN_REFRESH_THRESHOLD_MS
    }
  }

  /**
   * Refresh with the refresh_token grant. JSON body here — the *code* exchange
   * is form-encoded, this one is not (both per the CLI).
   *
   * Rotation: the endpoint may return a new refresh token; absent fields leave
   * the stored value untouched, matching the CLI's persist behavior.
   */
  async refreshTokenWithConfig(config: AISourcesConfig): Promise<ProviderResult<{
    accessToken: string
    refreshToken: string
    expiresAt: number
  }>> {
    const c = this.conf(config)
    if (!c?.refreshToken) {
      return { success: false, error: 'No refresh token available' }
    }

    try {
      console.log('[ChatGPT] Refreshing OAuth token')

      const response = await proxyFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: c.refreshToken
        })
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        console.error('[ChatGPT] Token refresh failed:', response.status, errorText)
        return { success: false, error: `Token refresh failed: ${response.status}` }
      }

      const json = await response.json() as {
        id_token?: string
        access_token?: string
        refresh_token?: string
      }
      if (!json.access_token) {
        return { success: false, error: 'Token refresh returned no access token' }
      }

      console.log('[ChatGPT] Token refreshed')

      return {
        success: true,
        data: {
          accessToken: json.access_token,
          refreshToken: json.refresh_token || c.refreshToken,
          expiresAt: readExpiresAt(json.access_token)
        }
      }
    } catch (error) {
      console.error('[ChatGPT] Token refresh error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to refresh token'
      }
    }
  }

  /**
   * Drop the pending flow and revoke the credential upstream.
   *
   * Revocation is best effort: the CLI also treats a failed revoke as
   * non-fatal and clears local state regardless, and the manager deletes the
   * source either way.
   */
  async logout(config?: AISourcesConfig): Promise<ProviderResult<void>> {
    this.cleanupPending()

    const refreshToken = config ? this.conf(config)?.refreshToken : undefined
    if (refreshToken) {
      try {
        await proxyFetch(REVOKE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: refreshToken,
            token_type_hint: 'refresh_token',
            client_id: CLIENT_ID
          })
        })
      } catch (error) {
        console.warn('[ChatGPT] Token revoke failed (continuing):', error)
      }
    }

    return { success: true }
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /**
   * Bind the CLI's port, falling back to its single alternate. Anything other
   * than `EADDRINUSE` is a real failure and propagates.
   */
  private async bindCallbackServer(server: http.Server): Promise<number> {
    for (const port of [DEFAULT_CALLBACK_PORT, FALLBACK_CALLBACK_PORT]) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            server.removeListener('listening', onListening)
            reject(err)
          }
          const onListening = () => {
            server.removeListener('error', onError)
            resolve()
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(port, CALLBACK_HOST)
        })
        return port
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
        console.warn(`[ChatGPT] Callback port ${port} in use, trying the fallback`)
      }
    }
    throw new Error(`Failed to bind ${CALLBACK_HOST}:${DEFAULT_CALLBACK_PORT} or ${FALLBACK_CALLBACK_PORT}`)
  }

  /** Wait for the loopback callback code, bounded by the authorize timeout. */
  private awaitAuthorizationCode(pending: PendingAuth): Promise<string> {
    const remaining = Math.max(0, AUTHORIZE_TIMEOUT_MS - (Date.now() - pending.createdAt))
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Authorization timed out')), remaining)
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

  /** Loopback callback: validate `state`, settle the pending flow with `code`. */
  private handleLoopbackRequest(req: http.IncomingMessage, res: http.ServerResponse, expectedState: string): void {
    let code = ''
    let stateParam = ''
    let errParam = ''
    try {
      const parsed = new URL(req.url || '', `http://${CALLBACK_HOST}`)
      if (!parsed.pathname.startsWith(CALLBACK_PATH)) {
        res.statusCode = 404
        res.end('Not Found')
        return
      }
      code = (parsed.searchParams.get('code') || '').trim()
      stateParam = (parsed.searchParams.get('state') || '').trim()
      errParam = (parsed.searchParams.get('error_description') || parsed.searchParams.get('error') || '').trim()
    } catch {
      // fall through to the failure branch below
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(
      '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
      '<title>Login complete</title></head><body style="font-family:system-ui,sans-serif;padding:40px;text-align:center">' +
      '<h1 style="font-size:1.25rem">Login complete</h1><p>You can return to Halo now.</p></body></html>'
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
   * Exchange the authorization code for tokens.
   *
   * Form-encoded (not JSON) and with exactly these five fields — the CLI sends
   * no more, and an extra field is a fingerprint deviation.
   */
  private async exchangeCode(code: string, pending: PendingAuth): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pending.verifier
    })

    const response = await proxyFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      console.error('[ChatGPT] Token exchange failed:', response.status, errorText)
      throw new Error(`Token exchange failed: ${response.status}`)
    }

    const json = await response.json() as {
      id_token?: string
      access_token?: string
      refresh_token?: string
    }
    if (!json.access_token) {
      throw new Error('Token exchange returned no access token')
    }

    return {
      idToken: json.id_token || '',
      accessToken: json.access_token,
      refreshToken: json.refresh_token || ''
    }
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

let providerInstance: ChatGPTProvider | null = null

export function getChatGPTProvider(): ChatGPTProvider {
  if (!providerInstance) {
    providerInstance = new ChatGPTProvider()
  }
  return providerInstance
}

export { ChatGPTProvider }
