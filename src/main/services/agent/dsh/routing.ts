/**
 * Map Halo's stored source credentials onto what the dsh runtime's DeepSeek
 * adapter expects.
 *
 * Pure and dependency-free so it can be tested without Electron: `options.ts`
 * owns the ambient reads, this owns the translation rules.
 */

/** Used when the active source names a model the runtime cannot route. */
export const DSH_FALLBACK_MODEL = 'deepseek-chat'

const CHAT_COMPLETIONS_SUFFIX = '/chat/completions'

/**
 * The runtime posts to `${DEEPSEEK_BASE_URL}/chat/completions`, so a stored
 * base URL has to be reduced to the prefix that form expects. Halo stores what
 * the user typed, across several dialects, which is where 404s come from:
 *
 *   https://host                     → https://host/v1
 *   https://host/v1                  → unchanged
 *   https://host/v1/chat/completions → https://host/v1
 *
 * A bare origin gets `/v1` because effectively every OpenAI-compatible gateway
 * serves the API there; DeepSeek's own endpoint accepts both spellings.
 *
 * A source speaking a non-OpenAI dialect (Anthropic `/v1/messages`) cannot be
 * repaired here — it will 404 at the model, and the caller's log of the
 * resulting URL is what makes that diagnosable.
 */
export function normalizeChatCompletionsBase(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined

  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return baseUrl
  }

  let pathname = url.pathname.replace(/\/+$/, '')
  if (pathname.endsWith(CHAT_COMPLETIONS_SUFFIX)) {
    pathname = pathname.slice(0, -CHAT_COMPLETIONS_SUFFIX.length)
  }
  if (pathname === '') pathname = '/v1'

  return `${url.origin}${pathname}`
}

/**
 * dsh routes only through its DeepSeek adapter. A `claude-*` id means the
 * active source is Anthropic-shaped, which the runtime cannot address at all;
 * passing it through would fail deeper with a less obvious error.
 */
export function resolveDshModel(
  optionModel: string | undefined,
  credentialModel: string | undefined
): { model: string; fellBack: boolean } {
  const candidate = credentialModel || optionModel
  if (candidate && !candidate.startsWith('claude-')) return { model: candidate, fellBack: false }
  return {
    model: process.env.HALO_DSH_DEFAULT_MODEL || DSH_FALLBACK_MODEL,
    fellBack: true,
  }
}
