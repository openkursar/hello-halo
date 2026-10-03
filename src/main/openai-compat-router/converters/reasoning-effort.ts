/**
 * Reasoning effort → OpenAI-compatible wire values.
 *
 * A level picked for the session is forwarded as picked unless the model's
 * profile says otherwise: upstreams that serve Codex already map the whole
 * ladder. A level the user declared in Model Config is sent verbatim,
 * including values Halo does not recognize, so a new provider level works the
 * day it ships and a wrong one surfaces the upstream's own error. A level Halo
 * *inferred* from the request is held to what any endpoint accepts.
 */

import {
  clampReasoningEffort,
  inferReasoningEffortFromBudget,
  isReasoningEffortLevel,
  type ReasoningEffortSetting,
} from '../../../shared/constants/reasoning-effort'
import {
  INFERRED_REASONING_EFFORT_LEVELS,
  forcedThinkingLevel,
  profileEffort,
  reasoningEffortProfileById,
  type ReasoningEffortProfile,
} from '../../../shared/constants/reasoning-effort-profiles'

export interface AnthropicThinkingConfig {
  type: string
  budget_tokens?: number
}

export interface ResolvedReasoning {
  /** Value for `reasoning_effort` / `reasoning.effort`; undefined omits the field. */
  effort?: string
  /**
   * Send `thinking: { type: 'disabled' }` (Chat Completions): thinking is off
   * and the model's profile stops it through that toggle.
   */
  disableThinking: boolean
}

function resolveOff(profile: ReasoningEffortProfile): ResolvedReasoning {
  const forced = forcedThinkingLevel(profile)
  if (forced) return { effort: forced, disableThinking: false }
  return { effort: profile.disableValue, disableThinking: !!profile.thinkingToggle }
}

/**
 * Reasoning settings for one request.
 *
 * @param thinking Thinking block of the incoming Anthropic request. Its type
 *        decides whether the model thinks at all; `adaptive` is the mode newer
 *        Claude models use, where depth lives in the effort level rather than
 *        a token budget, so there is no budget to read.
 * @param declared Level from the user's Model Config, forwarded verbatim.
 * @param picked Level picked for this session (a conversation's or digital
 *        human's own). Wins over both the request and `declared`, since the
 *        request cannot carry it: the engine sends a non-Claude model only an
 *        adaptive block. Anything that is not a ladder level is ignored — it
 *        arrives decoded from the request's key.
 */
export function resolveReasoning(
  thinking: AnthropicThinkingConfig | undefined,
  declared: ReasoningEffortSetting | undefined,
  modelId: string,
  picked?: unknown
): ResolvedReasoning {
  const profile = reasoningEffortProfileById(modelId)

  if (isReasoningEffortLevel(picked)) {
    return picked === 'off'
      ? resolveOff(profile)
      : { effort: profileEffort(picked, profile), disableThinking: false }
  }

  const thinkingOff = !thinking || thinking.type === 'disabled' || declared === 'off'
  if (thinkingOff) return resolveOff(profile)

  if (declared) return { effort: declared, disableThinking: false }

  const inferred = thinking.type === 'enabled'
    ? inferReasoningEffortFromBudget(thinking.budget_tokens)
    : 'high'

  if (inferred === 'off') return resolveOff(profile)

  return {
    effort: clampReasoningEffort(inferred, profile.levels ?? INFERRED_REASONING_EFFORT_LEVELS),
    disableThinking: false
  }
}

/** The effort value alone; see {@link resolveReasoning}. */
export function resolveReasoningEffortValue(
  thinking: AnthropicThinkingConfig | undefined,
  declared: ReasoningEffortSetting | undefined,
  modelId: string,
  picked?: unknown
): string | undefined {
  return resolveReasoning(thinking, declared, modelId, picked).effort
}

/**
 * Whether a wire value denotes thinking being active. `none` and `off` are
 * sent to switch thinking off, so a present field is not by itself a signal.
 */
export function isThinkingEffort(value: string | undefined): boolean {
  return !!value && value !== 'none' && value !== 'off'
}
