/**
 * Codex model capabilities, as last reported by that backend's model catalog.
 *
 * Two things the request shape depends on are only knowable from the catalog —
 * whether a model accepts `reasoning.summary`, and whether it requires the
 * Responses-Lite layout — and the catalog is fetched by the AI source provider,
 * which lives in a different module from the adapter that needs them. The
 * provider writes; the adapter reads; nothing else touches this.
 *
 * Keyed by model slug. Several Codex sources in one process share a plan far
 * more often than they differ, and a slug whose flags disagreed between accounts
 * would cost one request shape, not correctness.
 */

export interface CodexModelCapability {
  /**
   * Whether the model accepts the Responses `reasoning.summary` parameter.
   * Absent on the wire means true — that field is `skip_serializing_if =
   * "is_true"`, so a false is stated explicitly and silence is assent.
   */
  reasoningSummary: boolean
  /** Whether the model requires Responses-Lite request layout. */
  responsesLite: boolean
}

const capabilities = new Map<string, CodexModelCapability>()

/** Wire shape of the fields this module reads from a catalog entry. */
export interface CodexCatalogCapabilities {
  slug?: string
  supports_reasoning_summary_parameter?: boolean
  use_responses_lite?: boolean
}

/**
 * Record the capabilities of every model in a freshly fetched catalog.
 *
 * Replaces the previous set rather than merging: a model that disappeared from
 * the catalog is one this account can no longer select, so keeping its flags
 * would only preserve stale decisions.
 */
export function setCodexModelCapabilities(models: CodexCatalogCapabilities[]): void {
  capabilities.clear()
  for (const model of models) {
    if (!model?.slug) continue
    capabilities.set(model.slug, {
      reasoningSummary: model.supports_reasoning_summary_parameter !== false,
      responsesLite: model.use_responses_lite === true
    })
  }
}

/**
 * Capabilities for a model, or `undefined` when the catalog has never been read.
 *
 * Callers must decide what an unknown model means; this deliberately does not
 * invent a default, because the two capabilities fail in opposite directions.
 */
export function getCodexModelCapability(slug: unknown): CodexModelCapability | undefined {
  return typeof slug === 'string' ? capabilities.get(slug) : undefined
}
