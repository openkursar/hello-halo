import type { BlackboardFinding, TeamActivity } from '../../../../shared/apps/team-types'
import type { ArtifactEntry } from '../TeamArtifacts'
import { compareTaskTimes, taskTime } from './time'

export interface TaskOutput { entry: ArtifactEntry; at: number | null }

/** Each member's latest act in a task. */
export function latestActs(activities: readonly TeamActivity[]): Map<string, TeamActivity> {
  const result = new Map<string, TeamActivity>()
  for (const activity of activities) {
    // A failed turn shows through the member's state while it lasts; it is not what the member last did.
    if (activity.kind === 'reply' && (activity.status === 'error' || activity.status === 'timeout')) continue
    const current = result.get(activity.actorAppId)
    if (!current || (taskTime(activity.createdAt) ?? 0) >= (taskTime(current.createdAt) ?? 0)) result.set(activity.actorAppId, activity)
  }
  return result
}

/** Outputs newest first, dated by when they were shared on the board; undated ones keep their order at the end. */
export function newestOutputs(list: readonly ArtifactEntry[], findings: readonly BlackboardFinding[]): TaskOutput[] {
  const sharedAt = new Map<string, number>()
  for (const finding of findings) {
    const at = taskTime(finding.createdAt)
    if (!finding.ref || at === null) continue
    for (const key of [finding.ref, baseName(finding.ref)]) sharedAt.set(key, Math.max(at, sharedAt.get(key) ?? at))
  }
  return list
    .map(entry => ({ entry, at: sharedAt.get(entry.ref) ?? sharedAt.get(entry.name) ?? null }))
    .sort((a, b) => compareTaskTimes(a.at, b.at, true))
}

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}
