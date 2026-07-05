/**
 * API Validator Service
 *
 * Validates API connections by sending a test message through the Claude Code SDK.
 * This ensures the entire pipeline (router, SDK, upstream API) works correctly.
 *
 * Why use SDK instead of direct HTTP?
 * 1. Tests the complete data path including OpenAI compat router
 * 2. Handles proxy/network configurations correctly
 * 3. Validates credentials in the same way production code does
 *
 * Uses the same SDK pattern as the agent module (session-manager.ts)
 */

import { proxyFetch } from './proxy-fetch'
import { createSession } from './agent/resolved-sdk'
import { app } from 'electron'
import path from 'path'
import { ensureOpenAICompatRouter, encodeBackendConfig, normalizeApiUrl } from '../openai-compat-router'
import type { BackendConfig } from '../openai-compat-router'
import { buildSdkEnv } from './agent/sdk-config'
import { DEFAULT_MODEL } from '../../shared/types/ai-sources'
import { getHeadlessElectronPath } from './agent/helpers'

// Re-export normalizeApiUrl for external use (moved to router module)
export { normalizeApiUrl } from '../openai-compat-router'

export interface FetchModelsParams {
  apiKey: string
  apiUrl: string
}

export interface FetchModelsResult {
  models: Array<{ id: string; name: string }>
}

/**
 * Fetch available models from an OpenAI-compatible API endpoint.
 *
 * Runs in the main process (Node.js) to avoid CORS restrictions
 * that block direct renderer fetch() calls to external APIs.
 */
