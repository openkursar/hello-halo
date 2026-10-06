/**
 * Agent Module - Helper Functions
 *
 * Utility functions shared across the agent module.
 * Includes working directory management, Electron path handling,
 * API credential resolution, and renderer communication.
 */

import { join, dirname, basename } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { getTempSpacePath, getCredentialsGeneration } from '../../foundation/config.service'
import { getSpace } from '../space.service'
import { getAISourceManager } from '../ai-sources'
import { getAppManager } from '../app-bridge'
import type { McpSpec } from '../../apps/spec/schema'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { resolveModelId, type BackendRequestConfig, type AISource } from '../../../shared/types/ai-sources'
import { modelCapabilitiesService } from '../model-capabilities.service'
import { sanitizeCatalogModelCapability } from '../../../shared/model-catalog'
import { validateModelCapabilityOverride } from '../../../shared/model-capability-overrides'
import { isMcpCommandBlocked } from '../security-policy'
import type { ApiCredentials, ResolvedModelCapabilities } from './types'
import { assertDelegatedAuthReady } from './cli-auth'

// ============================================
// Headless Electron Path Management
// ============================================

// Cached path to a Node-capable Electron binary that won't register a Dock icon on macOS.
let headlessElectronPath: string | null = null

/**
 * Get the path to a Node-capable Electron binary that won't create a Dock
 * icon when spawned with ELECTRON_RUN_AS_NODE=1.
 *
 * Why: Every chat conversation / MCP test / Codex run spawns Claude Code CLI
 * as a child process. The CLI is JS, so we reuse Electron's bundled Node by
 * spawning the Electron binary with ELECTRON_RUN_AS_NODE=1. On macOS,
 * spawning the *main* app binary registers a new GUI process with
 * LaunchServices (Dock icon, Cmd+Tab entry) before Electron has a chance to
 * read the env var. Result: each conversation leaves a persistent extra Dock
 * icon (issue #105).
 *
 * How: Spawn the Electron *Helper* binary instead. Every packaged Electron
 * app ships 4 Helper.app bundles under Frameworks/ (Helper, Helper (GPU),
 * Helper (Plugin), Helper (Renderer)), each with `LSUIElement=true` in its
 * Info.plist — the documented macOS "agent app" flag that suppresses Dock /
 * Cmd+Tab registration. Helper binaries link the same Electron Framework as
 * the main binary, so they fully support ELECTRON_RUN_AS_NODE. This is a
 * common pattern in Electron-based editors for spawning child Node hosts
 * without polluting the Dock.
 *
 * Replaces a previous workaround that symlinked the main binary to a path
 * outside the .app bundle; that relied on LaunchServices not resolving
 * symlinks for activation policy, which is undocumented behavior and failed
 * on some macOS configurations.
 *
 * Bundle layout the resolver expects:
 *   <App>.app/Contents/
 *     MacOS/<App>                           ← process.execPath (main binary)
 *     Frameworks/
 *       <App> Helper.app/
 *         Contents/Info.plist               ← LSUIElement=true
 *         Contents/MacOS/<App> Helper       ← what we spawn
 *
 * Works uniformly for:
 *   - Packaged macOS app: <App> = product name (e.g. "Halo")
 *   - Dev mode (npm run dev): <App> = "Electron" (node_modules/electron/dist/Electron.app)
 *
 * Falls back to process.execPath when:
 *   - Not on macOS (no LSUIElement concept relevant to spawn semantics)
 *   - execPath isn't inside a .app bundle (running raw binary; no Dock concern)
 *   - Helper bundle is missing (broken install / antivirus quarantine);
 *     logged loudly so support can diagnose
 */
