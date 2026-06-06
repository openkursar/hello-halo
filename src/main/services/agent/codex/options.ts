/**
 * Option translation: Halo's CC-shaped SDK options → Codex app-server JSON-RPC params.
 *
 * Compared to the old subprocess-per-turn adapter this file is much smaller
 * because we no longer:
 *   - flatten nested config into `--config a.b.c=v` CLI flags
 *   - massage `RUST_LOG` for stderr capture (the long-running app-server
 *     emits its own diagnostics on stderr, which the connection layer
 *     forwards to Halo's logger)
 *   - resolve a Codex executable override (handled in
 *     transport/connection.ts with `resolveBundledCodexBinary`)
 *
 * What we DO produce:
 *   - process env: CODEX_HOME isolation, ANTHROPIC_* stripped, NO_PROXY
 *   - thread/start params: model, cwd, sandbox, approvalPolicy, config{...}
 *   - per-turn parameters (model override; we don't override anything else)
 *   - OpenAI-compat router config (when the user has selected a non-Anthropic
 *     provider): inject as `model_provider` + `model_providers` inside
 *     `config` instead of via TOML
 */

import path from 'path'
import { mkdirSync } from 'fs'
import { getApiCredentials, credentialsToBackendConfig } from '../helpers'
import { getConfig, getHaloDir } from '../../../foundation/config.service'
import { getCleanUserEnv } from '../sdk-config'
import { ensureOpenAICompatRouter, encodeBackendConfig } from '../../../openai-compat-router'
import type { ApiCredentials } from '../types'
import type { AskForApproval, SandboxMode, ThreadStartParams } from './types/codex-protocol'
import { prepareCodexMcpServers, type CodexSdkMcpBridge } from './mcp-bridge'

export interface CodexResolvedOptions {
  /** Process env passed to the app-server child. */
  env: NodeJS.ProcessEnv
  /** Working directory for the child process. */
  cwd: string
  /** Resolved primary model the session uses. */
  model: string
  /** Display label for the model (UI only). */
  displayModel: string
  /** thread/start parameters. */
  threadParams: ThreadStartParams
  /** MCP servers (used by the event normalizer to populate system.init.tools). */
  mcpServers: Record<string, any>
  /** Local bridge for SDK-backed MCP servers. Owned by CodexAppServerSession. */
  mcpBridge?: CodexSdkMcpBridge
  /**
   * Mirrors Claude Code SDK's `includePartialMessages`:
   *   - true  → consumer wants stream_event (token-level deltas) for live UI.
   *             Codex normalizer suppresses the redundant text payload in the
   *             aggregate `type:'assistant'` envelope so stream-processor's
   *             stream_event path is the sole source of bubble text and
   *             nothing gets double-appended.
   *   - false → consumer wants only the aggregate `type:'assistant'`
   *             envelope (execute.ts automation runtime, post-hoc replay).
   *             Codex normalizer suppresses stream_event text/thinking
   *             deltas so the aggregate is the sole source.
   *
   * Tool_use aggregate is always emitted regardless of this flag because
   * session-store JSONL replay needs the tool_use envelope to arrive BEFORE
   * the matching user.tool_result for id-based linking (see
   * event-normalizer.aggregateBlock rationale).
   */
  includePartialMessages: boolean
}

export async function resolveCodexOptions(sdkOptions: Record<string, any>): Promise<CodexResolvedOptions> {
  const appConfig = getConfig()
  const credentials = await getApiCredentials(appConfig)
  const model = resolveCodexModel(sdkOptions.model, credentials)
  const cwd = sdkOptions.cwd || process.cwd()

  // Build the routing config first so we know whether a router-encoded
  // API key needs to be exported to the spawned process. Codex reads
  // `model_providers.<id>.env_key` from the OS environment of the
  // app-server child — NOT from the JSON config — so the key must land
  // in `env`, not in `config.env`.
  const preparedMcp = await prepareCodexMcpServers(sdkOptions.mcpServers)
  try {
    const { config, processEnvAdditions } = await buildThreadConfig(sdkOptions, credentials, preparedMcp.mcpServers)
    const env = await buildCodexEnv(sdkOptions, credentials, processEnvAdditions)

    const threadParams: ThreadStartParams = {
      model,
      cwd,
      sandbox: resolveSandboxMode(sdkOptions),
      approvalPolicy: resolveApprovalPolicy(sdkOptions),
      config,
    }

    return {
      env,
      cwd,
      model,
      displayModel: credentials.displayModel || credentials.model || model,
      threadParams,
      mcpServers: pickInjectedMcpServers(sdkOptions.mcpServers || {}, preparedMcp.injectedServerNames),
      mcpBridge: preparedMcp.bridge,
      // Default to true to match Halo's chat path (sdk-config.ts sets it
      // explicitly to true for interactive sessions). execute.ts overrides
      // to false for automation. Falling back to true keeps live-UI parity
      // with Claude SDK when the caller forgets to set it.
      includePartialMessages: sdkOptions.includePartialMessages !== false,
    }
  } catch (err) {
    await preparedMcp.bridge?.close().catch(() => {})
    throw err
  }
}

