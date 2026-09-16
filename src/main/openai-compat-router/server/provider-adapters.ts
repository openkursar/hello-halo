/**
 * Provider Adapters
 *
 * Handles provider-specific request/response transformations.
 * Each adapter encapsulates the quirks and requirements of a specific LLM provider.
 *
 * Design principles:
 * - Single Responsibility: Each adapter handles one provider
 * - Open/Closed: Easy to add new adapters without modifying existing code
 * - Dual matching: URL-based detection (built-in providers) + adapterId (plugin providers)
 * - Minimal by default: The converter produces a spec-compliant baseline; adapters
 *   opt-in to extensions. No provider-specific fields leak into the shared interface.
 */

import type { AnthropicRequest } from '../types'
import { inlineToolSchemaRefs } from '../utils/json-schema'
import { CODEX_ADAPTER_ID } from '../../../shared/constants/codex-models'
import { getCodexModelCapability } from './codex-capabilities'
import { isThinkingEffort } from '../converters/reasoning-effort'

// ============================================================================
// Types
// ============================================================================

/**
 * Original request context passed to adapters.
 * Gives adapters access to pre-conversion data (e.g. thinking blocks)
 * without polluting the shared interface with provider-specific flags.
 */
export interface AdapterContext {
  /** The original Anthropic request before any conversion */
  readonly originalRequest: AnthropicRequest
  /**
   * Per-conversation session id taken from the SDK's affinity headers, or `''`
   * when the caller sent none. Generic (not provider-specific): any upstream
   * that keys cache or routing on a conversation needs the same value the SDK
   * already uses for its own affinity.
   */
  readonly sessionId?: string
}

export interface ProviderAdapter {
  /** Unique identifier for this adapter */
  readonly id: string

  /** Human-readable name */
  readonly name: string

  /** Check if this adapter should handle the given URL */
  match(url: string): boolean

  /**
   * Transform request body before sending to provider.
   * Mutates body in place for efficiency.
   * Use context.originalRequest to access pre-conversion data (e.g. thinking blocks).
   */
  transformRequest?(body: Record<string, unknown>, context?: AdapterContext): void

  /**
   * Get additional headers to include in the request.
   * These headers are merged with existing headers (adapter headers take precedence).
   * Context is passed so a header value can be derived from the same
   * pre-conversion data `transformRequest` sees.
   */
  getExtraHeaders?(context?: AdapterContext): Record<string, string>
}

// ============================================================================
// Groq Adapter
// ============================================================================

/**
 * Groq requires temperature > 0
 *
 * When temperature is exactly 0, Groq API returns an error.
 * We convert 0 to 0.01 which is effectively deterministic but valid.
 *
 * @see https://console.groq.com/docs/api-reference#chat-create
 */
const groqAdapter: ProviderAdapter = {
  id: 'groq',
  name: 'Groq',

  match(url: string): boolean {
    return url.includes('api.groq.com')
  },

  transformRequest(body: Record<string, unknown>): void {
    if (body.temperature === 0) {
      body.temperature = 0.01
    }
  }
}

// ============================================================================
// OpenRouter Adapter
// ============================================================================

/**
 * OpenRouter recommends app attribution headers
 *
 * These headers are optional but provide:
 * - App appears in OpenRouter leaderboard
 * - Request analytics show app name instead of "Unknown"
 *
 * @see https://openrouter.ai/docs/app-attribution
 */
const openRouterAdapter: ProviderAdapter = {
  id: 'openrouter',
  name: 'OpenRouter',

  match(url: string): boolean {
    return url.includes('openrouter.ai')
  },

  getExtraHeaders(): Record<string, string> {
    return {
      'HTTP-Referer': 'https://hello-halo.cc/',
      'X-Title': 'Halo'
    }
  }
}

// ============================================================================
// Requesty Adapter
// ============================================================================

/**
 * Requesty recommends app attribution headers
 *
 * Requesty is OpenAI-compatible and, like OpenRouter, supports optional
 * app attribution headers:
 * - App appears in Requesty analytics / leaderboard
 * - Request analytics show app name instead of "Unknown"
 *
 * @see https://requesty.ai/
 */