export function getHeadlessElectronPath(): string {
  if (headlessElectronPath && existsSync(headlessElectronPath)) {
    return headlessElectronPath
  }

  const execPath = process.execPath

  // Non-macOS platforms don't have the LaunchServices Dock-registration
  // problem; spawn the main binary directly.
  if (process.platform !== 'darwin') {
    headlessElectronPath = execPath
    return headlessElectronPath
  }

  // Derive Helper path from execPath. execPath looks like
  // `<App>.app/Contents/MacOS/<App>`; the Helper sits at
  // `<App>.app/Contents/Frameworks/<App> Helper.app/Contents/MacOS/<App> Helper`.
  const macosDir = dirname(execPath)
  const contentsDir = dirname(macosDir)
  const binaryName = basename(execPath)

  if (basename(macosDir) !== 'MacOS' || basename(contentsDir) !== 'Contents') {
    // Not a standard .app bundle layout — no Dock-icon concern, no Helper to
    // resolve. Use execPath as-is.
    headlessElectronPath = execPath
    console.log('[Agent] execPath not inside .app/Contents/MacOS; using as-is:', execPath)
    return headlessElectronPath
  }

  const helperPath = join(
    contentsDir,
    'Frameworks',
    `${binaryName} Helper.app`,
    'Contents',
    'MacOS',
    `${binaryName} Helper`
  )

  if (!existsSync(helperPath)) {
    // Should never happen with a properly packaged Electron app. Defend
    // against broken installs (partial download, antivirus quarantine,
    // tampered bundle) by falling back to the main binary, but log loudly
    // so support can grep for it. Users in this state will see Dock icons
    // accumulate, but the app remains functional.
    console.error(
      '[Agent] Electron Helper not found; falling back to main binary. ' +
      'Conversations will leave extra Dock icons. ' +
      `Expected Helper at: ${helperPath}`
    )
    headlessElectronPath = execPath
    return headlessElectronPath
  }

  headlessElectronPath = helperPath
  console.log('[Agent] Using Electron Helper for headless Node:', helperPath)
  return headlessElectronPath
}

// ============================================
// Working Directory Management
// ============================================

/**
 * Get working directory for a space
 */
export function getWorkingDir(spaceId: string): string {
  console.log(`[Agent] getWorkingDir called with spaceId: ${spaceId}`)

  if (spaceId === 'halo-temp') {
    const artifactsDir = join(getTempSpacePath(), 'artifacts')
    if (!existsSync(artifactsDir)) {
      mkdirSync(artifactsDir, { recursive: true })
    }
    console.log(`[Agent] [temp] Using temp space artifacts dir: ${artifactsDir}`)
    return artifactsDir
  }

  const space = getSpace(spaceId)
  if (space) {
    const dir = space.workingDir || space.path
    console.log(`[Agent] Space "${space.name}" (${space.id}): path=${space.path}, workingDir=${space.workingDir ?? '(none)'}, resolved=${dir}`)
    return dir
  }

  console.log(`[Agent] WARNING: Space not found, falling back to temp path`)
  return getTempSpacePath()
}

// ============================================
// API Credentials
// ============================================

/**
 * Resolve effective model capabilities for a source + model combination.
 *
 * Centralizes the merge of (built-in preset → per-source modelOverrides) so
 * every credential surface — getApiCredentials, getApiCredentialsForSource,
 * and any future per-call overrides — produces identical numbers for the
 * same (source, modelId) pair.
 *
 * @param source  AISource whose `modelOverrides` should be applied. Pass
 *                null/undefined when the source isn't known yet — the
 *                preset chain still resolves correctly without overrides.
 * @param modelId **Wire model id**, e.g. `claude-opus-4-6`, `deepseek-chat`,
 *                `Pro/zai-org/GLM-4.7`. NEVER pass a displayModel / friendly
 *                name here: the preset pattern table and the modelOverrides
 *                map are both keyed by the wire id. Passing a friendly name
 *                silently falls through to defaults and re-introduces the
 *                "user override has no effect" class of bug fixed by
 *                issue #112.
 *
 * @returns Resolved capabilities. Falls back to `modelCapabilitiesService`
 *          defaults when no preset and no override match — caller decides
 *          whether to inject env vars based on these values.
 */
