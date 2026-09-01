/**
 * Agent Module - SDK Configuration Builder
 *
 * Pure functions for building SDK configuration.
 * Centralizes all SDK-related configuration logic to ensure consistency
 * between send-message.ts and session-manager.ts.
 */

import path from 'path'
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { app } from 'electron'
import { resolveClaudeConfigDir, getConfig } from '../../foundation/config.service'
import {
  ensureOpenAICompatRouter,
  encodeBackendConfig,
  decodeBackendConfig,
  DELEGATED_ROUTING_HEADER
} from '../../openai-compat-router'
import type { ApiCredentials, ResolvedModelCapabilities } from './types'
import { inferOpenAIWireApi, credentialsToBackendConfig, getHeadlessElectronPath } from './helpers'
import { resolveModelId } from '../../../shared/types/ai-sources'
import { buildSystemPrompt, DEFAULT_ALLOWED_TOOLS } from './system-prompt'
import { createCanUseTool } from './permission-handler'
import { DEFAULT_DISABLED_TOOLS, TEAM_TOOLS } from '../../../shared/constants/disabled-tools'
import {
  MAX_OUTPUT_TOKENS_HARD_MIN,
  MAX_OUTPUT_TOKENS_HARD_CAP,
  RECOMMENDED_MIN_MAX_OUTPUT_TOKENS,
  CONTEXT_WINDOW_HARD_MIN,
  CONTEXT_WINDOW_HARD_CAP,
} from '../../../shared/constants/model-runtime-limits'

// ============================================
// Configuration
// ============================================

/**
 * When true, Anthropic requests route through the local router for interceptor
 * coverage (warmup, preflight, etc.) with zero-conversion passthrough.
 * When false, Anthropic requests go directly to the API via the SDK's built-in
 * HTTP client — no router, no interceptors, no overhead.
 *
 * Toggle this to A/B test proxy overhead vs direct SDK performance.
 * OpenAI/OAuth providers always route through the router regardless of this flag.
 */
const PROXY_ANTHROPIC = true

// ============================================
// Types
// ============================================

/**
 * Resolved credentials ready for SDK use.
 * This is the output of credential resolution process.
 */
export interface ResolvedSdkCredentials {
  /** Base URL for Anthropic API (may be OpenAI compat router) */
  anthropicBaseUrl: string
  /** API key for Anthropic API (may be encoded backend config) */
  anthropicApiKey: string
  /** Model to pass to SDK (may be fake Claude model for compat) */
  sdkModel: string
  /** User's actual configured model name (for display) */
  displayModel: string
  /**
   * Effective per-model capability numbers (preset + user override merged).
   * Carried through to buildSdkEnv so CLI subprocess env reflects what the
   * user actually configured in Settings > Provider > Model Config.
   */
  capabilities?: ResolvedModelCapabilities
  /**
   * Backend routing identity for delegated sources, as a `Name: value` header
   * line. Present only when the CLI subprocess authenticates itself: the auth
   * channel then carries its own OAuth token, so the router cannot recover the
   * backend from `x-api-key` and reads this header instead.
   */
  delegatedRoutingHeader?: string
}

/**
 * Parameters for building SDK environment variables
 */
export interface SdkEnvParams {
  anthropicApiKey: string
  anthropicBaseUrl: string
  /** See ResolvedSdkCredentials.delegatedRoutingHeader. */
  delegatedRoutingHeader?: string
  /** Claude CLI config directory mode */
  configDirMode?: 'halo' | 'cc' | 'custom'
  /** Custom config dir path (when configDirMode === 'custom') */
  customConfigDir?: string
  /** Enable Agent Teams (multi-agent collaboration) */
  enableTeams?: boolean
  /**
   * Resolved per-model capability numbers (preset + user override merged).
   * When present, drives CLAUDE_CODE_MAX_OUTPUT_TOKENS and
   * CLAUDE_CODE_AUTO_COMPACT_WINDOW env injection so the CC subprocess
   * honors what the user configured in Settings > Provider > Model Config.
   * When absent, no env override is injected (callers like api-validator
   * that don't have a resolved model can omit this safely).
   */
  capabilities?: ResolvedModelCapabilities
}

// ============================================
// CC SDK Runtime Limit Resolution
// ============================================

/**
 * Bounds for CC env-var injection. See `shared/constants/model-runtime-limits.ts`
 * for the rationale split between hard floors (correctness) and the recommended
 * floor for `maxOutputTokens` (quality — surfaced as WARN + UI hint, not clamped).
 */

// CC's MODEL_CONTEXT_WINDOW_DEFAULT for unknown models. CC's `[1m]` suffix
// is the documented opt-in to raise the intrinsic to 1M.
const CC_INTRINSIC_DEFAULT_CONTEXT = 200_000

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

