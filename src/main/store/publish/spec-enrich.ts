/**
 * Pre-dispatch spec enrichment for publish flows.
 *
 * Why this exists: locally-runnable specs may omit publish-only metadata
 * (notably `store.slug`) because the runtime identifies apps by internal
 * UUID. Registries need a URL-safe public identifier and reject specs
 * without one. Rather than push that requirement back into the create flow
 * and Zod schema, we derive a sensible default at publish time so any spec
 * the local runtime accepts is also publishable.
 *
 * The derivation MUST stay in sync with the server-side fallback in
 * digital-human-protocol/server/internal/spec/spec.go (`DeriveSlug`).
 */

import { pinyin } from 'pinyin-pro'
import type { AppSpec } from '../../apps/spec'

/**
 * CJK Unified Ideographs + common extension ranges.
 * Used to detect characters that should be romanized before slugification.
 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/

/**
 * Convert an arbitrary display name into a registry-safe slug.
 *
 * For names containing CJK characters, Chinese characters are first
 * romanized to pinyin so pure-CJK names like "会议室自动预订数字人"
 * produce a usable slug ("hui-yi-shi-zi-dong-yu-ding-shu-zi-ren")
 * instead of an empty string.
 *
 * Pipeline: pinyin romanization (if CJK detected) → lowercase → runs of
 * non-[a-z0-9] collapsed to a single hyphen → edge hyphens trimmed.
 */
export function deriveSlug(name: string): string {
  let input = name
  if (CJK_RE.test(input)) {
    // Replace CJK runs with their space-separated pinyin, preserving ASCII as-is
    input = input.replace(
      /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g,
      (match) => ` ${pinyin(match, { toneType: 'none', type: 'array' }).join(' ')} `,
    )
  }
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Return a shallow copy of `spec` with publish-only metadata filled in:
 *   - `spec.author` set from `authorOverride` when provided
 *   - `store.slug` forced to scoped `<author>/<id>` format
 *
 * Throws when no usable slug can be derived — surfacing the problem at
 * publish-time with a message the user can act on, instead of letting the
 * registry return a generic 400.
 */
export function enrichSpecForPublish<T extends AppSpec>(spec: T, authorOverride?: string): T {
  const author = authorOverride?.trim() || spec.author?.trim()
  if (!author) {
    throw new Error('Author is required for publishing.')
  }

  const authorSlug = deriveSlug(author)
  if (!authorSlug) {
    throw new Error(
      `Cannot derive a slug from author "${author}" (no ASCII alphanumerics).`
    )
  }

  const existingSlug = spec.store?.slug?.trim()
  let slug: string

  if (existingSlug && existingSlug.includes('/')) {
    // Already scoped — re-scope under the current author
    const id = existingSlug.split('/').slice(1).join('/')
    slug = `${authorSlug}/${id}`
  } else {
    // Flat or missing — derive id from existing slug or spec.name
    const id = existingSlug || deriveSlug(spec.name)
    if (!id) {
      throw new Error(
        `Cannot derive a registry slug from name "${spec.name}" ` +
        `(no ASCII alphanumerics). Set spec.store.slug explicitly.`
      )
    }
    slug = `${authorSlug}/${id}`
  }

  return {
    ...spec,
    author,
    store: { ...(spec.store ?? {}), slug },
  }
}
