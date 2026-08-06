/**
 * Resolving which installed app a listing belongs to.
 *
 * Kept apart from `publish/index.ts`: this is a synchronous read of local
 * install state, while that module reaches the registry over the network.
 * Sharing a file would make importing this query pull the network path in with
 * it — including into its own tests.
 */

import { getAppManager } from '../../apps/manager'
import { enrichSpecForPublish } from './spec-enrich'
import type { InstalledApp } from '../../../shared/apps/app-types'
import type { AppType } from '../../apps/spec'

/**
 * The installed app a publish by `author` would land on `slug`, or null when
 * that app is not uniquely determined.
 *
 * This inverts the slug derivation rather than matching names: every candidate
 * is run through the same `enrichSpecForPublish` publish itself uses, and kept
 * only when it lands on exactly this slug — author scope included, so a listing
 * owned by someone else never resolves to a local app. The answer therefore
 * states a fact about what publishing would do, and cannot drift from the
 * derivation rules.
 *
 * Zero or genuinely rival matches return null. A near-miss must stay silent:
 * the caller surfaces this as a hint next to a listing, and a wrong hint is
 * worse than none.
 */
export function findAppByPublishSlug(slug: string, type?: AppType, author?: string): string | null {
  const manager = getAppManager()
  if (!manager) return null

  const candidates: Array<{ app: InstalledApp; publishes: string }> = []
  for (const app of manager.listApps(type ? { type } : undefined)) {
    if (app.status === 'uninstalled') continue
    try {
      const spec = enrichSpecForPublish(app.spec, author)
      if (spec.store!.slug !== slug) continue
      candidates.push({ app, publishes: canonicalize(spec) })
    } catch {
      // No derivable slug (no author, unslugifiable name) — cannot be this one.
    }
  }

  const rivals = distinctReleases(candidates)
  if (rivals.length > 1) {
    console.warn(
      `[publish/find-app] ${rivals.length} installed apps derive slug "${slug}" ` +
      `(${rivals.map(a => a.id).join(', ')}) — reporting none`
    )
    return null
  }
  return rivals[0]?.id ?? null
}

/**
 * Collapse candidates that would publish the very same release.
 *
 * An app can be installed globally and again inside a space — installs are
 * unique per spec *and scope* — and both would produce a byte-identical
 * listing. Counting them as rivals suppresses the hint over a choice the user
 * does not actually have. Anything that would publish differently stays a
 * rival, so a genuine ambiguity still silences the lookup.
 *
 * The global install speaks for its group, being the one shared across spaces.
 */
function distinctReleases(candidates: Array<{ app: InstalledApp; publishes: string }>): InstalledApp[] {
  const byRelease = new Map<string, InstalledApp>()
  for (const { app, publishes } of candidates) {
    const held = byRelease.get(publishes)
    if (!held || (held.spaceId !== null && app.spaceId === null)) {
      byRelease.set(publishes, app)
    }
  }
  return [...byRelease.values()]
}

/**
 * Serialize independently of key order, so two specs assembled by different
 * routes still compare equal when their content matches.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    .join(',')}}`
}
