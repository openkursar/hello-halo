/**
 * Published-artifact ref semantics — the single source of truth for "which refs
 * count as published team artifacts, and who produced them". A ref is published
 * when a finding carries it (explicit team_post_finding) OR a task's resultRef
 * points at it (the assignee delivered it). Both the local artifact reader
 * (runtime/team) and the federation owner-serve gate (runtime/federation)
 * resolve through here, so the two sides of a cross-machine read always agree.
 *
 * A ref names a file relative to its producer's own working directory, so two
 * members can pick the same name for different files, and the only moment the
 * two are still distinguishable is when the second one publishes. Hence the pair
 * below: `findConflictingPublisher` lets the publish gate refuse that moment,
 * and `resolvePublishedArtifact` reports ambiguity rather than guessing for the
 * writes that slip past it (concurrent publishes on two nodes see no conflict
 * until replication catches up).
 */

import type { TeamStore } from './types'

type PublishedRefStore = Pick<TeamStore, 'listFindingsByEpoch' | 'listTasksByEpoch'>

/**
 * Who produced a published ref in this epoch. `ambiguous` carries every claimant
 * so the caller can name them: it must never be collapsed to a "first one wins"
 * pick, which is how a reader silently receives a teammate's unrelated file.
 */
export type PublishedArtifactResolution =
  | { kind: 'unique'; authorAppId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; authorAppIds: string[] }

/**
 * Resolve the app that produced a published ref: the publishing finding's
 * author, and the assignee of a task delivering it as resultRef. One member
 * doing both is still one producer; two different members are ambiguous.
 */
export function resolvePublishedArtifact(
  store: PublishedRefStore,
  teamId: string,
  epochId: string,
  ref: string
): PublishedArtifactResolution {
  const authors = new Set<string>()
  for (const finding of store.listFindingsByEpoch(teamId, epochId)) {
    if (finding.ref === ref) authors.add(finding.authorAppId)
  }
  for (const task of store.listTasksByEpoch(teamId, epochId)) {
    // An unassigned task delivers a ref nobody owns: it anchors to no working
    // directory, so it is not a publication and cannot make one ambiguous.
    if (task.resultRef === ref && task.assigneeAppId) authors.add(task.assigneeAppId)
  }
  if (authors.size === 0) return { kind: 'none' }
  const authorAppIds = Array.from(authors)
  return authorAppIds.length === 1
    ? { kind: 'unique', authorAppId: authorAppIds[0] }
    : { kind: 'ambiguous', authorAppIds }
}

/**
 * Whether a ref is a readable published artifact of this epoch — the owner-serve
 * gate's question. An ambiguous ref is deliberately NOT servable: the owner
 * cannot know which of two identically-named files the asker meant.
 */
export function isPublishedArtifactRef(
  store: PublishedRefStore,
  teamId: string,
  epochId: string,
  ref: string
): boolean {
  return resolvePublishedArtifact(store, teamId, epochId, ref).kind === 'unique'
}

/**
 * The publish gate's question: who else already owns this ref? Null when the ref
 * is free or already the claimant's own (republishing your own file is an
 * update, not a collision).
 *
 * `claimantAppId` is the app that will OWN the ref after the write — the
 * finding's author or the task's assignee, not necessarily the caller: a lead
 * may attach a member's file to that member's task. A null claimant owns
 * nothing, so nothing can collide with it.
 */
export function findConflictingPublisher(
  store: PublishedRefStore,
  teamId: string,
  epochId: string,
  ref: string,
  claimantAppId: string | null
): string | null {
  if (!claimantAppId) return null
  const resolution = resolvePublishedArtifact(store, teamId, epochId, ref)
  if (resolution.kind === 'none') return null
  const authors = resolution.kind === 'unique' ? [resolution.authorAppId] : resolution.authorAppIds
  return authors.find((appId) => appId !== claimantAppId) ?? null
}