function resolveCapabilitiesFromSource(
  source: AISource | null | undefined,
  modelId: string
): ResolvedModelCapabilities {
  const overrides = source?.modelOverrides
  const catalogModel = source?.availableModels?.find(model => model.id === modelId)
  const catalogCapability = sanitizeCatalogModelCapability(catalogModel?.capabilities)
  const resolved = modelCapabilitiesService.resolve(
    modelId,
    overrides,
    catalogCapability,
    catalogModel?.supportsVision
  )
  // Same validator resolve() applies, so a malformed override cannot be
  // honoured here while being discarded there.
  const overrideValidation = validateModelCapabilityOverride(overrides?.[modelId])
  const userOverride = overrideValidation.valid ? overrideValidation.value : undefined
  return {
    maxOutputTokens: resolved.maxOutputTokens,
    contextWindow: resolved.contextWindow,
    reasoningEffort: resolved.reasoningEffort,
    // Whether the number above came from somewhere that actually knows this
    // model. When nothing does, the caller leaves CLAUDE_CODE_MAX_OUTPUT_TOKENS
    // unset so CC applies its own default rather than Halo's guess.
    maxOutputTokensConfigured: userOverride?.maxOutputTokens !== undefined
      || modelCapabilitiesService.getPreset(modelId) !== null
      || catalogCapability?.maxOutputTokens !== undefined,
    adaptiveThinking: resolved.adaptiveThinking === true,
  }
}

/** Capture the selection once; a token refresh must not redirect it to another account. */
export async function getApiCredentials(): Promise<ApiCredentials> {
  const manager = getAISourceManager()
  await manager.ensureInitialized()
  const source = manager.getCurrentSourceConfig()
  if (!source) {
    console.warn('[AgentService] Credential resolution refused: no AI source selected')
    throw new Error('No AI source configured. Please configure an API key or login.')
  }
  return resolveSourceCredentials(manager, source.id)
}

/** An unavailable explicit source is an error, never an account substitution. */
export async function getApiCredentialsForSource(
  sourceId: string,
  modelId?: string
): Promise<ApiCredentials> {
  const manager = getAISourceManager()
  await manager.ensureInitialized()
  return resolveSourceCredentials(manager, sourceId, modelId)
}

async function resolveSourceCredentials(
  manager: ReturnType<typeof getAISourceManager>,
  sourceId: string,
  modelId?: string
): Promise<ApiCredentials> {
  let source = manager.getSourceConfig(sourceId)
  if (!source) {
    console.warn(`[AgentService] Credential resolution refused: source ${sourceId} not found`)
    throw new Error(`AI source "${sourceId}" is unavailable. Please select an available source.`)
  }

  const effectiveModel = modelId || source.model
  if (source.authType === 'oauth') {
    const tokenResult = await manager.ensureValidToken(sourceId, effectiveModel)
    if (!tokenResult.success) {
      throw new Error('OAuth token expired or invalid. Please login again.')
    }
    // Refresh may replace the source record, its account metadata and catalog.
    source = manager.getSourceConfig(sourceId)
    if (!source) {
      console.warn(`[AgentService] Credential resolution refused: source ${sourceId} removed during refresh`)
      throw new Error(`AI source "${sourceId}" is unavailable. Please select an available source.`)
    }
  }

  const backendConfig = manager.getBackendConfigForSource(sourceId, effectiveModel)
  if (!backendConfig) {
    console.warn(`[AgentService] Credential resolution refused: source ${sourceId} has no usable backend config`)
    throw new Error(`AI source "${sourceId}" is not configured or unavailable. Please configure it or login again.`)
  }
  if (backendConfig.delegatedAuth) assertDelegatedAuthReady()

  const provider = source.authType === 'oauth' || source.authType === 'delegated'
    ? 'oauth'
    : source.provider === 'anthropic' ? 'anthropic' : 'openai'
  const effectiveModelId = resolveModelId(backendConfig.model || modelId || source.model)
  const modelOption = source.availableModels?.find(model => model.id === effectiveModelId)

  return {
    sourceId,
    credentialsGeneration: getCredentialsGeneration(sourceId),
    codexModelCapabilities: backendConfig.codexModelCapabilities,
    profileArn: backendConfig.profileArn,
    baseUrl: backendConfig.url,
    apiKey: backendConfig.key,
    model: effectiveModelId,
    displayModel: modelOption?.name || effectiveModelId,
    provider,
    oauthProvider: source.authType === 'oauth' ? source.provider : undefined,
    customHeaders: backendConfig.headers,
    apiType: backendConfig.apiType,
    forceStream: backendConfig.forceStream,
    filterContent: backendConfig.filterContent,
    adapterId: backendConfig.adapterId,
    visionOverride: backendConfig.visionOverride,
    delegatedAuth: backendConfig.delegatedAuth,
    capabilities: resolveCapabilitiesFromSource(source, effectiveModelId),
    supportsVision: modelOption?.supportsVision,
  }
}

