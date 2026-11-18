import { taskTime } from './time'
import { undeliveredParties } from './model'
import type { BlackboardTask, RosterMember, TaskStatus, TeamActivity } from '../../../../shared/apps/team-types'

export type MemberProgressState = 'waiting' | 'failed' | 'working' | 'done' | 'idle'

export interface MemberProgress {
  appId: string
  state: MemberProgressState
  /** The board task this state is about, when there is one. */
  taskTitle?: string
  /** Waiting: the decision the user can answer here; absent when only its owner can. */
  decisionId?: string
  question?: string
  /** Failed: the record that tells it. */
  activityId?: string
  /** Failed: whose message never arrived; absent when the member's own turn failed. */
  senderAppId?: string | null
  /** Failed own turn: why, as the engine reported it. */
  reason?: string
  timedOut?: boolean
}

export interface TaskProgress {
  /** Attention first, then work in flight, then everyone else in roster order. */
  members: MemberProgress[]
  /** Board tasks by status, in the order the bar draws them. */
  counts: Record<TaskStatus, number>
  total: number
  /** Ended as done, or every subtask settled with nobody still at work or waiting. */
  finished: boolean
}

export interface TaskProgressInput {
  epochId: string
  roster: readonly RosterMember[]
  leadAppId: string | null
  activities: readonly TeamActivity[]
  tasks: readonly BlackboardTask[]
  /** Unanswered decisions this user can answer. */
  decisions: readonly { id: string; appId: string; question: string }[]
  /** Members whose owners owe a decision in this conversation, this user's or not. */
  waitingAppIds: readonly string[]
  participants: ReadonlySet<string>
  /** Closed, or ended as done. */
  completed: boolean
}

export type ProgressSummary =
  | { kind: 'waiting' | 'failed' | 'decision' | 'working'; count: number }
  | { kind: 'done' | 'idle' }

const RANK: Record<MemberProgressState, number> = { waiting: 0, failed: 0, working: 1, done: 2, idle: 2 }

/** Who on the team is doing what in one conversation, as the conversation bar tells it. */
export function taskProgress(input: TaskProgressInput): TaskProgress {
  const busy = new Set(input.roster.filter(member => member.busy?.some(row => row.epochId === input.epochId)).map(member => member.appId))
  const failures = latestFailures(input.activities, busy)
  const waiting = new Set(input.waitingAppIds)
  const members = input.roster
    .filter(member => input.participants.has(member.appId) || member.appId === input.leadAppId)
    .map((member): MemberProgress => {
      const assigned = input.tasks.filter(row => row.assigneeAppId === member.appId).sort((a, b) => b.updatedAt - a.updatedAt)
      const decision = input.decisions.find(row => row.appId === member.appId)
      if (decision) return { appId: member.appId, state: 'waiting', decisionId: decision.id, question: decision.question }
      if (waiting.has(member.appId)) return { appId: member.appId, state: 'waiting' }
      const failure = failures.get(member.appId)
      if (failure) return { appId: member.appId, state: 'failed', ...failure }
      if (busy.has(member.appId)) return { appId: member.appId, state: 'working', taskTitle: assigned.find(row => row.status === 'in_progress')?.title }
      const open = assigned.find(row => row.status === 'pending' || row.status === 'in_progress' || row.status === 'blocked')
      if (open) return { appId: member.appId, state: 'idle', taskTitle: open.title }
      if (assigned.length || input.completed) return { appId: member.appId, state: 'done', taskTitle: assigned[0]?.title }
      return { appId: member.appId, state: 'idle' }
    })
  const counts: Record<TaskStatus, number> = { done: 0, in_progress: 0, blocked: 0, pending: 0, rejected: 0 }
  for (const row of input.tasks) counts[row.status]++
  const settled = counts.done > 0 && counts.done + counts.rejected === input.tasks.length
    && members.every(row => row.state === 'done' || row.state === 'idle')
  return {
    members: members.map((row, index) => ({ row, index })).sort((a, b) => RANK[a.row.state] - RANK[b.row.state] || a.index - b.index).map(({ row }) => row),
    counts,
    total: input.tasks.length,
    finished: input.completed || settled,
  }
}

