/**
 * Codex Responses compatibility handler.
 *
 * Codex 0.128 only speaks OpenAI Responses wire format. This module lets Codex
 * use Halo's existing OpenAI-compatible providers by accepting /v1/responses
 * locally and converting to either upstream Responses or Chat Completions.
 */

import type { Response as ExpressResponse } from 'express'
import type { AnthropicContentBlock, AnthropicMessage, AnthropicRequest, AnthropicToolUseBlock, BackendConfig } from '../types'
import {
  convertAnthropicToOpenAIChat,
  convertAnthropicToOpenAIResponses,
  convertOpenAIChatToAnthropic,
  convertOpenAIResponsesToAnthropic
} from '../converters'
import { streamOpenAIChatToAnthropic } from '../stream'
import { proxyFetch } from '../../services/proxy-fetch'
import { getEndpointUrlError, isValidEndpointUrl } from './api-type'
import { applyProviderAdapter, type AdapterContext } from './provider-adapters'
import { deferInputTokensEstimate, fillResponseUsageFallback } from '../utils/usage-estimator'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

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

export interface CodexResponsesRequest {
  model?: string
  instructions?: string
  input?: unknown
  tools?: unknown[]
  tool_choice?: unknown
  parallel_tool_calls?: boolean
  reasoning?: unknown
  store?: boolean
  stream?: boolean
}

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
    console.log('[CodexResponsesHandler] Request timeout, aborting...')
    controller.abort()
  }, timeoutMs)

  try {
    const headers: Record<string, string> = { ...(customHeaders || {}) }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') {
        delete headers[key]
      }
    }
    headers['Content-Type'] = 'application/json'
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

function getErrorTypeFromStatus(status: number): string {
  return STATUS_ERROR_MAP[status] || 'api_error'
}

function getUpstreamError(status: number, errorText: string): { type: string; message: string } {
  try {
    const json = JSON.parse(errorText)
    if (json?.error?.type) {
      return { type: json.error.type, message: json.error.message || '' }
    }
    if (json?.error?.message) {
      return { type: json.error.type || getErrorTypeFromStatus(status), message: json.error.message }
    }
  } catch {
    // Not JSON, ignore.
  }
  return {
    type: getErrorTypeFromStatus(status),
    message: errorText || `HTTP ${status}`
  }
}

export function codexResponsesToAnthropicRequest(request: CodexResponsesRequest): AnthropicRequest {
  const messages: AnthropicMessage[] = []
  const systemParts: string[] = []

  if (request.instructions) {
    systemParts.push(request.instructions)
  }

  // Pending reasoning text accumulated from `type: "reasoning"` input items.
  // Codex CLI replays the previous assistant turn's reasoning back to the model
  // server as standalone reasoning items (see anthropicToCodexResponse below
  // and codex-rs/protocol response item shape). They precede the assistant
  // `message` / `function_call` / `custom_tool_call` items they belong to.
  //
  // Without preserving them as Anthropic `thinking` blocks here, the shared
  // outbound converter (converters/messages.ts:160-176) has nothing to lift
  // into `reasoning_content`, and the empty-string placeholder guard in
  // anthropic-to-openai-chat.ts:52-64 never fires either (it only triggers
  // when at least one assistant message already has reasoning_content or
  // when thinking mode is explicitly enabled). DeepSeek/Moonshot/GLM all
  // require `reasoning_content` to be echoed back on every assistant turn
  // once reasoning has appeared, and reject the request with
  // `The reasoning_content in the thinking mode must be passed back to the API.`
  // when it is missing. Same reasoning content is also required by Anthropic's
  // own thinking turns when this request is forwarded to a Responses-format
  // upstream — see openai-responses-to-anthropic.ts:90-113 for the inverse
  // mapping that this branch keeps symmetric.
  let pendingThinking: string[] = []
  // Pending parallel tool_use blocks. Codex's wire format (Responses API)
  // serializes parallel tool calls as multiple consecutive `function_call` /
  // `custom_tool_call` items belonging to ONE assistant turn, followed by
  // their `function_call_output` items in matching order
  // (codex-rs/core/src/session/turn.rs:985 enables `parallel_tool_calls`).
  // OpenAI Chat Completions strict validation requires every assistant
  // message with `tool_calls` to be followed by exactly the matching tool
  // messages, with no other assistant or user content in between. If we
  // emit each function_call as its own assistant message, DeepSeek and
  // similar strict providers reject with:
  //   "An assistant message with 'tool_calls' must be followed by tool
  //    messages responding to each 'tool_call_id'. (insufficient tool
  //    messages following tool_calls message)"
  // Group consecutive tool calls into a single assistant turn so the
  // outbound Anthropic→Chat conversion produces one assistant message with
  // a multi-element `tool_calls` array, immediately followed by the
  // matching tool messages.
  let pendingToolCalls: AnthropicContentBlock[] = []
  // Pending assistant text content (from `message[role=assistant]` items),
  // kept separately from tool calls so the flush can produce a single
  // assistant message that mirrors the OpenAI Chat shape `{content,
  // reasoning_content, tool_calls}` — text + tool_calls coexist on one turn.
  let pendingTextContent: AnthropicContentBlock[] = []

  // Flush the accumulated assistant turn (thinking + tool_calls + text) as
  // ONE Anthropic message. Called at every user-side boundary and at the end
  // of input. Preserves the original string-shortcut for the single-text
  // case so existing callers/tests asserting string content keep passing.
  const flushAssistantTurn = (): void => {
    if (
      pendingThinking.length === 0
      && pendingToolCalls.length === 0
      && pendingTextContent.length === 0
    ) {
      return
    }
    const blocks: AnthropicContentBlock[] = []
    if (pendingThinking.length > 0) {
      const text = pendingThinking.join('\n')
      if (text) blocks.push({ type: 'thinking', thinking: text })
    }
    blocks.push(...pendingToolCalls)
    blocks.push(...pendingTextContent)
    pendingThinking = []
    pendingToolCalls = []
    pendingTextContent = []
    if (blocks.length === 0) return
    if (blocks.length === 1 && blocks[0].type === 'text') {
      messages.push({ role: 'assistant', content: (blocks[0] as any).text })
      return
    }
    messages.push({ role: 'assistant', content: blocks })
  }

  for (const item of normalizeResponsesInput(request.input)) {
    if (item.type === 'reasoning') {
      const text = reasoningItemToThinkingText(item)
      if (text) pendingThinking.push(text)
      continue
    }

    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      // Parallel-call grouping: do NOT flush yet. Accumulate into the same
      // pending assistant turn as any preceding reasoning / earlier tool
      // calls. The flush happens when the next user-side item arrives or at
      // end of input.
      pendingToolCalls.push(responsesCallItemToAnthropicToolUse(item))
      continue
    }

    if (item.type === 'message') {
      if (item.role === 'system' || item.role === 'developer') {
        const content = responsesContentToAnthropicBlocks(item.content, 'user')
        const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
        if (text) systemParts.push(text)
        continue
      }
      if (item.role === 'assistant') {
        const content = responsesContentToAnthropicBlocks(item.content, 'assistant')
        pendingTextContent.push(...content)
        continue
      }
      // User message — flush the accumulated assistant turn first so all of
      // its reasoning/tool_calls/text land on a single message that
      // immediately precedes any user input.
      flushAssistantTurn()
      const content = responsesContentToAnthropicBlocks(item.content, 'user')
      messages.push({
        role: 'user',
        content: content.length === 1 && content[0].type === 'text' ? content[0].text : content
      })
      continue
    }

    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      // Tool output is user-side. Flush the assistant turn (including any
      // pending parallel tool_calls) so the tool message that follows
      // satisfies the OpenAI Chat strict ordering contract.
      flushAssistantTurn()
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(item.call_id || item.id || ''),
          content: normalizeResponsesOutput(item.output),
        }]
      })
    }
  }

  // Trailing accumulated assistant turn (no following user-side item) — emit
  // it so reasoning/tool_calls/text are all preserved end-of-input.
  flushAssistantTurn()

  return {
    model: request.model || 'unknown',
    max_tokens: 8192,
    messages,
    ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
    ...(request.stream !== undefined ? { stream: request.stream } : {}),
    tools: responsesToolsToAnthropicTools(request.tools),
    tool_choice: responsesToolChoiceToAnthropic(request.tool_choice),
    thinking: responsesReasoningToAnthropicThinking(request.reasoning),
  }
}