const requestyAdapter: ProviderAdapter = {
  id: 'requesty',
  name: 'Requesty',

  match(url: string): boolean {
    return url.includes('router.requesty.ai')
  },

  getExtraHeaders(): Record<string, string> {
    return {
      'HTTP-Referer': 'https://hello-halo.cc/',
      'X-Title': 'Halo'
    }
  }
}

// ============================================================================
// OrcaRouter Adapter
// ============================================================================

/**
 * OrcaRouter supports app attribution headers
 *
 * OrcaRouter is an OpenAI-compatible gateway and, like OpenRouter, accepts
 * optional app attribution headers so requests show up under the app name
 * in gateway analytics instead of "Unknown".
 *
 * @see https://docs.orcarouter.ai
 */
const orcaRouterAdapter: ProviderAdapter = {
  id: 'orcarouter',
  name: 'OrcaRouter',

  match(url: string): boolean {
    return url.includes('orcarouter.ai')
  },

  getExtraHeaders(): Record<string, string> {
    return {
      'HTTP-Referer': 'https://hello-halo.cc/',
      'X-Title': 'Halo'
    }
  }
}

// ============================================================================
// DeepSeek Adapter
// ============================================================================

/**
 * DeepSeek adapter
 *
 * DeepSeek follows the OpenAI Chat Completions spec. reasoning_content
 * injection is handled at the converter layer (thinking blocks → reasoning_content
 * + fallback loop when reasoning_effort is set), so no per-adapter transform is needed.
 *
 * @see https://api-docs.deepseek.com/
 */
const deepSeekAdapter: ProviderAdapter = {
  id: 'deepseek',
  name: 'DeepSeek',

  match(url: string): boolean {
    return url.includes('api.deepseek.com')
  }
}

// ============================================================================
// Moonshot Adapter
// ============================================================================

/**
 * Moonshot (Kimi) adapter
 *
 * Rejects tool schemas containing `$ref`, so local references are inlined for
 * this upstream only. MCP servers commonly emit `$defs`, and inlining can
 * multiply a schema several times over — every other upstream keeps the
 * compact referenced form.
 *
 * reasoning_content injection is handled at the converter layer.
 *
 * @see https://platform.moonshot.cn/docs
 */
const moonshotAdapter: ProviderAdapter = {
  id: 'moonshot',
  name: 'Moonshot',

  match(url: string): boolean {
    return url.includes('api.moonshot.cn') || url.includes('api.moonshot.ai')
  },

  transformRequest(body: Record<string, unknown>): void {
    const rewritten = inlineToolSchemaRefs(body)
    if (rewritten > 0) {
      console.log(`[MoonshotAdapter] inlined $ref in ${rewritten} tool schema(s)`)
    }
  }
}

// ============================================================================
// Zhipu AI (GLM) Adapter
// ============================================================================

/**
 * Zhipu AI (GLM) adapter
 *
 * reasoning_content injection is handled at the converter layer.
 *
 * @see https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode
 */
const zhipuAdapter: ProviderAdapter = {
  id: 'zhipu',
  name: 'Zhipu AI (GLM)',

  match(url: string): boolean {
    return url.includes('open.bigmodel.cn')
  }
}

// ============================================================================
// Tencent Adapter
// ============================================================================

/**
 * Tencent Hunyuan / CodeBuddy API uses flat reasoning parameters
 *
 * Tencent's API expects:
 * - reasoning_effort: 'low' | 'medium' | 'high'
 * - reasoningEffort: 'low' | 'medium' | 'high'  (camelCase alias)
 * - reasoning_summary: 'auto'
 *
 * We handle two incoming formats:
 * - Chat Completions: top-level `reasoning_effort` string (already correct key)
 * - Responses API: nested `reasoning: { effort }` object
 *
 * Matched via adapterId from provider plugins.
 */
const tencentAdapter: ProviderAdapter = {
  id: 'tencent',
  name: 'Tencent',

  match(url: string): boolean {
    return url.includes('copilot.tencent.com')
  },

  transformRequest(body: Record<string, unknown>): void {
    // Chat Completions format: top-level reasoning_effort string
    if (typeof body.reasoning_effort === 'string') {
      const effort = body.reasoning_effort as string
      body.reasoningEffort = effort
      body.reasoning_summary = 'auto'
      console.log(`[TencentAdapter] reasoning_effort transform: effort=${effort}`)
      return
    }

    // Responses API format: nested reasoning.effort object
    const reasoning = body.reasoning as { effort?: string } | undefined
    if (reasoning?.effort) {
      const effort = reasoning.effort
      body.reasoning_effort = effort
      body.reasoningEffort = effort
      body.reasoning_summary = 'auto'
      delete body.reasoning
      console.log(`[TencentAdapter] reasoning object transform: effort=${effort}`)
    }
  }
}