/**
 * Append CC's `[1m]` suffix to the SDK-facing model id so `has1mContext`
 * unlocks the 1M intrinsic. Only decorates the SDK-facing copy — the wire
 * id encoded into the API key stays clean so non-Anthropic upstreams never
 * see the synthetic suffix. Threshold is strict `>` to avoid opening
 * unaudited CC `[1m]` branches for models that don't need them.
 */
export function applyCC1mContextUnlock(
  sdkModel: string,
  capabilities: ResolvedModelCapabilities | undefined
): string {
  if (!sdkModel) return sdkModel
  if (/\[1m\]$/i.test(sdkModel)) return sdkModel
  if (!capabilities || !Number.isFinite(capabilities.contextWindow)) return sdkModel
  if (capabilities.contextWindow <= CC_INTRINSIC_DEFAULT_CONTEXT) return sdkModel
  return `${sdkModel}[1m]`
}

/**
 * Translate resolved model capabilities into the actual env-var pair that
 * controls the CC subprocess. Returns `undefined` for an env var when the
 * input is missing or non-finite — caller then skips injection so CC falls
 * back to its own internal defaults.
 *
 * Exported for unit testing; not part of the public agent surface.
 */
export function resolveSdkRuntimeLimits(
  capabilities: ResolvedModelCapabilities | undefined
): { maxOutputTokens?: number; autoCompactWindow?: number } {
  if (!capabilities) return {}
  const out: { maxOutputTokens?: number; autoCompactWindow?: number } = {}

  // maxOutputTokens: pass through, only sanity-bounded. Below the recommended
  // floor we log a WARN so users who intentionally go low see why
  // auto-compact later fails — but we no longer silently rewrite their value
  // (the UI shows the same warning so the choice is explicit).
  if (Number.isFinite(capabilities.maxOutputTokens) && capabilities.maxOutputTokens > 0) {
    const value = clampInt(
      capabilities.maxOutputTokens,
      MAX_OUTPUT_TOKENS_HARD_MIN,
      MAX_OUTPUT_TOKENS_HARD_CAP
    )
    out.maxOutputTokens = value
    if (value < RECOMMENDED_MIN_MAX_OUTPUT_TOKENS) {
      console.warn(
        `[SDK Config] maxOutputTokens=${value} is below recommended ${RECOMMENDED_MIN_MAX_OUTPUT_TOKENS}. ` +
        `CC auto-compact summary may truncate (summary p99.99 ≈ 17_387 tokens).`
      )
    }
  }

  // contextWindow keeps a hard floor: below ~33K the auto-compact threshold
  // goes negative and compaction fires every turn — that's a correctness
  // failure, not a quality tradeoff, so silent clamp is justified here.
  if (Number.isFinite(capabilities.contextWindow) && capabilities.contextWindow > 0) {
    out.autoCompactWindow = clampInt(
      capabilities.contextWindow,
      CONTEXT_WINDOW_HARD_MIN,
      CONTEXT_WINDOW_HARD_CAP
    )
  }
  return out
}

/**
 * Parameters for building base SDK options
 */
export interface BaseSdkOptionsParams {
  /** Resolved SDK credentials */
  credentials: ResolvedSdkCredentials
  /** Working directory for the agent */
  workDir: string
  /** Path to headless Electron binary */
  electronPath: string
  /** Space ID */
  spaceId: string
  /** Conversation ID */
  conversationId: string
  /** Optional stderr handler (for error accumulation) */
  stderrHandler?: (data: string) => void
  /** Optional MCP servers configuration */
  mcpServers?: Record<string, any> | null
  /** Maximum tool call turns per message (from config) */
  maxTurns?: number
  /** System prompt profile ('official' | 'halo') */
  promptProfile?: 'official' | 'halo'
  /** Claude CLI config directory mode */
  configDirMode?: 'halo' | 'cc' | 'custom'
  /** Custom config dir path (when configDirMode === 'custom') */
  customConfigDir?: string
  /** Enable Agent Teams (multi-agent collaboration) */
  enableTeams?: boolean
  /** Tools disabled by user (Extended Capabilities toggles) */
  disabledTools?: string[]
  /** Whether Digital Humans MCP tools are enabled */
  digitalHumansEnabled?: boolean
  /**
   * Enabled-toolset guides section for toolset-broker sessions (main chat).
   * Chat callers pass buildToolsetSection(spaceId, conversationId) — possibly ''.
   * Leave undefined for legacy static-injection sessions (apps/runtime), which
   * override systemPrompt entirely after this builder returns.
   */
  toolsetIndex?: string
}

