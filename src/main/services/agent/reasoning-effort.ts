/**
 * Reasoning effort → engine thinking options.
 *
 * The chat "Deep Thinking" toggle is a boolean; how hard the model then thinks
 * is a per-model setting (Settings > Provider > Model Config). This module is
 * the single place those two combine, so every SDK call site — space chat,
 * digital-human chat, automation runs — derives the same options from the same
 * inputs.
 *
 * Each engine takes a different subset of the ladder, and the subsets are not
 * nested, so a level is clamped per engine rather than forwarded. Unlike the
 * OpenAI-compat router — which talks HTTP to a server that can reject a value
 * with an error the user sees — these values configure a local process, where
 * an out-of-enum value fails as an opaque startup error. Nothing unrecognized
 * is passed through here.
 */

import {
  DEFAULT_REASONING_EFFORT,
  MIN_ANSWER_TOKENS,
  MIN_THINKING_BUDGET,
  REASONING_EFFORT_THINKING_BUDGET,
  clampReasoningEffort,
  isReasoningEffortLevel,
  type ReasoningEffortLevel,
  type ReasoningEffortSetting,
} from '../../../shared/constants/reasoning-effort'
import type { ResolvedModelCapabilities } from './types'

/** Levels `@anthropic-ai/claude-agent-sdk` accepts for its `effort` option. */
const ANTHROPIC_EFFORT_LEVELS: readonly ReasoningEffortLevel[] = ['low', 'medium', 'high', 'max']

/** Levels Codex accepts for `model_reasoning_effort`. */
const CODEX_EFFORT_LEVELS: readonly ReasoningEffortLevel[] = [
  'minimal', 'low', 'medium', 'high', 'xhigh'
]

/** Codex exposes no way to stop reasoning, so 'off' takes its cheapest level. */
const CODEX_EFFORT_FOR_OFF = 'low'

/** Ladder level for a setting, substituting the default for a passthrough value. */
function toLevel(effort: ReasoningEffortSetting): ReasoningEffortLevel {
  return isReasoningEffortLevel(effort) ? effort : DEFAULT_REASONING_EFFORT
}

/**
 * Effective effort for one request: the toggle decides whether the model
 * thinks at all, the model config decides how hard.
 */
export function resolveRequestEffort(
  thinkingEnabled: boolean | undefined,
  configured: ReasoningEffortSetting | undefined
): ReasoningEffortSetting {
  if (!thinkingEnabled) return 'off'
  return configured || DEFAULT_REASONING_EFFORT
}

/**
 * Thinking token budget for `effort`, or null when the model should not think.
 *
 * @param maxOutputTokens Resolved output limit for the model. Thinking and the
 *        reply share it, so the budget leaves {@link MIN_ANSWER_TOKENS} for the
 *        reply; a limit too small to hold both disables thinking rather than
 *        returning an answer truncated mid-sentence.
 */
export function resolveThinkingBudget(
  effort: ReasoningEffortSetting,
  maxOutputTokens: number | undefined
): number | null {
  if (effort === 'off') return null

  const budget = REASONING_EFFORT_THINKING_BUDGET[toLevel(effort)]
  if (!maxOutputTokens) return budget

  const ceiling = maxOutputTokens - MIN_ANSWER_TOKENS
  if (ceiling < MIN_THINKING_BUDGET) return null

  return Math.min(budget, ceiling)
}

/**
 * Value for the Claude Agent SDK's `effort` option, or undefined when the
 * model should not think.
 */
export function resolveAnthropicEffort(
  effort: ReasoningEffortSetting
): ReasoningEffortLevel | undefined {
  if (effort === 'off') return undefined
  return clampReasoningEffort(toLevel(effort), ANTHROPIC_EFFORT_LEVELS)
}

/** Value for Codex's `model_reasoning_effort` thread config. */
export function resolveCodexReasoningEffort(effort: ReasoningEffortSetting): string {
  if (effort === 'off') return CODEX_EFFORT_FOR_OFF
  return clampReasoningEffort(toLevel(effort), CODEX_EFFORT_LEVELS) ?? CODEX_EFFORT_FOR_OFF
}

/**
 * Depth options for a session created before any turn exists.
 *
 * Depth is fixed when the engine spawns — `--effort` is a launch argument and
 * Codex reads its thread config at thread start, while the SDK's only runtime
 * setter is for the token budget. A session warmed without a level can
 * therefore never acquire one. Whether the model thinks is left to that
 * setter, so no budget is written here.
 */
export function applySessionReasoningEffort(
  sdkOptions: Record<string, any>,
  capabilities: ResolvedModelCapabilities | undefined
): void {
  const configured = capabilities?.reasoningEffort || DEFAULT_REASONING_EFFORT

  sdkOptions.reasoningEffort = configured
  const anthropicEffort = resolveAnthropicEffort(configured)
  if (anthropicEffort) sdkOptions.effort = anthropicEffort
}

/**
 * Derive every thinking-related SDK option for one request and write them into
 * `sdkOptions`, returning the thinking budget for the session's runtime setter.
 *
 * Three names carry the same decision because three consumers read different
 * ones: `effort` and `maxThinkingTokens` are the Claude Agent SDK's own option
 * names, while `reasoningEffort` is Halo's unclamped level, which the Codex
 * adapter needs because its ladder has levels Anthropic's does not.
 */
export function applyReasoningEffort(
  sdkOptions: Record<string, any>,
  thinkingEnabled: boolean | undefined,
  capabilities: ResolvedModelCapabilities | undefined
): number | null {
  const effort = resolveRequestEffort(thinkingEnabled, capabilities?.reasoningEffort)
  const budget = resolveThinkingBudget(effort, capabilities?.maxOutputTokens)

  sdkOptions.reasoningEffort = effort
  const anthropicEffort = resolveAnthropicEffort(effort)
  if (anthropicEffort) sdkOptions.effort = anthropicEffort
  if (budget !== null) sdkOptions.maxThinkingTokens = budget

  return budget
}
