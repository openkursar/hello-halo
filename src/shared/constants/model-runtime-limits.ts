/**
 * Model Runtime Limits — Single Source of Truth
 *
 * Shared between:
 *   - Renderer Settings UI (`ModelConfigPanel`) for input bounds and warning UI
 *   - Every agent engine that has to tell its runtime what the active model can
 *     do: Claude Code via env vars (`sdk-config.ts`), dsh via JSON-RPC
 *     `initialize` + its cordis composition (`agent/dsh/options.ts`)
 *
 * Why split "hard cap" vs "recommended floor":
 *   We used to silently clamp `maxOutputTokens` up to 20_000 in the agent
 *   layer, which made the UI lie to the user (input said 300, runtime used
 *   20_000). The 20_000 number itself mirrors CC's internal
 *   `COMPACT_MAX_OUTPUT_TOKENS` in `utils/context.ts` and the summary call
 *   reservation in `services/compact/compact.ts:1317-1320`, but CC does not
 *   enforce a floor — it is a quality recommendation, not a wire constraint.
 *
 *   So we now treat it as a recommendation: pass the user's value through
 *   to the env var, warn loudly when it falls below the recommended floor,
 *   and surface the same warning in the UI. The user stays in control.
 *
 * Why `contextWindow` keeps a HARD floor:
 *   Below ~33K the CC autoCompactThreshold goes negative (20K summary
 *   reserve + 13K compact buffer), causing compaction to fire on every
 *   turn — the agent is effectively unusable. This is a correctness floor,
 *   not a quality one, so we still clamp.
 */

// ── maxOutputTokens ────────────────────────────────────────────────────────

/** Lower bound the agent layer will not go below (rejects 0, negative, NaN). */
export const MAX_OUTPUT_TOKENS_HARD_MIN = 1

/** Upper sanity cap for the env value. CC further caps to the model's own upper limit. */
export const MAX_OUTPUT_TOKENS_HARD_CAP = 1_000_000

/**
 * Quality recommendation — mirrors CC's `COMPACT_MAX_OUTPUT_TOKENS` (20_000).
 * Values below this may cause CC's auto-compact summary to truncate
 * mid-generation (summary p99.99 ≈ 17_387 tokens per CC source). Not enforced.
 */
export const RECOMMENDED_MIN_MAX_OUTPUT_TOKENS = 20_000

// ── contextWindow ──────────────────────────────────────────────────────────

/** Hard floor — below this, auto-compact fires every turn (see file header). */
export const CONTEXT_WINDOW_HARD_MIN = 40_000

/** Upper sanity cap — future-proof for >1M models. */
export const CONTEXT_WINDOW_HARD_CAP = 2_000_000

// ── Resolution ─────────────────────────────────────────────────────────────

/** The two capability numbers a runtime needs, as resolved for the active model. */
export interface ModelRuntimeCapabilities {
  maxOutputTokens: number
  contextWindow: number
}

/**
 * A field is absent when the input carried nothing usable for it, which the
 * caller must read as "say nothing and let the runtime keep its own default"
 * rather than as a zero.
 */
export interface ModelRuntimeLimits {
  maxOutputTokens?: number
  contextWindow?: number
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

/**
 * Bound resolved capabilities into values that are safe to hand a runtime.
 *
 * Engine-neutral on purpose. Every engine that pins output length or context
 * capacity has to start from the same numbers, or the engines disagree about
 * one model: dsh shipped for a while reading its own SDK's DeepSeek defaults
 * (256K output, 1M window), which only DeepSeek's endpoint accepts — every
 * other vendor rejected the request outright. Naming those values per engine
 * stays with the engine; deciding them does not.
 */
export function clampModelRuntimeLimits(
  capabilities: ModelRuntimeCapabilities | undefined
): ModelRuntimeLimits {
  if (!capabilities) return {}
  const limits: ModelRuntimeLimits = {}

  if (Number.isFinite(capabilities.maxOutputTokens) && capabilities.maxOutputTokens > 0) {
    limits.maxOutputTokens = clampInt(
      capabilities.maxOutputTokens,
      MAX_OUTPUT_TOKENS_HARD_MIN,
      MAX_OUTPUT_TOKENS_HARD_CAP
    )
  }

  if (Number.isFinite(capabilities.contextWindow) && capabilities.contextWindow > 0) {
    limits.contextWindow = clampInt(
      capabilities.contextWindow,
      CONTEXT_WINDOW_HARD_MIN,
      CONTEXT_WINDOW_HARD_CAP
    )
  }

  return limits
}