// ============================================
// Tool Filtering
// ============================================

/**
 * Build the final disallowed tools list from user config + implicit rules.
 * When userDisabledTools is undefined (not yet configured), applies defaults.
 * Deduplicates to avoid passing the same tool name twice.
 */
function buildDisallowedTools(
  userDisabledTools?: string[],
  enableTeams?: boolean
): string[] {
  const set = new Set<string>()

  // User-configured disabled tools, or defaults for unconfigured users
  const effectiveDisabled = userDisabledTools ?? [...DEFAULT_DISABLED_TOOLS]
  for (const tool of effectiveDisabled) set.add(tool)

  // When Agent Teams is off, also disable team-related tools
  if (!enableTeams) {
    for (const tool of TEAM_TOOLS) set.add(tool)
  }

  return Array.from(set)
}

// ============================================
// Credential Resolution
// ============================================

/**
 * Resolve API credentials for SDK use.
 *
 * This function handles the complexity of different providers:
 * - Anthropic: Routed through OpenAI compat router (PROXY_ANTHROPIC=true)
 * - OpenAI/OAuth: Route through OpenAI compat router with encoded config
 *
 * Important: The model is encoded into the apiKey (ANTHROPIC_API_KEY env var)
 * at session creation time. Model changes require session rebuild — they cannot
 * be switched dynamically via setModel(). See config.service.ts getAiSourcesSignature().
 *
 * @param credentials - Raw API credentials from getApiCredentials()
 * @returns Resolved credentials ready for SDK
 */
export async function resolveCredentialsForSdk(
  credentials: ApiCredentials
): Promise<ResolvedSdkCredentials> {
  console.debug(`[SDK Config] resolveCredentialsForSdk: provider=${credentials.provider}, model=${credentials.model}, baseUrl=${credentials.baseUrl}`)

  if (credentials.delegatedAuth) {
    return resolveDelegatedAuth(credentials)
  }

  // Experimental: route Anthropic through local router for interceptor coverage
  if (PROXY_ANTHROPIC && credentials.provider === 'anthropic') {
    return resolveAnthropicPassthrough(credentials)
  }

  // ── Original logic (identical to pre-optimization code) ──
  // Start with direct values
  let anthropicBaseUrl = credentials.baseUrl
  let anthropicApiKey = credentials.apiKey
  let sdkModel = resolveModelId(credentials.model)
  const displayModel = credentials.displayModel || credentials.model

  // For non-Anthropic providers (openai or OAuth), use the OpenAI compat router
  if (credentials.provider !== 'anthropic') {
    const router = await ensureOpenAICompatRouter({ debug: false })
    anthropicBaseUrl = router.baseUrl

    // Use apiType from credentials (set by provider), fallback to inference
    const apiType = credentials.apiType
      || (credentials.provider === 'oauth' ? 'chat_completions' : inferOpenAIWireApi(credentials.baseUrl))

    // Encode with real wire id BEFORE sdkModel decoration so [1m] never leaks upstream.
    anthropicApiKey = encodeBackendConfig(credentialsToBackendConfig(credentials, { apiType }))

    console.log(`[SDK Config] ${credentials.provider} provider: routing via ${anthropicBaseUrl}, apiType=${apiType}, sdkModel=${sdkModel}`)
  }

  const decoratedSdkModel = applyCC1mContextUnlock(sdkModel, credentials.capabilities)
  if (decoratedSdkModel !== sdkModel) {
    console.log(`[SDK Config] CC 1M context unlock: sdkModel "${sdkModel}" → "${decoratedSdkModel}" (contextWindow=${credentials.capabilities?.contextWindow})`)
    sdkModel = decoratedSdkModel
  }

  return {
    anthropicBaseUrl,
    anthropicApiKey,
    sdkModel,
    displayModel,
    capabilities: credentials.capabilities,
  }
}

/**
 * Compute a per-session credential fingerprint from built SDK options.
 *
 * The model is baked into the encoded `ANTHROPIC_API_KEY` at session creation
 * (see resolveCredentialsForSdk) and, for direct Anthropic, into the top-level
 * `model` option. This is the per-conversation analog of the global
 * `credentialsGeneration`: it lets a single conversation's session rebuild
 * when its own model/source pin changes, without affecting other
 * conversations (session-manager compares it on session reuse).
 *
 * MUST be deterministic for unchanged credentials. Router-encoded keys embed
 * per-resolution request headers (e.g. a fresh `x-client-request-id` UUID from
 * claude.provider getBackendConfig), so the raw blob differs on every resolve —
 * hashing it verbatim rebuilds the session on every warm-up and tears down
 * in-flight agent teams. Only the stable identity fields participate.
 */
