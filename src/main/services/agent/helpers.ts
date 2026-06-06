/**
 * Agent Module - Helper Functions
 *
 * Utility functions shared across the agent module.
 * Includes working directory management, Electron path handling,
 * API credential resolution, and renderer communication.
 */

import { join, dirname, basename } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { getConfig, getTempSpacePath } from '../../foundation/config.service'
import { getSpace } from '../space.service'
import { getAISourceManager } from '../ai-sources'
import { getAppManager } from '../app-bridge'
import type { McpSpec } from '../../apps/spec/schema'
import type { BackendRequestConfig, AISource } from '../../../shared/types/ai-sources'
import { modelCapabilitiesService } from '../model-capabilities.service'
import { isMcpCommandBlocked } from '../security-policy'
import type { ApiCredentials, ResolvedModelCapabilities } from './types'

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
  const resolved = modelCapabilitiesService.resolve(modelId, overrides)
  return {
    maxOutputTokens: resolved.maxOutputTokens,
    contextWindow: resolved.contextWindow,
  }
}

/**
 * Get API credentials based on current aiSources configuration (v2)
 * This is the central place that determines which API to use
 * Now uses AISourceManager for unified access with v2 format
 */
export async function getApiCredentials(config: ReturnType<typeof getConfig>): Promise<ApiCredentials> {
  const manager = getAISourceManager()
  await manager.ensureInitialized()

  console.log('[AgentService] getApiCredentials called')

  // Get current source from manager (v2 format)
  const currentSource = manager.getCurrentSourceConfig()

  console.log('[AgentService] currentSource:', currentSource ? {
    id: currentSource.id,
    name: currentSource.name,
    provider: currentSource.provider,
    authType: currentSource.authType
  } : null)

  // Ensure token is valid for OAuth sources
  if (currentSource?.authType === 'oauth') {
    console.log('[AgentService] Checking OAuth token validity for:', currentSource.name)
    const tokenResult = await manager.ensureValidToken(currentSource.id)
    console.log('[AgentService] Token check result:', tokenResult.success)
    if (!tokenResult.success) {
      throw new Error('OAuth token expired or invalid. Please login again.')
    }
  }

  // Get backend config from manager
  console.log('[AgentService] Calling manager.getBackendConfig()')
  const backendConfig = manager.getBackendConfig()
  console.log('[AgentService] backendConfig:', backendConfig ? {
    url: backendConfig.url,
    model: backendConfig.model,
    hasKey: !!backendConfig.key
  } : null)

  if (!backendConfig) {
    throw new Error('No AI source configured. Please configure an API key or login.')
  }

  // Determine provider type based on current source
  let provider: 'anthropic' | 'openai' | 'oauth'

  if (currentSource?.authType === 'oauth') {
    provider = 'oauth'
    console.log(`[Agent] Using OAuth provider ${currentSource.provider} via AISourceManager`)
  } else if (currentSource?.provider === 'anthropic') {
    provider = 'anthropic'
    console.log(`[Agent] Using Anthropic API via AISourceManager`)
  } else {
    // OpenAI-compatible providers (deepseek, siliconflow, etc.)
    provider = 'openai'
    console.log(`[Agent] Using OpenAI-compatible API (${currentSource?.provider || 'unknown'}) via AISourceManager`)
  }

  const modelId = backendConfig.model || 'claude-opus-4-5-20251101'
  const modelOption = currentSource?.availableModels?.find(m => m.id === modelId)
  const displayModel = modelOption?.name || modelId
  // Capabilities MUST resolve against the wire model id. Both the preset
  // patterns in model-capabilities.json (e.g. "claude-opus-", "deepseek-chat")
  // and the user's per-model overrides (keyed in ModelConfigPanel by the
  // selected model id) live on the wire id, not the human-friendly name.
  // Passing displayModel here would silently fall back to defaults whenever
  // the source labels a model with a friendly name — re-introducing the
  // original "32K cap not honored" symptom on every custom source.
  const capabilities = resolveCapabilitiesFromSource(currentSource, modelId)

  return {
    baseUrl: backendConfig.url,
    apiKey: backendConfig.key,
    model: modelId,
    displayModel,
    provider,
    customHeaders: backendConfig.headers,
    apiType: backendConfig.apiType,
    forceStream: backendConfig.forceStream,
    filterContent: backendConfig.filterContent,
    adapterId: backendConfig.adapterId,
    capabilities,
  }
}

/**
 * Get API credentials for a specific AI source (used for per-app model overrides).
 * Falls back to getApiCredentials() if the specified source is not found or not configured.
 */