/** Only legacy conversations without a source pin use the current global selection. */
export async function getApiCredentialsForConversation(
  conversation: { modelSourceId?: string; modelId?: string } | null | undefined
): Promise<ApiCredentials> {
  const sourceId = conversation?.modelSourceId
  return sourceId !== undefined
    ? getApiCredentialsForSource(sourceId, conversation?.modelId)
    : getApiCredentials()
}

/**
 * Infer OpenAI wire API type from URL or environment
 */
export function inferOpenAIWireApi(apiUrl: string): 'responses' | 'chat_completions' {
  // 1. Check environment variable override
  const envApiType = process.env.HALO_OPENAI_API_TYPE || process.env.HALO_OPENAI_WIRE_API
  if (envApiType) {
    const v = envApiType.toLowerCase()
    if (v.includes('response')) return 'responses'
    if (v.includes('chat')) return 'chat_completions'
  }
  // 2. Infer from URL
  if (apiUrl) {
    if (apiUrl.includes('/chat/completions') || apiUrl.includes('/chat_completions')) return 'chat_completions'
    if (apiUrl.includes('/responses')) return 'responses'
  }
  // 3. Default to chat_completions (most common for third-party providers)
  return 'chat_completions'
}

// ============================================
// Credential → BackendConfig Conversion
// ============================================

/**
 * Convert ApiCredentials back to BackendRequestConfig.
 *
 * Centralizes the reverse mapping (ApiCredentials → BackendRequestConfig)
 * used by sdk-config.ts and mcp-manager.ts when encoding config for the
 * OpenAI compat router. Use `overrides` for computed fields like apiType.
 */
export function credentialsToBackendConfig(
  credentials: ApiCredentials,
  overrides?: Partial<BackendRequestConfig>
): BackendRequestConfig {
  return {
    sourceId: credentials.sourceId,
    codexModelCapabilities: credentials.codexModelCapabilities,
    profileArn: credentials.profileArn,
    url: credentials.baseUrl,
    key: credentials.apiKey,
    model: credentials.model,
    headers: credentials.customHeaders,
    apiType: credentials.apiType,
    forceStream: credentials.forceStream,
    filterContent: credentials.filterContent,
    adapterId: credentials.adapterId,
    visionOverride: credentials.visionOverride,
    reasoningEffort: credentials.capabilities?.reasoningEffort,
    delegatedAuth: credentials.delegatedAuth,
    ...overrides
  }
}

/**
 * Convert an installed MCP app to an SDK `mcpServers` entry.
 *
 * Single conversion point shared by session config assembly, automation
 * least-privilege injection, and the connection probe — so all consumers
 * see the exact same server definition (transport, merged env, headers).
 *
 * Returns null when the app has no usable server definition or its stdio
 * command is blocked by security policy.
 */
