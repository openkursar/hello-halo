/**
 * Reasoning effort profiles — the one table of models whose thinking controls
 * deviate from the default.
 *
 * The default is to forward a picked level verbatim and let the upstream map
 * it: providers that serve Claude Code or Codex already accept that ladder. An
 * entry exists only where forwarding is known to fail or to do nothing — a
 * level the API rejects, a model that cannot stop thinking, or an off switch
 * that lives in a different field. Each entry is a claim about a vendor's
 * documented API, and a wrong claim turns a working conversation into an
 * HTTP 400, so the list stays short.
 *
 * Both router wires read it: the OpenAI-compatible converters and the
 * Anthropic passthrough. A profile describes the model, not the wire.
 */

import {
  clampReasoningEffort,
  isReasoningEffortLevel,
  type ReasoningEffortLevel,
} from './reasoning-effort'

/** How a Claude model takes thinking on the Anthropic Messages wire. */
export interface AnthropicThinkingProfile {
  /**
   * `adaptive`: the model decides when to think and `output_config.effort`
   * sets how hard. `budget`: legacy `budget_tokens` thinking, which the
   * engine already sizes from the level.
   */
  mode: 'adaptive' | 'budget'
  /** Whether the model accepts `output_config.effort`. */
  effort: boolean
  /** `thinking.type` that stops up-front thinking. Defaults to `disabled`. */
  disableType?: 'disabled' | 'between_tools'
}

export interface ReasoningEffortProfile {
  /**
   * Levels the model accepts; a level outside steps to the nearest one, and
   * an empty list means the model takes no effort field at all. Absent means
   * any level is forwarded as picked.
   */
  levels?: readonly ReasoningEffortLevel[]
  /**
   * What "thinking off" becomes. A ladder level means the model cannot stop
   * thinking and runs at that level instead; any other string is the
   * OpenAI-wire effort value that stops it (e.g. `none`). Absent means the
   * effort field is omitted.
   */
  disableValue?: string
  /**
   * Chat Completions upstreams that stop thinking through
   * `thinking: { type: 'disabled' }` rather than an effort value.
   */
  thinkingToggle?: boolean
  /** Present for Claude models, which the Anthropic passthrough reshapes. */
  anthropic?: AnthropicThinkingProfile
}

/**
 * Levels a Halo-*inferred* level is held to on a model with no `levels`.
 *
 * Only a level Halo derived from a thinking budget lands here — the user never
 * chose it, so it must not be one an older endpoint has never heard of.
 */
export const INFERRED_REASONING_EFFORT_LEVELS: readonly ReasoningEffortLevel[] = ['low', 'medium', 'high']

const DEFAULT_PROFILE: ReasoningEffortProfile = {}

const ADAPTIVE: AnthropicThinkingProfile = { mode: 'adaptive', effort: true }
const BUDGET: AnthropicThinkingProfile = { mode: 'budget', effort: false }

const LOW_TO_MAX: readonly ReasoningEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const LOW_TO_XHIGH: readonly ReasoningEffortLevel[] = ['low', 'medium', 'high', 'xhigh']
const LOW_TO_HIGH: readonly ReasoningEffortLevel[] = ['low', 'medium', 'high']
const GPT_PRO: ReasoningEffortProfile = { levels: ['medium', 'high', 'xhigh'], disableValue: 'medium' }
const GPT_CODEX: ReasoningEffortProfile = { levels: LOW_TO_XHIGH, disableValue: 'low' }

interface ProfileEntry {
  pattern: string
  /**
   * Match this exact version only: the pattern must not be followed by a
   * further version number, so `opus-5` leaves `opus-5-5` (and a future
   * `opus-5-6`) alone while still matching dated ids like `opus-5-20260101`.
   */
  exact?: boolean
  /**
   * The pattern must open the id or a path segment and end at a word
   * boundary, for short names (`o3`) that would otherwise match inside
   * unrelated ids.
   */
  start?: boolean
  profile: ReasoningEffortProfile
}

/**
 * Matched as a lowercase substring of the wire id with `.` read as `-`, so
 * proxy-prefixed and dotted ids (`Pro/zai-org/GLM-5.3`,
 * `anthropic/claude-opus-4.6`) resolve. First match wins.
 */
