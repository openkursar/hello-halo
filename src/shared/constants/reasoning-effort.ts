/**
 * Reasoning Effort — how hard a model should think before answering.
 *
 * The ladder below is the vocabulary the providers themselves converged on, so
 * a value configured in Halo is spelled the same way as in the provider's own
 * documentation. No single engine accepts all seven levels and the accepted
 * subsets are not nested (`max` is Anthropic-only, `minimal`/`xhigh` are
 * Codex-only), so every engine path clamps this ladder to its own before
 * putting a value on the wire.
 */

/** Ordered from least to most thinking. */
export const REASONING_EFFORT_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number]

/**
 * What may be stored in model config: a ladder level, or any provider-specific
 * value the user wants passed through as-is.
 */
export type ReasoningEffortSetting = ReasoningEffortLevel | string

/**
 * Level applied when the user configured none. Equals the fixed budget Halo
 * used before the ladder existed, so an unconfigured model keeps its behavior.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffortLevel = 'high'

export function isReasoningEffortLevel(value: unknown): value is ReasoningEffortLevel {
  return typeof value === 'string'
    && (REASONING_EFFORT_LEVELS as readonly string[]).includes(value)
}

/**
 * Position on the ladder, or -1 for a passthrough value.
 *
 * Ordering only exists between known levels; an unrecognized word cannot be
 * ranked against them, which is why passthrough values skip level clamping.
 */
export function reasoningEffortRank(value: ReasoningEffortSetting): number {
  return (REASONING_EFFORT_LEVELS as readonly string[]).indexOf(value)
}

/**
 * Thinking token budget per level, for Anthropic-protocol engines that take a
 * budget instead of a level.
 *
 * Halo's own scale: no provider publishes a budget-per-level mapping. Only two
 * properties are load-bearing — the values are strictly increasing, and none
 * falls below {@link MIN_THINKING_BUDGET}.
 *
 * Kept next to the ladder rather than beside either consumer because the
 * correspondence is read in both directions: engines are configured with the
 * budget, and the OpenAI-compat router reads a budget back out of requests it
 * did not originate.
 */
export const REASONING_EFFORT_THINKING_BUDGET: Record<
  Exclude<ReasoningEffortLevel, 'off'>,
  number
> = {
  minimal: 1_024,
  low: 2_048,
  medium: 5_120,
  high: 10_240,
  xhigh: 20_480,
  max: 32_000,
}

/** Lowest budget Anthropic accepts for a thinking block. */
export const MIN_THINKING_BUDGET = 1_024

/**
 * Output tokens withheld from the thinking budget so the answer still fits.
 *
 * Thinking and the reply share one `max_tokens`, so an unbounded budget on a
 * model with a small output limit yields a reply truncated mid-sentence.
 */
export const MIN_ANSWER_TOKENS = 4_096

/**
 * Level whose budget bracket contains `budgetTokens`. Inverse of
 * {@link REASONING_EFFORT_THINKING_BUDGET}.
 */
export function inferReasoningEffortFromBudget(
  budgetTokens: number | null | undefined
): ReasoningEffortLevel {
  if (!budgetTokens) return 'off'

  let matched: ReasoningEffortLevel = 'minimal'
  for (const level of REASONING_EFFORT_LEVELS) {
    if (level === 'off') continue
    if (budgetTokens >= REASONING_EFFORT_THINKING_BUDGET[level]) matched = level
  }
  return matched
}

/**
 * Highest level in `supported` that does not exceed `level`.
 *
 * Falls back to the lowest supported level when every supported level ranks
 * above the request, so a narrow ladder still yields a legal value.
 */
export function clampReasoningEffort(
  level: ReasoningEffortLevel,
  supported: readonly ReasoningEffortLevel[]
): ReasoningEffortLevel | undefined {
  if (supported.length === 0) return undefined
  if (supported.includes(level)) return level

  const target = reasoningEffortRank(level)
  const ranked = [...supported].sort((a, b) => reasoningEffortRank(a) - reasoningEffortRank(b))

  let best: ReasoningEffortLevel | undefined
  for (const candidate of ranked) {
    if (reasoningEffortRank(candidate) <= target) best = candidate
  }
  return best ?? ranked[0]
}