/**
 * The most pressing state as a count, never names or task text, so the line always
 * reads in full. The lead's own work already shows in the stream.
 */
export function progressSummary(progress: TaskProgress, leadAppId: string | null): ProgressSummary {
  const count = (test: (row: MemberProgress) => boolean) => progress.members.filter(test).length
  const answerable = count(row => row.state === 'waiting' && !!row.decisionId)
  if (answerable) return { kind: 'waiting', count: answerable }
  const failed = count(row => row.state === 'failed')
  if (failed) return { kind: 'failed', count: failed }
  const decision = count(row => row.state === 'waiting')
  if (decision) return { kind: 'decision', count: decision }
  const working = count(row => row.state === 'working' && row.appId !== leadAppId)
  if (working) return { kind: 'working', count: working }
  return { kind: progress.finished ? 'done' : 'idle' }
}

export type FailureCause = 'model' | 'account' | 'quota' | 'service' | 'network' | 'timeout'

const CAUSES: readonly [Exclude<FailureCause, 'timeout'>, RegExp][] = [
  ['model', /model.{0,40}(not.?found|not exist|deprecated|retired|invalid|unsupported|not supported)|service id|model_not_found|unknown model|no such model/i],
  ['account', /\b(401|403)\b|authenticat|unauthori[sz]ed|invalid.{0,12}(api.?key|token)|permission denied/i],
  ['quota', /\b429\b|rate.?limit|quota|insufficient|billing|balance|credit/i],
  ['service', /\b(500|502|503|504|529)\b|overloaded|service unavailable/i],
  ['network', /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network/i],
]

/** What kind of trouble a member's own failed turn ran into; null when the error says nothing recognisable. */
export function failureCause(row: Pick<MemberProgress, 'reason' | 'timedOut'>): FailureCause | null {
  if (row.timedOut) return 'timeout'
  if (!row.reason) return null
  return CAUSES.find(([, pattern]) => pattern.test(row.reason!))?.[0] ?? null
}

/** Causes only the member's model settings can fix, so they fall to whoever owns it. */
export function isSettingsCause(cause: FailureCause | null): boolean {
  return cause === 'model' || cause === 'account' || cause === 'quota'
}

type FailureRecord = Pick<MemberProgress, 'senderAppId' | 'reason' | 'timedOut'> & { activityId: string }

/** The collaboration runtime's lead-in to a failed turn's record; what follows is the engine's error. */
const TURN_FAILED_PREFIX = /^The (?:member|teammate)['’]s turn failed:\s*/

/**
 * Each member's latest failure that nothing has answered since: a message that
 * never reached it, or its own turn that failed. Anything it did afterwards, or
 * it being at work now, means it has moved on.
 */
function latestFailures(activities: readonly TeamActivity[], busy: ReadonlySet<string>) {
  const result = new Map<string, FailureRecord & { at: number }>()
  const lastActed = new Map<string, number>()
  for (const activity of activities) {
    const at = taskTime(activity.createdAt) ?? 0
    const undelivered = undeliveredParties(activity)
    const failedTurn = activity.kind === 'reply' && (activity.status === 'error' || activity.status === 'timeout')
    if (undelivered?.recipientAppId) {
      if (at >= (result.get(undelivered.recipientAppId)?.at ?? -1)) result.set(undelivered.recipientAppId, { activityId: activity.id, senderAppId: undelivered.senderAppId, at })
    } else if (failedTurn) {
      if (at >= (result.get(activity.actorAppId)?.at ?? -1)) {
        result.set(activity.actorAppId, { activityId: activity.id, at, ...(activity.status === 'timeout' ? { timedOut: true } : { reason: activity.subject.replace(TURN_FAILED_PREFIX, '').trim() || undefined }) })
      }
    } else {
      lastActed.set(activity.actorAppId, Math.max(at, lastActed.get(activity.actorAppId) ?? -1))
    }
  }
  const open = new Map<string, FailureRecord>()
  for (const [appId, { at, ...failure }] of result) {
    if (busy.has(appId) || (lastActed.get(appId) ?? -1) > at) continue
    open.set(appId, failure)
  }
  return open
}