export function computeCredentialsFingerprint(sdkOptions: Record<string, any>): string {
  const env = (sdkOptions.env || {}) as Record<string, unknown>
  // Delegated sources carry the encoded backend on a custom header instead of
  // the key; without it their identity fields would all hash to the same value.
  const rawKey = String(env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_CUSTOM_HEADERS ?? '')
    .replace(new RegExp(`^${DELEGATED_ROUTING_HEADER}:\\s*`), '')

  const backend = decodeBackendConfig(rawKey)
  const keyIdentity = backend
    ? [
        backend.url,
        backend.key,
        backend.model ?? '',
        backend.apiType ?? '',
        backend.adapterId ?? '',
        backend.profileArn ?? '',
        // Vision capability is frozen in the session's encoded key, while the
        // image fallback re-resolves it per turn. Without it here, flipping the
        // Vision setting mid-conversation makes the two disagree: the turn
        // keeps image blocks the session is still configured to strip.
        String(backend.visionOverride ?? ''),
      ].join('|')
    : rawKey  // Direct Anthropic: plain key, stable as-is

  const material = [
    String(sdkOptions.model ?? ''),
    String(env.ANTHROPIC_BASE_URL ?? ''),
    keyIdentity,
  ].join('|')
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/**
 * Fingerprint the session-defining inputs a caller bakes into sdkOptions up
 * front: the system prompt plus the set of MCP server names. These are frozen at
 * session creation and are NOT covered by the credentials or knowledge
 * fingerprints, so without this a live session whose tool set / prompt changed
 * (e.g. the user toggled a digital human's AI Browser permission, edited its
 * prompt, or changed a config value) would be silently reused with the stale
 * wiring — the change would appear to "not take effect" until a manual restart.
 *
 * The MCP set is fingerprinted by server NAME only: the in-process SDK server
 * objects are rebuilt on every call, so their identity is meaningless; only which
 * servers are present matters. Callers that build MCP servers lazily (main chat)
 * must not use this — they have no eager mcpServers here and drive toolset changes
 * through their own rebuild path.
 *
 * The guest permission envelope (permissionMode, the disallowedTools blacklist,
 * and the dangerously-skip-permissions extra arg) is part of the fingerprint so
 * that on a shared conversationId that alternates owner and guest senders, a
 * guest turn cannot reuse the owner's bypassPermissions session: the differing
 * permission fields force a rebuild with the guest's restricted wiring.
 *
 * INVARIANT: every fingerprinted input must be stable across consecutive sends.
 * The system prompt currently varies only by calendar day (one rebuild per day
 * is acceptable); injecting anything higher-frequency into it — precise
 * timestamps, live memory content, per-message state — would degrade this into
 * a session rebuild on EVERY message. Keep such content out of the prompt, or
 * exclude it here.
 */
export function computeSessionInputsFingerprint(sdkOptions: Record<string, any>): string {
  const mcpKeys = Object.keys(sdkOptions.mcpServers ?? {}).sort().join(',')
  const prompt = typeof sdkOptions.systemPrompt === 'string' ? sdkOptions.systemPrompt : ''
  const permissionMode = String(sdkOptions.permissionMode ?? '')
  const disallowed = Array.isArray(sdkOptions.disallowedTools)
    ? [...sdkOptions.disallowedTools].sort().join(',')
    : ''
  const skipPermissions = sdkOptions.extraArgs
    ? String(sdkOptions.extraArgs['dangerously-skip-permissions'] ?? '')
    : ''
  const material = [mcpKeys, prompt, permissionMode, disallowed, skipPermissions].join('\u0000')
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/**
 * Resolve a source whose credential lives inside the CLI subprocess.
 *
 * No key is produced: the subprocess authenticates itself and sends its own
 * `Authorization` header. Requests still go through the router — that is what
 * keeps the image budget, the warmup/preflight short-circuits, system-prompt
 * normalization and `[1m]` stripping working — so the backend identity travels
 * in a dedicated header instead of the occupied auth channel.
 */
async function resolveDelegatedAuth(
  credentials: ApiCredentials
): Promise<ResolvedSdkCredentials> {
  const router = await ensureOpenAICompatRouter({ debug: false })

  const routingConfig = encodeBackendConfig(
    credentialsToBackendConfig(credentials, { apiType: 'anthropic_passthrough' })
  )

  let sdkModel = resolveModelId(credentials.model)
  const decoratedSdkModel = applyCC1mContextUnlock(sdkModel, credentials.capabilities)
  if (decoratedSdkModel !== sdkModel) {
    console.log(`[SDK Config] CC 1M context unlock (delegated): sdkModel "${sdkModel}" → "${decoratedSdkModel}" (contextWindow=${credentials.capabilities?.contextWindow})`)
    sdkModel = decoratedSdkModel
  }

  console.log(`[SDK Config] Delegated auth: routing via ${router.baseUrl}, CLI supplies its own credential`)

  return {
    anthropicBaseUrl: router.baseUrl,
    anthropicApiKey: '',
    sdkModel,
    displayModel: credentials.displayModel || credentials.model,
    capabilities: credentials.capabilities,
    delegatedRoutingHeader: `${DELEGATED_ROUTING_HEADER}: ${routingConfig}`,
  }
}

/**
 * Resolve Anthropic credentials via local router passthrough (experimental).
 * Isolated from the main path — only called when PROXY_ANTHROPIC = true.
 */
async function resolveAnthropicPassthrough(
  credentials: ApiCredentials
): Promise<ResolvedSdkCredentials> {
  const router = await ensureOpenAICompatRouter({ debug: false })
  const configUrl = credentials.baseUrl.replace(/\/+$/, '') + '/v1/messages'

  // Encode with real wire id; router strips any [1m] suffix before forwarding.
  const anthropicApiKey = encodeBackendConfig(
    credentialsToBackendConfig(credentials, { url: configUrl, apiType: 'anthropic_passthrough' })
  )

  let sdkModel = resolveModelId(credentials.model)
  const decoratedSdkModel = applyCC1mContextUnlock(sdkModel, credentials.capabilities)
  if (decoratedSdkModel !== sdkModel) {
    console.log(`[SDK Config] CC 1M context unlock (anthropic passthrough): sdkModel "${sdkModel}" → "${decoratedSdkModel}" (contextWindow=${credentials.capabilities?.contextWindow})`)
    sdkModel = decoratedSdkModel
  }

  console.log(`[SDK Config] Anthropic passthrough: routing via ${router.baseUrl}`)

  return {
    anthropicBaseUrl: router.baseUrl,
    anthropicApiKey,
    sdkModel,
    displayModel: credentials.displayModel || credentials.model,
    capabilities: credentials.capabilities,
  }
}

// ============================================
// Sandbox Settings (written to settings.json)
// ============================================

/**
 * Sandbox configuration
 *
 * Sandbox is enabled primarily for performance optimization (skips some runtime checks).
 * Network and filesystem access are intentionally permissive - the goal is not strict
 * security isolation, but rather to enable SDK's internal optimizations.
 *
 * Note: Do NOT add `network.allowedDomains` config unless you actually need domain filtering.
 * Setting this array (even to ['*']) triggers SDK's network proxy infrastructure, which:
 *   - Starts HTTP + SOCKS proxy servers (performance overhead)
 *   - Routes all network requests through the proxy (added latency)
 *   - Has a bug where '*' wildcard is not properly handled (causes false blocks)
 *
 * Security note: SDK has built-in filesystem restrictions (e.g., protecting Halo config files)
 * that are separate from these sandbox settings.
 */
const SANDBOX_CONFIG = {
  enabled: false,
  autoAllowBashIfSandboxed: true,
  // No network config → proxy servers won't start → no performance overhead
}
let sandboxSettingsWritten = false

/**
 * Ensure sandbox config exists in CLAUDE_CONFIG_DIR/settings.json.
 *
 * By writing sandbox to the userSettings file, the CLI reads it natively
 * without needing --settings flag. This avoids the CLI writing a temp file
 * to $TMPDIR and chokidar watching the entire tmpdir (which crashes on
 * macOS due to Unix socket files like CloudClient).
 *
 * Runs once per process lifetime — subsequent calls are no-ops.
 */
function ensureSandboxSettings(configDir: string): void {
  if (sandboxSettingsWritten) return
  mkdirSync(configDir, { recursive: true })
  const settingsPath = path.join(configDir, 'settings.json')
  try {
    let settings: Record<string, any> = {}
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    }
    let dirty = false
    if (JSON.stringify(settings.sandbox) !== JSON.stringify(SANDBOX_CONFIG)) {
      settings.sandbox = SANDBOX_CONFIG
      dirty = true
    }
    if (settings.skipWebFetchPreflight !== true) {
      settings.skipWebFetchPreflight = true
      dirty = true
    }
    if (dirty) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    }
  } catch (err) {
    console.error('[SDK Config] Failed to write sandbox settings:', err)
  }
  sandboxSettingsWritten = true
}