const REASONING_EFFORT_PROFILES: readonly ProfileEntry[] = [
  // Claude — platform.claude.com "Thinking" and "Effort" per-model tables.
  // Always-on models reject every way of turning thinking off.
  { pattern: 'opus-5-5', exact: true, profile: { levels: LOW_TO_MAX, disableValue: 'low', anthropic: ADAPTIVE } },
  { pattern: 'claude-fable', profile: { levels: LOW_TO_MAX, disableValue: 'low', anthropic: ADAPTIVE } },
  { pattern: 'claude-mythos', profile: { levels: LOW_TO_MAX, disableValue: 'low', anthropic: ADAPTIVE } },
  // Rejects `disabled` and takes `between_tools` to stop up-front thinking.
  {
    pattern: 'sonnet-5-5',
    exact: true,
    profile: { levels: LOW_TO_MAX, anthropic: { ...ADAPTIVE, disableType: 'between_tools' } }
  },
  { pattern: 'opus-5', exact: true, profile: { levels: LOW_TO_MAX, anthropic: ADAPTIVE } },
  { pattern: 'sonnet-5', exact: true, profile: { levels: LOW_TO_MAX, anthropic: ADAPTIVE } },
  { pattern: 'opus-4-8', exact: true, profile: { levels: LOW_TO_MAX, anthropic: ADAPTIVE } },
  { pattern: 'opus-4-7', exact: true, profile: { levels: LOW_TO_MAX, anthropic: ADAPTIVE } },
  // The 4.6 generation predates `xhigh`.
  { pattern: 'opus-4-6', exact: true, profile: { levels: ['low', 'medium', 'high', 'max'], anthropic: ADAPTIVE } },
  { pattern: 'sonnet-4-6', exact: true, profile: { levels: ['low', 'medium', 'high', 'max'], anthropic: ADAPTIVE } },
  // The one budget-only model that also takes effort.
  { pattern: 'opus-4-5', exact: true, profile: { levels: ['low', 'medium', 'high'], anthropic: { mode: 'budget', effort: true } } },
  // Budget-only models without effort. OpenAI-compatible proxies still map an
  // effort onto their budget, hence the inferred ladder.
  { pattern: 'haiku-4-5', exact: true, profile: { levels: INFERRED_REASONING_EFFORT_LEVELS, anthropic: BUDGET } },
  { pattern: 'sonnet-4-5', exact: true, profile: { levels: INFERRED_REASONING_EFFORT_LEVELS, anthropic: BUDGET } },
  { pattern: 'opus-4-1', exact: true, profile: { levels: INFERRED_REASONING_EFFORT_LEVELS, anthropic: BUDGET } },
  { pattern: 'opus-4-0', exact: true, profile: { levels: INFERRED_REASONING_EFFORT_LEVELS, anthropic: BUDGET } },
  { pattern: 'opus-4', exact: true, profile: { levels: INFERRED_REASONING_EFFORT_LEVELS, anthropic: BUDGET } },
  { pattern: 'sonnet-4-0', exact: true, profile: { levels: INFERRED_REASONING_EFFORT_LEVELS, anthropic: BUDGET } },
  { pattern: 'sonnet-4', exact: true, profile: { levels: INFERRED_REASONING_EFFORT_LEVELS, anthropic: BUDGET } },
  { pattern: 'claude-3', profile: { levels: INFERRED_REASONING_EFFORT_LEVELS, anthropic: BUDGET } },
  // A Claude model newer than this table: assume the current generation's
  // controls, and since whether it can stop thinking is unknown, run "off" at
  // the lowest level, which every adaptive model accepts.
  { pattern: 'claude', profile: { levels: LOW_TO_MAX, disableValue: 'low', anthropic: ADAPTIVE } },

  // OpenAI — developers.openai.com model pages ("reasoning.effort supports").
  // `none` stops thinking where a model lists it; a model without it cannot
  // stop and runs "off" at its lowest level.
  { pattern: 'gpt-6-1-sol', profile: { levels: LOW_TO_MAX, disableValue: 'low' } },
  { pattern: 'gpt-6-astra', profile: { levels: LOW_TO_MAX, disableValue: 'low' } },
  { pattern: 'gpt-6-sol', exact: true, profile: { levels: LOW_TO_MAX, disableValue: 'none' } },
  { pattern: 'gpt-6-luna', exact: true, profile: { levels: LOW_TO_MAX, disableValue: 'none' } },
  { pattern: 'gpt-5-6', exact: true, profile: { levels: LOW_TO_MAX, disableValue: 'none' } },
  { pattern: 'gpt-5-5-pro', profile: GPT_PRO },
  { pattern: 'gpt-5-4-pro', profile: GPT_PRO },
  { pattern: 'gpt-5-2-pro', profile: GPT_PRO },
  { pattern: 'gpt-5-pro', profile: { levels: ['high'], disableValue: 'high' } },
  { pattern: 'gpt-5-3-codex', profile: GPT_CODEX },
  { pattern: 'gpt-5-2-codex', profile: GPT_CODEX },
  { pattern: 'gpt-5-1-codex-max', profile: GPT_CODEX },
  // Earlier Codex variants document no ladder; held to the long-standing three.
  { pattern: 'gpt-5-1-codex', profile: { levels: LOW_TO_HIGH, disableValue: 'low' } },
  { pattern: 'gpt-5-codex', profile: { levels: LOW_TO_HIGH, disableValue: 'low' } },
  // Covers the -mini and -nano tiers too.
  { pattern: 'gpt-5-5', exact: true, profile: { levels: LOW_TO_XHIGH, disableValue: 'none' } },
  { pattern: 'gpt-5-4', exact: true, profile: { levels: LOW_TO_XHIGH, disableValue: 'none' } },
  { pattern: 'gpt-5-2', exact: true, profile: { levels: LOW_TO_XHIGH, disableValue: 'none' } },
  { pattern: 'gpt-5-1', exact: true, profile: { levels: LOW_TO_HIGH, disableValue: 'none' } },
  { pattern: 'gpt-5', exact: true, profile: { levels: ['minimal', 'low', 'medium', 'high'], disableValue: 'minimal' } },
  // o-series: low/medium/high, no way to stop.
  { pattern: 'o1', start: true, profile: { levels: LOW_TO_HIGH, disableValue: 'low' } },
  { pattern: 'o3', start: true, profile: { levels: LOW_TO_HIGH, disableValue: 'low' } },
  { pattern: 'o4', start: true, profile: { levels: LOW_TO_HIGH, disableValue: 'low' } },

  // DeepSeek — api-docs.deepseek.com thinking-mode guide: every effort value is accepted
  // and mapped server-side; thinking stops only through `thinking.type`.
  { pattern: 'deepseek', profile: { thinkingToggle: true } },

  // GLM — docs.bigmodel.cn thinking-mode guide. GLM-5.3 and GLM-5.3-FLASH always think
  // and accept only low/high/max.
  { pattern: 'glm-5-3', profile: { levels: ['low', 'high', 'max'], disableValue: 'low' } },
  // GLM-5.2 is the first GLM to document `reasoning_effort`. It silently
  // remaps low/medium to high and xhigh to max, so only the two distinct tiers
  // are sent; `none` stops thinking.
  { pattern: 'glm-5-2', profile: { levels: ['high', 'max'], disableValue: 'none' } },
  // GLM-5, 5.1, 5-Turbo and the GLM-4 family take no `reasoning_effort`;
  // `thinking.type` is their only control.
  { pattern: 'glm-5', profile: { levels: [], thinkingToggle: true } },
  { pattern: 'glm-4', profile: { levels: [], thinkingToggle: true } },
]