/**
 * Extract reasoning text from a Codex Responses `type: "reasoning"` item.
 *
 * The canonical shape Halo emits outbound (anthropicToCodexResponse) and that
 * Codex CLI replays back inbound is:
 *   { type: 'reasoning', summary: [{ type: 'output_text', text: '...' }] }
 *
 * For robustness we also accept a generic `content` array with `text` fields
 * (some upstream Responses-format servers surface reasoning that way), and
 * silently ignore `encrypted_content` since we have no key to decrypt it.
 */
function reasoningItemToThinkingText(item: any): string {
  const parts: string[] = []
  const summary = Array.isArray(item?.summary) ? item.summary : null
  if (summary) {
    for (const entry of summary) {
      if (entry && typeof entry === 'object' && typeof (entry as any).text === 'string') {
        parts.push((entry as any).text)
      }
    }
  }
  const content = Array.isArray(item?.content) ? item.content : null
  if (content) {
    for (const entry of content) {
      if (entry && typeof entry === 'object' && typeof (entry as any).text === 'string') {
        parts.push((entry as any).text)
      }
    }
  }
  return parts.filter(Boolean).join('\n')
}

function normalizeResponsesInput(input: unknown): any[] {
  if (Array.isArray(input)) return input.filter(Boolean)
  if (typeof input === 'string' && input) return [{ type: 'message', role: 'user', content: input }]
  if (input && typeof input === 'object') return [input]
  return []
}

function responsesContentToAnthropicBlocks(content: unknown, role: 'user' | 'assistant'): AnthropicContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []

  const blocks: AnthropicContentBlock[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const type = String((part as any).type || '')
    if ((type === 'input_text' || type === 'output_text' || type === 'text') && typeof (part as any).text === 'string') {
      blocks.push({ type: 'text', text: (part as any).text })
      continue
    }
    if (type === 'input_image' && role === 'user' && typeof (part as any).image_url === 'string') {
      const imageUrl = (part as any).image_url as string
      if (imageUrl.startsWith('data:')) {
        const match = imageUrl.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/)
        if (match) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1] as any, data: match[2] } })
        }
      } else {
        blocks.push({ type: 'image', source: { type: 'url', url: imageUrl } })
      }
    }
  }
  return blocks
}

