/**
 * How the composition layer reads from sources.
 *
 * A store is N sources, so every backend read has to answer "which sources,
 * and what does failure mean". There are exactly two answers (DESIGN.md §2.1),
 * and they live here so they cannot drift between the surfaces that use them.
 */

import { getPrimaryRegistry } from '../registry.service'
import { getAdapter } from '../adapters'
import type { RegistrySource } from '../../../shared/store/store-types'

/**
 * Per-source cardinality: ask every source that implements the endpoint and
 * merge. Failure is graded —
 *
 *   all failed  → rethrow the first rejection, the caller renders a load error
 *   some failed → return the successes, log the failures
 *   none asked  → empty (no source implements the endpoint)
 */
export async function aggregateAcrossSources<T>(
  logTag: string,
  sources: RegistrySource[],
  fetchOne: (source: RegistrySource) => Promise<T[]> | undefined,
): Promise<T[]> {
  // A source whose driver has no such method is not asked at all — it is
  // neither a success nor a failure, and must not affect the verdict.
  const asked = sources
    .map(source => ({ source, pending: fetchOne(source) }))
    .filter((c): c is { source: RegistrySource; pending: Promise<T[]> } => c.pending !== undefined)
  if (asked.length === 0) return []

  const settled = await Promise.allSettled(asked.map(c => c.pending))

  const merged: T[] = []
  const failures: Array<{ id: string; reason: unknown }> = []
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') merged.push(...result.value)
    else failures.push({ id: asked[i].source.id, reason: result.reason })
  })

  if (failures.length > 0) {
    const summary = failures.map(f => `${f.id}: ${(f.reason as Error)?.message ?? String(f.reason)}`).join('; ')
    console.warn(`[${logTag}] ${failures.length}/${asked.length} sources failed: ${summary}`)
    if (failures.length === asked.length) {
      // Rethrown unwrapped: callers match sentinel errors (e.g. signed-out) by
      // exact message, which a summary string would destroy.
      throw failures[0].reason
    }
  }
  return merged
}

/** Documents there is only one of per page, so only the primary source is asked. */
type PageDocument = 'fetchPageTaxonomy' | 'fetchPageLayout'

/** Long enough that chips/layout cost nothing to re-read, short enough that an
 * operator's edit lands without a client restart. */
const PAGE_DOCUMENT_TTL_MS = 5 * 60_000

/** Shorter window after a fault so a transient failure self-heals soon. */
const PAGE_DOCUMENT_ERROR_TTL_MS = 30_000

export interface PageDocumentResolver<T> {
  get(): Promise<T | null>
  invalidate(): void
}

/**
 * Primary-source cardinality with the shared caching policy: an absent document
 * is cached for the full TTL, while a fault retains the last good value and
 * retries soon — dropping straight to the fallback would visibly rearrange the
 * page on one bad response.
 *
 * `validate` runs on untrusted remote data and owns the resulting shape;
 * returning null falls the caller through to its next resolution tier.
 */
export function createPageDocumentResolver<T>(
  logTag: string,
  document: PageDocument,
  validate: (raw: unknown) => T | null,
): PageDocumentResolver<T> {
  // The held document and its validator outlive `invalidate`, which only expires
  // the TTL: dropping the validator would turn every forced re-read into a full
  // download, which is the opposite of what invalidating is for.
  let held: { value: T | null; validator?: string } | null = null
  let expiresAt = 0

  return {
    invalidate() {
      expiresAt = 0
    },
    async get() {
      const now = Date.now()
      if (held && expiresAt > now) return held.value

      const primary = getPrimaryRegistry()
      try {
        const result = primary
          ? await getAdapter(primary)[document]?.(primary, held?.validator)
          : undefined
        if (!result || result.status === 'absent') {
          held = { value: null }
        } else if (result.status === 'ok') {
          held = { value: validate(result.document), validator: result.validator }
        }
        expiresAt = now + PAGE_DOCUMENT_TTL_MS
        return held?.value ?? null
      } catch (error) {
        console.warn(`[${logTag}] server fetch failed, using cached/fallback: ${(error as Error).message}`)
        // A first fetch that faults still has to record something, or the
        // `held &&` guard above never passes and the error window buys nothing —
        // an unreachable source would be re-fetched on every single read.
        held ??= { value: null }
        expiresAt = now + PAGE_DOCUMENT_ERROR_TTL_MS
        return held.value
      }
    },
  }
}
