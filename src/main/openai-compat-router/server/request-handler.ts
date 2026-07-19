/**
 * Request Handler
 *
 * Core logic for handling API requests through the router.
 *
 * Supports two modes:
 *   1. OpenAI conversion: Anthropic -> OpenAI -> Backend -> OpenAI -> Anthropic
 *   2. Anthropic passthrough: Anthropic -> Backend -> Anthropic (zero conversion)
 *
 * Interceptors run BEFORE any format conversion, on the native Anthropic request.
 * URL is the single source of truth for OpenAI mode - no inference, no override.
 */

import type { Response as ExpressResponse } from 'express'
import type { AnthropicRequest, BackendConfig } from '../types'
import {
  convertAnthropicToOpenAIChat,
  convertAnthropicToOpenAIResponses,
  convertOpenAIChatToAnthropic,
  convertOpenAIResponsesToAnthropic
} from '../converters'
import {
  streamOpenAIChatToAnthropic,
  streamOpenAIResponsesToAnthropic,
  streamAnthropicPassthrough,
  pipeAnthropicPassthrough
} from '../stream'
import { isNativeAnthropicHost } from '../utils'
import { proxyFetch } from '../../services/proxy-fetch'
import { getApiTypeFromUrl, isValidEndpointUrl, getEndpointUrlError, shouldForceStream } from './api-type'
import { withRequestQueue, generateQueueKey } from './request-queue'
import { runInterceptors } from '../interceptors'
import { applyProviderAdapter, type AdapterContext } from './provider-adapters'
import { handleKiroRequest } from '../adapters/kiro.adapter'
import { countTokens } from '../utils/token-counter'
import { deferInputTokensEstimate, fillResponseUsageFallback } from '../utils/usage-estimator'

export interface RequestHandlerOptions {
  debug?: boolean
  timeoutMs?: number
  /** Anthropic SDK headers from the incoming request (anthropic-version, anthropic-beta, etc.) */
  sdkHeaders?: Record<string, string>
  /** Raw query string from the incoming request URL (e.g., "beta=true") */
  queryString?: string
  /** Raw request body buffer captured before JSON parsing */
  rawBody?: Buffer
  /** Whether interceptors modified the request (set internally) */
  requestModified?: boolean
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Anthropic error type to HTTP status code mapping
 */
const ERROR_STATUS_MAP: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
  timeout_error: 504
}

/**
 * HTTP status code to Anthropic error type mapping (official only)
 */
const STATUS_ERROR_MAP: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  529: 'overloaded_error'
}

/**
 * Get Anthropic error type from HTTP status code
 */
function getErrorTypeFromStatus(status: number): string {
  return STATUS_ERROR_MAP[status] || 'api_error'
}

/**
 * Get error type and message from upstream response
 * Priority: upstream error.type (OpenAI format) > HTTP status mapping > 'api_error'
 */
function getUpstreamError(status: number, errorText: string): { type: string; message: string } {
  try {
    const json = JSON.parse(errorText)
    // OpenAI format: { error: { type, message } }
    if (json?.error?.type) {
      return { type: json.error.type, message: json.error.message || '' }
    }
    // Anthropic format: { error: { type, message } }
    if (json?.error?.message) {
      return { type: json.error.type || getErrorTypeFromStatus(status), message: json.error.message }
    }
  } catch {
    // Not JSON, ignore
  }
  return {
    type: getErrorTypeFromStatus(status),
    message: errorText || `HTTP ${status}`
  }
}

/**
 * Send error response in Anthropic JSON format
 *
 * Returns HTTP error status code + JSON body (not SSE).
 * SDK recognizes HTTP 4xx/5xx and throws APIError immediately.
 */
function sendError(
  res: ExpressResponse,
  errorType: string,
  message: string
): void {
  const status = ERROR_STATUS_MAP[errorType] || 500
  console.log(`[RequestHandler] Sending error: HTTP ${status} ${errorType} - ${message.slice(0, 100)}`)

  res.status(status)
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('request-id', `req_${Date.now()}`)
  res.setHeader('retry-after', '3')
  res.json({
    type: 'error',
    error: { type: errorType, message }
  })
}

// ============================================================================
// Upstream Fetch
// ============================================================================

/**
 * Make upstream request with OpenAI-style Authorization header
 */
