import type { RosterMember, TeamActivity, TeamConversation, TeamDetail, TeamPendingEscalation } from '../../../../shared/apps/team-types'

/** One task-level state shared by every list, card and filter on the team detail page. */
export type TaskStateKey = 'waiting_user' | 'error' | 'waiting_member' | 'running' | 'idle' | 'done'

/** The single fact a task row shows under its title, chosen in the same order as the state. */
export type TaskFact =
  | { kind: 'decision'; memberName?: string; question?: string }
  | { kind: 'error'; memberName?: string; subject?: string }
  | { kind: 'waiting'; memberName?: string; owner?: string }
  | { kind: 'working'; memberName: string; label?: string }
  | { kind: 'summary'; text: string }
  | { kind: 'none' }

export interface TaskState {
  key: TaskStateKey
  fact: TaskFact
  priority: number
}

const PRIORITY: Record<TaskStateKey, number> = { waiting_user: 0, error: 1, waiting_member: 2, running: 3, idle: 4, done: 5 }
const FAILURES = new Set(['error', 'timeout', 'undelivered'])

/** Decisions on this machine waiting for the user, oldest first. */
export function taskDecisions(detail: TeamDetail, epochId: string): TeamPendingEscalation[] {
  return (detail.pendingEscalations ?? [])
    .filter(item => item.epochId === epochId)
    .sort((a, b) => (a.entry?.ts ?? 0) - (b.entry?.ts ?? 0))
}

function state(key: TaskStateKey, fact: TaskFact): TaskState {
  return { key, fact, priority: PRIORITY[key] }
}

/** A failure counts only while it is the actor's latest act in the task; a later act means it recovered. */
export function openFailure(activities: readonly TeamActivity[], epochId: string): TeamActivity | null {
  const latest = new Map<string, TeamActivity>()
  for (const activity of activities) {
    if (activity.epochId !== epochId) continue
    const current = latest.get(activity.actorAppId)
    if (!current || activity.createdAt >= current.createdAt) latest.set(activity.actorAppId, activity)
  }
  let failure: TeamActivity | null = null
  for (const activity of latest.values()) {
    if (FAILURES.has(activity.status ?? '') && (!failure || activity.createdAt > failure.createdAt)) failure = activity
  }
  return failure
}

function busyOn(member: RosterMember, epochId: string) {
  return member.busy?.find(row => row.epochId === epochId)
}

export function taskState(detail: TeamDetail, task: TeamConversation): TaskState {
  const decision = taskDecisions(detail, task.epochId)[0]
  if (decision || task.waitingForMe) return state('waiting_user', { kind: 'decision', memberName: decision?.memberName, question: decision?.question })

  const finished = !!task.completed || task.finishedAt !== undefined
  if (finished) return state('done', task.summary ? { kind: 'summary', text: task.summary } : { kind: 'none' })

  const failedMember = detail.roster.find(member => member.status === 'error' && busyOn(member, task.epochId))
  if (failedMember) return state('error', { kind: 'error', memberName: failedMember.memberName })
  if (!task.active) {
    const failure = openFailure(detail.activities ?? [], task.epochId)
    if (failure) {
      const actor = detail.roster.find(member => member.appId === failure.actorAppId)
      return state('error', { kind: 'error', memberName: actor?.memberName, subject: failure.subject || undefined })
    }
  }

  const waitingId = task.waitingMemberAppIds?.[0]
  if (waitingId) {
    const member = detail.roster.find(item => item.appId === waitingId)
    return state('waiting_member', { kind: 'waiting', memberName: member?.memberName, owner: member?.sameMachine === false ? member.owner ?? undefined : undefined })
  }

  const worker = detail.roster.find(member => busyOn(member, task.epochId))
  if (worker) return state('running', { kind: 'working', memberName: worker.memberName, label: busyOn(worker, task.epochId)?.label || undefined })
  const fact: TaskFact = task.summary ? { kind: 'summary', text: task.summary } : { kind: 'none' }
  if (task.active) return state('running', fact)
  const subtasks = task.subtasks
  if (subtasks && subtasks.done > 0 && !subtasks.open) return state('done', fact)
  return state('idle', fact)
}

