/**
 * Choose the model id the dsh runtime is pinned to at `initialize`.
 *
 * Pure and dependency-free so it can be tested without Electron: `options.ts`
 * owns the ambient reads, this owns the rule.
 */

/** Used when no source names a model at all. */
export const DSH_FALLBACK_MODEL = 'deepseek-chat'

/**
 * The active source's model is the wire id, and it is sent verbatim: which
 * dialect the endpoint speaks is decided by the compat router from the source's
 * URL, not guessed here from the id's spelling. An OpenAI-compatible gateway
 * serving `claude-*` is a real deployment, and rewriting its model would send
 * the turn to a model nobody selected.
 */
export function resolveDshModel(
  optionModel: string | undefined,
  credentialModel: string | undefined
): { model: string; fellBack: boolean } {
  const candidate = credentialModel || optionModel
  if (candidate) return { model: candidate, fellBack: false }
  return {
    model: process.env.HALO_DSH_DEFAULT_MODEL || DSH_FALLBACK_MODEL,
    fellBack: true,
  }
}
