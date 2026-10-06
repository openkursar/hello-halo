/**
 * GitHub Copilot OAuth Provider
 *
 * Implements OAuth Device Code Flow for GitHub Copilot authentication.
 * Mirrors the exact request behavior of VSCode copilot-chat/0.39.1 to ensure
 * protocol-level compatibility.
 *
 * Authentication Flow:
 * 1. Request device code from GitHub
 * 2. User authorizes in browser
 * 3. Poll for access token
 * 4. Exchange GitHub token for Copilot token  (/copilot_internal/v2/token)
 * 5. Fetch session token                       (/models/session)
 * 6. Use Copilot token + session token for API calls
 */

import { proxyFetch } from '../../proxy-fetch'
import { createHash, randomBytes } from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import open from 'open'
import { getConfig, saveConfig } from '../../../foundation/config.service'
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
// Client Version Constants  (mirrors vscode/1.111.0 + copilot-chat/0.39.1)
// ============================================================================

const VSCODE_VERSION      = 'vscode/1.111.0'
const PLUGIN_VERSION      = 'copilot-chat/0.39.1'
const USER_AGENT          = 'GitHubCopilotChat/0.39.1'
const GITHUB_API_VERSION  = '2025-10-01'

/**
 * A/B experiment context snapshot matching copilot-chat/0.39.1 distribution.
 * This is a stable snapshot — the server reads it for telemetry, not for auth.
 * Update when bumping plugin version.
 */
const VSCODE_AB_EXP_CONTEXT =
  'vsliv368cf:30146710;binariesv615:30325510;ah738568:30811544;' +
  'nativeloc1:31344060;7d05f481:31460312;cg8ef616:31460313;' +
  'copilot_t_ci:31333650;pythonrdcb7:31342333;6518g693:31463988;' +
  'aj953862:31281341;82j33506:31327384;6abeh943:31336334;' +
  'envsdeactivate2:31464701;cloudbuttont:31379625;aihoversummaries_f:31469309;' +
  'upload-service:31384080;3efgi100_wstrepl:31403338;839jf696:31457053;' +
  'use-responses-api:31390855;ddidtcf:31399634;je187915:31454425;' +
  'ec5jj548:31422691;cp_cls_t_966_ss:31454198;find_all_ref_in_bg_f:31469307;' +
  '30h21147:31435638;ge8j1254_inline_auto_hint_haiku:31427726;' +
  '38bie571_auto:31426784;7a04d226_do_not_restore_last_panel_session:31438103;' +
  'cp_cls_t_1081:31454832;ia-use-proxy-models-svc:31452481;a43f0575b:31442825;' +
  'test_treatment2:31471001;nes-conv-1-3:31477813;g_63ac8346:31467999;' +
  'h17fi823:31466946;edit_mode_hidden:31461530;' +
  '864ei723_large_tool_results_to_disk:31460878;notips:31471632;' +
  '55364912:31471672;0h66b693:31473807;grok_6ec3c140:31477193;' +
  'cpptoolson-v2:31475363;4dgh1208:31471592;editor1:31474144;' +
  'db0gd219:31473911;noiconchange:31473925;'

// ============================================================================
// GitHub / Copilot Endpoints
// ============================================================================

const GITHUB_CLIENT_ID        = 'Iv1.b507a08c87ecfe98'
const GITHUB_DEVICE_CODE_URL  = 'https://github.com/login/device/code'
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL         = 'https://api.github.com/user'
const COPILOT_TOKEN_URL       = 'https://api.github.com/copilot_internal/v2/token'

/** Fallback base URL when token endpoint does not return endpoints.api */
const COPILOT_API_FALLBACK    = 'https://api.individual.githubcopilot.com'

const GITHUB_SCOPES = 'read:user'

// ============================================================================
// Polling / Timing
// ============================================================================

const POLL_INTERVAL_MS           = 5000
const POLL_TIMEOUT_MS            = 300000   // 5 minutes
const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000  // refresh 5 min before expiry
const TOKEN_REQUEST_TIMEOUT_MS = 15_000
const TOKEN_CACHE_TTL_MS = 60 * 60 * 1000
const MAX_CACHED_ACCOUNTS = 32
const MAX_CACHED_MODELS = 8

// ============================================================================
// Persistent Identity
// Stored in ~/.halo/config.json under copilot.identity, created once, never rotated.
// Mirrors vscode-machineid (hex) and editor-device-id (UUID).
// ============================================================================

interface CopilotIdentity {
  /** 64-char lowercase hex — sent as vscode-machineid */
  machineId: string
  /** UUID v4 — sent as editor-device-id */
  deviceId: string
}

/**
 * Load persistent identity from config, creating it on first run.
 * Called once lazily before the first API request.
 */
function loadOrCreateIdentity(): CopilotIdentity {
  const config = getConfig()

  const existing = config.copilot?.identity
  if (
    existing?.machineId?.length === 64 &&
    existing?.deviceId?.length >= 32
  ) {
    return existing as CopilotIdentity
  }

  const newIdentity: CopilotIdentity = {
    machineId: randomBytes(32).toString('hex'),
    deviceId:  uuidv4()
  }

  try {
    saveConfig({ copilot: { ...config.copilot, identity: newIdentity } })
  } catch (err) {
    console.warn('[GitHubCopilot] Failed to persist identity:', err)
  }

  return newIdentity
}

// ============================================================================
// Process-lifetime Session ID
// Format: {UUIDv4}{Unix-ms} — mirrors vscode-sessionid generation.
// Constant for this process lifetime, changes on every app restart.
// ============================================================================

