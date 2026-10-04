/**
 * Compare scopes: how a tab stores them, the git scope they resolve to, and
 * the label the user sees (also the label references and reviews carry).
 */

import type { GitCompareScope, GitReviewRecord } from '../../../../../../shared/types/git'
import type { StoredCompareScope } from '../../../../../types/changes-view'

export type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * The scope to load. "Since last review" needs the latest review's snapshot;
 * without a review there is nothing to compare from, so it falls back to
 * uncommitted changes.
 */
export function resolveScope(stored: StoredCompareScope, review: GitReviewRecord | null): GitCompareScope {
  switch (stored.kind) {
    case 'since-review':
      return review ? { kind: 'since-review', snapshot: review.snapshot } : { kind: 'uncommitted' }
    case 'revision':
      return { kind: 'revision', revision: stored.revision, mergeBase: stored.mergeBase }
    default:
      return { kind: stored.kind }
  }
}

export function storedScopeOf(scope: GitCompareScope): StoredCompareScope {
  if (scope.kind === 'since-review') return { kind: 'since-review' }
  return scope
}

/** Short name for a revision: a commit id is cut to seven characters, branch and tag names kept. */
export function revisionName(revision: string): string {
  return /^[0-9a-f]{12,64}$/i.test(revision) ? revision.slice(0, 7) : revision
}

export function scopeLabel(scope: StoredCompareScope | GitCompareScope, t: Translate): string {
  switch (scope.kind) {
    case 'uncommitted': return t('Uncommitted changes')
    case 'staged': return t('Staged changes')
    case 'since-review': return t('Since last review')
    case 'revision': return t('Compared with {{revision}}', { revision: revisionName(scope.revision) })
  }
}

/** The scope's name on its picker button, where the full label does not fit. */
export function scopeShortLabel(scope: StoredCompareScope | GitCompareScope, t: Translate): string {
  switch (scope.kind) {
    case 'uncommitted': return t('Uncommitted')
    case 'staged': return t('Staged')
    case 'since-review': return t('Since review')
    case 'revision': return revisionName(scope.revision)
  }
}

/** Identity of a scope, for caches keyed by what was compared. */
export function scopeKey(scope: GitCompareScope): string {
  switch (scope.kind) {
    case 'since-review': return `since-review:${scope.snapshot}`
    case 'revision': return `revision:${scope.mergeBase ? 'base' : 'tip'}:${scope.revision}`
    default: return scope.kind
  }
}

export function sameStoredScope(a: StoredCompareScope, b: StoredCompareScope): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'revision' && b.kind === 'revision') return a.revision === b.revision && a.mergeBase === b.mergeBase
  return true
}
