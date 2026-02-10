/**
 * Pre-flight Request Interceptor
 *
 * CC SDK makes internal LLM calls for safety analysis (e.g., bash command prefix
 * extraction) that are separate from the main agent loop. These calls are designed
 * for fast models (Haiku, <1s) but get routed through the OpenAI compat router to
 * potentially slow models (e.g., DeepSeek Reasoner), causing severe performance
 * degradation (~30-60s per bash command).
 *
 * In Halo's architecture (permissionMode: 'bypassPermissions'), these safety
 * analysis results are unused -- commands are auto-approved regardless. This
 * interceptor detects and short-circuits these requests with instant mock
 * responses, eliminating the latency without affecting functionality.
 *
 * Detection uses a 100% precise fingerprint:
 *   1. tools = 0 (internal calls carry no tool schemas; main agent loop always has 20+ tools)
 *   2. System prompt contains a unique, hardcoded string from cli.js
 *
 * This dual condition guarantees zero false positives across all CC SDK versions
 * that use these exact system prompts.
 *
 * Background: https://github.com/anthropics/claude-code/issues/1249
 */

import type { AnthropicRequest, AnthropicSystemBlock } from '../types'
import type { RequestInterceptor, InterceptorContext, InterceptorResult } from './types'

// ============================================================================
// Fingerprint Definitions
// ============================================================================

/**
 * Defines how to detect a specific CC SDK internal LLM call.
 *
 * Each fingerprint targets a unique, hardcoded system prompt substring in cli.js.
 * The combination of tools=0 + system prompt match guarantees zero false positives.
 */
interface PreflightFingerprint {
  /** Identifier for logging */
  name: string
  /** Unique substring from the hardcoded system prompt in cli.js */
  systemPromptMatch: string
  /** Text to return in the mock response */
  mockResponseText: string
}

/**
 * Registry of known CC SDK internal calls to intercept.
 *
 * To add a new intercepted call:
 *   1. Find its querySource value in cli.js (e.g., "bash_extract_prefix")
 *   2. Locate its jK() / Cd() call and extract a unique system prompt substring
 *   3. Verify the substring does NOT appear in any other querySource's prompt
 *   4. Determine a safe mock response that won't crash the caller
 *   5. Add an entry here
 */
const FINGERPRINTS: PreflightFingerprint[] = [
  {
    // cli.js: bW9() → jK({ querySource: "bash_extract_prefix" })
    //
    // Purpose: Extracts command prefix (e.g., "git commit", "cat") from bash
    // commands for permission rule matching and command injection detection.
    //
    // Why safe to intercept: In bypassPermissions mode, the extracted prefix
    // is unused -- the permission check at zJ7() returns "allow" regardless
    // of what prefix was extracted. Returning "none" is a valid CLI response
    // meaning "no specific prefix to extract" (same as "npm run lint => none").
    //
    // Impact: Eliminates ~30-60s delay per bash tool use on slow models.
    // Frequency: Every single bash command execution.
    name: 'bash_extract_prefix',
    systemPromptMatch: 'Your task is to process Bash commands',
    mockResponseText: 'none'
  }
]

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract system prompt text from an Anthropic request.
 *
 * Handles both formats the SDK may send:
 *   - string: direct system prompt text
 *   - Array<AnthropicSystemBlock>: array of typed blocks (extract text blocks)
 */
function getSystemText(request: AnthropicRequest): string {
  const { system } = request

  if (typeof system === 'string') {
    return system
  }

  if (Array.isArray(system)) {
    return (system as AnthropicSystemBlock[])
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text)
      .join('\n')
  }

  return ''
}

/**
 * Find a matching fingerprint for the given request.
 *
 * Check order is optimized for minimal overhead on non-matching requests:
 *   1. tools array length (O(1) integer comparison) -- filters out ~90% of requests
 *   2. System prompt existence and text extraction
 *   3. System text substring match (String.includes, native V8 Boyer-Moore)
 *
 * @returns The matching fingerprint, or null if no match
 */
function matchFingerprint(request: AnthropicRequest): PreflightFingerprint | null {
  // Fast reject: main agent loop requests always carry tools (20+)
  if (request.tools && request.tools.length > 0) return null

  // Extract system prompt text
  const systemText = getSystemText(request)
  if (!systemText) return null

  // Match against registered fingerprints
  for (const fp of FINGERPRINTS) {
    if (systemText.includes(fp.systemPromptMatch)) {
      return fp
    }
  }

  return null
}

/**
 * Send a mock Anthropic SSE streaming response.
 *
 * CC SDK internal calls always use streaming (via Cd/SW9 functions in cli.js).
 * The response format must match Anthropic's Messages API streaming protocol
 * exactly, since the SDK parses it as a standard Anthropic response.
 */
function sendMockAnthropicResponse(
  context: InterceptorContext,
  responseText: string
): void {
  const { res, originalModel } = context
  const msgId = `msg_preflight_${Date.now()}`

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  // message_start
  res.write(`event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: originalModel,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  })}\n\n`)

  // content_block_start
  res.write(`event: content_block_start\ndata: ${JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' }
  })}\n\n`)

  // content_block_delta
  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: responseText }
  })}\n\n`)

  // content_block_stop
  res.write(`event: content_block_stop\ndata: ${JSON.stringify({
    type: 'content_block_stop',
    index: 0
  })}\n\n`)

  // message_delta
  res.write(`event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 }
  })}\n\n`)

  // message_stop
  res.write(`event: message_stop\ndata: ${JSON.stringify({
    type: 'message_stop'
  })}\n\n`)

  res.end()
}

// ============================================================================
// Interceptor Export
// ============================================================================

/**
 * Pre-flight interceptor -- detects and short-circuits CC SDK internal LLM calls.
 *
 * Performance overhead on non-matching requests:
 *   - With tools (main agent loop): ~0.001ms (single array.length check)
 *   - Without tools (other internal calls): ~0.01ms (system text extraction + includes)
 *
 * Savings per intercepted bash_extract_prefix: ~30-60s on slow models
 */
export const preflightInterceptor: RequestInterceptor = {
  name: 'preflight',

  shouldIntercept(request: AnthropicRequest): boolean {
    return matchFingerprint(request) !== null
  },

  intercept(request: AnthropicRequest, context: InterceptorContext): InterceptorResult {
    const fp = matchFingerprint(request)
    if (!fp) {
      // Safety: should never reach here (shouldIntercept guards this)
      return { handled: false }
    }

    console.log(`[Interceptor:preflight] Intercepted ${fp.name}, returning mock response`)
    sendMockAnthropicResponse(context, fp.mockResponseText)
    return { handled: true, responded: true }
  }
}