function responsesCallItemToAnthropicToolUse(item: any): AnthropicToolUseBlock {
  let input: Record<string, unknown> = {}
  if (item.type === 'custom_tool_call') {
    // FREEFORM custom-tool calls expose the raw freeform body in `input` — it
    // is NOT JSON. We surface freeform tools to upstream Anthropic providers
    // as JSON tools with a `{ input: string }` schema (see
    // responsesToolsToAnthropicTools below), so forward the raw body under
    // the same key here to keep history replay consistent.
    input = { input: String(item.input ?? item.arguments ?? '') }
  } else {
    const raw = item.arguments ?? item.input ?? '{}'
    try {
      input = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw
    } catch {
      input = { text: String(raw || '') }
    }
  }

  // Reconstruct the flat tool name that was sent OUTBOUND to the upstream
  // model. Codex's `ResponseItem::FunctionCall` stores `name` and an optional
  // `namespace` as separate fields (codex-rs/protocol/src/models.rs:778-791),
  // and replays both on the next turn's `request.input`. We flattened
  // namespace tools outbound as `<namespace_with_trailing_dunder><inner_name>`
  // (responsesToolsToAnthropicTools above), so the flat name the upstream
  // model saw and used is exactly that. If we drop `namespace` here, the
  // assistant message we replay to the upstream Chat Completions provider
  // will carry only the bare inner name (e.g. `browser_snapshot` instead of
  // `mcp__ai_browser__browser_snapshot`). The model then learns the short
  // name from its own conversation history and emits short names on
  // subsequent turns — codex's tool registry can't look those up
  // (registry.rs requires a non-null `namespace` for namespaced tools)
  // and surfaces "unsupported call: ..." back to the model. That cascade is
  // exactly the AI-browser breakage where browser_navigate works once and
  // every subsequent browser_* tool fails.
  const rawNs = typeof item.namespace === 'string' ? String(item.namespace) : ''
  const nsPrefix = rawNs ? (rawNs.endsWith('__') ? rawNs : `${rawNs}__`) : ''
  const innerName = String(item.name || 'tool')
  const flatName = nsPrefix && !innerName.startsWith(nsPrefix) ? `${nsPrefix}${innerName}` : innerName

  return {
    type: 'tool_use',
    id: String(item.call_id || item.id || `call_${Date.now()}`),
    name: flatName,
    input,
  }
}

function normalizeResponsesOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output.map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part) return String((part as any).text)
      return JSON.stringify(part)
    }).join('\n')
  }
  return output === undefined ? '' : JSON.stringify(output)
}

/**
 * Build the flat-name → {namespace, name} map for codex namespace tools so the
 * outgoing stream bridge can split a tool_use's flat name (e.g.
 * `mcp__web_search__web_search`) back into the namespace+name pair codex's
 * tool registry expects on the function_call return path. Without this map,
 * codex would receive `name="mcp__web_search__web_search"` with `namespace=null`,
 * fail the registry lookup, and respond "unsupported call: ..." to the model
 * (registry.rs:319,554), which is exactly the symptom we hit before this fix.
 */
export type CodexToolNamespaceMap = Map<string, { namespace: string; name: string }>

export function buildCodexToolNamespaceMap(tools: unknown[] | undefined): CodexToolNamespaceMap {
  const map: CodexToolNamespaceMap = new Map()
  if (!Array.isArray(tools)) return map
  for (const tool of tools as any[]) {
    if (!tool || typeof tool !== 'object') continue
    if (String(tool.type || '') !== 'namespace') continue
    const rawNs = String(tool.name || '')
    const nsPrefix = rawNs.endsWith('__') ? rawNs : (rawNs ? `${rawNs}__` : '')
    if (!nsPrefix) continue
    const innerTools = Array.isArray(tool.tools) ? tool.tools : []
    for (const innerTool of innerTools as any[]) {
      if (!innerTool || typeof innerTool !== 'object') continue
      if (String(innerTool.type || '') !== 'function') continue
      const fn = innerTool.function || innerTool
      const innerName = String(fn.name || innerTool.name || 'tool')
      map.set(`${nsPrefix}${innerName}`, { namespace: nsPrefix, name: innerName })
    }
  }
  return map
}

function responsesToolsToAnthropicTools(tools: unknown[] | undefined): AnthropicRequest['tools'] {
  if (!Array.isArray(tools)) return undefined
  const converted: NonNullable<AnthropicRequest['tools']> = []
  for (const tool of tools as any[]) {
    if (!tool || typeof tool !== 'object') continue
    const type = String(tool.type || '')
    if (type === 'function') {
      const fn = tool.function || tool
      converted.push({
        name: String(fn.name || tool.name || 'tool'),
        description: fn.description || tool.description,
        input_schema: fn.parameters || tool.parameters || { type: 'object', properties: {} },
        strict: fn.strict || tool.strict,
      })
      continue
    }
    // Codex namespace tools (codex-rs/tools/src/responses_api.rs:43-67) wrap
    // multiple function tools under a single `type: "namespace"` envelope.
    // MCP tools always arrive in this shape (namespace name = "mcp__<server>__"),
    // so we MUST flatten them into individual function tools or the model
    // never sees them in the upstream chat_completions/responses request and
    // (correctly) reports them as unavailable.
    //
    // Naming: the canonical model-visible name is "<namespace_name>+<inner_name>"
    // — codex strips the trailing "__" off the namespace before joining
    // (compare unavailable_tool.rs which prints "mcp__server__lookup", i.e.
    // namespace "mcp__server__" + inner "lookup"). Mirror that exactly so a
    // tool_use returning here round-trips back to codex with the same name
    // codex registered with the MCP server.
    if (type === 'namespace') {
      const rawNs = String(tool.name || '')
      const nsPrefix = rawNs.endsWith('__') ? rawNs : (rawNs ? `${rawNs}__` : '')
      const innerTools = Array.isArray(tool.tools) ? tool.tools : []
      for (const innerTool of innerTools as any[]) {
        if (!innerTool || typeof innerTool !== 'object') continue
        if (String(innerTool.type || '') !== 'function') continue
        const fn = innerTool.function || innerTool
        const innerName = String(fn.name || innerTool.name || 'tool')
        converted.push({
          name: `${nsPrefix}${innerName}`,
          description: fn.description || innerTool.description || tool.description,
          input_schema: fn.parameters || innerTool.parameters || { type: 'object', properties: {} },
          strict: fn.strict || innerTool.strict,
        })
      }
      continue
    }
    if (type === 'custom') {
      const fn = tool.function || tool
      const explicitParams = fn.parameters || tool.parameters
      // Two shapes arrive as `type: "custom"`:
      //   1. JSON-schema function tools that simply use the custom marker
      //      (have `parameters`). Pass the schema through untouched.
      //   2. FREEFORM grammar tools (e.g. codex's `apply_patch`), which
      //      carry `format: { type, syntax, definition }` and NO JSON
      //      schema — the model is meant to emit raw text matching the
      //      grammar. Anthropic tool-use has no FREEFORM/grammar surface,
      //      so we degrade these to a single-string-arg JSON tool whose
      //      shape mirrors codex's own `create_apply_patch_json_tool`
      //      (input: string, required). The grammar definition is woven
      //      into the description so the model still has a contract, and
      //      the receiving codex handler accepts both Function and Custom
      //      payloads (apply_patch.rs:304-309), so the JSON envelope round-
      //      trips back into the FREEFORM tool's parser cleanly.
      if (explicitParams) {
        converted.push({
          name: String(fn.name || tool.name || 'tool'),
          description: fn.description || tool.description,
          input_schema: explicitParams,
          strict: fn.strict || tool.strict,
        })
        continue
      }
      converted.push({
        name: String(fn.name || tool.name || 'tool'),
        description: freeformToolDescription(
          String(fn.description || tool.description || ''),
          tool.format,
        ),
        input_schema: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: 'The entire freeform tool body as a single string.',
            },
          },
          required: ['input'],
          additionalProperties: false,
        },
        strict: fn.strict || tool.strict,
      })
    }
  }
  return converted.length ? converted : undefined
}

