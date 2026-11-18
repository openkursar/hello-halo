import type { BlackboardTask, TeamActivity } from '../../../../shared/apps/team-types'
import type { MemberProgress } from './progress'
import { taskTime } from './time'

export type SubtaskGroupId = 'waiting' | 'failed' | 'working' | 'pending' | 'done'
export type SubtaskCell = SubtaskGroupId | 'rejected'

export interface SubtaskGroup {
  id: SubtaskGroupId
  tasks: BlackboardTask[]
}

export interface SubtaskBoard {
  /** Non-empty groups in display order. */
  groups: SubtaskGroup[]
  /** One cell per task, in the order the progress strip draws them. */
  cells: SubtaskCell[]
}

const ORDER: SubtaskGroupId[] = ['waiting', 'failed', 'working', 'pending', 'done']

/**
 * The board's tasks grouped by what they need: an in-progress task takes its
 * assignee's state (a decision for me, a failure); a blocked task cannot go on.
 * `inOrder` keeps every group in the order the work was handed out, for work that
 * passed from one member to the next.
 */
export function subtaskBoard(tasks: readonly BlackboardTask[], members: readonly MemberProgress[], inOrder = false): SubtaskBoard {
  const stateOf = new Map(members.map(member => [member.appId, member]))
  const buckets: Record<SubtaskGroupId, BlackboardTask[]> = { waiting: [], failed: [], working: [], pending: [], done: [] }
  for (const task of tasks) buckets[groupOf(task, task.assigneeAppId ? stateOf.get(task.assigneeAppId) : undefined)].push(task)
  const newest = inOrder ? (a: BlackboardTask, b: BlackboardTask) => a.createdAt - b.createdAt : (a: BlackboardTask, b: BlackboardTask) => b.updatedAt - a.updatedAt
  buckets.waiting.sort(newest)
  buckets.failed.sort(newest)
  buckets.working.sort(newest)
  buckets.done.sort(newest)
  buckets.pending.sort((a, b) => a.createdAt - b.createdAt)
  const cells: SubtaskCell[] = [
    ...(inOrder ? buckets.done : [...buckets.done].reverse()).map(task => (task.status === 'rejected' ? 'rejected' : 'done') as SubtaskCell),
    ...(['waiting', 'failed', 'working', 'pending'] as const).flatMap(id => buckets[id].map(() => id)),
  ]
  return { groups: ORDER.filter(id => buckets[id].length).map(id => ({ id, tasks: buckets[id] })), cells }
}

function groupOf(task: BlackboardTask, member: MemberProgress | undefined): SubtaskGroupId {
  switch (task.status) {
    case 'done':
    case 'rejected': return 'done'
    case 'pending': return 'pending'
    case 'blocked': return 'failed'
    case 'in_progress':
      if (member?.state === 'waiting' && member.decisionId) return 'waiting'
      if (member?.state === 'failed') return 'failed'
      return 'working'
  }
}

export interface SubtaskDuration {
  ms: number
  /** Part of `ms` its assignee spent waiting for an answer it asked for. */
  waited: number
}

/**
 * How long each done task took: from when it was taken up (else posted) to when it
 * was marked done. Waits for answers someone else asked for are left out; the
 * assignee's own count, since they belong to this task.
 */
export function subtaskDurations(tasks: readonly BlackboardTask[], activities: readonly TeamActivity[]): Map<string, SubtaskDuration> {
  const started = new Map<string, number>()
  const finished = new Map<string, number>()
  for (const activity of activities) {
    if (activity.kind !== 'task_update' || !activity.refId) continue
    const at = taskTime(activity.createdAt)
    if (at === null) continue
    if (activity.status === 'in_progress') started.set(activity.refId, Math.min(at, started.get(activity.refId) ?? at))
    else if (activity.status === 'done') finished.set(activity.refId, Math.max(at, finished.get(activity.refId) ?? at))
  }
  const waits = decisionWaitSpans(activities)
  const result = new Map<string, SubtaskDuration>()
  for (const task of tasks) {
    if (task.status !== 'done') continue
    const from = started.get(task.id) ?? task.createdAt
    const to = finished.get(task.id) ?? task.updatedAt
    const within = waits.map(({ appId, span: [start, end] }) => ({ own: appId === task.assigneeAppId, span: [Math.max(start, from), Math.min(end, to)] as [number, number] }))
      .filter(({ span: [start, end] }) => end > start)
    const waited = unionLength(within.filter(row => row.own).map(row => row.span))
    const ms = to - from - (unionLength(within.map(row => row.span)) - waited)
    if (ms > 0) result.set(task.id, { ms, waited })
  }
  return result
}