export async function fetchModelsFromApi(params: FetchModelsParams): Promise<FetchModelsResult> {
  const { apiKey, apiUrl } = params

  if (!apiKey || !apiUrl) {
    throw new Error('API key and URL are required')
  }

  // Normalize URL: strip trailing slashes, known path suffixes, and auto-append /v1
  let baseUrl = apiUrl.replace(/\/+$/, '')
  const suffixes = ['/chat/completions', '/completions', '/responses', '/v1/chat']
  for (const suffix of suffixes) {
    if (baseUrl.endsWith(suffix)) {
      baseUrl = baseUrl.slice(0, -suffix.length)
      break
    }
  }

  if (!baseUrl.includes('/v1') && !baseUrl.includes('/api/paas')) {
    baseUrl = `${baseUrl}/v1`
  }

  const modelsUrl = `${baseUrl}/models`

  console.log('[API Validator] Fetching models from:', modelsUrl)

  const response = await proxyFetch(modelsUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    signal: AbortSignal.timeout(15000)
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch models (${response.status})`)
  }

  const data = await response.json()

  if (!data.data || !Array.isArray(data.data)) {
    throw new Error('Invalid API response format')
  }

  const models = data.data
    .filter((m: any) => typeof m.id === 'string')
    .map((m: any) => ({ id: m.id, name: m.id }))
    .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id))

  if (models.length === 0) {
    throw new Error('No models found')
  }

  console.log(`[API Validator] Found ${models.length} models`)

  return { models }
}

export interface ValidateApiParams {
  apiKey: string
  apiUrl: string
  provider: 'anthropic' | 'openai'
  model?: string
}

export interface ValidateApiResult {
  valid: boolean
  message?: string
  model?: string
  normalizedUrl: string
}

/**
 * Validate API connection by sending a test message through SDK
 *
 * This function:
 * 1. Normalizes the URL based on provider type
 * 2. Starts the OpenAI compat router if needed
 * 3. Creates a temporary SDK session with the test config
 * 4. Sends a minimal test message and streams response
 * 5. Returns validation result
 *
 * Uses the same SDK pattern as session-manager.ts: send() + stream()
 */
export async function validateApiConnection(params: ValidateApiParams): Promise<ValidateApiResult> {
  const { apiKey, apiUrl, provider, model } = params

  // Step 1: Normalize URL
  const normalizedUrl = normalizeApiUrl(apiUrl, provider)

  // Step 2: Build backend config for router
  let anthropicBaseUrl: string
  let anthropicApiKey: string

  if (provider === 'openai') {
    // Route through OpenAI compat router
    const routerInfo = await ensureOpenAICompatRouter({ debug: false })

    const backendConfig: BackendConfig = {
      url: normalizedUrl,
      key: apiKey
    }

    anthropicBaseUrl = routerInfo.baseUrl
    anthropicApiKey = encodeBackendConfig(backendConfig)
  } else {
    // Direct Anthropic API
    anthropicBaseUrl = normalizedUrl
    anthropicApiKey = apiKey
  }

  // Step 3: Determine test model
  // For OpenAI compat: MUST use the user-configured model, because each provider has its own
  // model namespace (e.g. Gemini uses 'gemini-2.5-pro', not Claude model names).
  // Do NOT fall back to a Claude model name for OpenAI-compat providers — providers like Gemini
  // will reject unknown model IDs such as 'claude-sonnet-4-20250514' with a 404/400 error.
  // For Anthropic: use model from config or the default Claude Sonnet.
  if (provider === 'openai' && !model) {
    return {
      valid: false,
      normalizedUrl,
      message: 'Please select a model before testing the connection'
    }
  }
  const testModel = model || DEFAULT_MODEL

  // Step 4: Get headless Electron path (same as agent module, used for executable fallback)
  const electronPath = getHeadlessElectronPath()

  // Step 5: Create temporary SDK session with same pattern as session-manager.ts
  const abortController = new AbortController()

  // Set timeout for validation (15 seconds)
  const timeoutId = setTimeout(() => {
    abortController.abort()
  }, 15000)

  try {
    const sdkOptions: Record<string, unknown> = {
      model: testModel,
      cwd: app.getPath('temp'),
      abortController,
      // Use buildSdkEnv for consistent environment setup matching the agent module.
      // This includes CLAUDE_CONFIG_DIR, proxy normalization, and all required flags.
      env: buildSdkEnv({
        anthropicApiKey,
        anthropicBaseUrl
      }),
      systemPrompt: 'Reply with exactly: OK',
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'bypassPermissions' as const,
      // Use the same cli.js path as the agent module (sdk-config.ts buildBaseSdkOptions)
      // This avoids spawning a full Electron subprocess for headless node usage,
      // which can fail on Windows when the executable path contains spaces or
      // when the Electron binary is not recognized as a Node.js runtime.
      pathToClaudeCodeExecutable: path.join(app.getAppPath(), 'node_modules/@anthropic-ai/claude-code/cli.js'),
      executable: electronPath,
      executableArgs: ['--no-warnings'],
      extraArgs: {
        'dangerously-skip-permissions': null
      }
    }

    console.log('[API Validator] Creating SDK session for validation...')
    const session = await createSession(sdkOptions) as any

    // Step 6: Send test message using correct SDK pattern: send() + stream()
    console.log('[API Validator] Sending test message...')
    session.send('test')

    // Step 7: Stream response and check for valid reply
    let hasResponse = false
    let responseContent = ''

    for await (const msg of session.stream()) {
      // Check for abort
      if (abortController.signal.aborted) {
        break
      }

      // Look for assistant message or result
      if (msg.type === 'assistant') {
        hasResponse = true
        const content = (msg as any).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              responseContent += block.text || ''
            }
          }
        }
      } else if (msg.type === 'result') {
        hasResponse = true
        break
      }
    }

    // Step 8: Close session
    clearTimeout(timeoutId)
    try {
      session.close()
    } catch {
      // Ignore close errors
    }

    console.log(`[API Validator] Validation complete: hasResponse=${hasResponse}, content="${responseContent.substring(0, 50)}"`)

    if (hasResponse) {
      return {
        valid: true,
        normalizedUrl,
        model: testModel,
        message: 'Connection successful'
      }
    } else {
      return {
        valid: false,
        normalizedUrl,
        message: 'No response received from API'
      }
    }
  } catch (error) {
    clearTimeout(timeoutId)

    const err = error as Error
    const errorMessage = err.message || 'Connection failed'

    console.error('[API Validator] Validation error:', errorMessage)

    // Parse common error patterns for better user feedback
    let userFriendlyMessage = errorMessage

    if (err.name === 'AbortError' || errorMessage.includes('aborted')) {
      userFriendlyMessage = 'Connection timeout - server may be slow or unreachable'
    } else if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
      userFriendlyMessage = 'Invalid API key'
    } else if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
      userFriendlyMessage = 'Access denied - check API key permissions'
    } else if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
      userFriendlyMessage = 'API endpoint not found - check URL'
    } else if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
      userFriendlyMessage = 'Rate limited - try again later'
    } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
      userFriendlyMessage = 'Cannot connect to API server - check URL'
    } else if (errorMessage.includes('timeout')) {
      userFriendlyMessage = 'Connection timeout - server may be slow or unreachable'
    }

    return {
      valid: false,
      normalizedUrl,
      message: userFriendlyMessage
    }
  }
}