export function appToSdkServerConfig(app: InstalledApp): Record<string, unknown> | null {
  if (app.spec.type !== 'mcp') return null
  const mcpServer = (app.spec as McpSpec).mcp_server
  if (!mcpServer) return null // defensive: required by schema but guard against old data

  const serverConfig: Record<string, unknown> = {}

  // Map transport type
  if (mcpServer.transport === 'sse') {
    serverConfig.type = 'sse'
    serverConfig.url = mcpServer.command // For SSE, command holds URL
  } else if (mcpServer.transport === 'streamable-http') {
    serverConfig.type = 'http'
    serverConfig.url = mcpServer.command
  } else {
    // stdio (default)
    // Defense in depth: if the blacklist was updated after this MCP was
    // installed, skip the entry here so the SDK never spawns the child
    // process. The install-time check in AppManager.install() is the
    // primary gate; this runtime filter only catches the
    // "policy tightened post-install" case. No-op on open-source builds.
    if (isMcpCommandBlocked(mcpServer.command)) {
      console.warn(
        `[Security] Skipped MCP '${app.specId}': command '${mcpServer.command}' blocked by policy`
      )
      return null
    }
    serverConfig.command = mcpServer.command
    if (mcpServer.args?.length) serverConfig.args = mcpServer.args
    if (mcpServer.cwd) serverConfig.cwd = mcpServer.cwd
  }
  // Merge static spec env with user-provided config values (e.g. API tokens).
  // userConfig keys map directly to env var names; user values override spec defaults.
  const mergedEnv: Record<string, string> = {
    ...(mcpServer.env ?? {}),
    ...Object.fromEntries(
      Object.entries(app.userConfig ?? {})
        .filter(([, v]) => v != null)
        .map(([k, v]) => [k, String(v)])
    )
  }
  if (Object.keys(mergedEnv).length > 0) {
    serverConfig.env = mergedEnv
  }
  if (mcpServer.headers && Object.keys(mcpServer.headers).length > 0) {
    serverConfig.headers = mcpServer.headers
  }

  return serverConfig
}

/**
 * Build MCP servers config from installed MCP apps in the database.
 * Reads effective MCP apps for the given space (global + space-scoped, with override)
 * and converts them to the SDK mcpServers format.
 */
export function getDbMcpServers(spaceId: string): Record<string, unknown> | null {
  const manager = getAppManager()
  if (!manager) return null

  const mcpApps = manager.listEffectiveMcpApps(spaceId)
  if (mcpApps.length === 0) return null

  const servers: Record<string, unknown> = {}
  for (const app of mcpApps) {
    if (app.status === 'paused') continue
    const serverConfig = appToSdkServerConfig(app)
    if (!serverConfig) continue
    servers[app.specId] = serverConfig
  }

  return Object.keys(servers).length > 0 ? servers : null
}

/**
 * Build MCP servers config for a specific set of MCP dependency declarations.
 *
 * Used by automation runtime (execute.ts) to inject only the MCPs that
 * an automation explicitly declares in its requires.mcps field.
 * This enforces least-privilege: automations only receive the tools they declare.
 *
 * @param requiredMcps - The requires.mcps array from the automation spec
 * @param spaceId - The space context (app.spaceId ?? fallback)
 * @returns SDK-compatible mcpServers config, keyed by specId
 */
export function getMcpServersForRequires(
  requiredMcps: Array<{ id: string; reason?: string; bundled?: boolean; enabled?: boolean }> | undefined,
  spaceId: string
): Record<string, unknown> {
  if (!requiredMcps || requiredMcps.length === 0) return {}

  const manager = getAppManager()
  if (!manager) return {}

  // Get all effective MCP apps for this space (global + space-scoped)
  const allMcpApps = manager.listEffectiveMcpApps(spaceId)

  const result: Record<string, unknown> = {}

  for (const dep of requiredMcps) {
    // Per-digital-human switch: an explicitly disabled dependency is skipped
    // for this app only. The shared MCP server's own status is untouched.
    if (dep.enabled === false) {
      console.log(`[Agent] Required MCP "${dep.id}" disabled for this digital human (spaceId=${spaceId})`)
      continue
    }

    const app = allMcpApps.find(
      (a) => a.specId === dep.id && a.status === 'active'
    )
    if (!app) {
      console.warn(
        `[Agent] Required MCP "${dep.id}" not found or not active (spaceId=${spaceId})`
      )
      continue
    }

    const serverConfig = appToSdkServerConfig(app)
    if (!serverConfig) continue

    result[app.specId] = serverConfig
  }

  return result
}
