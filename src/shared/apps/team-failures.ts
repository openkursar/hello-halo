import type { TeamActivity, TeamMemberFailure } from './team-types'

/**
 * Sender and intended recipient of a message that did not arrive. A failed
 * fate (`reply`) is filed under the member the message never reached.
 */
export function undeliveredParties(activity: TeamActivity): { senderAppId: string | null; recipientAppId: string | null } | null {
  if (activity.status !== 'undelivered') return null
  return activity.kind === 'reply'
    ? { senderAppId: activity.targetAppId, recipientAppId: activity.actorAppId }
    : { senderAppId: activity.actorAppId, recipientAppId: activity.targetAppId }
}

/** A record whose act did not go through: a message never delivered, or a turn that failed or ran out of time. */
export function isFailedActivity(activity: Pick<TeamActivity, 'status'>): boolean {
  return activity.status === 'undelivered' || activity.status === 'error' || activity.status === 'timeout'
}

function timeOf(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') return 0
  if (typeof value === 'string' && !value.trim()) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

/** The collaboration runtime's lead-in to a failed turn's record; what follows is the engine's error. */
const TURN_FAILED_PREFIX = /^The (?:member|teammate)['’]s turn failed:\s*/

/**
 * Each member's latest failure in one task that nothing has answered since: a
 * message that never reached it, or its own turn that failed. Anything it did
 * afterwards, or it being at work now, means it has moved on. Newest first.
 */
export function openMemberFailures(activities: readonly TeamActivity[], busyAppIds: ReadonlySet<string>): Map<string, TeamMemberFailure> {
  const result = new Map<string, TeamMemberFailure & { at: number }>()
  const lastActed = new Map<string, number>()
  for (const activity of activities) {
    const at = timeOf(activity.createdAt)
    const undelivered = undeliveredParties(activity)
    const failedTurn = activity.kind === 'reply' && (activity.status === 'error' || activity.status === 'timeout')
    if (undelivered?.recipientAppId) {
      const appId = undelivered.recipientAppId
      if (at >= (result.get(appId)?.at ?? -1)) result.set(appId, { appId, activityId: activity.id, senderAppId: undelivered.senderAppId, at })
    } else if (failedTurn) {
      const appId = activity.actorAppId
      if (at >= (result.get(appId)?.at ?? -1)) {
        result.set(appId, { appId, activityId: activity.id, at, ...(activity.status === 'timeout' ? { timedOut: true } : { reason: activity.subject.replace(TURN_FAILED_PREFIX, '').trim() || undefined }) })
      }
    } else {
      lastActed.set(activity.actorAppId, Math.max(at, lastActed.get(activity.actorAppId) ?? -1))
    }
  }
  const open = new Map<string, TeamMemberFailure>()
  for (const [appId, { at, ...failure }] of [...result].sort((a, b) => b[1].at - a[1].at)) {
    if (busyAppIds.has(appId) || (lastActed.get(appId) ?? -1) > at) continue
    open.set(appId, failure)
  }
  return open
}
