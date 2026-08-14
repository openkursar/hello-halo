/**
 * Reasoning effort → OpenAI-compatible wire values.
 *
 * A level the user declared in Model Config is sent as-is, including values
 * Halo does not recognize: it states what that model accepts, so a new
 * provider level works the day it ships, and a wrong one surfaces the
 * upstream's own error instead of being silently downgraded. Only a level Halo
 * *inferred* from the request is clamped to what the model is known to accept.
 */

import {
  clampReasoningEffort,
  inferReasoningEffortFromBudget,
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
 */
export function resolveReasoningEffortValue(
  thinking: AnthropicThinkingConfig | undefined,
  declared: ReasoningEffortSetting | undefined,
  modelId: string
): string | undefined {
  const profile = reasoningEffortProfileById(modelId)

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
