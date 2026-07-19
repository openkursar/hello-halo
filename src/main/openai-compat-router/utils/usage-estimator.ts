/**
 * Usage Estimation Fallback
 *
 * Some OpenAI-compatible providers omit `usage` from their responses
 * (notably streams sent without `stream_options.include_usage`). The
 * converted Anthropic stream is the single source of token accounting for
 * every downstream consumer — SDK context display, `llm.invocation`
 * telemetry, automation run records — so missing usage silently zeroes
 * all of them.
 *
 * Estimation contract: MAY over-count, MUST NEVER under-count. Values come
 * from `estimateTokensByChars` (calibrated against the Claude tokenizer)
 * scaled by BIAS_HIGH_FACTOR, which lifts the worst measured under-count
 * (digit/log-heavy text at ~0.74x of real) to >= 1.0x.
 *
 * Char-based estimation (not the real tokenizers in token-counter.ts) is
 * deliberate: input estimation walks the full conversation context on every
 * LLM call, and a single char pass is an order of magnitude cheaper than a
 * BPE encode, with zero allocation pressure.
 */

import type { AnthropicContentBlock, AnthropicMessageResponse, AnthropicRequest } from '../types'
import { estimateTokensByChars } from './token-counter'

/** Lifts estimateTokensByChars' worst measured under-count (~0.74x) above 1.0x. */
const BIAS_HIGH_FACTOR = 1.35

/** Role marker + formatting overhead per message (same heuristic as kiro.adapter). */
const PER_MESSAGE_OVERHEAD = 4

/** Bias-high token estimate for a single text. Returns 0 for empty input. */
export function estimateUsageTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(estimateTokensByChars(text) * BIAS_HIGH_FACTOR)
}

/**
 * Estimate input tokens for an Anthropic request (system + messages + tool
 * definitions), matching what backends report as input_tokens/prompt_tokens.
 *
 * Walks text-bearing fields only — image blocks carry base64 payloads whose
 * char length wildly overstates their real token cost, so they are skipped.
 */
export function estimateRequestInputTokens(request: AnthropicRequest): number {
  let raw = 0
  let overhead = 0

  if (typeof request.system === 'string') {
    raw += estimateTokensByChars(request.system)
  } else if (Array.isArray(request.system)) {
    for (const block of request.system) {
      if (block.text) raw += estimateTokensByChars(block.text)
    }
  }

  for (const msg of request.messages) {
    overhead += PER_MESSAGE_OVERHEAD
    if (typeof msg.content === 'string') {
      raw += estimateTokensByChars(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        raw += estimateBlockChars(block)
      }
    }
  }

  if (request.tools?.length) {
    raw += estimateTokensByChars(JSON.stringify(request.tools))
  }

  return Math.ceil(raw * BIAS_HIGH_FACTOR) + overhead
}

/**
 * Estimate output tokens from a completed Anthropic response's content
 * blocks (text, thinking, tool_use input).
 */
export function estimateResponseOutputTokens(content: AnthropicContentBlock[]): number {
  let raw = 0
  for (const block of content) {
    raw += estimateBlockChars(block)
  }
  return raw > 0 ? Math.ceil(raw * BIAS_HIGH_FACTOR) : 0
}

/** Raw (unscaled) char-estimate for one content block. */
function estimateBlockChars(block: AnthropicContentBlock): number {
  switch (block.type) {
    case 'text':
      return block.text ? estimateTokensByChars(block.text) : 0
    case 'thinking':
      return block.thinking ? estimateTokensByChars(block.thinking) : 0
    case 'tool_use':
      return estimateTokensByChars(JSON.stringify(block.input ?? {}))
    case 'tool_result': {
      if (typeof block.content === 'string') {
        return estimateTokensByChars(block.content)
      }
      if (Array.isArray(block.content)) {
        let sum = 0
        for (const sub of block.content) {
          if (sub.type === 'text' && sub.text) sum += estimateTokensByChars(sub.text)
        }
        return sum
      }
      return 0
    }
    default:
      return 0
  }
}

/**
 * Start a background input-token estimate for the given request.
 *
 * The walk over the full conversation context costs milliseconds for large
 * histories — too much for the stream-finish path, free while the upstream
 * model is still generating. The computation is kicked onto the macrotask
 * queue immediately; the returned thunk awaits the cached result, which has
 * settled long before the stream finishes, so the await is a resolved-promise
 * microtask rather than a wait.
 *
 * The request object must not be mutated after this call (the walk may run
 * on the next tick). Both call sites pass the request after all interceptor
 * and model-override mutations are done.
 */
export function deferInputTokensEstimate(request: AnthropicRequest): () => Promise<number> {
  const promise = new Promise<number>((resolve) => {
    setImmediate(() => {
      try {
        resolve(estimateRequestInputTokens(request))
      } catch (err) {
        console.warn('[UsageEstimator] input estimate failed:', err)
        resolve(0)
      }
    })
  })
  return () => promise
}

/**
 * Non-streaming fallback: fill zero usage fields on a converted Anthropic
 * response in place. Runs synchronously — the response is fully buffered at
 * this point and the path is not latency-critical.
 */
export function fillResponseUsageFallback(
  response: AnthropicMessageResponse,
  request: AnthropicRequest
): void {
  const usage = response.usage
  if (!usage) return

  const needInput = !usage.input_tokens
  const needOutput = !usage.output_tokens

  if (needInput) {
    usage.input_tokens = estimateRequestInputTokens(request)
  }
  if (needOutput) {
    const estimated = estimateResponseOutputTokens(response.content)
    if (estimated > 0) usage.output_tokens = estimated
  }
  if (needInput || needOutput) {
    console.log(
      `[UsageEstimator] non-stream usage fallback: input=${usage.input_tokens} output=${usage.output_tokens} (bias-high estimate)`
    )
  }
}