// ============================================================================
// Env
// ============================================================================

async function buildCodexEnv(
  sdkOptions: Record<string, any>,
  credentials: ApiCredentials,
  additions: Record<string, string>,
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {}
  const base = sdkOptions.env || getCleanUserEnv()
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = String(value)
  }

  // Codex app-server picks up Anthropic env vars and tries to dial Anthropic;
  // strip them so it routes through our credentials path instead.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_BASE_URL
  delete env.CLAUDE_CONFIG_DIR

  env.CODEX_HOME = ensureCodexHome()
  env.DISABLE_TELEMETRY = '1'
  env.NO_PROXY = appendNoProxy(env.NO_PROXY || env.no_proxy)
  env.no_proxy = env.NO_PROXY

  // Forward our chosen API key to the app-server. For Anthropic-direct
  // routes, this is the user's key; for routed providers we set the
  // env var named in `model_providers.<id>.env_key` (see buildThreadConfig).
  if (credentials.provider === 'anthropic') {
    env.OPENAI_API_KEY = credentials.apiKey
    env.CODEX_API_KEY = credentials.apiKey
  }

  // Router-encoded keys / any other env additions buildThreadConfig
  // declared. These MUST land in process env — Codex's `env_key` lookup
  // hits the OS env, not the JSON config.
  for (const [k, v] of Object.entries(additions)) {
    env[k] = v
  }

  if (!env.RUST_LOG) {
    env.RUST_LOG = 'codex_core=info,codex_app_server=info'
  }

  return env
}

function ensureCodexHome(): string {
  const codexHome = path.join(getHaloDir(), 'codex')
  mkdirSync(codexHome, { recursive: true })
  return codexHome
}

function appendNoProxy(current: string | undefined): string {
  const values = new Set((current || '').split(',').map((entry) => entry.trim()).filter(Boolean))
  values.add('localhost')
  values.add('127.0.0.1')
  return Array.from(values).join(',')
}

// ============================================================================
// Model
// ============================================================================

function resolveCodexModel(optionModel: string | undefined, credentials: ApiCredentials): string {
  const candidate = credentials.model || optionModel
  if (candidate && !candidate.startsWith('claude-')) return candidate
  return process.env.HALO_CODEX_DEFAULT_MODEL || 'gpt-5.1-codex-max'
}

// ============================================================================
// thread/start config (sandbox, approvals, OpenAI-compat router)
// ============================================================================

interface BuiltThreadConfig {
  config: Record<string, unknown>
  /**
   * Env vars that MUST be added to the spawned process environment.
   * Codex resolves `env_key` from the OS env, not from anything in the
   * JSON `config`, so the router's encoded API key has to flow back here
   * for buildCodexEnv to inject.
   */
  processEnvAdditions: Record<string, string>
}