async function fetchUpstream(
  targetUrl: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
  customHeaders?: Record<string, string>
): Promise<globalThis.Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    console.log('[RequestHandler] Request timeout, aborting...')
    controller.abort()
  }, timeoutMs)

  try {
    // Build headers: start with custom headers, then add defaults
    // Custom headers can override Authorization if needed (e.g., OAuth providers)
    const headers: Record<string, string> = {
      ...(customHeaders || {}),
    }
    // Remove any case variant of content-type to avoid duplicate values
    // (e.g., user may have set 'content-type' lowercase; fetch merges same headers
    // case-insensitively into "application/json, application/json")
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') {
        delete headers[key]
      }
    }
    headers['Content-Type'] = 'application/json'
    // Only add Authorization if not provided in custom headers
    if (!headers['Authorization']) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    return await proxyFetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal ?? controller.signal
    })
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Make upstream request with Anthropic-style x-api-key header.
 *
 * Header merge order (later wins):
 *   1. SDK headers (content-type, anthropic-version, anthropic-beta, etc. from the SDK's request)
 *   2. User custom headers (from provider config)
 *   3. x-api-key (replaced with real key — sdkHeaders carries the encoded config key)
 *
 * @param bodyOrBuffer - Pre-serialized Buffer (raw body) or object to JSON.stringify
 */
async function fetchAnthropicUpstream(
  targetUrl: string,
  apiKey: string,
  bodyOrBuffer: Buffer | unknown,
  timeoutMs: number,
  sdkHeaders?: Record<string, string>,
  customHeaders?: Record<string, string>
): Promise<globalThis.Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    console.log('[RequestHandler] Anthropic passthrough timeout, aborting...')
    controller.abort()
  }, timeoutMs)

  try {
    const hasAuthHeader = Object.keys(customHeaders || {}).some(
      k => k.toLowerCase() === 'authorization'
    )

    // Merge anthropic-beta from the SDK layer and the provider instead of
    // overwriting. The SDK sets betas for the features it uses (context-
    // management, etc.) and the provider adds its own (oauth, interleaved-
    // thinking). Both must be present — overwriting drops one side's betas,
    // causing API rejections.
    const sdkBeta = Object.entries(sdkHeaders || {}).find(([k]) => k.toLowerCase() === 'anthropic-beta')?.[1]
    const customBeta = Object.entries(customHeaders || {}).find(([k]) => k.toLowerCase() === 'anthropic-beta')?.[1]
    let mergedBeta: string | undefined
    if (sdkBeta && customBeta) {
      const seen = new Set<string>()
      const all = [...sdkBeta.split(','), ...customBeta.split(',')]
        .map(s => s.trim()).filter(Boolean)
        .filter(s => seen.has(s) ? false : (seen.add(s), true))
      // Web Headers API serializes array-valued headers as ', '-joined.
      mergedBeta = all.join(', ')
    } else {
      mergedBeta = customBeta || sdkBeta
    }

    const headers: Record<string, string> = {
      ...(sdkHeaders || {}),
      ...(customHeaders || {}),
      // Override with merged beta (covers both SDK and provider betas)
      ...(mergedBeta && { 'anthropic-beta': mergedBeta }),
      // Skip x-api-key when the provider already injected an Authorization header
      // (e.g. GitHub Copilot uses Bearer token instead of x-api-key)
      ...(!hasAuthHeader && { 'x-api-key': apiKey }),
    }

    // Deduplicate content-type: sdkHeaders (lowercase from Express) and customHeaders
    // (user-defined, any casing) may both contain content-type. When a plain object
    // with two differently-cased keys like 'content-type' and 'Content-Type' is passed
    // to fetch, undici normalizes both to the same header and joins the values with
    // ", " — producing "application/json, application/json" which upstream APIs reject.
    const contentTypeValue = Object.entries(headers).find(
      ([k]) => k.toLowerCase() === 'content-type'
    )?.[1]
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') {
        delete headers[key]
      }
    }
    headers['content-type'] = contentTypeValue || 'application/json'

    return await proxyFetch(targetUrl, {
      method: 'POST',
      headers,
      body: Buffer.isBuffer(bodyOrBuffer) ? bodyOrBuffer : JSON.stringify(bodyOrBuffer),
      signal: controller.signal
    })
  } finally {
    clearTimeout(timeout)
  }
}

// ============================================================================
// Anthropic Passthrough Handler
// ============================================================================

