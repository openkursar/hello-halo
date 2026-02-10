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

import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk'
import { app } from 'electron'
import { ensureOpenAICompatRouter, encodeBackendConfig, normalizeApiUrl } from '../openai-compat-router'
import type { BackendConfig } from '../openai-compat-router'
import { getCleanUserEnv } from './agent/sdk-config'
import { AVAILABLE_MODELS } from '../../shared/types/ai-sources'
import { getHeadlessElectronPath } from './agent/helpers'

// Re-export normalizeApiUrl for external use (moved to router module)
export { normalizeApiUrl } from '../openai-compat-router'

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
  // For OpenAI compat: use a simple model, SDK will pass through router
  // For Anthropic: use actual model from config or default
  const testModel = model || (provider === 'anthropic' ? AVAILABLE_MODELS[2].id : 'claude-sonnet-4-20250514')

  // Step 4: Get headless Electron path (same as agent module)
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
      env: {
        ...getCleanUserEnv(),
        ELECTRON_RUN_AS_NODE: 1,
        ELECTRON_NO_ATTACH_CONSOLE: 1,
        ANTHROPIC_API_KEY: anthropicApiKey,
        ANTHROPIC_BASE_URL: anthropicBaseUrl,
        NO_PROXY: 'localhost,127.0.0.1',
        no_proxy: 'localhost,127.0.0.1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_COST_WARNINGS: '1'
      },
      systemPrompt: 'Reply with exactly: OK',
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'default' as const,
      executable: electronPath,
      executableArgs: ['--no-warnings']
    }

    console.log('[API Validator] Creating SDK session for validation...')
    const session = await unstable_v2_createSession(sdkOptions as any) as any

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