const PROCESS_SESSION_ID = `${uuidv4()}${Date.now()}`

// ============================================================================
// Request / Interaction ID Rotation
//
// From packet captures of VSCode copilot-chat/0.39.1:
//
//   x-interaction-id  — identifies a "user conversation turn"
//   x-request-id      — identifies a "task" (one user action + all agent loops)
//   x-agent-task-id   — always equals x-request-id
//   x-initiator       — "user" on the first HTTP request, "agent" on all
//                        subsequent requests within the same task
//
// All three UUIDs share the same lifecycle: they are generated together and
// reused for a weighted-random number of HTTP requests before rotating.
// This matches the observed pattern where a single user action in agent mode
// triggers many HTTP round-trips that all share the same IDs and count as
// one quota unit.
//
// Rotation triggers (either condition is sufficient):
//   1. Use count exhausted  — weighted-random [idReuseMin, idReuseMax] per cycle
//   2. Age limit exceeded   — idMaxAgeMinutes (default 15 min) since cycle started
//      Prevents the same IDs from appearing across long idle gaps (e.g.
//      morning → afternoon), which would be far more anomalous than
//      count-based rotation alone.
//
// All parameters are configurable via config.copilot.simulation.
// Defaults: count range [10, 20] weighted toward [15, 20] at 60%, age limit 15 min.
//
// Safe partial configuration:
//   - Only idReuseMin or only idReuseMax set → treated as a fixed count (min = max).
//   - idReuseHighMin omitted → auto-computed as midpoint of [min, max].
//   - idReuseHighMin out of [min, max] → clamped into range.
//   - idReuseHighWeight out of [0, 1] → clamped.
//   - idReuseMin > idReuseMax → swapped automatically.
// ============================================================================

interface CopilotSimulation {
  idReuseMin:        number
  idReuseMax:        number
  idReuseHighMin:    number
  idReuseHighWeight: number
  /** Maximum wall-clock age of a single ID cycle in minutes (default: 15). */
  idMaxAgeMinutes:   number
}

const DEFAULT_SIMULATION: CopilotSimulation = {
  idReuseMin:        10,
  idReuseMax:        20,
  idReuseHighMin:    15,
  idReuseHighWeight: 0.6,
  idMaxAgeMinutes:   15
}

/**
 * Returns a weighted-random reuse count within [min, max].
 *
 * The range is split into two sub-ranges by highMin:
 *   - High range [highMin, max]       — chosen with probability highWeight
 *   - Low  range [min, highMin - 1]   — chosen with probability 1 - highWeight
 *
 * Within each sub-range, values are uniformly distributed.
 */
function weightedRandomInteractionCount(sim: CopilotSimulation): number {
  const { idReuseMin, idReuseMax, idReuseHighMin, idReuseHighWeight } = sim

  if (Math.random() < idReuseHighWeight) {
    // High range: [idReuseHighMin, idReuseMax]
    return idReuseHighMin + Math.floor(Math.random() * (idReuseMax - idReuseHighMin + 1))
  }
  // Low range: [idReuseMin, idReuseHighMin - 1]
  return idReuseMin + Math.floor(Math.random() * (idReuseHighMin - idReuseMin))
}

/**
 * Read simulation config from disk with safe partial-config handling.
 *
 * min/max resolution:
 *   - Both set              → use as-is; swap if reversed.
 *   - Only one set          → treat as a fixed count (min = max = that value).
 *   - Neither set           → fall back to defaults.
 *
 * highMin resolution:
 *   - Explicitly set        → clamp into [min, max].
 *   - Not set               → auto-compute as midpoint of [min, max].
 *
 * highWeight resolution:
 *   - Any value             → clamp to [0, 1].
 *
 * idMaxAgeMinutes resolution:
 *   - Positive number       → use as the cycle age limit.
 *   - Not set / ≤ 0         → fall back to default (15 min).
 */
function getSimulationConfig(): CopilotSimulation {
  const sim = getConfig().copilot?.simulation
  if (!sim) return DEFAULT_SIMULATION

  // ── min / max ──────────────────────────────────────────────────────────────
  const hasMin = sim.idReuseMin != null
  const hasMax = sim.idReuseMax != null

  let min: number
  let max: number

  if (hasMin && hasMax) {
    min = sim.idReuseMin ?? DEFAULT_SIMULATION.idReuseMin
    max = sim.idReuseMax ?? DEFAULT_SIMULATION.idReuseMax
    if (min > max) { const tmp = min; min = max; max = tmp }
  } else if (hasMin) {
    min = sim.idReuseMin ?? DEFAULT_SIMULATION.idReuseMin
    max = min
  } else if (hasMax) {
    max = sim.idReuseMax ?? DEFAULT_SIMULATION.idReuseMax
    min = max
  } else {
    min = DEFAULT_SIMULATION.idReuseMin
    max = DEFAULT_SIMULATION.idReuseMax
  }

  // ── highMin ────────────────────────────────────────────────────────────────
  const highMin = sim.idReuseHighMin != null
    ? Math.min(max, Math.max(min, sim.idReuseHighMin))
    : Math.round((min + max) / 2)

  // ── highWeight ─────────────────────────────────────────────────────────────
  const weight = sim.idReuseHighWeight != null
    ? Math.min(1, Math.max(0, sim.idReuseHighWeight))
    : DEFAULT_SIMULATION.idReuseHighWeight

  // ── idMaxAgeMinutes ────────────────────────────────────────────────────────
  const idMaxAgeMinutes = sim.idMaxAgeMinutes != null && sim.idMaxAgeMinutes > 0
    ? sim.idMaxAgeMinutes
    : DEFAULT_SIMULATION.idMaxAgeMinutes

  return { idReuseMin: min, idReuseMax: max, idReuseHighMin: highMin, idReuseHighWeight: weight, idMaxAgeMinutes }
}

