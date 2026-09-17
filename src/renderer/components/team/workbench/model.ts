import { compareTaskTimes, taskTime } from './time'
import type { Message, Thought } from '../../../types'
import type { ActivityEntry } from '../../../../shared/apps/app-types'
import type { TeamActivity, TeamConversation } from '../../../../shared/apps/team-types'

export type TaskGroup = 'attention' | 'involved' | 'mine' | 'other' | 'reception' | 'automatic'
export const taskGroups: TaskGroup[] = ['attention', 'mine', 'involved', 'other', 'reception', 'automatic']

export function taskGroup(task: TeamConversation): TaskGroup {
  if (task.waitingForMe) return 'attention'
  if (task.kind === 'im') return 'reception'
  if (task.kind === 'run') return 'automatic'
  if (task.createdByMe) return 'mine'
  if (task.involvedMe) return 'involved'
  return 'other'
}

export function visibleTasks(tasks: TeamConversation[]): TeamConversation[] {
  return tasks.filter(task => task.kind !== 'member').sort((a, b) => compareTaskTimes(a.lastActivityAt, b.lastActivityAt, true) || a.epochId.localeCompare(b.epochId))
}

export function activityLevel(activity: TeamActivity): 'attention' | 'result' | 'process' | 'message' {
  if (['undelivered', 'timeout', 'error', 'escalation'].includes(activity.status ?? '')) return 'attention'
  if (activity.kind === 'message' || activity.kind === 'reply') return 'process'
  if (activity.kind === 'decision' || activity.kind === 'finding' || activity.kind === 'run_end' || activity.status === 'done') return 'result'
  return 'process'
}

export interface TaskMemberReport {
  appId: string
  message: Message
}

export function executionTurns(messages: Message[]): { id: string; input?: Message; outputs: Message[] }[] {
  const turns: { id: string; input?: Message; outputs: Message[] }[] = []
  for (const message of messages) {
    if (message.role === 'user') turns.push({ id: message.id, input: message, outputs: [] })
    else if (message.role === 'assistant') {
      const current = turns[turns.length - 1]
      if (current) current.outputs.push(message)
      else turns.push({ id: message.id, outputs: [message] })
    }
  }
  return turns.reverse()
}

export interface TaskActivityRow {
  id: string
  at: number | null
  message?: Message
  appId?: string
  activities?: TeamActivity[]
  notifications?: TaskMemberReport[]
}

export function taskActivityRows(reports: TaskMemberReport[], activities: TeamActivity[]): TaskActivityRow[] {
  const rows: TaskActivityRow[] = reports.map(({ appId, message }) => ({
    id: `message:${appId}:${message.id}`, at: taskTime(message.timestamp), appId,
    ...(isSystemNotification(message) ? { notifications: [{ appId, message }] } : { message }),
  }))
  rows.push(...activities.map(activity => ({ id: activity.id, at: taskTime(activity.createdAt), activities: [activity] })))
  rows.sort((a, b) => compareTaskTimes(a.at, b.at) || a.id.localeCompare(b.id))
  const grouped: TaskActivityRow[] = []
  for (const row of rows) {
    const previous = grouped[grouped.length - 1]
    const act = row.activities?.[0]
    const last = previous?.activities?.[previous.activities.length - 1]
    const notification = row.notifications?.[0]
    const lastNotification = previous?.notifications?.[previous.notifications.length - 1]
    const lastNotificationAt = taskTime(lastNotification?.message.timestamp)
    if (notification && lastNotification && previous.notifications!.length < 20 && notification.appId === lastNotification.appId && row.at !== null && lastNotificationAt !== null && row.at - lastNotificationAt < 300000) previous.notifications!.push(notification)
    else if (act && last && previous.activities!.length < 20 && act.kind === last.kind && activityLevel(act) === 'process' && activityLevel(last) === 'process' && row.at !== null && taskTime(last.createdAt) !== null && row.at - taskTime(last.createdAt)! < 300000) previous.activities!.push(act)
    else grouped.push(row)
  }
  return grouped.map(row => ({
    ...row,
    at: row.notifications?.length ? taskTime(row.notifications[row.notifications.length - 1].message.timestamp)
      : row.activities?.length ? taskTime(row.activities[row.activities.length - 1].createdAt) : row.at,
  })).sort((a, b) => compareTaskTimes(a.at, b.at, true) || a.id.localeCompare(b.id))
}

export function isTeamBackgroundTurn(messages: Message[]): boolean {
  return !messages.some(isHumanInput)
}

function isHumanInput(message: Message): boolean {
  return message.role === 'user' && (!message.metadata?.teamTriggerKind || message.metadata.teamTriggerKind === 'human_message')
}

function isSystemNotification(message: Message): boolean {
  return message.role === 'user' && ['member_stopped', 'periodic_check', 'run_start'].includes(message.metadata?.teamTriggerKind ?? '')
}

export function conversationMessages(messages: Message[]): Message[] {
  let humanConversation = false
  return messages.filter(message => {
    if (isHumanInput(message)) {
      humanConversation = true
      return true
    }
    // A teammate can resume the work without changing who the conversation serves.
    return humanConversation && message.role === 'assistant'
  })
}