// ============================================
// Environment Variables
// ============================================

/**
 * Prefixes to strip from inherited env before spawning CC subprocess.
 * Prevents leaked vars (ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY, CLAUDE_CODE_SSE_PORT, etc.)
 * from overriding Halo's explicit configuration.
 */
const AI_SDK_ENV_PREFIXES = ['ANTHROPIC_', 'OPENAI_', 'CLAUDE_']

/**
 * Copy of process.env with all AI SDK variables removed.
 */
export function getCleanUserEnv(): Record<string, string | undefined> {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (AI_SDK_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
      delete env[key]
    }
  }
  return env
}

/**
 * Build env for CC subprocess.
 * Inherits user env (PATH, HOME, SSH, proxy, etc.) for toolchain compat,
 * strips AI SDK vars, then sets exactly what CC needs.
 */
export function buildSdkEnv(params: SdkEnvParams): Record<string, string | number> {
  const env: Record<string, string | number | undefined> = {
    ...getCleanUserEnv(),

    // Electron: run as Node.js process
    ELECTRON_RUN_AS_NODE: 1,
    ELECTRON_NO_ATTACH_CONSOLE: 1,

    // API credentials. A delegated source deliberately sets no key: the CLI
    // resolves its own credential, and setting ANTHROPIC_API_KEY would make it
    // authenticate as an API-key user instead, bypassing that credential
    // entirely. Its backend identity rides on a custom header.
    ...(params.delegatedRoutingHeader
      ? { ANTHROPIC_CUSTOM_HEADERS: params.delegatedRoutingHeader }
      : { ANTHROPIC_API_KEY: params.anthropicApiKey }),
    ANTHROPIC_BASE_URL: params.anthropicBaseUrl,

    // Claude config dir: resolved from configDirMode (halo default / cc default / custom)
    CLAUDE_CONFIG_DIR: (() => {
      const configDir = resolveClaudeConfigDir(params.configDirMode, params.customConfigDir)
      ensureSandboxSettings(configDir)
      return configDir
    })(),

    // Localhost bypasses proxy (for OpenAI compat router)
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',

    // Disable non-essential traffic
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_COST_WARNINGS: '1',
    CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK: '1',

    // Align entrypoint with hardcoded User-Agent (external, cli) so billing header
    // and User-Agent are consistent — matches a regular CLI OAuth user's fingerprint.
    // Without this, main.tsx would auto-set it to 'sdk-cli' (non-interactive mode).
    CLAUDE_CODE_ENTRYPOINT: 'cli',

    // Performance: skip warmup calls + raise V8 heap ceiling
    CLAUDE_CODE_REMOTE: 'true',

    // Performance: skip file snapshot I/O (Halo doesn't expose /rewind)
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',

    // Enable Agent Teams (multi-agent collaboration with named teammates)
    // Only set when explicitly enabled via Settings > Advanced
    ...(params.enableTeams ? { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } : {}),

    // Per-model runtime limits resolved from preset + user override.
    // - CLAUDE_CODE_MAX_OUTPUT_TOKENS: caps the `max_tokens` request parameter
    //   for every Anthropic Messages call the CC subprocess makes. Default in
    //   CC is 32_000; injecting the user-configured value fixes the long-
    //   standing "response exceeded 32000 output token maximum" failures.
    // - CLAUDE_CODE_AUTO_COMPACT_WINDOW: shrinks CC's effective context window
    //   when the user's source/preset says the model supports less than CC's
    //   internal getContextWindowForModel detection would assume. CC's logic
    //   takes Math.min of this value with its own detection — so passing a
    //   value LARGER than the model intrinsic is a no-op, only shrinks apply.
    ...(() => {
      const limits = resolveSdkRuntimeLimits(params.capabilities)
      const injected: Record<string, string> = {}
      if (limits.maxOutputTokens !== undefined) {
        injected.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(limits.maxOutputTokens)
      }
      if (limits.autoCompactWindow !== undefined) {
        injected.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(limits.autoCompactWindow)
      }
      if (Object.keys(injected).length > 0) {
        console.log(
          `[SDK Config] Model runtime limits injected: ` +
          `maxOutputTokens=${limits.maxOutputTokens ?? 'default'}, ` +
          `autoCompactWindow=${limits.autoCompactWindow ?? 'default'}`
        )
      }
      return injected
    })(),

    // Windows: pass through Git Bash path (set by the git-bash module during startup)
    // This was stripped by getCleanUserEnv() along with all CLAUDE_* vars
    ...(process.env.CLAUDE_CODE_GIT_BASH_PATH
      ? { CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH }
      : {}),

    // debug flag to claude code sdk
    // DEBUG: '1',
    // DEBUG_CLAUDE_AGENT_SDK: '1',
  }

  // Propagate Halo app-level proxy (Settings > General > Network Proxy) to the
  // CC subprocess. Without this, the SDK's built-in WebFetch tool (and any other
  // network calls in the subprocess) bypass the proxy configured in Halo.
  // Only inject when the user has an explicit Halo proxy AND the OS environment
  // doesn't already provide the corresponding variable — OS-level vars take priority.
  // See: https://github.com/openkursar/hello-halo/issues/69
  const appProxy = getConfig().network?.proxy?.trim()
  if (appProxy) {
    const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const
    for (const key of proxyKeys) {
      if (!env[key]) {
        env[key] = appProxy
      }
    }
    console.log(`[SDK Config] Injected app proxy into subprocess env: ${appProxy}`)
  }

  // Normalize proxy env vars: add http:// if protocol is missing.
  // Some Windows users (esp. with Clash/V2Ray) set HTTPS_PROXY=127.0.0.1:7890
  // without protocol prefix. The Claude Code CLI's Anthropic SDK does
  // new URL(process.env.HTTPS_PROXY) which throws ERR_INVALID_URL.
  // NO_PROXY check happens AFTER URL parsing, so it can't prevent the crash.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    const val = env[key]
    if (typeof val === 'string' && val && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(val)) {
      env[key] = `http://${val}`
    }
  }

  return env as Record<string, string | number>
}

