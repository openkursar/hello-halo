import { compareTaskTimes, taskTime } from './time'
import { inputsByReply } from '../../chat/transcript'
import type { Message, Thought } from '../../../types'
import type { ActivityEntry } from '../../../../shared/apps/app-types'
import type { BlackboardFinding, BlackboardTask, RosterMember, TeamActivity, TeamConversation } from '../../../../shared/apps/team-types'

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

/**
 * Members with a trace in this task: a record naming them, work assigned to or
 * filed by them, a report of theirs already read, a decision of theirs, or work
 * running for it now. No trace proves nothing, so it only lowers how loudly an
 * unreadable member is mentioned (see `reportGaps`).
 */
export function taskParticipants(input: {
  epochId: string
  activities: readonly TeamActivity[]
  tasks: readonly BlackboardTask[]
  findings: readonly BlackboardFinding[]
  roster: readonly RosterMember[]
  reports: readonly TaskMemberReport[]
  memberAppIds: readonly string[]
}): Set<string> {
  const ids = new Set(input.memberAppIds)
  for (const act of input.activities) {
    ids.add(act.actorAppId)
    if (act.targetAppId) ids.add(act.targetAppId)
  }
  for (const task of input.tasks) {
    ids.add(task.createdByAppId)
    if (task.assigneeAppId) ids.add(task.assigneeAppId)
  }
  for (const finding of input.findings) ids.add(finding.authorAppId)
  for (const report of input.reports) ids.add(report.appId)
  for (const member of input.roster) if (member.busy?.some(row => row.epochId === input.epochId)) ids.add(member.appId)
  return ids
}

export interface ReportGaps {
  /** Members of this task whose owner's computer is offline, grouped by owner. */
  offline: Array<{ owner: string | null; members: string[] }>
  /** Members whose reports could not be read although their computer is reachable. */
  failed: string[]
  /** Owners of members with no trace in this task whose computers are offline. */
  elsewhere: Array<string | null>
}

/**
 * Whose reports cannot be shown, and how loudly to say so. A member that took
 * part, or that failed while reachable, is a warning; an offline member with no
 * trace in this task is only named, never left to read as having said nothing.
 */
export function reportGaps(unavailable: readonly string[], roster: readonly RosterMember[], participants: ReadonlySet<string>): ReportGaps {
  const missing = new Set(unavailable)
  const offline = new Map<string | null, string[]>()
  const failed: string[] = []
  const elsewhere = new Set<string | null>()
  for (const member of roster) {
    if (!missing.has(member.appId)) continue
    const owner = member.owner?.trim() || null
    if (member.sameMachine !== false || member.presence !== 'offline') failed.push(member.memberName)
    else if (participants.has(member.appId)) offline.set(owner, [...(offline.get(owner) ?? []), member.memberName])
    else elsewhere.add(owner)
  }
  return { offline: [...offline].map(([owner, members]) => ({ owner, members })), failed, elsewhere: [...elsewhere] }
}

export interface ExecutionTurn {
  id: string
  /** The input the execution started from. */
  input?: Message
  /** Every input it read: delivered together at its start, or received while it ran. */
  inputs: Message[]
  outputs: Message[]
}