export function taskReportMessages(messages: Message[]): Message[] {
  const conversation = new Set(conversationMessages(messages))
  return messages.filter(message => (message.content.trim() || message.error) &&
    (isSystemNotification(message) || (message.role === 'assistant' && !conversation.has(message))))
}

export type ConversationRow =
  | { id: string; message: Message; activities?: never; decision?: never; sharedDecision?: never }
  | { id: string; activities: TeamActivity[]; message?: never; decision?: never; sharedDecision?: never }
  | { id: string; decision: ActivityEntry; message?: never; activities?: never; sharedDecision?: never }
  | { id: string; sharedDecision: SharedTaskDecision; message?: never; activities?: never; decision?: never }

export interface SharedTaskDecision {
  refId: string
  appId: string
  question: string
  requestedAt: number
  answer?: string
  answeredAt?: number
}

export const COLLABORATION_PREVIEW_LIMIT = 3

export function decisionMessageId(decision: ActivityEntry, messages: Message[]): string | undefined {
  return conversationMessages(messages).find(message => message.role === 'assistant' &&
    decisionHasReceipt(decision, message.thoughts ?? []))?.id
}

export function decisionHasReceipt(decision: ActivityEntry, thoughts: Thought[]): boolean {
  return thoughts.some(thought =>
    (thought.toolResult?.output ?? thought.toolOutput ?? (thought.type === 'tool_result' ? thought.content : '')).includes(decision.id))
}

export function sharedTaskDecisions(activities: TeamActivity[], epochId: string | null, appId?: string, localDecisionIds: Set<string> = new Set()): SharedTaskDecision[] {
  if (!epochId || !appId) return []
  const paired = new Map<string, { request?: TeamActivity; answer?: TeamActivity }>()
  for (const activity of activities) {
    if (activity.epochId !== epochId || activity.kind !== 'decision' || activity.actorAppId !== appId || !activity.refId || localDecisionIds.has(activity.refId)) continue
    const pair = paired.get(activity.refId) ?? {}
    if (activity.status === 'escalation') pair.request = activity
    else if (activity.status === 'ok') pair.answer = activity
    paired.set(activity.refId, pair)
  }
  return [...paired.entries()].flatMap(([refId, pair]) => {
    const source = pair.request ?? pair.answer
    if (!source) return []
    return [{
      refId,
      appId,
      question: pair.request?.body?.trim() || source.subject.trim(),
      requestedAt: pair.request?.createdAt ?? source.createdAt,
      ...(pair.answer?.body?.trim() ? { answer: pair.answer.body.trim(), answeredAt: pair.answer.createdAt } : {}),
    }]
  })
}

export function taskConversationRows(messages: Message[], activities: TeamActivity[], epochId: string | null, appId?: string, decisions: ActivityEntry[] = []): ConversationRow[] {
  const sharedDecisions = sharedTaskDecisions(activities, epochId, appId, new Set(decisions.map(decision => decision.id)))
  const entries: Array<{
    id: string
    at: number | null
    message?: Message
    decision?: ActivityEntry
    sharedDecision?: SharedTaskDecision
    activity?: TeamActivity
  }> = [
    ...conversationMessages(messages).map(message => ({ id: `message:${message.id}`, at: taskTime(message.timestamp), message, activity: undefined, decision: undefined })),
    ...decisions.map(decision => ({ id: `decision:${decision.id}`, at: taskTime(decision.ts), decision, message: undefined, activity: undefined })),
    ...sharedDecisions.map(sharedDecision => ({ id: `shared-decision:${sharedDecision.refId}`, at: taskTime(sharedDecision.requestedAt), sharedDecision })),
    ...[...new Map(activities.map(activity => [activity.id, activity])).values()]
      .filter(activity => appId && epochId && activity.epochId === epochId &&
        (activity.kind === 'message' || activity.kind === 'reply') && activity.targetAppId &&
        activity.actorAppId !== activity.targetAppId &&
        (activity.actorAppId === appId || activity.targetAppId === appId) &&
        (activity.subject.trim() || activity.body?.trim()))
      .map(activity => ({ id: `activity:${activity.id}`, at: taskTime(activity.createdAt), activity, message: undefined, decision: undefined })),
  ].sort((a, b) => compareTaskTimes(a.at, b.at) || a.id.localeCompare(b.id))
  const rows: ConversationRow[] = []
  for (const entry of entries) {
    if (entry.decision) rows.push({ id: entry.id, decision: entry.decision })
    else if ('sharedDecision' in entry && entry.sharedDecision) rows.push({ id: entry.id, sharedDecision: entry.sharedDecision })
    else if (entry.message) rows.push({ id: entry.id, message: entry.message })
    else if (entry.activity) {
      const previous = rows[rows.length - 1]
      if (previous?.activities && activityLevel(entry.activity) !== 'attention' && activityLevel(previous.activities[previous.activities.length - 1]) !== 'attention') previous.activities.push(entry.activity)
      else rows.push({ id: entry.id, activities: [entry.activity] })
    }
  }
  return rows
}
