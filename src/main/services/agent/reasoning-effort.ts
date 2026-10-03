/**
 * Reasoning effort → engine thinking options.
 *
 * How hard a model thinks comes from, first match wins: a level picked for the
 * session (a conversation's or digital human's own, or one an API send
 * carried), the send's thinking flag (false = off), and the model's configured
 * effort (Settings > Provider > Model Config). This module is the single place
 * they combine, so every SDK call site — space chat, digital-human chat,
 * automation runs — derives the same options from the same inputs.
 *
 * Each engine takes a different subset of the ladder, and the subsets are not
 * nested, so a level is clamped per engine rather than forwarded. Unlike the
 * OpenAI-compat router — which talks HTTP to a server that can reject a value
 * with an error the user sees — these values configure a local process, where
 * an out-of-enum value fails as an opaque startup error. Nothing unrecognized
 * is passed through here.
 */

import {
  CODEX_REASONING_EFFORT_LEVELS,
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

/** Codex exposes no way to stop reasoning, so 'off' takes its cheapest level. */
const CODEX_EFFORT_FOR_OFF = 'low'

/** Ladder level for a setting, substituting the default for a passthrough value. */
function toLevel(effort: ReasoningEffortSetting): ReasoningEffortLevel {
  return isReasoningEffortLevel(effort) ? effort : DEFAULT_REASONING_EFFORT
}

/**
 * Effective effort for one request. A level the user picked for this send
 * wins outright ('off' included); otherwise the toggle decides whether the
 * model thinks at all and the model config decides how hard. Anything that is
 * not a ladder level is ignored, since it arrives from the transport.
 */
export function resolveRequestEffort(
  thinkingEnabled: boolean | undefined,
  configured: ReasoningEffortSetting | undefined,
  requested?: unknown
): ReasoningEffortSetting {
  if (isReasoningEffortLevel(requested)) return requested
  if (!thinkingEnabled) return 'off'
  return configured || DEFAULT_REASONING_EFFORT
}

/**
 * First candidate that is a ladder level. Stored levels arrive through
 * unvalidated update paths, so a bad one must fall through to the next source
 * instead of shadowing it.
 */
export function pickReasoningEffort(...candidates: unknown[]): ReasoningEffortLevel | undefined {
  return candidates.find(isReasoningEffortLevel)
}

/**
 * Record the picked level on its own, apart from the resolved one.
 *
 * The OpenAI-compat router cannot read it off the wire — Claude Code sends a
 * non-Claude model only an adaptive thinking block — so it travels in the
 * router key, and must stay distinguishable from a Model Config value, which
 * the router forwards verbatim instead of clamping. The Claude path encodes
 * the key before these options exist, from the same pick passed to
 * `resolveCredentialsForSdk`; the Codex adapter encodes it from this option.
 */
function setPickedEffort(sdkOptions: Record<string, any>, picked: ReasoningEffortLevel | undefined): void {
  if (picked) sdkOptions.pickedReasoningEffort = picked
  else delete sdkOptions.pickedReasoningEffort
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
  const level = toLevel(effort)
  if (level === 'off') return null

  const budget = REASONING_EFFORT_THINKING_BUDGET[level]
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
  return clampReasoningEffort(toLevel(effort), CODEX_REASONING_EFFORT_LEVELS) ?? CODEX_EFFORT_FOR_OFF
}

/**
 * Depth options for a session created before any turn exists.
 *
 * Depth is fixed when the engine spawns — `--effort` is a launch argument and
 * Codex reads its thread config at thread start, while the SDK's only runtime
 * setter is for the token budget. A session warmed without a level can
 * therefore never acquire one. Whether the model thinks is left to that
 * setter, so no budget is written here.
 *
 * `requested` is the conversation's own level: the first send resolves the
 * same one, so the warmed session is reused rather than rebuilt.
 */
export function applySessionReasoningEffort(
  sdkOptions: Record<string, any>,
  capabilities: ResolvedModelCapabilities | undefined,
  requested?: unknown
): void {
  const picked = pickReasoningEffort(requested)
  const effort = picked ?? (capabilities?.reasoningEffort || DEFAULT_REASONING_EFFORT)

  sdkOptions.reasoningEffort = effort
  setPickedEffort(sdkOptions, picked)
  const anthropicEffort = resolveAnthropicEffort(effort)
  if (anthropicEffort) sdkOptions.effort = anthropicEffort
}

/**
 * Derive every thinking-related SDK option for one request and write them into
 * `sdkOptions`, returning the thinking budget for the session's runtime setter.
 *
 * Several names carry the same decision because several consumers read
 * different ones: `effort` and `maxThinkingTokens` are the Claude Agent SDK's
 * own option names; `reasoningEffort` is Halo's unclamped level, which the
 * Codex adapter needs because its ladder has levels Anthropic's does not; and
 * `pickedReasoningEffort` is the picked level alone, for the OpenAI-compat
 * router (see {@link setPickedEffort}).
 */
export function applyReasoningEffort(
  sdkOptions: Record<string, any>,
  thinkingEnabled: boolean | undefined,
  capabilities: ResolvedModelCapabilities | undefined,
  requestedEffort?: unknown
): number | null {
  const effort = resolveRequestEffort(thinkingEnabled, capabilities?.reasoningEffort, requestedEffort)
  const budget = resolveThinkingBudget(effort, capabilities?.maxOutputTokens)

  sdkOptions.reasoningEffort = effort
  setPickedEffort(sdkOptions, pickReasoningEffort(requestedEffort))
  const anthropicEffort = resolveAnthropicEffort(effort)
  if (anthropicEffort) sdkOptions.effort = anthropicEffort
  if (budget !== null) sdkOptions.maxThinkingTokens = budget

  return budget
}
