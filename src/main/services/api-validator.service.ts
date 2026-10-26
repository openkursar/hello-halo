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
import { ensureOpenAICompatRouter, encodeBackendConfig, normalizeApiUrl } from '../openai-compat-router'
import type { BackendConfig } from '../openai-compat-router'
import { buildSdkEnv, resolveClaudeCodeCliPath } from './agent/sdk-config'
import { getTempSpacePath } from '../foundation/config.service'
import { DEFAULT_MODEL } from '../../shared/types/ai-sources'
import {
  ModelFetchError,
  modelFetchFailureFromError,
  modelFetchFailureFromResponse
} from '../../shared/model-fetch-error'
import { parseCatalogModelOption } from '../../shared/model-catalog'
import type { CatalogModelCapability } from '../../shared/types/model-capabilities'
import { getHeadlessElectronPath } from './agent/helpers'

// Re-export normalizeApiUrl for external use (moved to router module)
export { normalizeApiUrl } from '../openai-compat-router'

export interface FetchModelsParams {
  apiKey: string
  apiUrl: string
}

export interface FetchedModel {
  id: string
  name: string
  supportsVision?: boolean
  capabilities?: CatalogModelCapability
}

export interface FetchModelsResult {
  models: FetchedModel[]
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

  // Only auto-append /v1 when the URL has no explicit API version segment.
  // Gateways like Zhipu's Coding Plan already end in /v4 (…/api/coding/paas/v4),
  // and blindly appending /v1 corrupts the path (…/v4/v1/models → 404 once the
  // key authenticates), which silently degrades the model list to the static
  // fallback.
  const hasVersionSuffix = /\/v\d+$/.test(baseUrl)
  if (!hasVersionSuffix && !baseUrl.includes('/v1') && !baseUrl.includes('/api/paas')) {
    baseUrl = `${baseUrl}/v1`
  }

  const modelsUrl = `${baseUrl}/models`

  console.log('[API Validator] Fetching models from:', modelsUrl)

  try {
    const response = await proxyFetch(modelsUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(15000)
    })

    if (!response.ok) {
      const body = await response.text()
      throw new ModelFetchError(modelFetchFailureFromResponse(response.status, body, apiKey))
    }

    const data = await response.json() as { data?: unknown }

    if (!Array.isArray(data.data)) {
      throw new Error('Invalid API response format')
    }

    const models: FetchedModel[] = data.data
      .map(parseCatalogModelOption)
      .filter((model): model is FetchedModel => model !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id))

    if (models.length === 0) {
      throw new Error('No models found')
    }

    console.log(`[API Validator] Found ${models.length} models`)

    return { models }
  } catch (error) {
    if (error instanceof ModelFetchError) throw error
    throw new ModelFetchError(modelFetchFailureFromError(error))
  }
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

interface ValidationFrame {
  type?: string
  subtype?: string
  is_error?: boolean
  error?: unknown
  errors?: unknown
  result?: unknown
  message?: { content?: Array<{ type?: string; text?: unknown }> }
}

interface ValidationSession {
  send(message: string): void | Promise<void>
  stream(): AsyncIterable<ValidationFrame>
  close(): void
}

function validationFailureMessage(error: unknown, timedOut: boolean): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const name = error instanceof Error ? error.name : ''
  if (timedOut || name === 'AbortError' || /aborted|timeout|timed out/i.test(message)) return 'Connection timeout - server may be slow or unreachable'
  if (/\b401\b|unauthorized|authentication_failed|invalid api key/i.test(message)) return 'Invalid API key'
  if (/\b403\b|forbidden|permission_denied/i.test(message)) return 'Access denied - check API key permissions'
  if (/model.{0,80}(?:not found|not available|unavailable|does not exist)|(?:unknown|invalid) model|model_not_found/i.test(message)) return 'Requested model is not available'
  if (/\b404\b|not found/i.test(message)) return 'API endpoint not found - check URL'
  if (/\b429\b|rate.?limit/i.test(message)) return 'Rate limited - try again later'
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed/i.test(message)) return 'Cannot connect to API server - check URL'
  return 'Connection failed'
}

function validationFrameError(frame: ValidationFrame): Error {
  const details = [frame.error, ...(Array.isArray(frame.errors) ? frame.errors : []), frame.result]
  if (frame.type === 'assistant' && frame.error) {
    details.push(...(frame.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text))
  }
  return new Error(details.filter((value): value is string => typeof value === 'string').map(value => value.slice(0, 2000)).join('\n') || 'Connection failed')
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

  let session: ValidationSession | undefined
  let sessionClosed = false
  let cleanupFailed = false
  let timedOut = false
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const closeSession = () => {
    if (!session || sessionClosed) return
    sessionClosed = true
    try { session.close() }
    catch {
      cleanupFailed = true
      console.warn('[API Validator] Temporary validation session close failed; cleanup may be incomplete')
    }
  }
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true
      abortController.abort()
      reject(new Error('Connection timeout'))
    }, 15000)
  })
  let outcome: ValidateApiResult

  try {
    const sdkOptions: Record<string, unknown> = {
      model: testModel,
      apiCredentials: { baseUrl: normalizedUrl, apiKey, model: testModel, provider },
      // Halo's own temp space, never the OS temp dir: on macOS the latter is the
      // shared $TMPDIR that Chromium fills with short-lived `.<bundle-id>.XXXXXX`
      // files, and a CLI subprocess rooted there races their deletion (ENOENT).
      cwd: getTempSpacePath(),
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
      pathToClaudeCodeExecutable: resolveClaudeCodeCliPath(),
      executable: electronPath,
      executableArgs: ['--no-warnings'],
      extraArgs: {
        'dangerously-skip-permissions': null
      }
    }

    const validate = async () => {
      session = await createSession(sdkOptions) as ValidationSession
      if (abortController.signal.aborted) {
        // Creation can finish after the deadline even when the adapter ignores cancellation.
        closeSession()
        throw new Error('Connection timeout')
      }
      await session.send('test')
      if (abortController.signal.aborted) throw new Error('Connection timeout')
      for await (const msg of session.stream()) {
        if (abortController.signal.aborted) throw new Error('Connection timeout')
        if (msg.type === 'error' || (msg.type === 'assistant' && msg.error)) throw validationFrameError(msg)
        if (msg.type === 'result') {
          if (msg.subtype !== 'success' || msg.is_error !== false || (Array.isArray(msg.errors) && msg.errors.length > 0)) {
            throw validationFrameError(msg)
          }
          return true
        }
      }
      return false
    }
    const valid = await Promise.race([validate(), timeout])
    outcome = valid
      ? { valid: true, normalizedUrl, model: testModel, message: 'Connection successful' }
      : { valid: false, normalizedUrl, message: 'No response received from API' }
  } catch (error) {
    outcome = { valid: false, normalizedUrl, message: validationFailureMessage(error, timedOut) }
  } finally {
    clearTimeout(timeoutId)
    abortController.abort()
    closeSession()
  }
  if (cleanupFailed) outcome = { valid: false, normalizedUrl, message: 'Connection failed' }
  const log = outcome.valid ? console.log : console.warn
  log('[API Validator] Validation complete:', { valid: outcome.valid, message: outcome.message })
  return outcome
}