// ============================================
// Claude Code CLI Path Resolution
// ============================================

const CLI_RELATIVE = 'node_modules/@anthropic-ai/claude-code/cli.js'

/**
 * Resolve the path to the Claude Code CLI executable.
 *
 * Three runtime environments need to be handled:
 *
 * 1. **Packaged** (`app.isPackaged === true`): electron-builder bundles node_modules
 *    alongside app.asar. `app.getAppPath()` returns the asar root, so the CLI is
 *    always at `<appPath>/node_modules/...`. This path is guaranteed to exist.
 *
 * 2. **Dev** (`npm run dev`): Vite runs the main process from the project root.
 *    `app.getAppPath()` returns the project root, so the CLI is at
 *    `<projectRoot>/node_modules/...`.
 *
 * 3. **Built but unpackaged** (`npm run build` + run `out/main/index.mjs`, i.e. E2E):
 *    Electron resolves `app.getAppPath()` to `out/main/` (the entry file's directory),
 *    which has no `node_modules`. The CLI must be found at the project root instead.
 *
 * Using `app.isPackaged` cleanly separates case 1 from 2/3. For the unpackaged cases,
 * `existsSync` picks whichever candidate path actually exists, covering both dev and E2E
 * without any hardcoded relative-path assumptions.
 */
