/**
 * Agent Module - SDK Configuration Builder
 *
 * Pure functions for building SDK configuration.
 * Centralizes all SDK-related configuration logic to ensure consistency
 * between send-message.ts and session-manager.ts.
 */

import path from 'path'
import { app } from 'electron'
import { ensureOpenAICompatRouter, encodeBackendConfig } from '../../openai-compat-router'
import type { ApiCredentials } from './types'
import { inferOpenAIWireApi } from './helpers'
import { buildSystemPrompt, DEFAULT_ALLOWED_TOOLS } from './system-prompt'
import { createCanUseTool } from './permission-handler'

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
}

/**
 * Parameters for building SDK environment variables
 */
export interface SdkEnvParams {
  anthropicApiKey: string
  anthropicBaseUrl: string
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
  /** Abort controller for cancellation */
  abortController: AbortController
  /** Optional stderr handler (for error accumulation) */
  stderrHandler?: (data: string) => void
  /** Optional MCP servers configuration */
  mcpServers?: Record<string, any> | null
}

// ============================================
// Credential Resolution
// ============================================

/**
 * Resolve API credentials for SDK use.
 *
 * This function handles the complexity of different providers:
 * - Anthropic: Direct pass-through
 * - OpenAI/OAuth: Route through OpenAI compat router with encoded config
 *
 * @param credentials - Raw API credentials from getApiCredentials()
 * @returns Resolved credentials ready for SDK
 */
export async function resolveCredentialsForSdk(
  credentials: ApiCredentials
): Promise<ResolvedSdkCredentials> {
  // Start with direct values
  let anthropicBaseUrl = credentials.baseUrl
  let anthropicApiKey = credentials.apiKey
  let sdkModel = credentials.model || 'claude-opus-4-5-20251101'
  const displayModel = credentials.model

  // For non-Anthropic providers (openai or OAuth), use the OpenAI compat router
  if (credentials.provider !== 'anthropic') {
    const router = await ensureOpenAICompatRouter({ debug: false })
    anthropicBaseUrl = router.baseUrl

    // Use apiType from credentials (set by provider), fallback to inference
    const apiType = credentials.apiType
      || (credentials.provider === 'oauth' ? 'chat_completions' : inferOpenAIWireApi(credentials.baseUrl))

    anthropicApiKey = encodeBackendConfig({
      url: credentials.baseUrl,
      key: credentials.apiKey,
      model: credentials.model,
      headers: credentials.customHeaders,
      apiType,
      forceStream: credentials.forceStream,
      filterContent: credentials.filterContent
    })

    // Pass a fake Claude model to CC for normal request handling
    sdkModel = 'claude-sonnet-4-20250514'

    console.log(`[SDK Config] ${credentials.provider} provider: routing via ${anthropicBaseUrl}, apiType=${apiType}`)
  }

  return {
    anthropicBaseUrl,
    anthropicApiKey,
    sdkModel,
    displayModel
  }
}

// ============================================
// Environment Variables
// ============================================

/**
 * Build SDK environment variables.
 *
 * This is a pure function that constructs the env object
 * needed by the Claude Code subprocess.
 *
 * @param params - Environment parameters
 * @returns Environment variables object
 */
export function buildSdkEnv(params: SdkEnvParams): Record<string, string | number> {
  return {
    // Inherit user env: PATH (git, node, python), HOME (config), HTTP_PROXY, LANG, SSH_AUTH_SOCK
    ...process.env,

    // Electron-specific: Run as Node.js process without GUI
    ELECTRON_RUN_AS_NODE: 1,
    ELECTRON_NO_ATTACH_CONSOLE: 1,

    // API credentials for Claude Code
    ANTHROPIC_API_KEY: params.anthropicApiKey,
    ANTHROPIC_BASE_URL: params.anthropicBaseUrl,

    // Use Halo's own config directory to avoid conflicts with CC's ~/.claude
    CLAUDE_CONFIG_DIR: path.join(app.getPath('userData'), 'claude-config'),

    // Ensure localhost bypasses proxy (for OpenAI compat router)
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',

    // Disable unnecessary API requests
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_COST_WARNINGS: '1'
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
    abortController,
    stderrHandler,
    mcpServers
  } = params

  // Build environment variables
  const env = buildSdkEnv({
    anthropicApiKey: credentials.anthropicApiKey,
    anthropicBaseUrl: credentials.anthropicBaseUrl
  })

  // Build base options
  const sdkOptions: Record<string, any> = {
    model: credentials.sdkModel,
    cwd: workDir,
    abortController,
    env,
    extraArgs: {
      'dangerously-skip-permissions': null
    },
    stderr: stderrHandler || ((data: string) => {
      console.error(`[Agent][${conversationId}] CLI stderr:`, data)
    }),
    // Use Halo's custom system prompt instead of SDK's 'claude_code' preset
    systemPrompt: buildSystemPrompt({ workDir, modelInfo: credentials.displayModel }),
    maxTurns: 50,
    allowedTools: [...DEFAULT_ALLOWED_TOOLS],
    // Enable Skills loading from $CLAUDE_CONFIG_DIR/skills/ and <workspace>/.claude/skills/
    settingSources: ['user', 'project'],
    permissionMode: 'acceptEdits' as const,
    canUseTool: createCanUseTool(),
    // Requires SDK patch: enable token-level streaming (stream_event)
    includePartialMessages: true,
    executable: electronPath,
    executableArgs: ['--no-warnings']
  }

  // Add MCP servers if provided
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    sdkOptions.mcpServers = mcpServers
  }

  return sdkOptions
}
