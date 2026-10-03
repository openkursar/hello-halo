/**
 * Apply the session's reasoning level to an Anthropic passthrough request.
 *
 * Claude Code shapes a request's thinking from a model list frozen at its
 * release: a Claude model it does not know gets a legacy `budget_tokens`
 * block and no effort, and a level picked in Halo never reaches the wire. The
 * router therefore reshapes the request from the model's profile, so the level
 * lands in `output_config.effort` and every model receives a thinking type it
 * accepts.
 *
 * Only requests that carry a thinking block are reshaped. Claude Code leaves
 * the block out of its own auxiliary calls (summaries, checks), and the router
 * rewrites their model to the session's, so adding one would make them think.
 *
 * Precedence matches the OpenAI-compatible converters: the level picked for
 * the session, then the Model Config value (verbatim), and with neither, only
 * a thinking block the model would reject is repaired.
 */

import type { AnthropicRequest, AnthropicThinkingConfig, BackendConfig } from '../types'
import {
  inferReasoningEffortFromBudget,
  isReasoningEffortLevel,
} from '../../../shared/constants/reasoning-effort'
import {
  forcedThinkingLevel,
  profileEffort,
  reasoningEffortProfileById,
  type ReasoningEffortProfile,
} from '../../../shared/constants/reasoning-effort-profiles'

type Target = { off: true } | { off: false; effort: string }

const OFF: Target = { off: true }

function resolveTarget(
  thinking: AnthropicThinkingConfig,
  profile: ReasoningEffortProfile,
  declared: string | undefined,
  picked: unknown
): Target | undefined {
  if (isReasoningEffortLevel(picked)) return picked === 'off' ? OFF : { off: false, effort: picked }
  if (declared === 'off') return OFF
  if (declared) return { off: false, effort: declared }

  if (profile.anthropic?.mode === 'adaptive' && thinking.type === 'enabled') {
    const inferred = inferReasoningEffortFromBudget(thinking.budget_tokens)
    return inferred === 'off' ? OFF : { off: false, effort: inferred }
  }
  if (thinking.type === 'disabled' && forcedThinkingLevel(profile)) return OFF
  return undefined
}

/** Thinking block and effort for `target`; `undefined` leaves a field out. */
function shape(
  thinking: AnthropicThinkingConfig,
  profile: ReasoningEffortProfile,
  target: Target
): { thinking?: AnthropicThinkingConfig; effort?: string } {
  const claude = profile.anthropic
  const forced = target.off ? forcedThinkingLevel(profile) : undefined

  if (target.off && !forced) {
    if (claude) return { thinking: { type: claude.disableType ?? 'disabled' } }
    // On the Anthropic wire no thinking block means no thinking; only a model
    // whose thinking defaults on needs the explicit switch.
    return { thinking: profile.thinkingToggle ? { type: 'disabled' } : undefined }
  }

  const level = forced ?? (target as { effort: string }).effort
  const effort = isReasoningEffortLevel(level) ? profileEffort(level, profile) : level

  if (!claude) {
    // A model that cannot stop thinking rejects `disabled`; left out, it
    // thinks by default.
    return { thinking: forced && thinking.type === 'disabled' ? undefined : thinking, effort }
  }

  return {
    thinking: claude.mode === 'adaptive'
      // Newer models hide thinking text unless asked; Halo shows it.
      ? { type: 'adaptive', display: thinking.display ?? 'summarized' }
      : thinking,
    effort: claude.effort ? effort : undefined,
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const loggedDecisions = new Set<string>()

/**
 * Reshape `thinking` and `output_config.effort` for the request's model.
 * Returns the request untouched (`modified: false`) when nothing changes, so
 * the caller can keep forwarding the raw body.
 */
export function normalizeAnthropicReasoning(
  request: AnthropicRequest,
  config: Pick<BackendConfig, 'reasoningEffort' | 'pickedReasoningEffort'>
): { request: AnthropicRequest; modified: boolean } {
  const original = request.thinking
  if (!original) return { request, modified: false }

  const profile = reasoningEffortProfileById(request.model)
  const target = resolveTarget(original, profile, config.reasoningEffort, config.pickedReasoningEffort)
  if (!target) return { request, modified: false }

  const { thinking, effort } = shape(original, profile, target)

  const outputConfig = { ...request.output_config }
  if (effort) outputConfig.effort = effort
  else delete outputConfig.effort
  const nextOutputConfig = Object.keys(outputConfig).length > 0 ? outputConfig : undefined

  if (sameJson(thinking, original) && sameJson(nextOutputConfig, request.output_config)) {
    return { request, modified: false }
  }

  const next: AnthropicRequest = { ...request }
  if (thinking) next.thinking = thinking
  else delete next.thinking
  if (nextOutputConfig) next.output_config = nextOutputConfig
  else delete next.output_config

  // Once per distinct decision: the outcome is stable within a conversation,
  // and this runs on every request.
  const decision = `${request.model}|${thinking?.type ?? '-'}|${effort ?? '-'}`
  if (!loggedDecisions.has(decision)) {
    loggedDecisions.add(decision)
    console.log(
      `[Router] Anthropic reasoning: model=${request.model} thinking=${thinking?.type ?? 'omitted'} ` +
      `effort=${effort ?? 'omitted'} (was thinking=${original.type} ` +
      `effort=${request.output_config?.effort ?? 'omitted'})`
    )
  }

  return { request: next, modified: true }
}