export function resolveClaudeCodeCliPath(): string {
  if (app.isPackaged) {
    // Packaged: node_modules is bundled inside the asar alongside the app
    return path.join(app.getAppPath(), CLI_RELATIVE)
  }

  // Unpackaged (dev or E2E build): search candidate locations
  const candidates = [
    // Dev mode: app.getAppPath() === project root
    path.join(app.getAppPath(), CLI_RELATIVE),
    // E2E build mode: app.getAppPath() === out/main/, project root is two levels up
    path.join(app.getAppPath(), '..', '..', CLI_RELATIVE),
  ]

  const resolved = candidates.find(existsSync)
  if (!resolved) {
    throw new Error(
      `[SDK Config] Claude Code CLI not found. Searched:\n${candidates.join('\n')}`
    )
  }
  return resolved
}

/**
 * Shell command that runs the bundled CLI's own login flow against Halo's
 * credential slot, for the user to execute in a terminal session.
 *
 * Spawned through the headless Electron binary rather than `node`: a packaged
 * install has no guarantee that a system Node exists. `CLAUDE_CONFIG_DIR` is
 * passed inline because the terminal service inherits the user's shell
 * environment and exposes no per-session env — and it decides which credential
 * slot receives the login, so omitting it would sign the user into their
 * personal `claude` install instead of Halo's.
 *
 * POSIX quoting is sufficient while delegated auth is macOS-only; PowerShell
 * needs its own form when Windows is enabled.
 */
