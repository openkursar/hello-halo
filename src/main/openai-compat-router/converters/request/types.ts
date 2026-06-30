/**
 * Shared options for the Anthropic -> OpenAI request converters (Chat + Responses).
 */

export interface ConvertRequestOptions {
  /**
   * Explicit per-model vision capability set by the user in Model Config.
   * When defined, it overrides the name-based `supportsVisionById` heuristic
   * for the keep-or-strip-images decision. `undefined` = use the heuristic.
   */
  visionOverride?: boolean
}