export function executionTurns(messages: Message[]): ExecutionTurn[] {
  const turns: ExecutionTurn[] = []
  for (const message of messages) {
    const current = turns[turns.length - 1]
    if (message.role === 'user' || (message.role === 'system' && message.source === 'team-message')) {
      const joins = !!current?.input && (current.outputs.length === 0 || message.metadata?.inputMode === 'live')
      if (joins) current.inputs.push(message)
      else turns.push({ id: message.id, input: message, inputs: [message], outputs: [] })
    } else if (message.role === 'assistant') {
      if (current) current.outputs.push(message)
      else turns.push({ id: message.id, inputs: [], outputs: [message] })
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
  /** The message is a system notification sent to the member, not something it reported. */
  notice?: boolean
}

export function taskActivityRows(reports: TaskMemberReport[], activities: TeamActivity[]): TaskActivityRow[] {
  const rows: TaskActivityRow[] = reports.map(({ appId, message }) => ({
    id: `message:${appId}:${message.id}`, at: taskTime(message.timestamp), appId, message,
    ...(isSystemNotification(message) ? { notice: true } : {}),
  }))
  rows.push(...activities.map(activity => ({ id: activity.id, at: taskTime(activity.createdAt), activities: [activity] })))
  return rows.sort((a, b) => compareTaskTimes(a.at, b.at, true) || a.id.localeCompare(b.id))
}

export type TaskActivityKind = 'output' | 'decision' | 'failed'

function activityKind(activity: TeamActivity): TaskActivityKind | null {
  if (['undelivered', 'timeout', 'error'].includes(activity.status ?? '')) return 'failed'
  if (activity.kind === 'decision') return 'decision'
  if (activity.kind === 'finding' || activity.kind === 'run_end') return 'output'
  return null
}

export function filterTaskActivityRows(rows: TaskActivityRow[], kind: TaskActivityKind | null): TaskActivityRow[] {
  if (!kind) return rows
  return rows.filter(row => row.message ? kind === 'failed' && !!row.message.error
    : !!row.activities?.[0] && activityKind(row.activities[0]) === kind)
}

export function isTeamBackgroundTurn(messages: Message[]): boolean {
  return !messages.some(isHumanInput)
}

// The owner adding to work already running belongs to that work; it does not start a conversation.
function isHumanInput(message: Message): boolean {
  return message.role === 'user' && message.source !== 'injection'
    && (!message.metadata?.teamTriggerKind || message.metadata.teamTriggerKind === 'human_message')
}

const systemTriggerKinds = ['member_stopped', 'periodic_check', 'run_start']

function isSystemNotification(message: Message): boolean {
  return (message.role === 'user' || (message.role === 'system' && message.source === 'team-message'))
    && systemTriggerKinds.includes(message.metadata?.teamTriggerKind ?? '')
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

/**
 * The homepage reads a member as one chat: replies to teammates and to their
 * turn-end reports join the owner's dialogue, and what a teammate sent is drawn on
 * the reply from the collaboration record. Replies to checks stay in the execution
 * records; a run's replies to its start are how that run's conversation opens.
 */
function homepageMessages(messages: Message[]): Message[] {
  const conversation = new Set(conversationMessages(messages))
  return messages.filter(message => conversation.has(message) || (message.role === 'assistant'
    && !!(message.content.trim() || message.error)
    && message.metadata?.teamTriggerKind !== 'periodic_check'))
}

export function taskReportMessages(messages: Message[]): Message[] {
  const conversation = new Set(conversationMessages(messages))
  return messages.filter(message => (message.content.trim() || message.error) &&
    (isSystemNotification(message) || (message.role === 'assistant' && !conversation.has(message))))
}

/** A member's last word in the task: its latest reply with text, replies to periodic checks aside. */
export function finalReplyText(messages: readonly Message[]): string | undefined {
  return messages.findLast(message => message.role === 'assistant' && !message.error
    && message.metadata?.teamTriggerKind !== 'periodic_check' && message.content.trim())?.content.trim()
}

export type ConversationRow =
  | { id: string; message: Message; openers?: TeamActivity[]; dispatches?: TeamActivity[]; activities?: never; decision?: never; sharedDecision?: never; additions?: never }
  | { id: string; activities: TeamActivity[]; message?: never; decision?: never; sharedDecision?: never; additions?: never }
  | { id: string; decision: ActivityEntry; message?: never; activities?: never; sharedDecision?: never; additions?: never }
  | { id: string; sharedDecision: SharedTaskDecision; message?: never; activities?: never; decision?: never; additions?: never }
  | { id: string; additions: Message[]; message?: never; activities?: never; decision?: never; sharedDecision?: never }

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

/**
 * The owner's additions no shown reply carries — their reply is work this view
 * does not show, or there is none — drawn on their own where they were sent, as
 * they were while that work ran.
 */
function looseAdditions(messages: Message[], conversation: readonly Message[]): Message[] {
  const carriers = inputsByReply(messages)
  const carried = new Set<Message>()
  for (const message of conversation) for (const addition of carriers.get(message.id)?.injections ?? []) carried.add(addition)
  return messages.filter(message => message.source === 'injection' && !carried.has(message))
}

/** Deliveries a shown reply already draws in its work, by the request id their activity shares. */
function carriedDeliveries(messages: Message[], conversation: readonly Message[]): Set<string> {
  const carriers = inputsByReply(messages)
  const ids = new Set<string>()
  for (const message of conversation) {
    for (const arrival of carriers.get(message.id)?.arrivals ?? []) {
      if (arrival.metadata?.correlationId) ids.add(arrival.metadata.correlationId)
    }
  }
  return ids
}

/**
 * `compact` is the homepage conversation: replies to teammates are part of the
 * dialogue, failures are told by the progress card instead, and what a reply
 * handed on is drawn under that reply. `sharedDecisions` is off for a member on this
 * machine: its decisions reach the local inbox and are drawn as answerable cards.
 */
export function taskConversationRows(messages: Message[], activities: TeamActivity[], epochId: string | null, appId?: string, decisions: ActivityEntry[] = [], { compact = false, sharedDecisions: withShared = true }: { compact?: boolean; sharedDecisions?: boolean } = {}): ConversationRow[] {
  const sharedDecisions = withShared ? sharedTaskDecisions(activities, epochId, appId, new Set(decisions.map(decision => decision.id))) : []
  const conversation = compact ? homepageMessages(messages) : conversationMessages(messages)
  const carried = compact ? carriedDeliveries(messages, conversation) : new Set<string>()
  const entries: Array<{
    id: string
    at: number | null
    message?: Message
    addition?: Message
    decision?: ActivityEntry
    sharedDecision?: SharedTaskDecision
    activity?: TeamActivity
  }> = [
    ...conversation.map(message => ({ id: `message:${message.id}`, at: taskTime(message.timestamp), message, activity: undefined, decision: undefined })),
    ...looseAdditions(messages, conversation).map(addition => ({ id: `addition:${addition.id}`, at: taskTime(addition.timestamp), addition })),
    ...decisions.map(decision => ({ id: `decision:${decision.id}`, at: taskTime(decision.ts), decision, message: undefined, activity: undefined })),
    ...sharedDecisions.map(sharedDecision => ({ id: `shared-decision:${sharedDecision.refId}`, at: taskTime(sharedDecision.requestedAt), sharedDecision })),
    ...[...new Map(activities.map(activity => [activity.id, activity])).values()]
      .filter(activity => appId && epochId && activity.epochId === epochId &&
        (activity.kind === 'message' || activity.kind === 'reply') && activity.targetAppId &&
        activity.actorAppId !== activity.targetAppId &&
        (activity.actorAppId === appId || activity.targetAppId === appId) &&
        (activity.subject.trim() || activity.body?.trim()) && !(compact && activityLevel(activity) === 'attention') &&
        !(activity.targetAppId === appId && activity.correlationId && carried.has(activity.correlationId)))
      .map(activity => ({ id: `activity:${activity.id}`, at: taskTime(activity.createdAt), activity, message: undefined, decision: undefined })),
  ].sort((a, b) => compareTaskTimes(a.at, b.at) || a.id.localeCompare(b.id))
  const rows: ConversationRow[] = []
  for (const entry of entries) {
    if (entry.decision) rows.push({ id: entry.id, decision: entry.decision })
    else if ('sharedDecision' in entry && entry.sharedDecision) rows.push({ id: entry.id, sharedDecision: entry.sharedDecision })
    else if (entry.message) rows.push({ id: entry.id, message: entry.message })
    else if (entry.addition) {
      const previous = rows[rows.length - 1]
      if (previous?.additions) previous.additions.push(entry.addition)
      else rows.push({ id: entry.id, additions: [entry.addition] })
    } else if (entry.activity) {
      const previous = rows[rows.length - 1]
      if (previous?.activities && activityLevel(entry.activity) !== 'attention' && activityLevel(previous.activities[previous.activities.length - 1]) !== 'attention') previous.activities.push(entry.activity)
      else rows.push({ id: entry.id, activities: [entry.activity] })
    }
  }
  const withOpeners = attachOpeners(rows, appId)
  return compact ? attachDispatches(withOpeners, appId) : withOpeners
}

/**
 * Messages a member sent are drawn under the reply of the turn that sent them.
 * A reply is stamped when its text ends, so a message sent mid-turn sorts just
 * before its own reply; only when no reply follows does it belong to the one before.
 */
function attachDispatches(rows: ConversationRow[], appId?: string): ConversationRow[] {
  if (!appId) return rows
  const result: ConversationRow[] = []
  let reply: Extract<ConversationRow, { message: Message }> | null = null
  let pending: TeamActivity[] = []
  rows.forEach((row, index) => {
    if (row.message) {
      reply = row.message.role === 'assistant' ? { ...row, ...(pending.length ? { dispatches: pending } : {}) } : null
      pending = []
      result.push(reply ?? row)
      return
    }
    let next = index + 1
    while (rows[next]?.activities) next++
    const replyFollows = rows[next]?.message?.role === 'assistant'
    if ((!reply && !replyFollows) || !row.activities) {
      reply = null
      result.push(row)
      return
    }
    const dispatched = row.activities.filter(activity => activity.kind === 'message' && activity.actorAppId === appId && activityLevel(activity) !== 'attention')
    if (replyFollows) pending.push(...dispatched)
    else if (dispatched.length && reply) reply.dispatches = [...(reply.dispatches ?? []), ...dispatched]
    const rest = row.activities.filter(activity => !dispatched.includes(activity))
    if (rest.length) result.push({ id: row.id, activities: rest })
  })
  return result
}

/** What a member received right before its reply is what started that reply, so it is drawn on the reply. */
function attachOpeners(rows: ConversationRow[], appId?: string): ConversationRow[] {
  if (!appId) return rows
  const result: ConversationRow[] = []
  for (const row of rows) {
    if (row.message?.role !== 'assistant') {
      result.push(row)
      continue
    }
    let start = result.length
    while (start > 0 && result[start - 1].activities) start--
    const before = result.slice(start)
    const openers = before.flatMap(item => item.activities ?? []).filter(activity => activity.targetAppId === appId && activityLevel(activity) !== 'attention')
    if (!openers.length) {
      result.push(row)
      continue
    }
    result.length = start
    for (const item of before) {
      const rest = item.activities!.filter(activity => !openers.includes(activity))
      if (rest.length) result.push({ id: item.id, activities: rest })
    }
    result.push({ id: row.id, message: row.message, openers })
  }
  return result
}
