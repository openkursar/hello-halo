/**
 * Published-artifact ref semantics — the single source of truth for "which refs
 * count as published team artifacts, and who produced them". A ref is published
 * when a finding carries it (explicit team_post_finding) OR a task's resultRef
 * points at it (the assignee delivered it). Both the local artifact reader
 * (runtime/team) and the federation owner-serve gate (runtime/federation)
 * resolve through here, so the two sides of a cross-machine read always agree.
 */

import type { TeamStore } from './types'

type PublishedRefStore = Pick<TeamStore, 'listFindingsByEpoch' | 'listTasksByEpoch'>

/**
 * Resolve the app that produced a published ref: the publishing finding's
 * author, else the assignee of a task delivering it as resultRef. Returns null
 * when the ref is not published in this epoch (→ not servable, not readable).
 */
export function resolvePublishedArtifactAuthor(
  store: PublishedRefStore,
  teamId: string,
  epochId: string,
  ref: string
): string | null {
  const finding = store.listFindingsByEpoch(teamId, epochId).find((f) => f.ref === ref)
  if (finding) return finding.authorAppId
  return store.listTasksByEpoch(teamId, epochId).find((t) => t.resultRef === ref)?.assigneeAppId ?? null
}

/** Whether a ref is a published team artifact of this epoch (see above). */
export function isPublishedArtifactRef(
  store: PublishedRefStore,
  teamId: string,
  epochId: string,
  ref: string
): boolean {
  return resolvePublishedArtifactAuthor(store, teamId, epochId, ref) != null
}