/**
 * Headers that must NOT be forwarded from upstream response to client.
 * These are hop-by-hop or transport-level headers managed by Node/Express.
 */
const RESPONSE_HOP_BY_HOP = new Set([
  'connection',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'keep-alive',
])

/**
 * Forward all upstream response headers to the client, skipping hop-by-hop headers.
 * This ensures the proxy is fully transparent at the HTTP header level.
 */
function forwardResponseHeaders(upstreamResp: globalThis.Response, res: ExpressResponse): void {
  upstreamResp.headers.forEach((value, key) => {
    if (!RESPONSE_HOP_BY_HOP.has(key.toLowerCase())) {
      res.setHeader(key, value)
    }
  })
}

/**
 * Handle Anthropic passthrough request — zero format conversion.
 *
 * Proxies the Anthropic request directly to the upstream Anthropic API.
 *
 * Streaming responses take one of two paths, decided by the upstream host:
 *  - Genuine first-party Anthropic (api.anthropic.com — covers both API key and
 *    OAuth "Claude auth"): the upstream SSE is piped to the client byte-for-byte.
 *    Its events are already well-formed, and re-serializing would drop interleaved
 *    `thinking` text (see isNativeAnthropicHost).
 *  - Third-party Anthropic-compatible providers (e.g. GLM): the stream is
 *    re-serialized through BaseStreamHandler to apply repairs (empty text block,
 *    malformed tool JSON, etc.).
 *
 * Response headers and status codes are forwarded transparently from upstream.
 */
