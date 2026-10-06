/**
 * apps/manager -- Merging an author's new version into an installed digital human
 *
 * An upgrade replaces the author's part of a digital human, never the user's.
 * Whose part a field is gets read against the author's original — the spec as
 * the author last shipped it, recorded at install and at every upgrade: a field
 * still equal to the original was never edited and takes the new version; any
 * other field is the user's and stays. Run triggers are compared one by one, so
 * an edit to one schedule does not hold back a trigger the author adds. Values
 * are never merged inside a field.
 *
 * Pure: the caller validates the result and persists it.
 */

import type { AutomationSpec, SubscriptionDef } from '../spec'

/** These describe the release, not the digital human's behaviour, so they always follow the author. */
const RELEASE_FIELDS: ReadonlySet<string> = new Set(['type', 'spec_version', 'version', 'author', 'store'])

export interface AuthorUpgradeMerge {
  /** The merged spec, not yet validated. */
  spec: Record<string, unknown>
  /** Fields left different from the author's new version because the user's value was kept. */
  kept: string[]
}

/**
 * Merge the author's new version into the current spec.
 *
 * Without an original there is no telling which differences are the user's, so
 * every one is presumed to be: nothing is overwritten, and the caller must
 * present the kept fields as undetermined rather than as the user's edits.
 */
export function mergeAuthorUpgrade(
  current: AutomationSpec,
  original: AutomationSpec | null,
  next: AutomationSpec,
): AuthorUpgradeMerge {
  const base = original ?? next
  const mine = current as unknown as Record<string, unknown>
  const was = base as unknown as Record<string, unknown>
  const theirs = next as unknown as Record<string, unknown>
  const spec: Record<string, unknown> = {}
  const kept: string[] = []

  for (const key of new Set([...Object.keys(mine), ...Object.keys(was), ...Object.keys(theirs)])) {
    let value: unknown
    if (RELEASE_FIELDS.has(key)) {
      value = theirs[key]
    } else if (key === 'subscriptions') {
      value = mergeSubscriptions(current.subscriptions, base.subscriptions, next.subscriptions)
    } else {
      value = sameValue(mine[key], was[key]) ? theirs[key] : mine[key]
    }
    if (value !== undefined) spec[key] = value
    if (!sameValue(value, theirs[key])) kept.push(key)
  }

  return { spec, kept }
}

/**
 * A trigger is identified the way the scheduler keys its job: by id, else by
 * position — so an id-less trigger is matched by where it sits in the list.
 */
function keyed(subscriptions: SubscriptionDef[] | undefined): Map<string, SubscriptionDef> {
  return new Map((subscriptions ?? []).map((sub, index) => [sub.id ?? String(index), sub]))
}

function mergeSubscriptions(
  current: SubscriptionDef[] | undefined,
  original: SubscriptionDef[] | undefined,
  next: SubscriptionDef[] | undefined,
): SubscriptionDef[] | undefined {
  const mine = keyed(current)
  const base = keyed(original)
  const merged: SubscriptionDef[] = []
  const placed = new Set<string>()

  for (const [key, sub] of keyed(next)) {
    const own = mine.get(key)
    const was = base.get(key)
    if (!was) {
      // New from the author — unless the user already gave a trigger this id,
      // which makes it theirs.
      if (own?.id === key) continue
      merged.push(sub)
      if (own && sameValue(own, sub)) placed.add(key)
      continue
    }
    // Deleted by the user: it stays deleted.
    if (!own) continue
    merged.push(sameValue(own, was) ? sub : own)
    placed.add(key)
  }

  for (const [key, own] of mine) {
    if (placed.has(key)) continue
    const was = base.get(key)
    // Removed by the author and never edited: it goes with the author's version.
    if (was && sameValue(own, was)) continue
    merged.push(own)
  }

  return sameValue(merged, next ?? []) ? next : merged
}

/** Structural equality over JSON values; a missing key equals an undefined one. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((item, index) => sameValue(item, b[index]))
  }
  if (isRecord(a) && isRecord(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!sameValue(a[key], b[key])) return false
    }
    return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