export async function getApiCredentialsForSource(
  config: ReturnType<typeof getConfig>,
  sourceId: string,
  modelId?: string
): Promise<ApiCredentials> {
  const manager = getAISourceManager()
  await manager.ensureInitialized()

  const aiSources = config.aiSources
  const source = aiSources?.version === 2
    ? aiSources.sources.find((s: any) => s.id === sourceId)
    : null

  if (!source) {
    console.warn(`[AgentService] getApiCredentialsForSource: source ${sourceId} not found, falling back to global`)
    return getApiCredentials(config)
  }

  // Ensure token is valid for OAuth sources
  if (source.authType === 'oauth') {
    const tokenResult = await manager.ensureValidToken(source.id)
    if (!tokenResult.success) {
      throw new Error('OAuth token expired or invalid. Please login again.')
    }
  }

  const backendConfig = manager.getBackendConfigForSource(sourceId, modelId)
  if (!backendConfig) {
    console.warn(`[AgentService] getApiCredentialsForSource: no backend config for source ${sourceId}, falling back to global`)
    return getApiCredentials(config)
  }

  // Determine provider type
  let provider: 'anthropic' | 'openai' | 'oauth'
  if (source.authType === 'oauth') {
    provider = 'oauth'
  } else if (source.provider === 'anthropic') {
    provider = 'anthropic'
  } else {
    provider = 'openai'
  }

  const effectiveModelId = backendConfig.model || source.model
  const modelOption = source.availableModels?.find((m: any) => m.id === effectiveModelId)
  const displayModel = modelOption?.name || effectiveModelId
  // Per-app overrides still belong to the same source — resolve capabilities
  // from that source's modelOverrides so apps inherit user-configured limits.
  // Always use the wire model id here (see getApiCredentials for full
  // rationale): preset pattern matching and the modelOverrides keys both
  // live on the wire id, not the friendly displayModel.
  const capabilities = resolveCapabilitiesFromSource(source, effectiveModelId)

  console.log(`[AgentService] Using per-app model override: source=${source.name}, model=${displayModel}`)

  return {
    baseUrl: backendConfig.url,
    apiKey: backendConfig.key,
    model: effectiveModelId,
    displayModel,
    provider,
    customHeaders: backendConfig.headers,
    apiType: backendConfig.apiType,
    forceStream: backendConfig.forceStream,
    filterContent: backendConfig.filterContent,
    adapterId: backendConfig.adapterId,
    capabilities,
  }
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
    url: credentials.baseUrl,
    key: credentials.apiKey,
    model: credentials.model,
    headers: credentials.customHeaders,
    apiType: credentials.apiType,
    forceStream: credentials.forceStream,
    filterContent: credentials.filterContent,
    adapterId: credentials.adapterId,
    ...overrides
  }
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
    if (app.spec.type !== 'mcp') continue
    const mcpServer = (app.spec as McpSpec).mcp_server
    if (!mcpServer) continue // defensive: required by schema but guard against old data

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
        continue
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
  requiredMcps: Array<{ id: string; reason?: string; bundled?: boolean }> | undefined,
  spaceId: string
): Record<string, unknown> {
  if (!requiredMcps || requiredMcps.length === 0) return {}

  const manager = getAppManager()
  if (!manager) return {}

  // Get all effective MCP apps for this space (global + space-scoped)
  const allMcpApps = manager.listEffectiveMcpApps(spaceId)

  const result: Record<string, unknown> = {}

  for (const dep of requiredMcps) {
    const app = allMcpApps.find(
      (a) => a.specId === dep.id && a.status === 'active'
    )
    if (!app) {
      console.warn(
        `[Agent] Required MCP "${dep.id}" not found or not active (spaceId=${spaceId})`
      )
      continue
    }

    if (app.spec.type !== 'mcp') continue
    const mcpServer = (app.spec as McpSpec).mcp_server
    if (!mcpServer) continue // defensive: required by schema but guard against old data

    const serverConfig: Record<string, unknown> = {}

    // Map transport type — mirrors getDbMcpServers conversion logic
    if (mcpServer.transport === 'sse') {
      serverConfig.type = 'sse'
      serverConfig.url = mcpServer.command // For SSE, command holds URL
    } else if (mcpServer.transport === 'streamable-http') {
      serverConfig.type = 'http'
      serverConfig.url = mcpServer.command
    } else {
      // stdio (default)
      // Defense in depth: skip blacklisted commands so the SDK never spawns
      // the child process. Mirrors the filter in getDbMcpServers above.
      if (isMcpCommandBlocked(mcpServer.command)) {
        console.warn(
          `[Security] Skipped required MCP '${app.specId}': command '${mcpServer.command}' blocked by policy`
        )
        continue
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

    result[app.specId] = serverConfig
  }

  return result
}