// ============================================================================
// OpenAI Codex Adapter
// ============================================================================

/**
 * The complete set of top-level fields the Codex CLI can put on a request —
 * the fields of its `ResponsesApiRequest` struct (`codex-rs/codex-api/src/common.rs`).
 * The struct is closed, so the CLI physically cannot send anything else; this
 * backend rejects what it does not recognize, so the same closure is enforced
 * here rather than patched field by field.
 */
const CODEX_REQUEST_FIELDS = new Set([
  'model',
  'instructions',
  'input',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning',
  'store',
  'stream',
  'include',
  'prompt_cache_key'
])

/**
 * Ask for a reasoning summary when thinking is enabled.
 *
 * Without this Halo's thinking toggle is invisible on this backend: the catalog
 * default for these models is `none`, so a request that omits `summary` gets no
 * reasoning back at all — the official client shows it only because it asks.
 * `auto` lets the backend choose the detail level, the enum's own default.
 *
 * `supported` is `undefined` when the catalog has not been read yet, which is
 * treated as supported: a model states `false` explicitly (the field is
 * `skip_serializing_if = "is_true"`), so silence is assent.
 */
function applyReasoningSummary(body: Record<string, unknown>, supported: boolean | undefined): void {
  const reasoning = body.reasoning as { effort?: string; summary?: string } | undefined
  if (!reasoning || typeof reasoning !== 'object') return
  if (supported === false) return
  if (!isThinkingEffort(reasoning.effort)) return
  reasoning.summary = 'auto'
}

/**
 * Give every function tool its `strict` flag, which the CLI's tool struct
 * requires. Halo's converter forwards whatever the Anthropic side declared, and
 * that is usually absent — an omission this backend does not expect.
 */
function applyToolStrictness(body: Record<string, unknown>): void {
  if (!Array.isArray(body.tools)) return
  for (const tool of body.tools as Array<Record<string, unknown>>) {
    if (tool?.type === 'function' && typeof tool.strict !== 'boolean') {
      tool.strict = false
    }
  }
}

/**
 * OpenAI Codex (ChatGPT subscription) adapter.
 *
 * The Codex backend serves the Responses API but not the generic shape Halo's
 * converter produces for every Responses upstream. The differences below come
 * from the open-source Codex CLI — the one client this endpoint has to accept —
 * and the request is then reduced to exactly the CLI's field set, because the
 * backend rejects parameters the CLI never sends (observed: HTTP 400
 * "Unsupported parameter: max_output_tokens", which Halo's converter injects
 * for other upstreams).
 *
 * Reshapes, each one a field the server reads:
 * - The system prompt travels as the top-level `instructions` string. The CLI's
 *   request carries no `system` role in `input`, and its own conversion never
 *   emits one; Halo's generic converter does, so it is hoisted here.
 * - `store`, `stream` and `include` are unconditional. `include` carries
 *   `reasoning.encrypted_content`, which the subscription backend needs to
 *   round-trip reasoning across turns.
 * - `tool_choice` / `parallel_tool_calls` are always present, as in the CLI's
 *   request struct, not only when tools were supplied.
 * - `prompt_cache_key` mirrors the per-conversation session id the CLI also
 *   sends as headers. Unset, every turn is a cache miss.
 * - `reasoning.summary` is requested whenever thinking is on, and tool `strict`
 *   flags are always present. Both come from {@link getCodexModelCapability},
 *   which the provider fills from the catalog.
 * - Models flagged `use_responses_lite` take the system prompt as a leading
 *   `developer` item and must not receive `instructions`.
 *
 * Selected by `adapterId` from the provider's BackendRequestConfig, so it never
 * captures unrelated traffic that merely shares the host.
 */
