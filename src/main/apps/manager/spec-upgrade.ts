/**
 * apps/manager -- Merging an author's new version into an installed digital human
 *
 * An upgrade replaces the author's part of a digital human, never the user's.
 * Whose part a field is gets read against the author's original — the spec as
 * the author last shipped it, recorded at install and at every upgrade: a field
 * still equal to the original was never edited and takes the new version; any
 * other field is the user's and stays. Run triggers are compared one by one, so
 * an edit to one schedule neither holds back a trigger the author adds nor
 * brings back the one it replaced. Values are never merged inside a field.
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
 * Which trigger of `other` each trigger of `base` became (index to index).
 *
 * Triggers with an id are the same trigger when their ids match. Id-less ones,
 * the way authors usually write them, are paired first by identical content,
 * so a trigger inserted or removed elsewhere cannot shift the rest; what is
 * left is paired in order as the same trigger edited. A trigger still unpaired
 * was added (in `other`) or removed (from `base`).
 */
function pairTriggers(base: SubscriptionDef[], other: SubscriptionDef[]): Map<number, number> {
  const pairs = new Map<number, number>()
  const taken = new Set<number>()
  const pair = (i: number, j: number): void => {
    pairs.set(i, j)
    taken.add(j)
  }

  base.forEach((sub, i) => {
    if (sub.id === undefined) return
    const j = other.findIndex(candidate => candidate.id === sub.id)
    if (j !== -1) pair(i, j)
  })

  const unnamed = base.flatMap((sub, i) => (sub.id === undefined ? [i] : []))
  const free = (): number[] => other.flatMap((sub, j) => (sub.id === undefined && !taken.has(j) ? [j] : []))
  for (const i of unnamed) {
    const j = free().find(candidate => sameValue(base[i], other[candidate]))
    if (j !== undefined) pair(i, j)
  }
  const rest = free()
  unnamed.filter(i => !pairs.has(i)).forEach((i, k) => {
    if (k < rest.length) pair(i, rest[k])
  })
  return pairs
}

function invert(pairs: Map<number, number>): Map<number, number> {
  return new Map([...pairs].map(([from, to]) => [to, from]))
}

/**
 * Each trigger of the original follows the user's side first: edited stays
 * edited, deleted stays deleted, untouched follows the author (including the
 * author removing it). Triggers new on either side are added, in the author's
 * order, with the user's own after them.
 */
function mergeSubscriptions(
  current: SubscriptionDef[] | undefined,
  original: SubscriptionDef[] | undefined,
  next: SubscriptionDef[] | undefined,
): SubscriptionDef[] | undefined {
  const mine = current ?? []
  const base = original ?? []
  const theirs = next ?? []
  const toMine = pairTriggers(base, mine)
  const toTheirs = pairTriggers(base, theirs)
  const fromMine = invert(toMine)
  const fromTheirs = invert(toTheirs)

  // A trigger both sides added independently is one trigger, not two: the
  // same id, or for id-less ones the same content.
  const addedByUser = mine.flatMap((_, m) => (fromMine.has(m) ? [] : [m]))
  const addedByBoth = new Map<number, number>()
  theirs.forEach((sub, t) => {
    if (fromTheirs.has(t)) return
    const m = addedByUser.find(candidate => ![...addedByBoth.values()].includes(candidate)
      && (sub.id !== undefined ? mine[candidate].id === sub.id : sameValue(mine[candidate], sub)))
    if (m !== undefined) addedByBoth.set(t, m)
  })

  const merged: SubscriptionDef[] = []
  const placed = new Set<number>()
  theirs.forEach((sub, t) => {
    const b = fromTheirs.get(t)
    const m = b === undefined ? addedByBoth.get(t) : toMine.get(b)
    if (m === undefined) {
      // New from the author; or, paired with the original, deleted by the user.
      if (b === undefined) merged.push(sub)
      return
    }
    placed.add(m)
    merged.push(b !== undefined && sameValue(mine[m], base[b]) ? sub : mine[m])
  })
  mine.forEach((own, m) => {
    if (placed.has(m)) return
    const b = fromMine.get(m)
    // Removed by the author and never edited: it goes with the author's version.
    if (b !== undefined && sameValue(own, base[b])) return
    merged.push(own)
  })

  return sameValue(merged, theirs) ? next : merged
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