export function buildCliLoginCommand(): string {
  return [
    'ELECTRON_RUN_AS_NODE=1',
    `CLAUDE_CONFIG_DIR=${shellQuote(resolveClaudeConfigDir())}`,
    shellQuote(getHeadlessElectronPath()),
    shellQuote(resolveClaudeCodeCliPath()),
    '/login'
  ].join(' ')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// On spawn ENOENT the SDK always blames cliPath ("executable not found"), even
// when the real culprit is a missing cwd — the classic Node cause (#170). Log the
// triplet and surface a bad cwd with its true cause. Don't existsSync cliPath: it
// lives in app.asar (served from app.asar.unpacked), so existsSync false-negatives.
function validateSpawnInputs(electronPath: string, cliPath: string, workDir: string): void {
  console.log(`[SDK Config] spawn inputs: command="${electronPath}", cli="${cliPath}", cwd="${workDir}"`)
  if (!existsSync(workDir)) {
    throw new Error(
      `[SDK Config] Working directory does not exist: "${workDir}". ` +
      `Claude Code cannot be spawned with a missing cwd; verify the space's working directory.`
    )
  }
}

// ============================================
// SDK Options Builder
// ============================================

/**
 * Build base SDK options.
 *
 * This constructs the common SDK options used by both sendMessage and ensureSessionWarm.
 * Does NOT include dynamic configurations like AI Browser or Thinking mode.
 *
 * @param params - SDK options parameters
 * @returns Base SDK options object
 */
export function buildBaseSdkOptions(params: BaseSdkOptionsParams): Record<string, any> {
  const {
    credentials,
    workDir,
    electronPath,
    spaceId,
    conversationId,
    stderrHandler,
    mcpServers
  } = params

  console.log(`[SDK Config] buildBaseSdkOptions: workDir="${workDir}", spaceId="${spaceId}", configDirMode="${params.configDirMode ?? 'halo'}"`)
  console.debug(`[SDK Config] buildBaseSdkOptions details: model=${credentials.sdkModel}, displayModel=${credentials.displayModel}, maxTurns=${params.maxTurns}, promptProfile=${params.promptProfile}, enableTeams=${params.enableTeams}, disabledTools=[${(params.disabledTools || []).join(', ')}]`)

  // Build environment variables
  const env = buildSdkEnv({
    anthropicApiKey: credentials.anthropicApiKey,
    anthropicBaseUrl: credentials.anthropicBaseUrl,
    delegatedRoutingHeader: credentials.delegatedRoutingHeader,
    configDirMode: params.configDirMode,
    customConfigDir: params.customConfigDir,
    enableTeams: params.enableTeams,
    capabilities: credentials.capabilities,
  })

  const cliPath = resolveClaudeCodeCliPath()
  validateSpawnInputs(electronPath, cliPath, workDir)

  // Build base options
  const sdkOptions: Record<string, any> = {
    model: credentials.sdkModel,
    cwd: workDir,
    env,
    pathToClaudeCodeExecutable: cliPath,
    extraArgs: {
      'dangerously-skip-permissions': null
    },
    stderr: stderrHandler || ((data: string) => {
      console.error(`[Agent][${conversationId}] CLI stderr:`, data)
    }),
    // Use Halo's custom system prompt instead of SDK's 'claude_code' preset.
    // The capability index advertises optional toolsets (agent/toolsets) the AI
    // can ask the user to enable; full tool schemas enter context only once the
    // toolset is enabled and the session is rebuilt. AI Browser is one such
    // on-demand toolset here, so no aiBrowserEnabled branch. The Knowledge
    // section is appended at actual session creation (getOrCreateV2Session's
    // resolveKnowledgeBases) so a reused session never pays the index reads.
    systemPrompt: buildSystemPrompt({
      workDir,
      modelInfo: credentials.displayModel,
      promptProfile: params.promptProfile,
      digitalHumansEnabled: params.digitalHumansEnabled,
      toolsetIndex: params.toolsetIndex
    }),
    maxTurns: params.maxTurns ?? 50,
    allowedTools: [...DEFAULT_ALLOWED_TOOLS],
    // Enable Skills loading from $CLAUDE_CONFIG_DIR/skills/ and <workspace>/.claude/skills/
    settingSources: ['user', 'project'],
    permissionMode: 'bypassPermissions' as const,
    canUseTool: createCanUseTool({
      spaceId,
      conversationId
    }),
    // Requires SDK patch: enable token-level streaming (stream_event)
    includePartialMessages: true,
    executable: electronPath,
    executableArgs: ['--no-warnings'],
    // Sandbox config is written to CLAUDE_CONFIG_DIR/settings.json (see ensureSandboxSettings)
    // instead of passing via SDK's sandbox option → --settings flag → tmpdir temp file.
    // This avoids CLI creating a temp file and chokidar watching the entire tmpdir.
  }

  // Build disallowed tools list from user config + implicit rules
  const disallowedTools = buildDisallowedTools(params.disabledTools, params.enableTeams)
  if (disallowedTools.length > 0) {
    sdkOptions.disallowedTools = disallowedTools
    console.log(`[SDK Config] Disallowed tools (${disallowedTools.length}): ${disallowedTools.join(', ')}`)
  }

  // Add MCP servers if provided
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    sdkOptions.mcpServers = mcpServers
  }

  return sdkOptions
}