interface RequestIds {
  interactionId: string
  requestId: string
  remainingUses: number
  firstRequest: boolean
  startedAt: number
  maxAgeMs: number
}

function createRequestIds(): RequestIds {
  const sim = getSimulationConfig()
  return {
    interactionId: uuidv4(),
    requestId: uuidv4(),
    remainingUses: weightedRandomInteractionCount(sim),
    firstRequest: true,
    startedAt: Date.now(),
    maxAgeMs: sim.idMaxAgeMinutes * 60 * 1000
  }
}

/**
 * Returns the current set of per-request IDs and advances the state.
 *
 * On the first call after a rotation: x-initiator = "user"
 * On subsequent calls in the same cycle: x-initiator = "agent"
 *
 * Rotation is triggered when either condition is met:
 *   - Use count reaches zero (weighted-random [idReuseMin, idReuseMax] per cycle)
 *   - Current cycle has been alive for more than idMaxAgeMinutes (default 15 min)
 *
 * Simulation parameters are re-read from config on each rotation,
 * so config changes take effect at the next cycle without restart.
 */
function getNextRequestIds(ids: RequestIds): {
  interactionId: string
  requestId: string
  initiator: 'user' | 'agent'
} {
  if (ids.remainingUses <= 0 || Date.now() - ids.startedAt > ids.maxAgeMs) {
    Object.assign(ids, createRequestIds())
  }
  const initiator = ids.firstRequest ? 'user' as const : 'agent' as const
  ids.firstRequest = false
  ids.remainingUses--
  return { interactionId: ids.interactionId, requestId: ids.requestId, initiator }
}

// ============================================================================
// Module-level State
// ============================================================================

interface PendingAuth {
  deviceCode:       string
  userCode:         string
  verificationUri:  string
  expiresAt:        number
  interval:         number
}

interface CachedCopilotToken {
  token:       string
  expiresAt:   number
  apiEndpoint: string   // from token response endpoints.api, or COPILOT_API_FALLBACK
}

interface CachedSessionToken {
  token: string
  expiresAt: number
  availableModels: string[]
  selectedModel: string
  copilotToken: CachedCopilotToken
}

interface SessionCacheEntry {
  token?: CachedSessionToken
  pending?: Promise<CachedSessionToken | null>
}

interface AccountTokenCache {
  sourceId: string
  credentialId: string
  lastUsedAt: number
  copilot?: CachedCopilotToken
  pendingCopilot?: Promise<CachedCopilotToken | null>
  sessions: Map<string, SessionCacheEntry>
  requestIds: RequestIds
}

function credentialFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Lazy-loaded persistent identity (machineId + deviceId). */
let identity: CopilotIdentity | null = null

/** Ensure identity is loaded exactly once. */
function getIdentity(): CopilotIdentity {
  if (!identity) {
    identity = loadOrCreateIdentity()
  }
  return identity
}

// ============================================================================
// Response Types
// ============================================================================

interface DeviceCodeResponse {
  device_code:      string
  user_code:        string
  verification_uri: string
  expires_in:       number
  interval:         number
}

interface GitHubTokenResponse {
  access_token?:      string
  token_type?:        string
  scope?:             string
  error?:             string
  error_description?: string
}

interface CopilotTokenResponse {
  token:        string
  expires_at:   number
  refresh_in:   number
  endpoints?: {
    api:              string
    origin_tracker?:  string
    telemetry?:       string
  }
  error_details?: {
    message: string
  }
}

interface SessionTokenResponse {
  available_models: string[]
  selected_model:   string
  session_token:    string
  expires_at:       number
}

interface GitHubUser {
  login:      string
  id:         number
  avatar_url: string
  name:       string | null
}

interface CopilotModel {
  id:                   string
  name:                 string
  version:              string
  model_picker_enabled?: boolean
  capabilities?: {
    family?: string
    type?:   string
  }
}

// ============================================================================
// Header Builders
// ============================================================================

/**
 * Headers common to every request sent to api.individual.githubcopilot.com.
 * Does NOT include Authorization, Content-Type (added by fetch layer),
 * or request-specific headers.
 */
function buildCommonCopilotHeaders(id: CopilotIdentity): Record<string, string> {
  return {
    'copilot-integration-id':             'vscode-chat',
    'editor-device-id':                   id.deviceId,
    'editor-plugin-version':              PLUGIN_VERSION,
    'editor-version':                     VSCODE_VERSION,
    'user-agent':                         USER_AGENT,
    'vscode-abexpcontext':                VSCODE_AB_EXP_CONTEXT,
    'vscode-machineid':                   id.machineId,
    'vscode-sessionid':                   PROCESS_SESSION_ID,
    'x-github-api-version':               GITHUB_API_VERSION,
    'x-vscode-user-agent-library-version':'electron-fetch',
    'sec-fetch-site':                     'none',
    'sec-fetch-mode':                     'no-cors',
    'sec-fetch-dest':                     'empty',
    'priority':                           'u=4, i'
  }
}

// ============================================================================
// GitHub Copilot Provider Implementation
// ============================================================================