/**
 * Work the team took on, as opposed to a question the lead simply answered:
 * it was split, shared with members, produced files, or started by a trigger.
 */
export function isTeamWork(task: TeamConversation): boolean {
  return task.kind === 'run' || task.kind === 'collab' || !!task.subtasks || !!task.teamwork || !!task.artifactCount
}

/** Asks for the user wherever the conversation is filed. */
export function needsUser(key: TaskStateKey): boolean {
  return key === 'waiting_user' || key === 'error'
}

/** Open and not left idle: moving, or held up on a question or a failure. */
export function isLive(key: TaskStateKey): boolean {
  return key !== 'done' && key !== 'idle'
}

/** Moving: someone is on it, or it is held up on a member. */
export function isMoving(key: TaskStateKey): boolean {
  return key === 'running' || key === 'waiting_member'
}

export function liveTaskCount(detail: TeamDetail, tasks: readonly TeamConversation[]): number {
  return tasks.filter(task => isTeamWork(task) && isMoving(taskState(detail, task).key)).length
}

/** The 1st at 00:00 local time: where "this month" begins for finished work. */
export function startOfMonth(): number {
  const date = new Date()
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

/** Team work finished since the month began, as the list groups it. */
export function doneThisMonth(detail: TeamDetail, tasks: readonly TeamConversation[]): TeamConversation[] {
  const monthStart = startOfMonth()
  return tasks.filter(task => isTeamWork(task) && taskState(detail, task).key === 'done' && (task.finishedAt ?? task.lastActivityAt) >= monthStart)
}

/** Tasks most in need of attention first, then most recent. */
export function sortByState(detail: TeamDetail, tasks: readonly TeamConversation[]): TeamConversation[] {
  const priority = new Map(tasks.map(task => [task.epochId, taskState(detail, task).priority]))
  return [...tasks].sort((a, b) => priority.get(a.epochId)! - priority.get(b.epochId)! || b.lastActivityAt - a.lastActivityAt)
}

export type MemberStateKey = 'error' | 'waiting_user' | 'working' | 'idle' | 'offline'

const MEMBER_PRIORITY: Record<MemberStateKey, number> = { error: 0, waiting_user: 1, working: 2, idle: 3, offline: 4 }

export function memberState(detail: TeamDetail, member: RosterMember): MemberStateKey {
  if (member.presence === 'offline') return 'offline'
  if (member.status === 'error') return 'error'
  if (member.status === 'waiting_user' || (detail.pendingEscalations ?? []).some(item => item.appId === member.appId)) return 'waiting_user'
  if (member.status === 'working' || member.busy?.length) return 'working'
  return 'idle'
}

export function memberPriority(key: MemberStateKey): number {
  return MEMBER_PRIORITY[key]
}

/** Every task a member has a hand in, most in need of attention first. */
export function memberTasks(detail: TeamDetail, tasks: readonly TeamConversation[], member: RosterMember): TeamConversation[] {
  const ids = new Set<string>()
  for (const row of member.busy ?? []) if (row.epochId) ids.add(row.epochId)
  for (const item of detail.pendingEscalations ?? []) if (item.appId === member.appId && item.epochId) ids.add(item.epochId)
  for (const activity of detail.activities ?? []) if (activity.actorAppId === member.appId && activity.epochId) ids.add(activity.epochId)
  const related = tasks.filter(task => (ids.has(task.epochId) || task.memberAppId === member.appId || task.waitingMemberAppIds?.includes(member.appId))
    && (isTeamWork(task) || needsUser(taskState(detail, task).key)))
  return sortByState(detail, related)
}