async function handleAnthropicPassthrough(
  anthropicRequest: AnthropicRequest,
  config: BackendConfig,
  res: ExpressResponse,
  options: RequestHandlerOptions
): Promise<void> {
  const { debug = false, timeoutMs = DEFAULT_TIMEOUT_MS, sdkHeaders, queryString, rawBody, requestModified } = options
  const { url: backendUrl, key: apiKey, model, headers: customHeaders } = config

  // Append SDK query string to upstream URL (e.g., ?beta=true)
  // Deduplicate: skip SDK params already present in backendUrl
  let targetUrl = backendUrl
  if (queryString) {
    try {
      const backendUrlObj = new URL(backendUrl)
      const sdkParams = new URLSearchParams(queryString)
      // Remove params that already exist in the backend URL
      for (const [key] of backendUrlObj.searchParams) {
        sdkParams.delete(key)
      }
      const remaining = sdkParams.toString()
      if (remaining) {
        const separator = backendUrl.includes('?') ? '&' : '?'
        targetUrl = `${backendUrl}${separator}${remaining}`
      }
    } catch {
      // Fallback: append as-is if URL parsing fails
      const separator = backendUrl.includes('?') ? '&' : '?'
      targetUrl = `${backendUrl}${separator}${queryString}`
    }
  }

  // Override model if specified in config.
  //
  // [1m] is a Claude-specific client-side marker (used by the embedded SDK
  // for 1M-context window detection, see has1mContext / getContextWindowForModel)
  // that must be stripped before reaching /v1/messages — the Anthropic API
  // only accepts canonical model ids. The strip is a no-op for any backend
  // whose model ids never carry this suffix.
  //
  // This mutates the parsed object, so rawBody can't be used when the
  // override (or strip) actually changes the body.
  const wireModel = model ? model.replace(/\[1m\]$/i, '') : undefined
  const modelOverridden = !!(wireModel && wireModel !== anthropicRequest.model)
  if (wireModel) {
    anthropicRequest.model = wireModel
  }

  const toolCount = anthropicRequest.tools?.length ?? 0
  console.log(`[RequestHandler] Anthropic passthrough tools=${toolCount}`)
  console.log(`[RequestHandler] POST ${targetUrl} (stream=${anthropicRequest.stream ?? false})`)

  // Use raw body buffer when neither interceptors nor model override modified the request.
  // This avoids a JSON.stringify round-trip — the upstream receives byte-identical body from SDK.
  const canUseRawBody = rawBody && !requestModified && !modelOverridden
  const fetchBody: Buffer | unknown = canUseRawBody ? rawBody : anthropicRequest

  if (debug) {
    console.log(`[RequestHandler] Raw body forwarding: ${canUseRawBody ? 'yes' : 'no (modified)'}`)
  }

  const anthUpstreamStartTs = Date.now()
  try {
    const upstreamResp = await fetchAnthropicUpstream(
      targetUrl, apiKey, fetchBody, timeoutMs, sdkHeaders, customHeaders
    )
    console.log(`[RequestHandler] Anthropic upstream response: ${upstreamResp.status}`)
    console.log(`[RequestHandler] upstream_ok wire=anthropic status=${upstreamResp.status} duration_ms=${Date.now() - anthUpstreamStartTs} url=${targetUrl}`)

    // Handle errors — forward upstream response transparently (status + headers + body)
    if (!upstreamResp.ok) {
      const errorText = await upstreamResp.text().catch(() => '')
      console.error(`[RequestHandler] Anthropic error ${upstreamResp.status}: ${errorText.slice(0, 200)}`)
      console.log(`[RequestHandler] upstream_error_detail wire=anthropic status=${upstreamResp.status} duration_ms=${Date.now() - anthUpstreamStartTs} content_type=${upstreamResp.headers.get('content-type') || ''} www_authenticate=${upstreamResp.headers.get('www-authenticate') || ''} url=${targetUrl} body_head="${errorText.slice(0, 500).replace(/"/g, "'")}"`)

      res.status(upstreamResp.status)
      forwardResponseHeaders(upstreamResp, res)
      // Business policy: override retry-after for faster client recovery
      res.setHeader('retry-after', '3')
      res.end(errorText)
      return
    }

    // Streaming response.
    if (anthropicRequest.stream && upstreamResp.body) {
      forwardResponseHeaders(upstreamResp, res)
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')

      if (isNativeAnthropicHost(backendUrl)) {
        // Genuine first-party Anthropic: forward SSE verbatim. The repair
        // pipeline (below) would drop interleaved thinking text, so it must be
        // bypassed for well-formed native streams.
        console.log('[RequestHandler] Anthropic passthrough (raw pipe)')
        await pipeAnthropicPassthrough(upstreamResp.body, res)
        return
      }

      // Third-party Anthropic-compatible providers: re-serialize through the
      // BaseStreamHandler repair pipeline (empty text block, tool JSON, etc.).
      // The deferred estimate backs the usage fallback for providers that
      // omit usage; it computes in the background while the model generates.
      await streamAnthropicPassthrough(
        upstreamResp.body,
        res,
        anthropicRequest.model,
        debug,
        deferInputTokensEstimate(anthropicRequest)
      )
      return
    }

    // Non-streaming: forward JSON response as-is
    const body = await upstreamResp.text()
    if (debug) {
      console.log(`[RequestHandler] Anthropic response:\n${body.slice(0, 2000)}`)
    }
    forwardResponseHeaders(upstreamResp, res)
    res.end(body)
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      console.error('[RequestHandler] Anthropic passthrough AbortError (timeout or client disconnect)')
      return sendError(res, 'timeout_error', 'Request timed out')
    }
    console.error('[RequestHandler] Anthropic passthrough error:', error?.message || error)
    return sendError(res, 'api_error', error?.message || 'Internal error')
  }
}
// ============================================================================
// OpenAI Conversion Handler
// ============================================================================

/**
 * Handle OpenAI-compatible request — full format conversion pipeline.
 *
 * Converts Anthropic -> OpenAI, proxies to backend, converts OpenAI -> Anthropic.
 */