function freeformToolDescription(originalDescription: string, format: unknown): string {
  const segments: string[] = []
  if (originalDescription) segments.push(originalDescription)
  segments.push(
    'This tool was originally a FREEFORM grammar tool; it has been wrapped for JSON tool-call transport. Place the entire freeform body in the `input` field as a single string. Do not add fields, escape text, or wrap with code fences.',
  )
  if (format && typeof format === 'object') {
    const f = format as { syntax?: unknown; definition?: unknown; type?: unknown }
    const syntax = typeof f.syntax === 'string' ? f.syntax : (typeof f.type === 'string' ? f.type : 'grammar')
    const definition = typeof f.definition === 'string' ? f.definition : ''
    if (definition) segments.push(`Grammar (${syntax}):\n${definition}`)
  }
  return segments.join('\n\n')
}

function responsesToolChoiceToAnthropic(toolChoice: unknown): AnthropicRequest['tool_choice'] {
  if (!toolChoice) return undefined
  if (toolChoice === 'auto') return { type: 'auto' }
  if (toolChoice === 'none') return { type: 'none' }
  if (toolChoice === 'required') return { type: 'any' }
  if (typeof toolChoice === 'object' && (toolChoice as any).name) {
    return { type: 'tool', name: String((toolChoice as any).name) }
  }
  return undefined
}

function responsesReasoningToAnthropicThinking(reasoning: unknown): AnthropicRequest['thinking'] {
  if (!reasoning || typeof reasoning !== 'object') return undefined
  const effort = (reasoning as any).effort
  if (!effort || effort === 'none') return undefined
  return { type: 'enabled', budget_tokens: 1024 }
}

