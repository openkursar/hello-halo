/**
 * Reasoning effort → OpenAI-compatible wire values.
 *
 * A level the user declared in Model Config is sent as-is, including values
 * Halo does not recognize: it states what that model accepts, so a new
 * provider level works the day it ships, and a wrong one surfaces the
 * upstream's own error instead of being silently downgraded. A level picked
 * for the session, or one Halo *inferred* from the request, is clamped to what
 * the model is known to accept.
 */

import {
  clampReasoningEffort,
  inferReasoningEffortFromBudget,
  isReasoningEffortLevel,
  type ReasoningEffortSetting,
} from '../../../shared/constants/reasoning-effort'
import { reasoningEffortProfileById } from '../../../shared/constants/model-capabilities'

export interface AnthropicThinkingConfig {
  type: string
  budget_tokens?: number
}

/**
 * Wire value for `reasoning_effort` / `reasoning.effort`, or undefined when
 * the field should be omitted.
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
export function resolveReasoningEffortValue(
  thinking: AnthropicThinkingConfig | undefined,
  declared: ReasoningEffortSetting | undefined,
  modelId: string,
  picked?: unknown
): string | undefined {
  const profile = reasoningEffortProfileById(modelId)

  if (isReasoningEffortLevel(picked)) {
    return picked === 'off'
      ? profile.disableValue
      : clampReasoningEffort(picked, profile.levels)
  }

  const thinkingOff = !thinking || thinking.type === 'disabled' || declared === 'off'
  if (thinkingOff) return profile.disableValue

  if (declared) return declared

  const inferred = thinking.type === 'enabled'
    ? inferReasoningEffortFromBudget(thinking.budget_tokens)
    : 'high'

  if (inferred === 'off') return profile.disableValue

  return clampReasoningEffort(inferred, profile.levels)
}

/**
 * Whether a wire value denotes thinking being active. `none` and `off` are
 * sent to switch thinking off, so a present field is not by itself a signal.
 */
export function isThinkingEffort(value: string | undefined): boolean {
  return !!value && value !== 'none' && value !== 'off'
}
