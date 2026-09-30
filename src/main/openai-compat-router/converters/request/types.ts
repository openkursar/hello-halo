/**
 * Shared options for the Anthropic -> OpenAI request converters (Chat + Responses).
 */

import type { ReasoningEffortLevel, ReasoningEffortSetting } from '../../../../shared/constants/reasoning-effort'

export interface ConvertRequestOptions {
  /**
   * Explicit per-model vision capability set by the user in Model Config.
   * When defined, it overrides the name-based `supportsVisionById` heuristic
   * for the keep-or-strip-images decision. `undefined` = use the heuristic.
   */
  visionOverride?: boolean
  /**
   * Level the user set in Model Config. Carried alongside the request rather
   * than inside it: the Anthropic body can only express a token budget, so a
   * level put there would have to be guessed back out. `undefined` = infer
   * from the request.
   */
  reasoningEffort?: ReasoningEffortSetting
  /**
   * Level picked for this session (see `BackendRequestConfig`). Wins over
   * `reasoningEffort` and is clamped to what the upstream accepts.
   */
  pickedReasoningEffort?: ReasoningEffortLevel
}