const openAICodexAdapter: ProviderAdapter = {
  id: CODEX_ADAPTER_ID,
  name: 'OpenAI Codex',

  match(url: string): boolean {
    return url.includes('chatgpt.com/backend-api')
  },

  transformRequest(body: Record<string, unknown>, context?: AdapterContext): void {
    const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : []

    const instructions: string[] = []
    const remainder = input.filter((item) => {
      if (item?.role !== 'system') return true
      const content = Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : []
      for (const part of content) {
        if (typeof part?.text === 'string' && part.text) instructions.push(part.text)
      }
      return false
    })

    if (remainder.length !== input.length) {
      body.input = remainder
    }

    const capability = getCodexModelCapability(body.model)
    const systemPrompt = instructions.join('\n')

    if (capability?.responsesLite) {
      // Responses-Lite models reject `instructions` and take the system prompt
      // as a leading developer item instead — the layout the CLI switches to for
      // them (see `build_responses_request`).
      delete body.instructions
      if (systemPrompt) {
        body.input = [
          { type: 'message', role: 'developer', content: [{ type: 'input_text', text: systemPrompt }] },
          ...(body.input as Array<Record<string, unknown>>)
        ]
      }
    } else if (systemPrompt) {
      body.instructions = systemPrompt
    } else {
      delete body.instructions
    }

    body.store = false
    body.stream = true
    body.include = ['reasoning.encrypted_content']
    body.tool_choice = 'auto'
    body.parallel_tool_calls = true

    applyReasoningSummary(body, capability?.reasoningSummary)
    applyToolStrictness(body)

    if (context?.sessionId) {
      body.prompt_cache_key = context.sessionId
    }

    // Drop everything the CLI's struct cannot carry (stream_options for
    // translation gateways, max_output_tokens, and anything a future converter
    // adds). Must run last so it does not discard the fields set above.
    for (const key of Object.keys(body)) {
      if (!CODEX_REQUEST_FIELDS.has(key)) {
        delete body[key]
      }
    }
  },

  getExtraHeaders(context?: AdapterContext): Record<string, string> {
    const sessionId = context?.sessionId
    if (!sessionId) return {}
    // The CLI sends this id under three names in the same request; keep them equal.
    return {
      'session-id': sessionId,
      'thread-id': sessionId,
      'x-client-request-id': sessionId
    }
  }
}

// ============================================================================
// Registry
// ============================================================================

/**
 * All registered provider adapters
 * Order matters: first matching adapter wins
 */
const adapters: readonly ProviderAdapter[] = [
  groqAdapter,
  openRouterAdapter,
  orcaRouterAdapter,
  requestyAdapter,
  deepSeekAdapter,
  moonshotAdapter,
  zhipuAdapter,
  tencentAdapter,
  openAICodexAdapter
]

/**
 * Find the adapter matching the given URL or adapterId
 *
 * Resolution order:
 * 1. Explicit adapterId (from BackendRequestConfig) — exact match on adapter.id
 * 2. URL pattern matching — adapter.match(url)
 */
export function findAdapter(url: string, adapterId?: string): ProviderAdapter | undefined {
  if (adapterId) {
    const byId = adapters.find(a => a.id === adapterId)
    if (byId) return byId
  }
  return adapters.find(adapter => adapter.match(url))
}

/**
 * Apply provider-specific transformations to request
 *
 * @param url - Target API URL
 * @param body - Request body (will be mutated if adapter has transformRequest)
 * @param headers - Request headers (adapter headers will be merged)
 * @param adapterId - Explicit adapter ID from provider config (takes priority over URL matching)
 * @param context - Original request context; gives adapters access to pre-conversion data
 * @returns The adapter that was applied, or undefined if none matched
 */
export function applyProviderAdapter(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  adapterId?: string,
  context?: AdapterContext
): ProviderAdapter | undefined {
  const adapter = findAdapter(url, adapterId)

  if (!adapter) {
    return undefined
  }

  // Apply request transformation
  if (adapter.transformRequest) {
    adapter.transformRequest(body, context)
  }

  // Merge extra headers (adapter headers take precedence)
  const extraHeaders = adapter.getExtraHeaders?.(context)
  if (extraHeaders) {
    Object.assign(headers, extraHeaders)
  }

  return adapter
}

// ============================================================================
// Exports
// ============================================================================

export { groqAdapter, openRouterAdapter, orcaRouterAdapter, deepSeekAdapter, moonshotAdapter, zhipuAdapter, tencentAdapter, openAICodexAdapter }