/**
 * What may not follow an exact pattern: a digit (the pattern stopped inside a
 * number, as `gpt-5-1` in `gpt-5-10` or `gpt-5-2` in `gpt-5-2025-08-07`), or
 * a further version (`-5`, `-12`) — as opposed to a date (`-20260101`).
 */
const FURTHER_VERSION = /^(\d|-\d{1,2}(?!\d))/

function matchesAt(id: string, at: number, entry: ProfileEntry): boolean {
  const rest = id.slice(at + entry.pattern.length)
  if (entry.exact && FURTHER_VERSION.test(rest)) return false
  if (entry.start) {
    if (at > 0 && id[at - 1] !== '/') return false
    if (/^[a-z0-9]/.test(rest)) return false
  }
  return true
}

function matches(id: string, entry: ProfileEntry): boolean {
  for (let at = id.indexOf(entry.pattern); at >= 0; at = id.indexOf(entry.pattern, at + 1)) {
    if (matchesAt(id, at, entry)) return true
  }
  return false
}

/** Profile for a wire model id; the empty default forwards levels as picked. */
export function reasoningEffortProfileById(
  modelId: string | undefined | null
): ReasoningEffortProfile {
  if (!modelId) return DEFAULT_PROFILE
  const id = modelId.toLowerCase().replace(/\./g, '-')
  return REASONING_EFFORT_PROFILES.find((entry) => matches(id, entry))?.profile ?? DEFAULT_PROFILE
}

/**
 * Level the model runs at when asked to stop thinking but unable to, or
 * undefined when it can stop.
 */
export function forcedThinkingLevel(profile: ReasoningEffortProfile): ReasoningEffortLevel | undefined {
  const value = profile.disableValue
  return isReasoningEffortLevel(value) && value !== 'off' ? value : undefined
}

/**
 * Wire effort for `level` on this model: clamped to `levels` when the profile
 * has them (undefined when the model takes none), else forwarded as is.
 */
export function profileEffort(
  level: ReasoningEffortLevel,
  profile: ReasoningEffortProfile
): ReasoningEffortLevel | undefined {
  return profile.levels ? clampReasoningEffort(level, profile.levels) : level
}
