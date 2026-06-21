/**
 * Context usage accounting — engine-agnostic.
 *
 * Reproduces claude-code's `/context` headline number without depending on any
 * specific SDK. Halo runs multiple engines (claude-agent-sdk, codex, hello-halo)
 * that all normalize to the same per-turn frame contract, so this module reads
 * only the normalized `assistant`/`result` usage and our own model-capability
 * table — never an SDK-specific control method or field.
 *
 * The "current context size" equals the most recent real (non-synthetic)
 * assistant message's `input_tokens + cache_creation + cache_read`. This mirrors
 * claude-code `getCurrentUsage` + `analyzeContextUsage`: output_tokens is the
 * generated reply, not part of the prompt the model saw, so it is excluded.
 */

import { modelCapabilitiesService } from '../model-capabilities.service'
import type { SingleCallUsage, TokenUsage } from './types'

/**
 * Synthetic markers copied verbatim from claude-code (`utils/messages.ts`).
 * An assistant message carrying one of these is bookkeeping (interrupt, cancel,
 * tool rejection, no-response), not a real API turn — its usage is not a valid
 * measure of context size and must be skipped. Mirrors `getTokenUsage`.
 */
const SYNTHETIC_MODEL = '<synthetic>'
const SYNTHETIC_MESSAGE_TEXTS = new Set<string>([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
  'No response requested.'
])

/** Minimal shape of a normalized assistant message this module reads. */
interface RawAssistantMessage {
  message?: {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
    content?: Array<{ type?: string; text?: string }>
  }
}

/** Minimal shape of a normalized result frame this module reads. */
interface RawResultMessage {
  total_cost_usd?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export function isSyntheticAssistantMessage(msg: RawAssistantMessage): boolean {
  const m = msg.message
  if (!m) return false
  if (m.model === SYNTHETIC_MODEL) return true
  const first = Array.isArray(m.content) ? m.content[0] : undefined
  return (
    first?.type === 'text' &&
    typeof first.text === 'string' &&
    SYNTHETIC_MESSAGE_TEXTS.has(first.text)
  )
}

/**
 * Per-call usage from a real assistant message. Returns null for synthetic or
 * usage-less messages so the caller keeps the last real value instead of
 * overwriting it with bookkeeping noise.
 */
export function extractRealAssistantUsage(msg: RawAssistantMessage): SingleCallUsage | null {
  if (isSyntheticAssistantMessage(msg)) return null
  const u = msg.message?.usage
  if (!u) return null
  const inputTokens = u.input_tokens || 0
  const outputTokens = u.output_tokens || 0
  const cacheReadTokens = u.cache_read_input_tokens || 0
  const cacheCreationTokens = u.cache_creation_input_tokens || 0
  // Engines split one API response into several assistant frames (per content
  // block / streaming start); only one carries real usage, the rest report an
  // all-zero placeholder. Skipping the all-zero ones keeps the last REAL usage
  // instead of letting a trailing placeholder zero out the context size.
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) {
    return null
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }
}

/**
 * Current context size = input + cache_creation + cache_read of the latest real
 * assistant call. output_tokens is excluded to match claude-code's `/context`.
 */
export function computeContextUsed(usage: SingleCallUsage): number {
  return usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens
}

/**
 * Fallback context-window resolution from a model name alone, mirroring
 * claude-code's `getContextWindowForModel` order:
 *   1. `[1m]` suffix → 1M (documented client-side opt-in)
 *   2. known capability table entry → its window
 *   3. unknown → 200K (claude-code's MODEL_CONTEXT_WINDOW_DEFAULT)
 *
 * Only used when the caller cannot supply the resolved window from
 * credentials (see `buildTokenUsage`). The name here is often a friendly
 * displayModel, so this chain can disagree with the runtime window —
 * callers that know the source-resolved value must pass it instead.
 */
export function resolveContextWindow(model: string): number {
  if (/\[1m\]$/i.test(model)) return 1_000_000
  const preset = modelCapabilitiesService.getPreset(model)
  if (preset && preset.contextWindow > 0) return preset.contextWindow
  return 200_000
}

/**
 * Build the final TokenUsage for a turn.
 *
 * Primary source is `lastRealUsage` — the last real per-call usage captured from
 * the assistant frames (no cumulative aggregation, matches `/context`). Some
 * engines/turns (e.g. a short text-only reply) attach no usage to any assistant
 * frame; usage only reaches the `result` frame. In that case fall back to the
 * result frame's own usage so the indicator still shows a number. The fallback
 * only fires when no real per-call usage exists, so its turn-cumulative shape
 * equals the single call it represents and cannot double-count.
 */
export function buildTokenUsage(
  resultMsg: RawResultMessage,
  lastRealUsage: SingleCallUsage | null,
  model: string,
  contextWindow?: number
): TokenUsage | null {
  const usage = lastRealUsage ?? resultUsageFallback(resultMsg)
  if (!usage) return null
  return {
    ...usage,
    totalCostUsd: resultMsg.total_cost_usd || 0,
    // Prefer the source-resolved window (same value that drives the CC
    // subprocess via CLAUDE_CODE_AUTO_COMPACT_WINDOW) so the displayed
    // window always matches actual compaction behavior.
    contextWindow: contextWindow ?? resolveContextWindow(model)
  }
}

function resultUsageFallback(resultMsg: RawResultMessage): SingleCallUsage | null {
  const u = resultMsg.usage
  if (!u) return null
  const inputTokens = u.input_tokens || 0
  const outputTokens = u.output_tokens || 0
  const cacheReadTokens = u.cache_read_input_tokens || 0
  const cacheCreationTokens = u.cache_creation_input_tokens || 0
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) {
    return null
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }
}