export function anthropicToCodexResponse(
  anthropicResponse: any,
  model: string,
  toolNamespaceMap: CodexToolNamespaceMap = new Map(),
): Record<string, unknown> {
  const output: unknown[] = []
  for (const block of anthropicResponse?.content || []) {
    if (block.type === 'text') {
      output.push({
        id: `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: block.text || '' }],
      })
    } else if (block.type === 'thinking') {
      // codex's `ResponseItem::Reasoning` deserializer tags the
      // `ReasoningItemReasoningSummary` enum as `#[serde(tag="type",
      // rename_all="snake_case")]` with a single variant `SummaryText`
      // (codex-rs/protocol/src/models.rs:1192-1196). The ONLY accepted wire
      // value for the summary entry's `type` field is therefore
      // `summary_text`. Sending `output_text` here makes the
      // `serde_json::from_value::<ResponseItem>` call in
      // codex-api/src/sse/responses.rs:303 / :412 fail silently — codex logs
      // `failed to parse ResponseItem from output_item.added/done` and drops
      // the reasoning item, which is why the previous two attempts at this
      // fix did not resolve DeepSeek's "reasoning_content must be passed
      // back" rejection: codex never persisted the reasoning, never replayed
      // it, and the inbound converter never had any reasoning to attach.
      output.push({
        id: `rs_${Date.now()}`,
        type: 'reasoning',
        status: 'completed',
        summary: [{ type: 'summary_text', text: block.thinking || '' }],
      })
    } else if (block.type === 'tool_use') {
      const split = splitCodexToolName(String(block.name || ''), toolNamespaceMap)
      output.push({
        id: block.id,
        type: 'function_call',
        status: 'completed',
        name: split.name,
        ...(split.namespace ? { namespace: split.namespace } : {}),
        call_id: block.id,
        arguments: JSON.stringify(block.input || {}),
      })
    }
  }

  return {
    id: anthropicResponse?.id || `resp_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: anthropicResponse?.model || model,
    status: 'completed',
    output,
    usage: {
      input_tokens: anthropicResponse?.usage?.input_tokens || 0,
      output_tokens: anthropicResponse?.usage?.output_tokens || 0,
      total_tokens: (anthropicResponse?.usage?.input_tokens || 0) + (anthropicResponse?.usage?.output_tokens || 0),
    },
  }
}

function writeCodexSse(res: ExpressResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

export async function handleResponsesRequest(
  codexRequest: CodexResponsesRequest,
  config: BackendConfig,
  res: ExpressResponse,
  options: { debug?: boolean; timeoutMs?: number } = {}
): Promise<void> {
  const { debug = false, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const { url: backendUrl, key: apiKey, headers: customHeaders, apiType: configApiType, adapterId } = config

  if (!isValidEndpointUrl(backendUrl)) {
    return sendResponsesError(res, 400, 'invalid_request_error', getEndpointUrlError(backendUrl))
  }

  const apiType = configApiType === 'responses' ? 'responses' : 'chat_completions'

  // ── Raw inbound dump ──
  // Print the full inbound /v1/responses payload (model + tool names + input
  // item shape) to stdout so a developer can immediately tell from the dev
  // server log what codex actually delivered, without round-tripping through
  // upstream first. This intentionally bypasses the http-raw.log file because
  // the inbound side is not proxyFetch-mediated and the user explicitly asked
  // for raw debug prints in the dev process.
  try {
    const inboundToolNames = Array.isArray(codexRequest.tools)
      ? (codexRequest.tools as any[]).flatMap((t) => {
          if (!t || typeof t !== 'object') return []
          const ttype = String((t as any).type || '')
          if (ttype === 'namespace') {
            const ns = String((t as any).name || '')
            const inner = Array.isArray((t as any).tools) ? (t as any).tools : []
            return inner.map((it: any) => `${ns.endsWith('__') ? ns : ns ? ns + '__' : ''}${String(it?.name || it?.function?.name || '?')}`)
          }
          if (ttype === 'function') return [String((t as any).name || (t as any).function?.name || '?')]
          if (ttype === 'custom') return [`custom:${String((t as any).name || '?')}`]
          if (ttype === 'web_search') return ['web_search']
          return [`?:${ttype}`]
        })
      : []
    const inputShape = Array.isArray(codexRequest.input)
      ? (codexRequest.input as any[]).map((it) => {
          if (!it || typeof it !== 'object') return 'invalid'
          const ttype = String((it as any).type || '?')
          if (ttype === 'message') return `message[${(it as any).role || '?'}]`
          if (ttype === 'function_call') {
            const ns = typeof (it as any).namespace === 'string' ? (it as any).namespace : ''
            return ns ? `function_call(${ns}${String((it as any).name)})` : `function_call(${(it as any).name || '?'})`
          }
          if (ttype === 'function_call_output') return `function_call_output`
          if (ttype === 'reasoning') return `reasoning`
          return ttype
        })
      : []
    console.log(
      `[CodexResponsesHandler][raw] model=${codexRequest.model} stream=${codexRequest.stream === true} reasoning=${JSON.stringify(codexRequest.reasoning ?? null)} tools(${inboundToolNames.length})=[${inboundToolNames.join(', ')}]`,
    )
    console.log(
      `[CodexResponsesHandler][raw] input(${inputShape.length})=[${inputShape.join(', ')}]`,
    )
  } catch (logErr) {
    console.warn('[CodexResponsesHandler][raw] failed to dump inbound:', logErr)
  }

  const anthropicRequest = codexResponsesToAnthropicRequest(codexRequest)
  // Build the flat→{namespace, name} mapping so the outgoing stream bridge
  // can re-split tool_use names that originated from codex namespace tools.
  const toolNamespaceMap = buildCodexToolNamespaceMap(codexRequest.tools)
  // Diagnostic: count tools at each conversion boundary so we can see whether
  // codex MCP tools (which arrive as `type: "namespace"`) survive the
  // responses→anthropic step. Without this, an empty tools array silently
  // routes to the upstream LLM and the model says "tool not available".
  if (Array.isArray(codexRequest.tools)) {
    const inboundTypes = (codexRequest.tools as any[])
      .map((t) => (t && typeof t === 'object' ? String(t.type || 'unknown') : 'invalid'))
    const inboundCount = inboundTypes.length
    const inboundTypeCounts: Record<string, number> = {}
    for (const t of inboundTypes) inboundTypeCounts[t] = (inboundTypeCounts[t] || 0) + 1
    const anthropicCount = anthropicRequest.tools?.length ?? 0
    console.log(
      `[CodexResponsesHandler] inbound tools=${inboundCount} types=${JSON.stringify(inboundTypeCounts)} -> anthropic tools=${anthropicCount} ns_map=${toolNamespaceMap.size}`,
    )
  }

  // Diagnostic: trace reasoning round-trip end to end. Without this we cannot
  // tell whether codex actually replays prior reasoning (inbound `reasoning`
  // items) or whether our converter dropped it before it ever reached the
  // upstream. Both numbers must be > 0 once thinking-mode providers are in
  // use; if `inbound_reasoning_items=0` after a multi-turn session, codex
  // never persisted reasoning (most often because the previous outbound
  // ResponseItem failed to deserialize on its side).
  const inboundReasoningItems = Array.isArray(codexRequest.input)
    ? (codexRequest.input as any[]).filter((it) => it && typeof it === 'object' && (it as any).type === 'reasoning').length
    : 0
  const assistantWithThinking = anthropicRequest.messages.filter((m) =>
    m.role === 'assistant' && Array.isArray(m.content) && (m.content as any[]).some((b) => b && (b as any).type === 'thinking')
  ).length
  // Track tool_call / tool_result shapes too. Mismatched counts here are
  // exactly what triggers DeepSeek's "insufficient tool messages following
  // tool_calls" error. Any assistant turn with multiple tool_uses is logged
  // so parallel-call grouping can be verified at runtime.
  let assistantToolUseTotal = 0
  let assistantParallelTurns = 0
  for (const msg of anthropicRequest.messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    const toolUses = (msg.content as any[]).filter((b) => b && (b as any).type === 'tool_use').length
    assistantToolUseTotal += toolUses
    if (toolUses > 1) assistantParallelTurns += 1
  }
  const userToolResults = anthropicRequest.messages.filter(
    (m) => m.role === 'user' && Array.isArray(m.content) && (m.content as any[]).some((b) => b && (b as any).type === 'tool_result'),
  ).length
  console.log(
    `[CodexResponsesHandler] reasoning_round_trip inbound_reasoning_items=${inboundReasoningItems} assistant_msgs_with_thinking=${assistantWithThinking} thinking_enabled=${anthropicRequest.thinking ? 'yes' : 'no'} ` +
      `tool_uses=${assistantToolUseTotal} tool_results=${userToolResults} parallel_call_turns=${assistantParallelTurns}`,
  )
  const requestToSend = { ...anthropicRequest, stream: codexRequest.stream === true }
  const openaiRequest = apiType === 'responses'
    ? convertAnthropicToOpenAIResponses(requestToSend).request
    : convertAnthropicToOpenAIChat(requestToSend).request

  const requestHeaders: Record<string, string> = { ...(customHeaders || {}) }
  const adapterContext: AdapterContext = { originalRequest: requestToSend }
  applyProviderAdapter(backendUrl, openaiRequest as Record<string, unknown>, requestHeaders, adapterId, adapterContext)

  console.log(`[CodexResponsesHandler] Proxy ${apiType} -> ${backendUrl} stream=${codexRequest.stream === true}`)

  // Raw outbound dump: the EXACT body we are about to POST upstream. For
  // chat_completions this is what DS's strict validator sees, so this is
  // where to look first for any "tool_calls/tool message mismatch" or
  // missing-reasoning_content issue.
  try {
    const outboundToolNames = Array.isArray((openaiRequest as any).tools)
      ? ((openaiRequest as any).tools as any[]).map((t) => String(t?.function?.name || t?.name || '?'))
      : []
    const outboundMsgShape = Array.isArray((openaiRequest as any).messages)
      ? ((openaiRequest as any).messages as any[]).map((m) => {
          if (m?.role === 'assistant') {
            const tc = Array.isArray(m.tool_calls) ? m.tool_calls.length : 0
            const rc = 'reasoning_content' in m ? (m.reasoning_content === '' ? '""' : 'set') : '-'
            const ct = m.content == null ? 'null' : (typeof m.content === 'string' ? `text(${m.content.length})` : 'array')
            return `assistant{content=${ct},tool_calls=${tc},reasoning_content=${rc}}`
          }
          if (m?.role === 'tool') return `tool[${m.tool_call_id || '?'}]`
          if (m?.role === 'user') return `user`
          if (m?.role === 'system') return `system`
          return String(m?.role || '?')
        })
      : []
    console.log(
      `[CodexResponsesHandler][raw] outbound model=${(openaiRequest as any).model} stream=${(openaiRequest as any).stream === true} tools(${outboundToolNames.length})=[${outboundToolNames.join(', ')}]`,
    )
    console.log(
      `[CodexResponsesHandler][raw] outbound messages(${outboundMsgShape.length})=[${outboundMsgShape.join(' | ')}]`,
    )
  } catch (logErr) {
    console.warn('[CodexResponsesHandler][raw] failed to dump outbound:', logErr)
  }

  try {
    const upstreamResp = await fetchUpstream(backendUrl, apiKey, openaiRequest, timeoutMs, undefined, requestHeaders)
    if (!upstreamResp.ok) {
      const errorText = await upstreamResp.text().catch(() => '')
      const { type, message } = getUpstreamError(upstreamResp.status, errorText)
      return sendResponsesError(res, upstreamResp.status, type, message)
    }

    if (codexRequest.stream === true) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')

      if (apiType === 'responses') {
        await pipeNativeResponsesStream(upstreamResp.body, res)
      } else {
        await streamOpenAIChatToAnthropic(
          upstreamResp.body,
          createCodexAnthropicStreamBridge(res, anthropicRequest.model, toolNamespaceMap),
          anthropicRequest.model,
          debug,
          deferInputTokensEstimate(anthropicRequest),
        )
      }
      return
    }

    const openaiResponse = await upstreamResp.json()
    const anthropicResponse = apiType === 'responses'
      ? convertOpenAIResponsesToAnthropic(openaiResponse)
      : convertOpenAIChatToAnthropic(openaiResponse, anthropicRequest.model)
    fillResponseUsageFallback(anthropicResponse, anthropicRequest)
    res.json(anthropicToCodexResponse(anthropicResponse, anthropicRequest.model, toolNamespaceMap))
  } catch (error: any) {
    return sendResponsesError(res, 500, 'api_error', error?.message || String(error))
  }
}

async function pipeNativeResponsesStream(stream: ReadableStream<Uint8Array> | null, res: ExpressResponse): Promise<void> {
  if (!stream) {
    writeCodexSse(res, 'response.failed', { type: 'response.failed', response: { error: { message: 'Empty stream from provider' } } })
    res.end()
    return
  }

  try {
    await stream.pipeTo(new WritableStream({
      write(chunk) { res.write(Buffer.from(chunk)) },
      close() { res.end() },
      abort(error) {
        writeCodexSse(res, 'response.failed', { type: 'response.failed', response: { error: { message: error?.message || String(error) } } })
        res.end()
      }
    }))
  } catch (error: any) {
    writeCodexSse(res, 'response.failed', { type: 'response.failed', response: { error: { message: error?.message || String(error) } } })
    res.end()
  }
}

export function createCodexStreamBridgeForTest(
  res: ExpressResponse,
  model: string,
  toolNamespaceMap?: CodexToolNamespaceMap,
): ExpressResponse {
  return createCodexAnthropicStreamBridge(res, model, toolNamespaceMap ?? new Map())
}

function createCodexAnthropicStreamBridge(
  res: ExpressResponse,
  model: string,
  toolNamespaceMap: CodexToolNamespaceMap,
): ExpressResponse {
  let buffer = ''
  let tool: { index: number; id: string; name: string; args: string } | null = null
  let textItem: { index: number; id: string; text: string } | null = null
  let reasoning: { index: number; id: string; text: string } | null = null
  let completed = false

  const bridge = Object.create(res)
  bridge.write = (chunk: unknown) => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    const parts = buffer.split('\n\n')
    buffer = parts.pop() || ''
    for (const part of parts) {
      const dataLine = part.split('\n').find((line) => line.startsWith('data:'))
      const data = dataLine?.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const event = JSON.parse(data)
        const state = streamAnthropicEventToCodex(event, res, model, { tool, textItem, reasoning }, toolNamespaceMap)
        tool = state.tool
        textItem = state.textItem
        reasoning = state.reasoning
        if (event.type === 'message_stop') completed = true
      } catch {
        // Ignore malformed generated SSE chunks.
      }
    }
    return true
  }
  bridge.end = () => {
    if (!completed) {
      writeCodexSse(res, 'response.completed', {
        type: 'response.completed',
        response: { id: `resp_${Date.now()}`, model, status: 'completed' },
      })
    }
    res.end()
    return bridge
  }
  bridge.setHeader = () => bridge
  bridge.status = () => bridge
  return bridge as ExpressResponse
}

interface CodexStreamBridgeState {
  tool: { index: number; id: string; name: string; args: string } | null
  textItem: { index: number; id: string; text: string } | null
  // Reasoning item currently being streamed. MUST be framed by
  // response.output_item.added (with `type: "reasoning"`) and closed by
  // response.output_item.done — those two events are what codex CLI uses to
  // parse and persist reasoning into its conversation history (see binary
  // strings: "failed to parse ResponseItem from output_item.added",
  // "failed to parse response.output_item.done"). Without them, the
  // reasoning_summary_text deltas are orphaned and dropped, so codex never
  // replays the reasoning back inbound on the next turn — which makes
  // DeepSeek/Moonshot/GLM reject the request because the previous turn's
  // reasoning_content is missing from history. Mirror the contract used by
  // tool / textItem above.
  reasoning: { index: number; id: string; text: string } | null
}

/**
 * Resolve the codex-shaped {name, namespace} pair for an outgoing function_call.
 * Codex's tool registry keys handlers by `ToolName{namespace, name}`
 * (codex-rs/protocol/src/tool_name.rs:9-12); MCP tools are registered under
 * `ToolName::namespaced(<server_ns>, <tool_name>)`. When the model returns a
 * function_call with the flat name we emitted (e.g. `mcp__web_search__web_search`)
 * codex builds `ToolName::new(namespace, name)` from the response item
 * (router.rs:187). If `namespace` is null the lookup fails and codex emits
 * `unsupported call: ...` (registry.rs:319,554). We therefore split the flat
 * name back via the map populated when we flattened namespace tools inbound.
 */
function splitCodexToolName(
  flatName: string,
  toolNamespaceMap: CodexToolNamespaceMap,
): { name: string; namespace?: string } {
  const split = toolNamespaceMap.get(flatName)
  if (split) return { name: split.name, namespace: split.namespace }
  return { name: flatName }
}

function streamAnthropicEventToCodex(
  event: any,
  res: ExpressResponse,
  model: string,
  state: CodexStreamBridgeState,
  toolNamespaceMap: CodexToolNamespaceMap,
): CodexStreamBridgeState {
  if (event.type === 'message_start') {
    writeCodexSse(res, 'response.created', { type: 'response.created', response: { id: event.message?.id || `resp_${Date.now()}`, model } })
    return state
  }

  if (event.type === 'content_block_start') {
    const block = event.content_block || {}
    if (block.type === 'thinking') {
      console.log('[CodexResponsesHandler] outbound reasoning_block_start index=' + (event.index || 0))
      // Frame a reasoning item with output_item.added so codex CLI can parse
      // it as a ResponseItem and persist it into conversation history. The
      // matching output_item.done is emitted on content_block_stop below.
      // Without this pair, the reasoning_summary_text.delta events that
      // follow are orphaned — codex drops them, never stores reasoning, and
      // never replays it on the next turn (which is exactly what triggers
      // DeepSeek's "reasoning_content must be passed back" rejection).
      const nextReasoning = {
        index: event.index || 0,
        id: `rs_${Date.now()}_${event.index || 0}`,
        text: typeof block.thinking === 'string' ? block.thinking : '',
      }
      writeCodexSse(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: nextReasoning.index,
        item: {
          // id MUST match the item_id carried on every reasoning_summary_text
          // delta and on the eventual output_item.done — codex correlates the
          // three by id, identical to the message-item contract above.
          id: nextReasoning.id,
          type: 'reasoning',
          summary: [],
        },
      })
      return { ...state, reasoning: nextReasoning }
    }
    if (block.type === 'tool_use') {
      const nextTool = { index: event.index || 0, id: block.id, name: block.name, args: '' }
      const split = splitCodexToolName(String(block.name || ''), toolNamespaceMap)
      writeCodexSse(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: nextTool.index,
        item: {
          type: 'function_call',
          id: block.id,
          call_id: block.id,
          name: split.name,
          ...(split.namespace ? { namespace: split.namespace } : {}),
          arguments: '',
        },
      })
      return { ...state, tool: nextTool }
    }

    if (block.type === 'text') {
      const textItem = {
        index: event.index || 0,
        id: `msg_${Date.now()}_${event.index || 0}`,
        text: block.text || '',
      }
      writeCodexSse(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: textItem.index,
        item: {
          // `id` MUST be present and equal to the `item_id` later carried
          // on `response.output_text.delta` / `response.output_item.done`.
          // Codex CLI's parser correlates these three events by `item.id`;
          // when omitted, the parser auto-generates a synthetic id for
          // `output_item.added`, fails to match the deltas' `item_id`,
          // and ends up creating TWO message items for the same text —
          // which Halo's stream-processor renders as a doubled bubble
          // (the duplicate-text bug). Keep this field in sync with the
          // tool_use branch above and the lazy-create / done branches below.
          id: textItem.id,
          type: 'message',
          role: 'assistant',
          content: textItem.text ? [{ type: 'output_text', text: textItem.text }] : [],
          phase: 'final_answer',
        },
      })
      return { ...state, textItem }
    }

    return state
  }

  if (event.type === 'content_block_delta') {
    const delta = event.delta || {}
    if (delta.type === 'text_delta') {
      const textItem = state.textItem || { index: 0, id: `msg_${Date.now()}_0`, text: '' }
      const nextTextItem = { ...textItem, text: textItem.text + (delta.text || '') }
      if (!state.textItem) {
        writeCodexSse(res, 'response.output_item.added', {
          type: 'response.output_item.added',
          output_index: nextTextItem.index,
          // Same id-correlation contract as the content_block_start text
          // branch: id MUST equal the deltas' item_id.
          item: { id: nextTextItem.id, type: 'message', role: 'assistant', content: [], phase: 'final_answer' },
        })
      }
      writeCodexSse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: nextTextItem.id, delta: delta.text || '' })
      return { ...state, textItem: nextTextItem }
    }

    if (delta.type === 'thinking_delta') {
      // Lazy-create the reasoning frame if no content_block_start preceded
      // the delta. Some upstream stream variants (or replays) emit the delta
      // as the very first reasoning event; we still need to fire
      // output_item.added before the delta so codex can correlate them.
      let reasoning = state.reasoning
      if (!reasoning) {
        reasoning = {
          index: event.index || 0,
          id: `rs_${Date.now()}_${event.index || 0}`,
          text: '',
        }
        writeCodexSse(res, 'response.output_item.added', {
          type: 'response.output_item.added',
          output_index: reasoning.index,
          item: { id: reasoning.id, type: 'reasoning', summary: [] },
        })
      }
      const nextReasoning = { ...reasoning, text: reasoning.text + (delta.thinking || '') }
      writeCodexSse(res, 'response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        // item_id MUST match output_item.added/done so codex can attach the
        // delta to the right reasoning item; without it the delta is dropped.
        item_id: nextReasoning.id,
        output_index: nextReasoning.index,
        summary_index: 0,
        delta: delta.thinking || '',
      })
      return { ...state, reasoning: nextReasoning }
    }

    if (delta.type === 'input_json_delta' && state.tool) {
      const nextTool = { ...state.tool, args: state.tool.args + (delta.partial_json || '') }
      writeCodexSse(res, 'response.custom_tool_call_input.delta', {
        type: 'response.custom_tool_call_input.delta',
        item_id: nextTool.id,
        call_id: nextTool.id,
        delta: delta.partial_json || '',
      })
      return { ...state, tool: nextTool }
    }
    return state
  }

  if (event.type === 'content_block_stop') {
    if (state.reasoning) {
      console.log(`[CodexResponsesHandler] outbound reasoning_block_done id=${state.reasoning.id} text_len=${state.reasoning.text.length}`)
      // Close the reasoning item with the full summary text. This is what
      // codex CLI parses into a ResponseItem::Reasoning and stores in the
      // thread's conversation history; on the next turn, codex replays it
      // back as a `type: "reasoning"` input item, which our inbound
      // converter then maps to an Anthropic `thinking` block — restoring
      // the reasoning_content round-trip required by DeepSeek/Moonshot/GLM.
      // The summary entry MUST use `type: "summary_text"` — that is the only
      // variant codex's serde deserializer accepts for
      // `ReasoningItemReasoningSummary` (codex-rs/protocol/src/models.rs:1192-1196,
      // tagged `rename_all = "snake_case"` over the single `SummaryText`
      // variant). Any other tag value makes
      // `serde_json::from_value::<ResponseItem>` fail in
      // codex-api/src/sse/responses.rs and codex silently drops the reasoning
      // item — see comment on the non-streaming path above for why this is
      // the actual root cause of the DeepSeek "reasoning_content must be
      // passed back" rejection.
      writeCodexSse(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.reasoning.index,
        item: {
          id: state.reasoning.id,
          type: 'reasoning',
          status: 'completed',
          summary: [{ type: 'summary_text', text: state.reasoning.text }],
        },
      })
      return { ...state, reasoning: null }
    }

    if (state.tool) {
      // Mirror the split applied on output_item.added so the `done` event's
      // {name, namespace} matches what codex's response item parser expects;
      // mismatched names between added/done would also prevent the registry
      // lookup from finding the namespaced handler.
      const split = splitCodexToolName(state.tool.name, toolNamespaceMap)
      writeCodexSse(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.tool.index,
        item: {
          type: 'function_call',
          id: state.tool.id,
          call_id: state.tool.id,
          name: split.name,
          ...(split.namespace ? { namespace: split.namespace } : {}),
          arguments: state.tool.args || '{}',
        },
      })
      return { ...state, tool: null }
    }

    if (state.textItem) {
      writeCodexSse(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.textItem.index,
        item: {
          // Closes the id-correlation chain started by output_item.added.
          // Without this, Codex CLI's parser cannot match `done` to the
          // streamed deltas and creates a separate ghost item — see the
          // detailed comment on the content_block_start text branch.
          id: state.textItem.id,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: state.textItem.text }],
          phase: 'final_answer',
        },
      })
      return { ...state, textItem: null }
    }
  }

  if (event.type === 'message_stop') {
    writeCodexSse(res, 'response.completed', {
      type: 'response.completed',
      response: { id: `resp_${Date.now()}`, model, status: 'completed' },
    })
  }

  return state
}

function sendResponsesError(res: ExpressResponse, status: number, type: string, message: string): void {
  res.status(status).json({ error: { type, message } })
}