class GitHubCopilotProvider implements OAuthAISourceProvider {
  readonly type: AISourceType = 'github-copilot'
  readonly displayName = 'GitHub Copilot'

  private pendingAuth: PendingAuth | null = null
  private startingLogin: object | null = null
  private readonly tokenCache = new Map<string, AccountTokenCache>()

  private conf(config: AISourcesConfig): OAuthSourceConfig | undefined {
    return (config as unknown as Record<string, OAuthSourceConfig | undefined>)['github-copilot']
  }

  private cacheKey(c: OAuthSourceConfig): string {
    const credentialId = credentialFingerprint(c.accessToken!)
    return JSON.stringify([c.sourceId || credentialId, credentialId])
  }

  private ownsEntry(entry: AccountTokenCache): boolean {
    return this.tokenCache.get(JSON.stringify([entry.sourceId, entry.credentialId])) === entry
  }

  private releaseEntry(key: string, entry: AccountTokenCache): void {
    if (this.tokenCache.get(key) !== entry) return
    this.tokenCache.delete(key)
    entry.copilot = undefined
    entry.pendingCopilot = undefined
    entry.sessions.clear()
  }

  private getCache(c: OAuthSourceConfig, create = false): AccountTokenCache | undefined {
    const now = Date.now()
    for (const [key, entry] of this.tokenCache) {
      if (now - entry.lastUsedAt >= TOKEN_CACHE_TTL_MS) this.releaseEntry(key, entry)
    }
    const key = this.cacheKey(c)
    let entry = this.tokenCache.get(key)
    if (!entry && create) {
      if (c.sourceId) {
        for (const [oldKey, old] of this.tokenCache) {
          if (old.sourceId === c.sourceId) this.releaseEntry(oldKey, old)
        }
      }
      while (this.tokenCache.size >= MAX_CACHED_ACCOUNTS) {
        const oldest = this.tokenCache.entries().next().value as [string, AccountTokenCache]
        this.releaseEntry(...oldest)
      }
      const credentialId = credentialFingerprint(c.accessToken!)
      entry = {
        sourceId: c.sourceId || credentialId,
        credentialId,
        lastUsedAt: now,
        sessions: new Map(),
        requestIds: createRequestIds()
      }
    }
    if (entry) {
      entry.lastUsedAt = now
      this.tokenCache.delete(key)
      this.tokenCache.set(key, entry)
    }
    return entry
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  isConfigured(config: AISourcesConfig): boolean {
    const c = this.conf(config)
    return !!(c?.loggedIn && c?.accessToken)
  }

  /**
   * Build the BackendRequestConfig for each outgoing chat request.
   *
   * Authorization and Content-Type are injected by fetchUpstream(), so they
   * must NOT appear in headers here to avoid duplication.
   *
   * Per-request UUIDs (x-request-id, x-agent-task-id) are generated fresh on
   * every call. x-interaction-id rotates after a weighted-random 10–20 uses.
   */
  getBackendConfig(config: AISourcesConfig): BackendRequestConfig | null {
    const c = this.conf(config)
    if (!c?.loggedIn || !c?.accessToken) {
      return null
    }

    const now = Date.now()
    const model = c.model || 'gpt-4o'
    const entry = this.getCache(c)
    const copilot = entry?.copilot
    const session = entry?.sessions.get(model)?.token
    if (!entry || !copilot || copilot.expiresAt <= now || !session || session.expiresAt <= now ||
        session.selectedModel !== model || session.copilotToken !== copilot) {
      console.warn('[GitHubCopilot] Backend config unavailable: account/model tokens missing or expired')
      return null
    }
    const apiToken = copilot.token
    const apiBase = copilot.apiEndpoint
    const { interactionId, requestId, initiator } = getNextRequestIds(entry.requestIds)
    const id = getIdentity()

    const headers: Record<string, string> = {
      ...buildCommonCopilotHeaders(id),
      'openai-intent':      'conversation-agent',
      'x-agent-task-id':    requestId,
      'x-initiator':        initiator,
      'x-interaction-id':   interactionId,
      'x-interaction-type': 'conversation-agent',
      'x-request-id':       requestId
    }

    headers['copilot-session-token'] = session.token

    const isClaude = model.startsWith('claude-')

    if (isClaude) {
      // Claude models: use Anthropic native /v1/messages endpoint (passthrough).
      // Authorization header is injected here so fetchAnthropicUpstream skips x-api-key.
      headers['Authorization'] = `Bearer ${apiToken}`
      return {
        sourceId: c.sourceId,
        url:     `${apiBase}/v1/messages`,
        key:     apiToken,
        model,
        headers,
        apiType: 'anthropic_passthrough'
      }
    }

    return {
      sourceId: c.sourceId,
      url:     `${apiBase}/chat/completions`,
      key:     apiToken,
      model,
      headers,
      apiType: 'chat_completions'
    }
  }

  getCurrentModel(config: AISourcesConfig): string | null {
    const c = this.conf(config)
    return c?.model || null
  }

  // ── Available Models ────────────────────────────────────────────────────────

  async getAvailableModels(config: AISourcesConfig): Promise<string[]> {
    const c = this.conf(config)
    if (!c?.accessToken) {
      return []
    }

    try {
      const entry = this.getCache(c, true)!
      const copilot = await this.getCopilotToken(entry, c.accessToken)
      if (!copilot) return c.availableModels || []

      const pickerModels = await this.fetchModelsWithToken(copilot.token, copilot.apiEndpoint)
      if (!this.ownsEntry(entry) || entry.copilot !== copilot) {
        console.warn('[GitHubCopilot] Model catalog discarded: credential cache released or token replaced')
        return c.availableModels || []
      }
      return pickerModels.length > 0 ? pickerModels : c.availableModels || []
    } catch (err) {
      console.error('[GitHubCopilot] Error fetching models:', err)
      return c.availableModels || []
    }
  }

  getUserInfo(config: AISourcesConfig): AISourceUserInfo | null {
    const c = this.conf(config)
    return c?.user || null
  }

  // ── OAuth Device Flow ───────────────────────────────────────────────────────

  async startLogin(): Promise<ProviderResult<OAuthStartResult>> {
    const attempt = {}
    this.startingLogin = attempt
    this.pendingAuth = null
    let pending: PendingAuth | undefined
    try {
      console.log('[GitHubCopilot] Starting device code flow')

      const response = await proxyFetch(GITHUB_DEVICE_CODE_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        headers: {
          'Accept':       'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   USER_AGENT
        },
        body: new URLSearchParams({
          client_id: GITHUB_CLIENT_ID,
          scope:     GITHUB_SCOPES
        })
      })

      if (!response.ok) {
        throw new Error(`Failed to request device code: ${response.status}`)
      }

      const data: DeviceCodeResponse = await response.json()
      if (typeof data.device_code !== 'string' || !data.device_code ||
          typeof data.user_code !== 'string' || !data.user_code ||
          typeof data.verification_uri !== 'string' || !data.verification_uri ||
          !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
        throw new Error('Invalid device code response')
      }

      if (this.startingLogin !== attempt) {
        console.warn('[GitHubCopilot] Login start discarded: authorization cancelled or replaced')
        return { success: false, error: 'Authentication cancelled' }
      }
      pending = {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresAt: Date.now() + data.expires_in * 1000,
        interval: Number.isFinite(data.interval)
          ? Math.max(data.interval, POLL_INTERVAL_MS / 1000) : POLL_INTERVAL_MS / 1000
      }
      this.pendingAuth = pending

      const loginUrl = `${data.verification_uri}?user_code=${data.user_code}`
      await open(loginUrl)
      if (this.pendingAuth !== pending) {
        console.warn('[GitHubCopilot] Login start discarded: authorization cancelled or replaced')
        return { success: false, error: 'Authentication cancelled' }
      }

      console.log('[GitHubCopilot] Device code flow started')

      return {
        success: true,
        data: {
          loginUrl,
          state:           data.user_code,
          userCode:        data.user_code,
          verificationUri: data.verification_uri
        }
      }
    } catch (error) {
      console.error('[GitHubCopilot] Start login error:', error)
      if (pending && this.pendingAuth === pending) this.pendingAuth = null
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start login'
      }
    } finally {
      if (this.startingLogin === attempt) this.startingLogin = null
    }
  }

  async completeLogin(state: string): Promise<ProviderResult<OAuthCompleteResult>> {
    const pending = this.pendingAuth
    if (!pending || pending.userCode !== state) {
      console.warn('[GitHubCopilot] Login completion rejected: no pending authentication or state mismatch')
      return { success: false, error: 'No pending authentication or state mismatch' }
    }

    let loginEntry: AccountTokenCache | undefined
    try {
      const deadline = Math.min(pending.expiresAt, Date.now() + POLL_TIMEOUT_MS)
      while (Date.now() < deadline) {
        this.requirePending(pending)
        const response = await proxyFetch(GITHUB_ACCESS_TOKEN_URL, {
          method: 'POST',
          signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT
          },
          body: new URLSearchParams({
            client_id: GITHUB_CLIENT_ID,
            device_code: pending.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          })
        })
        if (!response.ok) throw new Error(`Authorization polling failed: ${response.status}`)
        const data: GitHubTokenResponse = await response.json()
        this.requirePending(pending)

        if (data.access_token) {
          const githubToken = data.access_token
          const user = await this.fetchGitHubUser(githubToken)
          this.requirePending(pending)
          const provisional: OAuthSourceConfig = {
            sourceId: uuidv4(),
            loggedIn: true,
            accessToken: githubToken,
            model: 'gpt-4o',
            availableModels: []
          }
          const entry = this.getCache(provisional, true)!
          loginEntry = entry
          const copilot = await this.getCopilotToken(entry, githubToken)
          this.requirePending(pending)
          if (!copilot) {
            throw new Error('Could not get Copilot token. Make sure you have an active Copilot subscription.')
          }
          const session = await this.fetchSessionToken(entry, copilot, provisional.model)
          this.requirePending(pending)
          if (!session) throw new Error('Could not get a usable Copilot session token')

          const uid = typeof user?.id === 'number' && Number.isSafeInteger(user.id) && user.id > 0
            ? String(user.id) : ''
          if (!uid) console.warn('[GitHubCopilot] Login completed without verified account identity')
          const result: OAuthCompleteResult & {
            _tokenData: { accessToken: string; refreshToken: string; expiresAt: number; uid: string }
            _availableModels: string[]
            _modelNames: Record<string, string>
            _defaultModel: string
          } = {
            success: true,
            user: {
              name: user?.name || user?.login || 'GitHub User',
              avatar: user?.avatar_url,
              uid
            },
            _tokenData: {
              accessToken: githubToken,
              refreshToken: githubToken,
              expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
              uid
            },
            _availableModels: session.availableModels,
            _modelNames: this.getModelDisplayNames(session.availableModels),
            _defaultModel: session.selectedModel
          }
          console.log('[GitHubCopilot] OAuth login completed')
          return { success: true, data: result }
        }

        if (data.error === 'authorization_pending' || data.error === 'slow_down') {
          if (data.error === 'slow_down') pending.interval += 5
          await new Promise(resolve => setTimeout(resolve, Math.min(pending.interval * 1000, deadline - Date.now())))
          continue
        }
        if (data.error === 'expired_token') throw new Error('Device code expired. Please try again.')
        if (data.error === 'access_denied') throw new Error('Access denied. User cancelled the authorization.')
        throw new Error('Authorization polling returned an unexpected response')
      }
      throw new Error('Timeout waiting for authorization')
    } catch (error) {
      console.error('[GitHubCopilot] Complete login error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to complete login'
      }
    } finally {
      if (this.pendingAuth === pending) this.pendingAuth = null
      if (loginEntry) {
        this.releaseEntry(JSON.stringify([loginEntry.sourceId, loginEntry.credentialId]), loginEntry)
      }
    }
  }

  private requirePending(pending: PendingAuth): void {
    if (this.pendingAuth !== pending) throw new Error('Authentication cancelled')
  }

  async refreshToken(): Promise<ProviderResult<void>> {
    return { success: true }
  }

  async checkToken(): Promise<ProviderResult<{ valid: boolean; expiresIn?: number }>> {
    return { success: true, data: { valid: true } }
  }

  async cancelLogin(): Promise<ProviderResult<void>> {
    this.pendingAuth = null
    this.startingLogin = null
    return { success: true }
  }

  async logout(config?: AISourcesConfig): Promise<ProviderResult<void>> {
    const c = config && this.conf(config)
    if (c?.sourceId || c?.accessToken) {
      const credentialId = c.accessToken ? credentialFingerprint(c.accessToken) : undefined
      for (const [key, entry] of this.tokenCache) {
        if (c.sourceId ? entry.sourceId === c.sourceId : entry.credentialId === credentialId) {
          this.releaseEntry(key, entry)
        }
      }
    }
    return { success: true }
  }

  // ── Token Management ────────────────────────────────────────────────────────

  /**
   * Ensure both the Copilot token and the session token are cached and fresh.
   * Called from the manager's ensureValidToken() before every chat request.
   *
   * Session tokens are bound to a specific model (selected_model in the JWT).
   * When the user switches models, we must re-fetch the session token with the
   * new model_hints so the backend accepts the request.
   */
  async ensureCopilotTokenCached(config: AISourcesConfig): Promise<boolean> {
    const c = this.conf(config)
    if (!c?.accessToken) {
      return false
    }

    const requestModel = c.model || 'gpt-4o'
    const entry = this.getCache(c, true)!
    const copilot = await this.getCopilotToken(entry, c.accessToken)
    if (!copilot) return false
    const session = await this.fetchSessionToken(entry, copilot, requestModel)
    return !!session && this.ownsEntry(entry) && entry.copilot === copilot &&
      entry.sessions.get(requestModel)?.token === session
  }

  checkTokenWithConfig(config: AISourcesConfig): { valid: boolean; expiresIn?: number; needsRefresh: boolean } {
    const c = this.conf(config)
    if (!c?.accessToken) {
      return { valid: false, needsRefresh: false }
    }

    const now = Date.now()
    const model = c.model || 'gpt-4o'
    const entry = this.getCache(c)
    const copilot = entry?.copilot
    const session = entry?.sessions.get(model)?.token
    const needsRefresh =
      !copilot || copilot.expiresAt <= now + TOKEN_REFRESH_THRESHOLD_MS ||
      !session || session.expiresAt <= now + TOKEN_REFRESH_THRESHOLD_MS ||
      session.selectedModel !== model || session.copilotToken !== copilot

    return { valid: true, needsRefresh }
  }

  async refreshTokenWithConfig(config: AISourcesConfig): Promise<ProviderResult<{
    accessToken:  string
    refreshToken: string
    expiresAt:    number
  }>> {
    const c = this.conf(config)
    if (!c?.accessToken) {
      return { success: false, error: 'No token to refresh' }
    }

    const success = await this.ensureCopilotTokenCached(config)
    if (!success) {
      return { success: false, error: 'Failed to refresh Copilot token' }
    }

    return {
      success: true,
      data: {
        accessToken:  c.accessToken,
        refreshToken: c.refreshToken || c.accessToken,
        expiresAt:    c.tokenExpires || Date.now() + 365 * 24 * 60 * 60 * 1000
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
          'github-copilot': {
            ...c,
            availableModels: models,
            modelNames: this.getModelDisplayNames(models)
          }
        } as unknown as Partial<AISourcesConfig>
      }
    } catch (error) {
      console.warn('[GitHubCopilot] Model catalog refresh failed')
      return { success: false, error: String(error) }
    }
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  async getAccountId(config: AISourcesConfig): Promise<string | null> {
    const token = this.conf(config)?.accessToken
    if (!token) return null
    const user = await this.fetchGitHubUser(token)
    return typeof user?.id === 'number' && Number.isSafeInteger(user.id) && user.id > 0
      ? String(user.id) : null
  }

  private async fetchGitHubUser(token: string): Promise<GitHubUser | null> {
    try {
      const response = await proxyFetch(GITHUB_USER_URL, {
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        'application/json',
          'User-Agent':    USER_AGENT
        }
      })
      if (!response.ok) {
        console.warn('[GitHubCopilot] Failed to fetch user:', response.status)
        return null
      }
      return await response.json()
    } catch (err) {
      console.error('[GitHubCopilot] Error fetching user:', err)
      return null
    }
  }

  /**
   * Exchange a GitHub OAuth token for a short-lived Copilot token (~30 min).
   * Results are cached; re-fetched when within TOKEN_REFRESH_THRESHOLD_MS of expiry.
   */
  private async getCopilotToken(entry: AccountTokenCache, githubToken: string): Promise<CachedCopilotToken | null> {
    if (!this.ownsEntry(entry)) {
      console.warn('[GitHubCopilot] Token exchange skipped: credential cache released')
      return null
    }
    if (entry.copilot && entry.copilot.expiresAt > Date.now() + TOKEN_REFRESH_THRESHOLD_MS) {
      return entry.copilot
    }
    if (entry.pendingCopilot) return entry.pendingCopilot

    const exchange = this.exchangeCopilotToken(entry, githubToken)
    entry.pendingCopilot = exchange
    try {
      return await exchange
    } finally {
      if (entry.pendingCopilot === exchange) entry.pendingCopilot = undefined
    }
  }

  private async exchangeCopilotToken(entry: AccountTokenCache, githubToken: string): Promise<CachedCopilotToken | null> {
    try {
      const response = await proxyFetch(COPILOT_TOKEN_URL, {
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        headers: {
          'Authorization': `token ${githubToken}`,
          'Accept': 'application/json',
          'editor-version': VSCODE_VERSION,
          'editor-plugin-version': PLUGIN_VERSION,
          'user-agent': USER_AGENT
        }
      })
      if (!response.ok) {
        console.warn('[GitHubCopilot] Failed to get Copilot token:', response.status)
        return null
      }
      const data: CopilotTokenResponse = await response.json()
      if (data.error_details || typeof data.token !== 'string' || !data.token ||
          !Number.isFinite(data.expires_at) || data.expires_at * 1000 <= Date.now()) {
        console.warn('[GitHubCopilot] Copilot token rejected: missing token, expired token or upstream error')
        return null
      }
      if (!this.ownsEntry(entry)) {
        console.warn('[GitHubCopilot] Token exchange discarded: credential cache released')
        return null
      }
      const token: CachedCopilotToken = {
        token: data.token,
        expiresAt: data.expires_at * 1000,
        apiEndpoint: data.endpoints?.api || COPILOT_API_FALLBACK
      }
      entry.copilot = token
      entry.sessions.clear()
      return token
    } catch {
      console.warn('[GitHubCopilot] Copilot token exchange failed or timed out')
      return null
    }
  }

  /**
   * Obtain a session token from POST {apiBase}/models/session.
   *
   * The session token (copilot-session-token) is a short-lived ES256 JWT
   * (~1 h) that encodes the available models and selected model for this
   * session. It must be included in every chat completion request.
   *
   * Request mirrors the exact headers sent by copilot-chat/0.39.1.
   */
  private async fetchSessionToken(
    entry: AccountTokenCache,
    copilot: CachedCopilotToken,
    model: string
  ): Promise<CachedSessionToken | null> {
    if (!this.ownsEntry(entry) || entry.copilot !== copilot) {
      console.warn('[GitHubCopilot] Session exchange skipped: credential cache released or token replaced')
      return null
    }
    let session = entry.sessions.get(model)
    if (session) {
      entry.sessions.delete(model)
      entry.sessions.set(model, session)
      if (session.token && session.token.expiresAt > Date.now() + TOKEN_REFRESH_THRESHOLD_MS &&
          session.token.selectedModel === model && session.token.copilotToken === copilot) {
        return session.token
      }
      if (session.pending) return session.pending
    } else {
      while (entry.sessions.size >= MAX_CACHED_MODELS) {
        entry.sessions.delete(entry.sessions.keys().next().value as string)
      }
      session = {}
      entry.sessions.set(model, session)
    }
    const exchange = this.exchangeSessionToken(entry, session, copilot, model)
    session.pending = exchange
    try {
      return await exchange
    } finally {
      if (session.pending === exchange) session.pending = undefined
    }
  }

  private async exchangeSessionToken(
    entry: AccountTokenCache,
    session: SessionCacheEntry,
    copilot: CachedCopilotToken,
    model: string
  ): Promise<CachedSessionToken | null> {
    try {
      const response = await proxyFetch(`${copilot.apiEndpoint}/models/session`, {
        method: 'POST',
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        headers: {
          'Authorization': `Bearer ${copilot.token}`,
          'Content-Type': 'application/json',
          ...buildCommonCopilotHeaders(getIdentity())
        },
        body: JSON.stringify({ auto_mode: { model_hints: [model] } })
      })
      if (!response.ok) {
        console.warn('[GitHubCopilot] Failed to fetch session token:', response.status)
        return null
      }
      const data: SessionTokenResponse = await response.json()
      if (typeof data.session_token !== 'string' || !data.session_token ||
          !Number.isFinite(data.expires_at) || data.expires_at * 1000 <= Date.now() ||
          data.selected_model !== model || !Array.isArray(data.available_models)) {
        console.warn('[GitHubCopilot] Session token rejected: invalid token, expiry or selected model')
        return null
      }
      if (!this.ownsEntry(entry) || entry.sessions.get(model) !== session || entry.copilot !== copilot) {
        console.warn('[GitHubCopilot] Session exchange discarded: credential/model cache released or replaced')
        return null
      }
      const token: CachedSessionToken = {
        token: data.session_token,
        expiresAt: data.expires_at * 1000,
        availableModels: data.available_models.filter(id => typeof id === 'string'),
        selectedModel: data.selected_model,
        copilotToken: copilot
      }
      session.token = token
      return token
    } catch {
      console.warn('[GitHubCopilot] Session token exchange failed or timed out')
      return null
    }
  }

  /**
   * Fetch the full model list from GET {apiBase}/models.
   * Uses the same base URL returned by the Copilot token endpoint.
   */
  private async fetchModelsWithToken(copilotToken: string, apiBase: string): Promise<string[]> {
    const id      = getIdentity()
    const url     = `${apiBase}/models`
    const reqId   = uuidv4()

    try {
      console.log('[GitHubCopilot] Fetching models from:', url)

      const response = await proxyFetch(url, {
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        headers: {
          'Authorization':      `Bearer ${copilotToken}`,
          ...buildCommonCopilotHeaders(id),
          'openai-intent':      'model-access',
          'x-agent-task-id':    reqId,
          'x-interaction-type': 'model-access',
          'x-request-id':       reqId
        }
      })

      if (!response.ok) {
        console.warn('[GitHubCopilot] Failed to fetch models:', response.status, response.statusText)
        return []
      }

      const data = await response.json()

      // Response format: { data: [...] }  or  { models: [...] }
      const models: CopilotModel[] = data.data || data.models || []

      if (!Array.isArray(models) || models.length === 0) {
        console.warn('[GitHubCopilot] No models in response')
        return []
      }

      // Log all chat models with their picker status for diagnostics
      const allChatModels = models.filter(m => m.capabilities?.type === 'chat' || !m.capabilities?.type)
      console.log('[GitHubCopilot] /models all chat models:',
        allChatModels.map(m => `${m.id} [picker=${m.model_picker_enabled ?? 'absent'}]`)
      )

      // model_picker_enabled:true is the field VSCode uses to decide which models
      // to show in the picker — already scoped by the server to the auth token.
      // Fall back to type==='chat' filter if the field is absent (older API response).
      const pickerModels = models.filter(m =>
        m.model_picker_enabled === true && m.capabilities?.type === 'chat'
      )
      const fallbackModels = pickerModels.length > 0
        ? pickerModels
        : models.filter(m => m.capabilities?.type === 'chat' || !m.capabilities?.type)

      const ids = fallbackModels.map(m => m.id)
      console.log('[GitHubCopilot] /models picker-enabled ids:', ids)
      return ids
    } catch (err) {
      console.error('[GitHubCopilot] Error fetching models:', err)
      return []
    }
  }

  private getModelDisplayNames(models: string[]): Record<string, string> {
    const known: Record<string, string> = {
      // GPT-5 family
      'gpt-5-mini':                'GPT-5 mini',
      'gpt-5.1':                   'GPT-5.1',
      'gpt-5.2':                   'GPT-5.2',
      'gpt-5.2-codex':             'GPT-5.2-Codex',
      'gpt-5.3-codex':             'GPT-5.3-Codex',
      'gpt-5.4':                   'GPT-5.4',
      'gpt-5.1-codex':             'GPT-5.1-Codex',
      'gpt-5.1-codex-mini':        'GPT-5.1-Codex-Mini',
      'gpt-5.1-codex-max':         'GPT-5.1-Codex-Max',
      // GPT-4 family
      'gpt-4o':                    'GPT-4o',
      'gpt-4o-mini':               'GPT-4o mini',
      'gpt-4o-mini-2024-07-18':    'GPT-4o mini',
      'gpt-4.1':                   'GPT-4.1',
      'gpt-4-turbo':               'GPT-4 Turbo',
      // Claude family
      'claude-3.5-sonnet':         'Claude 3.5 Sonnet',
      'claude-3-opus':             'Claude 3 Opus',
      'claude-sonnet-4':           'Claude Sonnet 4',
      'claude-sonnet-4.5':         'Claude Sonnet 4.5',
      'claude-sonnet-4.6':         'Claude Sonnet 4.6',
      'claude-haiku-4.5':          'Claude Haiku 4.5',
      'claude-opus-4.5':           'Claude Opus 4.5',
      'claude-opus-4.6':           'Claude Opus 4.6',
      // o-series
      'o1':                        'o1',
      'o1-mini':                   'o1 Mini',
      'o3-mini':                   'o3 mini',
      'o4-mini':                   'o4 mini',
      // Gemini family
      'gemini-2.5-pro':            'Gemini 2.5 Pro',
      'gemini-3-pro-preview':      'Gemini 3 Pro (Preview)',
      'gemini-3-flash-preview':    'Gemini 3 Flash (Preview)',
      'gemini-3.1-pro-preview':    'Gemini 3.1 Pro (Preview)',
      // Other
      'grok-code-fast-1':          'Grok Code Fast 1',
      'oswe-vscode-prime':         'Raptor mini (Preview)',
      'oswe-vscode-secondary':     'Raptor mini (Preview)',
      'raptor-mini-tertiary':      'Raptor mini'
    }

    const result: Record<string, string> = {}
    for (const id of models) {
      result[id] = known[id] || id
    }
    return result
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

let providerInstance: GitHubCopilotProvider | null = null

export function getGitHubCopilotProvider(): GitHubCopilotProvider {
  if (!providerInstance) {
    providerInstance = new GitHubCopilotProvider()
  }
  return providerInstance
}

export { GitHubCopilotProvider }