export interface SubtaskRecord {
  /** The poster's first message to the assignee after posting it, before their next task was posted. */
  brief: TeamActivity | null
  /** Status changes on this task, oldest first. */
  updates: TeamActivity[]
}

export function subtaskRecord(task: BlackboardTask, activities: readonly TeamActivity[]): SubtaskRecord {
  const updates = activities.filter(activity => activity.kind === 'task_update' && activity.refId === task.id)
    .sort((a, b) => (taskTime(a.createdAt) ?? 0) - (taskTime(b.createdAt) ?? 0))
  const posted = taskTime(task.createdAt)
  if (posted === null || !task.assigneeAppId) return { brief: null, updates }
  let nextPost = Infinity
  for (const activity of activities) {
    const at = taskTime(activity.createdAt)
    if (activity.kind === 'task_post' && activity.refId !== task.id && activity.targetAppId === task.assigneeAppId && at !== null && at > posted) nextPost = Math.min(nextPost, at)
  }
  let brief: TeamActivity | null = null
  let briefAt = Infinity
  for (const activity of activities) {
    const at = taskTime(activity.createdAt)
    if (activity.kind !== 'message' || activity.actorAppId !== task.createdByAppId || activity.targetAppId !== task.assigneeAppId || at === null || at < posted || at >= nextPost || at >= briefAt) continue
    brief = activity
    briefAt = at
  }
  return { brief, updates }
}

/**
 * All time spent waiting for answers, overlaps counted once, and whose answers
 * they were, as `ownerOf` names them.
 */
export function decisionWaitTotal(activities: readonly TeamActivity[], ownerOf: (appId: string) => string): { owners: string[]; ms: number } {
  const spans = decisionWaitSpans(activities)
  return { owners: [...new Set(spans.map(row => ownerOf(row.appId)))], ms: unionLength(spans.map(row => row.span)) }
}

export interface AnsweredDecision {
  id: string
  /** Who asked. */
  appId: string
  askedAt: number
  answeredAt: number
  ask: TeamActivity
  answer: TeamActivity
}

/** Each answered decision, earliest asked first. */
export function answeredDecisions(activities: readonly TeamActivity[]): AnsweredDecision[] {
  const asked = new Map<string, { activity: TeamActivity; at: number }>()
  const answered = new Map<string, { activity: TeamActivity; at: number }>()
  for (const activity of activities) {
    if (activity.kind !== 'decision' || !activity.refId) continue
    const at = taskTime(activity.createdAt)
    if (at === null) continue
    if (activity.status === 'escalation') asked.set(activity.refId, { activity, at })
    else if (activity.status === 'ok') answered.set(activity.refId, { activity, at })
  }
  return [...asked].flatMap(([id, ask]) => {
    const reply = answered.get(id)
    return !reply || reply.at <= ask.at ? [] : [{ id, appId: ask.activity.actorAppId, askedAt: ask.at, answeredAt: reply.at, ask: ask.activity, answer: reply.activity }]
  }).sort((a, b) => a.askedAt - b.askedAt)
}

function decisionWaitSpans(activities: readonly TeamActivity[]): { appId: string; span: [number, number] }[] {
  return answeredDecisions(activities).map(row => ({ appId: row.appId, span: [row.askedAt, row.answeredAt] }))
}

export function unionLength(spans: readonly [number, number][]): number {
  let total = 0
  let end = -Infinity
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (to <= end) continue
    total += to - Math.max(from, end)
    end = to
  }
  return total
}