async function handleOpenAIConversion(
  anthropicRequest: AnthropicRequest,
  config: BackendConfig,
  res: ExpressResponse,
  options: RequestHandlerOptions
): Promise<void> {
  const { debug = false, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const { url: backendUrl, key: apiKey, model, headers: customHeaders, apiType: configApiType, adapterId } = config
  console.log(`[RequestHandler] adapterId: ${adapterId || 'none'}`)

  // Validate URL has valid endpoint suffix
  if (!isValidEndpointUrl(backendUrl)) {
    return sendError(res, 'invalid_request_error', getEndpointUrlError(backendUrl))
  }

  // Get API type from URL suffix, or use config override (guaranteed non-null after validation)
  const apiType = configApiType === 'anthropic_passthrough' ? 'chat_completions' : (configApiType || getApiTypeFromUrl(backendUrl)!)

  // Override model if specified in config
  if (model) {
    anthropicRequest.model = model
  }

  console.log(`[RequestHandler] model=${anthropicRequest.model} apiKey=${apiKey ? apiKey.slice(0, 8) + '...' : 'none'}`)

  // Use request queue to prevent concurrent requests
  const queueKey = generateQueueKey(backendUrl, apiKey)

  await withRequestQueue(queueKey, async () => {
    try {
      // Determine stream mode
      const forceEnvStream = shouldForceStream()
      const preferStreamByWire = apiType === 'responses' && anthropicRequest.stream === undefined
      let wantStream = forceEnvStream || config.forceStream || preferStreamByWire || anthropicRequest.stream

      // Convert request
      const requestToSend = { ...anthropicRequest, stream: wantStream }
      const visionOverride = { supportsVision: config.supportsVision }
      const openaiRequest = apiType === 'responses'
        ? convertAnthropicToOpenAIResponses(requestToSend, visionOverride).request
        : convertAnthropicToOpenAIChat(requestToSend, visionOverride).request

      const toolCount = (openaiRequest as any).tools?.length ?? 0
      console.log(`[RequestHandler] wire=${apiType} tools=${toolCount}`)
      console.log(`[RequestHandler] POST ${backendUrl} (stream=${wantStream ?? false})`)

      // Build headers: start with custom headers from config
      const requestHeaders: Record<string, string> = { ...(customHeaders || {}) }

      // Apply provider-specific transformations (e.g., Groq temperature fix, OpenRouter headers)
      const adapterContext: AdapterContext = { originalRequest: requestToSend }
      const adapter = applyProviderAdapter(
        backendUrl,
        openaiRequest as Record<string, unknown>,
        requestHeaders,
        adapterId,
        adapterContext
      )
      if (adapter) {
        console.log(`[RequestHandler] Applied provider adapter: ${adapter.name}`)
      }

      const oaiUpstreamStartTs = Date.now()
      // Make upstream request - URL is used directly, no modification
      let upstreamResp = await fetchUpstream(backendUrl, apiKey, openaiRequest, timeoutMs, undefined, requestHeaders)
      console.log(`[RequestHandler] Upstream response: ${upstreamResp.status}`)
      console.log(`[RequestHandler] upstream_ok wire=openai api_type=${apiType} status=${upstreamResp.status} duration_ms=${Date.now() - oaiUpstreamStartTs} url=${backendUrl}`)

      // Handle errors - use upstream error type if available, else map from status
      if (!upstreamResp.ok) {
        const errorText = await upstreamResp.text().catch(() => '')
        const { type: errorType, message: errorMessage } = getUpstreamError(upstreamResp.status, errorText)
        console.error(`[RequestHandler] Provider error ${upstreamResp.status}: ${errorText.slice(0, 200)}`)
        console.log(`[RequestHandler] upstream_error_detail wire=openai api_type=${apiType} status=${upstreamResp.status} duration_ms=${Date.now() - oaiUpstreamStartTs} content_type=${upstreamResp.headers.get('content-type') || ''} www_authenticate=${upstreamResp.headers.get('www-authenticate') || ''} url=${backendUrl} body_head="${errorText.slice(0, 500).replace(/"/g, "'")}"`)

        // Check if upstream requires stream=true, retry if needed
        const errorLower = errorText?.toLowerCase() || ''
        const requiresStream = errorLower.includes('stream must be set to true') ||
                               (errorLower.includes('non-stream') && errorLower.includes('not supported'))

        if (requiresStream && !wantStream) {
          console.warn('[RequestHandler] Upstream requires stream=true, retrying...')

          // Retry with stream enabled
          wantStream = true
          const retryRequest = apiType === 'responses'
            ? convertAnthropicToOpenAIResponses({ ...anthropicRequest, stream: true }, visionOverride).request
            : convertAnthropicToOpenAIChat({ ...anthropicRequest, stream: true }, visionOverride).request

          // Re-apply provider adapter to retry request (reuse same headers and context)
          applyProviderAdapter(backendUrl, retryRequest as Record<string, unknown>, requestHeaders, adapterId, adapterContext)

          const oaiRetryStartTs = Date.now()
          upstreamResp = await fetchUpstream(backendUrl, apiKey, retryRequest, timeoutMs, undefined, requestHeaders)
          console.log(`[RequestHandler] upstream_ok wire=openai api_type=${apiType} retry=true status=${upstreamResp.status} duration_ms=${Date.now() - oaiRetryStartTs} url=${backendUrl}`)

          if (!upstreamResp.ok) {
            const retryErrorText = await upstreamResp.text().catch(() => '')
            const { type: retryErrorType, message: retryErrorMessage } = getUpstreamError(upstreamResp.status, retryErrorText)
            console.error(`[RequestHandler] Provider error ${upstreamResp.status}: ${retryErrorText.slice(0, 200)}`)
            console.log(`[RequestHandler] upstream_error_detail wire=openai api_type=${apiType} retry=true status=${upstreamResp.status} duration_ms=${Date.now() - oaiRetryStartTs} content_type=${upstreamResp.headers.get('content-type') || ''} www_authenticate=${upstreamResp.headers.get('www-authenticate') || ''} url=${backendUrl} body_head="${retryErrorText.slice(0, 500).replace(/"/g, "'")}"`)
            return sendError(res, retryErrorType, retryErrorMessage)
          }
        } else {
          return sendError(res, errorType, errorMessage)
        }
      }

      // Handle streaming response
      if (wantStream) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')

        // Background input-token estimate backing the usage fallback for
        // providers that omit usage from the stream; computes while the
        // model generates, so stream finish never waits on it.
        const estimateInputTokens = deferInputTokensEstimate(anthropicRequest)
        if (apiType === 'responses') {
          await streamOpenAIResponsesToAnthropic(upstreamResp.body, res, anthropicRequest.model, debug, estimateInputTokens)
        } else {
          await streamOpenAIChatToAnthropic(upstreamResp.body, res, anthropicRequest.model, debug, estimateInputTokens)
        }
        return
      }

      // Handle non-streaming response
      const openaiResponse = await upstreamResp.json()
      if (debug) {
        console.log(`[RequestHandler] Response body:\n${JSON.stringify(openaiResponse, null, 2)}`)
      }
      const anthropicResponse = apiType === 'responses'
        ? convertOpenAIResponsesToAnthropic(openaiResponse)
        : convertOpenAIChatToAnthropic(openaiResponse, anthropicRequest.model)

      fillResponseUsageFallback(anthropicResponse, anthropicRequest)
      res.json(anthropicResponse)
    } catch (error: any) {
      // Handle abort/timeout
      if (error?.name === 'AbortError') {
        console.error('[RequestHandler] AbortError (timeout or client disconnect)')
        return sendError(res, 'timeout_error', 'Request timed out')
      }

      console.error('[RequestHandler] Internal error:', error?.message || error)
      return sendError(res, 'api_error', error?.message || 'Internal error')
    }
  })
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Handle messages request — unified entry point for all providers.
 *
 * Flow:
 *   1. Run interceptors on Anthropic-format request (before any conversion)
 *   2. Route to appropriate handler based on apiType:
 *      - anthropic_passthrough: direct proxy, zero conversion
 *      - chat_completions/responses: full OpenAI conversion pipeline
 */
export async function handleMessagesRequest(
  anthropicRequest: AnthropicRequest,
  config: BackendConfig,
  res: ExpressResponse,
  options: RequestHandlerOptions = {}
): Promise<void> {
  const { url: backendUrl, apiType: configApiType } = config
  console.log('[RequestHandler] handleMessagesRequest', backendUrl)

  // Run interceptors on Anthropic-format request (before any conversion)
  const interceptResult = await runInterceptors(
    anthropicRequest,
    { originalModel: anthropicRequest.model, res }
  )

  // If interceptor sent a response, we're done
  if (interceptResult.intercepted && 'responded' in interceptResult) {
    return
  }

  // Use potentially modified request from interceptors
  const request = interceptResult.request

  // Route based on apiType
  if (configApiType === 'anthropic_passthrough') {
    return handleAnthropicPassthrough(request, config, res, {
      ...options,
      requestModified: interceptResult.intercepted
    })
  }

  if (configApiType === 'kiro') {
    return handleKiroRequest(request, config, res, { timeoutMs: options.timeoutMs })
  }

  return handleOpenAIConversion(request, config, res, options)
}

/**
 * Handle token counting request using model-aware tokenizers.
 *
 * Uses @anthropic-ai/tokenizer for Claude, gpt-tokenizer for GPT models,
 * and cl100k_base as fallback for other models (Qwen, DeepSeek, etc.).
 */
export function handleCountTokensRequest(
  messages: unknown,
  system: unknown,
  model?: string
): { input_tokens: number } {
  let count = 0

  if (system) {
    count += countTokens(JSON.stringify(system), model)
  }
  if (messages) {
    count += countTokens(JSON.stringify(messages), model)
  }

  return { input_tokens: count }
}
