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
import { randomBytes } from 'crypto'
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
    min = sim.idReuseMin
    max = sim.idReuseMax
    if (min > max) { const tmp = min; min = max; max = tmp }
  } else if (hasMin) {
    min = sim.idReuseMin
    max = sim.idReuseMin
  } else if (hasMax) {
    min = sim.idReuseMax
    max = sim.idReuseMax
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

// Read config once at startup so the hot path (every request) has zero I/O.
// Both idRemainingUses and idCurrentMaxAgeMs are refreshed on every rotation.
const _initSim                         = getSimulationConfig()
let currentInteractionId: string       = uuidv4()
let currentRequestId: string           = uuidv4()
let idRemainingUses: number            = weightedRandomInteractionCount(_initSim)
let isFirstRequestInCycle: boolean     = true
let idCycleStartedAt: number           = Date.now()
let idCurrentMaxAgeMs: number          = _initSim.idMaxAgeMinutes * 60 * 1000

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
function getNextRequestIds(): {
  interactionId: string
  requestId:     string
  initiator:     'user' | 'agent'
} {
  const now = Date.now()
  if (idRemainingUses <= 0 || now - idCycleStartedAt > idCurrentMaxAgeMs) {
    // Re-read config only on rotation — keeps the hot path (every request) I/O-free.
    const sim             = getSimulationConfig()
    currentInteractionId  = uuidv4()
    currentRequestId      = uuidv4()
    idRemainingUses       = weightedRandomInteractionCount(sim)
    isFirstRequestInCycle = true
    idCycleStartedAt      = now
    idCurrentMaxAgeMs     = sim.idMaxAgeMinutes * 60 * 1000
  }

  const initiator = isFirstRequestInCycle ? 'user' as const : 'agent' as const
  isFirstRequestInCycle = false
  idRemainingUses--

  return {
    interactionId: currentInteractionId,
    requestId:     currentRequestId,
    initiator
  }
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
  token:            string
  expiresAt:        number
  availableModels:  string[]
  selectedModel:    string
}

/** Lazy-loaded persistent identity (machineId + deviceId). */
let identity: CopilotIdentity | null = null

let pendingAuth:        PendingAuth        | null = null
let cachedCopilotToken: CachedCopilotToken | null = null
let cachedSessionToken: CachedSessionToken | null = null

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

  // ── Configuration ──────────────────────────────────────────────────────────

  isConfigured(config: AISourcesConfig): boolean {
    const c = config['github-copilot'] as OAuthSourceConfig | undefined
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
    const c = config['github-copilot'] as OAuthSourceConfig | undefined
    if (!c?.loggedIn || !c?.accessToken) {
      return null
    }

    const now = Date.now()

    // Use cached Copilot token when available and not expired
    const apiToken = (cachedCopilotToken && cachedCopilotToken.expiresAt > now)
      ? cachedCopilotToken.token
      : c.accessToken

    const apiBase = cachedCopilotToken?.apiEndpoint || COPILOT_API_FALLBACK

    if (!cachedCopilotToken || cachedCopilotToken.expiresAt <= now) {
      console.warn('[GitHubCopilot] No valid cached Copilot token — request may fail')
    }

    // All IDs share the same lifecycle (rotate together every 10–20 calls).
    // x-initiator is "user" on the first call in a cycle, "agent" thereafter.
    const { interactionId, requestId, initiator } = getNextRequestIds()
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

    // Include session token only when cached and valid
    if (cachedSessionToken && cachedSessionToken.expiresAt > now) {
      headers['copilot-session-token'] = cachedSessionToken.token
    }

    const model = c.model || 'gpt-4o'
    const isClaude = model.startsWith('claude-')

    if (isClaude) {
      // Claude models: use Anthropic native /v1/messages endpoint (passthrough).
      // Authorization header is injected here so fetchAnthropicUpstream skips x-api-key.
      headers['Authorization'] = `Bearer ${apiToken}`
      return {
        url:     `${apiBase}/v1/messages`,
        key:     apiToken,
        model,
        headers,
        apiType: 'anthropic_passthrough'
      }
    }

    return {
      url:     `${apiBase}/chat/completions`,
      key:     apiToken,
      model,
      headers,
      apiType: 'chat_completions'
    }
  }

  getCurrentModel(config: AISourcesConfig): string | null {
    const c = config['github-copilot'] as OAuthSourceConfig | undefined
    return c?.model || null
  }

  // ── Available Models ────────────────────────────────────────────────────────

  async getAvailableModels(config: AISourcesConfig): Promise<string[]> {
    const c = config['github-copilot'] as OAuthSourceConfig | undefined
    if (!c?.accessToken) {
      return []
    }

    try {
      const copilotToken = await this.getCopilotToken(c.accessToken)
      if (!copilotToken) {
        return c.availableModels || []
      }
      const apiBase      = cachedCopilotToken?.apiEndpoint || COPILOT_API_FALLBACK
      const requestModel = (c as OAuthSourceConfig & { model?: string }).model || 'gpt-4o'

      // Use /models with model_picker_enabled:true — this is the same filter VSCode uses
      // to populate its model picker. The server already scopes results to the auth token.
      const pickerModels = await this.fetchModelsWithToken(copilotToken, apiBase)
      if (pickerModels.length > 0) {
        return pickerModels
      }

      return c.availableModels || []
    } catch (err) {
      console.error('[GitHubCopilot] Error fetching models:', err)
      return c.availableModels || []
    }
  }

  getUserInfo(config: AISourcesConfig): AISourceUserInfo | null {
    const c = config['github-copilot'] as OAuthSourceConfig | undefined
    return c?.user || null
  }

  // ── OAuth Device Flow ───────────────────────────────────────────────────────

  async startLogin(): Promise<ProviderResult<OAuthStartResult>> {
    try {
      console.log('[GitHubCopilot] Starting device code flow')

      const response = await proxyFetch(GITHUB_DEVICE_CODE_URL, {
        method: 'POST',
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

      pendingAuth = {
        deviceCode:      data.device_code,
        userCode:        data.user_code,
        verificationUri: data.verification_uri,
        expiresAt:       Date.now() + data.expires_in * 1000,
        interval:        Math.max(data.interval, 5)
      }

      const loginUrl = `${data.verification_uri}?user_code=${data.user_code}`
      await open(loginUrl)

      console.log('[GitHubCopilot] Device code flow started, user code:', data.user_code)

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
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start login'
      }
    }
  }

  async completeLogin(state: string): Promise<ProviderResult<OAuthCompleteResult>> {
    if (!pendingAuth || pendingAuth.userCode !== state) {
      return { success: false, error: 'No pending authentication or state mismatch' }
    }

    try {
      console.log('[GitHubCopilot] Polling for authorization...')
      const startTime = Date.now()

      while (Date.now() - startTime < POLL_TIMEOUT_MS) {
        if (Date.now() > pendingAuth.expiresAt) {
          pendingAuth = null
          return { success: false, error: 'Device code expired' }
        }

        const response = await proxyFetch(GITHUB_ACCESS_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Accept':       'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent':   USER_AGENT
          },
          body: new URLSearchParams({
            client_id:   GITHUB_CLIENT_ID,
            device_code: pendingAuth.deviceCode,
            grant_type:  'urn:ietf:params:oauth:grant-type:device_code'
          })
        })

        const data: GitHubTokenResponse = await response.json()

        if (data.access_token) {
          const githubToken = data.access_token
          pendingAuth = null

          console.log('[GitHubCopilot] Got GitHub token, fetching user info...')
          const user = await this.fetchGitHubUser(githubToken)

          const copilotToken = await this.getCopilotToken(githubToken)
          if (!copilotToken) {
            return {
              success: false,
              error: 'Could not get Copilot token. Make sure you have an active Copilot subscription.'
            }
          }

          const apiBase = cachedCopilotToken?.apiEndpoint || COPILOT_API_FALLBACK

          // Fetch session token — this also returns the actual available models
          // for this account, which may be a subset of the full /models catalog.
          const defaultModel = 'gpt-4o'
          await this.fetchSessionToken(copilotToken, apiBase, defaultModel)

          // Use session's available_models as the authoritative model list
          const models = cachedSessionToken?.availableModels || [defaultModel]
          const selectedModel = cachedSessionToken?.selectedModel || defaultModel

          console.log('[GitHubCopilot] Login successful for user:', user?.login)

          const result: OAuthCompleteResult & {
            _tokenData:      { accessToken: string; refreshToken: string; expiresAt: number; uid: string }
            _availableModels: string[]
            _modelNames:      Record<string, string>
            _defaultModel:    string
          } = {
            success: true,
            user: {
              name:   user?.name || user?.login || 'GitHub User',
              avatar: user?.avatar_url,
              uid:    user?.login || ''
            },
            _tokenData: {
              accessToken:  githubToken,
              refreshToken: githubToken,
              expiresAt:    Date.now() + 365 * 24 * 60 * 60 * 1000,
              uid:          user?.login || ''
            },
            _availableModels: models,
            _modelNames:      this.getModelDisplayNames(models),
            _defaultModel:    selectedModel
          }

          return { success: true, data: result }
        }

        if (data.error === 'authorization_pending') {
          await new Promise(resolve => setTimeout(resolve, pendingAuth!.interval * 1000))
          continue
        }

        if (data.error === 'slow_down') {
          pendingAuth.interval += 5
          await new Promise(resolve => setTimeout(resolve, pendingAuth!.interval * 1000))
          continue
        }

        if (data.error === 'expired_token') {
          pendingAuth = null
          return { success: false, error: 'Device code expired. Please try again.' }
        }

        if (data.error === 'access_denied') {
          pendingAuth = null
          return { success: false, error: 'Access denied. User cancelled the authorization.' }
        }

        pendingAuth = null
        return { success: false, error: data.error_description || data.error || 'Unknown error' }
      }

      pendingAuth = null
      return { success: false, error: 'Timeout waiting for authorization' }
    } catch (error) {
      console.error('[GitHubCopilot] Complete login error:', error)
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
    cachedCopilotToken = null
    cachedSessionToken = null
    pendingAuth        = null
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
    const c = config['github-copilot'] as OAuthSourceConfig | undefined
    if (!c?.accessToken) {
      return false
    }

    const now          = Date.now()
    const requestModel = (c as OAuthSourceConfig & { model?: string }).model || 'gpt-4o'
    const copilotValid = cachedCopilotToken && cachedCopilotToken.expiresAt > now + TOKEN_REFRESH_THRESHOLD_MS

    // Session is valid only when not expired AND bound to the requested model
    const sessionValid =
      cachedSessionToken &&
      cachedSessionToken.expiresAt > now + TOKEN_REFRESH_THRESHOLD_MS &&
      cachedSessionToken.selectedModel === requestModel

    if (copilotValid && sessionValid) {
      return true
    }

    // Refresh Copilot token if needed
    const copilotToken = copilotValid
      ? cachedCopilotToken!.token
      : await this.getCopilotToken(c.accessToken)
    if (!copilotToken) {
      return false
    }

    // Re-fetch session token (either expired or model changed)
    if (!sessionValid) {
      const apiBase = cachedCopilotToken?.apiEndpoint || COPILOT_API_FALLBACK
      await this.fetchSessionToken(copilotToken, apiBase, requestModel)
    }

    return true
  }

  checkTokenWithConfig(config: AISourcesConfig): { valid: boolean; expiresIn?: number; needsRefresh: boolean } {
    const c = config['github-copilot'] as OAuthSourceConfig | undefined
    if (!c?.accessToken) {
      return { valid: false, needsRefresh: false }
    }

    const now          = Date.now()
    const requestModel = (c as OAuthSourceConfig & { model?: string }).model || 'gpt-4o'
    const needsRefresh =
      !cachedCopilotToken ||
      cachedCopilotToken.expiresAt <= now + TOKEN_REFRESH_THRESHOLD_MS ||
      !cachedSessionToken ||
      cachedSessionToken.expiresAt <= now + TOKEN_REFRESH_THRESHOLD_MS ||
      cachedSessionToken.selectedModel !== requestModel   // model switch

    return { valid: true, needsRefresh }
  }

  async refreshTokenWithConfig(config: AISourcesConfig): Promise<ProviderResult<{
    accessToken:  string
    refreshToken: string
    expiresAt:    number
  }>> {
    const c = config['github-copilot'] as OAuthSourceConfig | undefined
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
    const c = config['github-copilot'] as OAuthSourceConfig | undefined
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
        }
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  private async fetchGitHubUser(token: string): Promise<GitHubUser | null> {
    try {
      const response = await proxyFetch(GITHUB_USER_URL, {
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
  private async getCopilotToken(githubToken: string): Promise<string | null> {
    const now = Date.now()
    if (cachedCopilotToken && cachedCopilotToken.expiresAt > now + TOKEN_REFRESH_THRESHOLD_MS) {
      return cachedCopilotToken.token
    }

    try {
      const response = await proxyFetch(COPILOT_TOKEN_URL, {
        headers: {
          'Authorization':      `token ${githubToken}`,
          'Accept':             'application/json',
          'editor-version':     VSCODE_VERSION,
          'editor-plugin-version': PLUGIN_VERSION,
          'user-agent':         USER_AGENT
        }
      })

      if (!response.ok) {
        console.warn('[GitHubCopilot] Failed to get Copilot token:', response.status)
        return null
      }

      const data: CopilotTokenResponse = await response.json()

      if (data.error_details) {
        console.warn('[GitHubCopilot] Copilot token error:', data.error_details.message)
        return null
      }

      const apiEndpoint = data.endpoints?.api || COPILOT_API_FALLBACK

      // Decode token claims for diagnostics (token is a semicolon-delimited string, not JWT)
      const tokenClaims: Record<string, string> = {}
      for (const part of data.token.split(';')) {
        const eq = part.indexOf('=')
        if (eq !== -1) tokenClaims[part.slice(0, eq)] = part.slice(eq + 1)
      }
      console.log('[GitHubCopilot] Copilot token claims:', JSON.stringify({
        sku:      tokenClaims['sku'],
        ip:       tokenClaims['ip'],
        asn:      tokenClaims['asn']?.split(':')[0],
        exp:      tokenClaims['exp'],
        endpoint: apiEndpoint
      }))

      cachedCopilotToken = {
        token:       data.token,
        expiresAt:   data.expires_at * 1000,
        apiEndpoint
      }

      return data.token
    } catch (err) {
      console.error('[GitHubCopilot] Error getting Copilot token:', err)
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
    copilotToken: string,
    apiBase:      string,
    model:        string,
    /** When true, omit model_hints so the server returns all subscription models.
     *  When false (default), pass model as a hint so the session JWT's selected_model
     *  matches the target model for chat requests. */
    forListing = false
  ): Promise<void> {
    const id  = getIdentity()
    const url = `${apiBase}/models/session`

    try {
      // For listing: omit model_hints → server returns full subscription entitlements.
      // For chat:    pass model_hints → session JWT encodes the correct selected_model.
      const body = forListing
        ? { auto_mode: {} }
        : { auto_mode: { model_hints: [model] } }

      const response = await proxyFetch(url, {
        method: 'POST',
        headers: {
          'Authorization':                    `Bearer ${copilotToken}`,
          'Content-Type':                     'application/json',
          ...buildCommonCopilotHeaders(id)
        },
        body: JSON.stringify(body)
      })

      if (!response.ok) {
        console.warn('[GitHubCopilot] Failed to fetch session token:', response.status)
        return
      }

      const data: SessionTokenResponse = await response.json()

      cachedSessionToken = {
        token:           data.session_token,
        expiresAt:       data.expires_at * 1000,
        availableModels: data.available_models,
        selectedModel:   data.selected_model
      }

      console.log(
        '[GitHubCopilot] /models/session response:',
        JSON.stringify({
          selected_model:   data.selected_model,
          available_models: data.available_models,
          expires_at:       data.expires_at,
          raw_keys:         Object.keys(data)
        }, null, 2)
      )
    } catch (err) {
      console.error('[GitHubCopilot] Error fetching session token:', err)
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