async function buildThreadConfig(
  sdkOptions: Record<string, any>,
  credentials: ApiCredentials,
  codexMcpServers: Record<string, unknown>,
): Promise<BuiltThreadConfig> {
  const config: Record<string, unknown> = {
    model_reasoning_effort: sdkOptions.maxThinkingTokens ? 'high' : 'medium',
    sandbox_workspace_write: { network_access: true },
    hide_agent_reasoning: false,
    show_raw_agent_reasoning: false,
    tools: {
      web_search: hasMcpServer(sdkOptions.mcpServers, 'web-search'),
    },
    // codex's spawn_agent has two schema variants. v1 (legacy) exposes BOTH
    // `message` and `items` and rejects when both are populated, so a model
    // that defensively passes `items: []` alongside a real `message` trips
    // the "Provide either message or items, but not both" validator (see
    // codex-rs/core/src/tools/handlers/multi_agents_common.rs:170). v2 keeps
    // only `message`, matching how Halo wants sub-agents invoked. Selecting
    // v2 also activates the modern collab-tools surface (wait_agent /
    // close_agent / send_input / resume_agent) under `Feature::MultiAgentV2`
    // (codex-rs/tools/src/tool_config.rs:179-180,257). The feature ships
    // disabled by default in codex (`default_enabled: false`) so we MUST
    // opt in via thread/start config.
    features: {
      multi_agent_v2: true,
    },
  }

  if (Object.keys(codexMcpServers).length > 0) {
    config.mcp_servers = codexMcpServers
  }

  const processEnvAdditions: Record<string, string> = {}

  if (credentials.provider !== 'anthropic') {
    // Route everything else through Halo's OpenAI-compat proxy so the
    // app-server can speak responses/chat_completions while Halo handles
    // upstream auth + adapter selection.
    const router = await ensureOpenAICompatRouter({ debug: false })
    const upstreamApiType = credentials.apiType || inferCodexUpstreamApiType(credentials.baseUrl)
    const backendUrl = normalizeBackendEndpointUrl(credentials.baseUrl, upstreamApiType)
    const apiKey = encodeBackendConfig(
      credentialsToBackendConfig(credentials, { url: backendUrl, apiType: upstreamApiType }),
    )

    // Codex removed `wire_api = "chat"` (see codex-rs/model-provider-info
    // lib.rs L41 — "wire_api = \"chat\" is no longer supported"). Always
    // tell codex to speak the Responses API; Halo's OpenAI-compat router
    // accepts /v1/responses and converts to whatever protocol the upstream
    // provider speaks (chat_completions vs responses) using the apiType
    // encoded in the router-key blob.
    config.model_provider = 'halo-router'
    config.model_providers = {
      'halo-router': {
        name: 'Halo OpenAI compatibility router',
        base_url: `${router.baseUrl}/v1`,
        wire_api: 'responses',
        requires_openai_auth: false,
        env_key: 'HALO_ROUTER_KEY',
      },
    }
    processEnvAdditions.HALO_ROUTER_KEY = apiKey
  }

  return { config, processEnvAdditions }
}

function inferCodexUpstreamApiType(apiUrl: string): 'responses' | 'chat_completions' {
  if (apiUrl.includes('/responses')) return 'responses'
  return 'chat_completions'
}

function normalizeBackendEndpointUrl(apiUrl: string, apiType: 'responses' | 'chat_completions'): string {
  const baseUrl = normalizeCodexBaseUrl(apiUrl)
  return apiType === 'responses' ? `${baseUrl}/responses` : `${baseUrl}/chat/completions`
}

export function normalizeCodexBaseUrl(input: string): string {
  let normalized = input.replace(/\s/g, '').replace(/\/+$/, '')
  if (!normalized) {
    throw new Error('Codex requires a non-empty API base URL.')
  }
  for (const suffix of ['/chat/completions', '/responses']) {
    if (normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length)
      break
    }
  }
  if (normalized.endsWith('/chat')) normalized = normalized.slice(0, -5)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+$/.test(normalized)) {
    normalized = `${normalized}/v1`
  }
  return normalized.replace(/\/+$/, '')
}

// ============================================================================
// Sandbox & approval
// ============================================================================

function resolveSandboxMode(_sdkOptions: Record<string, any>): SandboxMode {
  // Halo always runs Codex with full access — gating happens at the Halo
  // layer (per-space scoping, AskUserQuestion bridge), not at the Codex
  // sandbox boundary.
  return 'danger-full-access'
}

function resolveApprovalPolicy(sdkOptions: Record<string, any>): AskForApproval {
  if (sdkOptions.permissionMode === 'bypassPermissions' || sdkOptions.extraArgs?.['dangerously-skip-permissions'] === null) {
    return 'never'
  }
  return 'on-request'
}

function hasMcpServer(mcpServers: Record<string, any> | undefined, name: string): boolean {
  return !!mcpServers && Object.prototype.hasOwnProperty.call(mcpServers, name)
}

function pickInjectedMcpServers(mcpServers: Record<string, any>, injectedNames: string[]): Record<string, any> {
  const injected = new Set(injectedNames)
  return Object.fromEntries(Object.entries(mcpServers).filter(([name]) => injected.has(name)))
}
