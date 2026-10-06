/**
 * Reminders a digital human sets for itself in a conversation ("remind me in an
 * hour", "every day at 9"): when one comes due, it returns to that same
 * conversation as a new turn. A request like that used to have nowhere to go
 * but a new resident digital human.
 *
 * The scheduler job IS the reminder — its metadata carries everything — so there
 * is no second store to keep in step, and the scheduler's own restart recovery
 * brings reminders back. A one-off is disabled by the scheduler once it has come
 * due; that leftover is swept at the next start rather than deleted from inside
 * its own handler, which would pull the job out from under the run log the
 * scheduler writes once the handler returns.
 *
 * Turning a due reminder into a turn belongs to the chat layer and is injected.
 */

import { randomUUID } from 'crypto'
import type { RunOutcome, Schedule, SchedulerJob, SchedulerService } from '../../../platform/scheduler'
import { computeNextRun, parseEveryString } from '../../../platform/scheduler'
import type { ReminderSchedule } from '../../../../shared/apps/conversation-reminders'
import { parseAppChatKey } from '../../../../shared/apps/im-keys'

const LOG_TAG = '[Reminders]'

export const REMINDER_JOB_KIND = 'app_reminder'

const MAX_PER_CONVERSATION = 20
/** A digital human with many chats (HTTP sessions alone may number 500) is bounded as a whole too. */
const MAX_PER_APP = 100
/** A reminder is for a person; anything more frequent is monitoring, which is what a schedule is for. */
const MIN_REPEAT_MS = 5 * 60 * 1000
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000
const MAX_MESSAGE_LENGTH = 2000

/** A refusal the model is meant to read and correct. */
export class ReminderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReminderError'
  }
}

/** The IM sender a reminder was set for; absent in the owner's own chats. */
export interface ReminderSetter {
  id: string
  name: string
}

export interface ConversationReminder {
  id: string
  appId: string
  conversationId: string
  message: string
  schedule: ReminderSchedule
  /** Null once a one-off has come due. */
  nextAt: number | null
  createdAt: number
  setBy?: ReminderSetter
}

/** When a reminder is due, as the model asks for it: exactly one of the four. */
export interface ReminderWhen {
  afterMinutes?: number
  at?: string
  every?: string
  cron?: string
}

/**
 * - `started`: its turn is on the way (it may still wait for the conversation to be free);
 * - `merged`: an earlier coming-due is still waiting for the conversation; this one is counted into it;
 * - `gone`: its conversation or digital human no longer exists;
 * - `unavailable`: the conversation exists but cannot be reached right now (an IM channel not running).
 */
export type ReminderDelivery = 'started' | 'merged' | 'gone' | 'unavailable'

export interface ConversationRemindersDeps {
  scheduler: SchedulerService
  deliver: (reminder: ConversationReminder, dueAt: number) => ReminderDelivery
  appExists: (appId: string) => boolean
  /** Whether the conversation a reminder returns to is still there (the default chat always is). */
  conversationExists: (appId: string, conversationId: string) => boolean
  now?: () => number
}

export interface ConversationReminders {
  /** Register the scheduler handler. Call once, before the scheduler starts. */
  registerHandler(): void
  /**
   * Drop jobs a previous run left behind: fired one-offs, and reminders whose
   * digital human or conversation is gone (a session the registry lost or
   * evicted without a removal reaching here).
   */
  sweep(): void
  /** Whether a reminder is still set: false once cancelled, removed or swept. */
  isStillSet(reminderId: string): boolean
  set(input: {
    appId: string
    conversationId: string
    message: string
    when: ReminderWhen
    setBy?: ReminderSetter
  }): ConversationReminder
  listForConversation(appId: string, conversationId: string): ConversationReminder[]
  listForApp(appId: string): ConversationReminder[]
  /** Cancel one; `conversationId` limits it to that conversation's reminders. */
  cancel(appId: string, reminderId: string, conversationId?: string): boolean
  removeForApp(appId: string): number
  /** A chat was removed from the session registry. */
  removeForChat(appId: string, channel: string, chatId: string): number
}

function jobId(reminderId: string): string {
  return `app-reminder:${reminderId}`
}

function toSchedule(schedule: ReminderSchedule): Schedule {
  switch (schedule.kind) {
    case 'once': return { kind: 'once', once: schedule.at }
    case 'every': return { kind: 'every', every: schedule.every }
    case 'cron': return { kind: 'cron', cron: schedule.cron }
  }
}

function fromSchedule(schedule: Schedule): ReminderSchedule {
  switch (schedule.kind) {
    case 'once': return { kind: 'once', at: schedule.once }
    case 'every': return { kind: 'every', every: schedule.every }
    case 'cron': return { kind: 'cron', cron: schedule.cron }
  }
}

function fromJob(job: SchedulerJob): ConversationReminder | null {
  if (job.kind !== REMINDER_JOB_KIND) return null
  const meta = job.metadata ?? {}
  const { reminderId, appId, conversationId, message } = meta as Record<string, unknown>
  if (typeof reminderId !== 'string' || typeof appId !== 'string' || typeof conversationId !== 'string' || typeof message !== 'string') {
    return null
  }
  const setBy = meta.setBy as Partial<ReminderSetter> | undefined
  return {
    id: reminderId,
    appId,
    conversationId,
    message,
    schedule: fromSchedule(job.schedule),
    nextAt: job.enabled && job.nextRunAtMs > 0 ? job.nextRunAtMs : null,
    createdAt: job.createdAt,
    ...(typeof setBy?.id === 'string' && typeof setBy.name === 'string' ? { setBy: { id: setBy.id, name: setBy.name } } : {}),
  }
}

/** Turn the model's request into a schedule, refusing one that is not a reminder for a person. */
export function reminderScheduleFrom(when: ReminderWhen, nowMs: number): ReminderSchedule {
  const given = (['afterMinutes', 'at', 'every', 'cron'] as const).filter(key => when[key] !== undefined && when[key] !== '')
  if (given.length !== 1) {
    throw new ReminderError('Give exactly one of after_minutes, at, every or cron.')
  }
  if (when.afterMinutes !== undefined) {
    if (!(when.afterMinutes > 0)) throw new ReminderError('after_minutes must be more than 0.')
    return onceAt(nowMs + Math.round(when.afterMinutes * 60_000), nowMs)
  }
  if (when.at !== undefined) {
    const at = new Date(when.at).getTime()
    if (Number.isNaN(at)) throw new ReminderError(`"${when.at}" is not a date and time; use a form like 2026-10-07T09:00.`)
    return onceAt(at, nowMs)
  }
  if (when.every !== undefined) {
    let everyMs: number
    try {
      everyMs = parseEveryString(when.every)
    } catch (error) {
      throw new ReminderError((error as Error).message)
    }
    if (everyMs < MIN_REPEAT_MS) throw new ReminderError('A repeating reminder must be at least 5 minutes apart.')
    return { kind: 'every', every: when.every.trim() }
  }
  const cron = when.cron!.trim()
  const schedule: Schedule = { kind: 'cron', cron }
  let previous: number | undefined
  try {
    previous = computeNextRun(schedule, nowMs, nowMs)
    for (let i = 0; previous !== undefined && i < 10; i++) {
      const next = computeNextRun(schedule, nowMs, previous)
      if (next === undefined) break
      if (next - previous < MIN_REPEAT_MS) throw new ReminderError('A repeating reminder must be at least 5 minutes apart.')
      previous = next
    }
  } catch (error) {
    if (error instanceof ReminderError) throw error
    throw new ReminderError((error as Error).message)
  }
  if (previous === undefined) throw new ReminderError('That cron expression never comes due.')
  return { kind: 'cron', cron }
}

function onceAt(at: number, nowMs: number): ReminderSchedule {
  if (at <= nowMs) throw new ReminderError(`That time has already passed (it is now ${formatLocalTime(nowMs)}). Pick a time ahead of now.`)
  if (at - nowMs > MAX_AHEAD_MS) throw new ReminderError('A reminder can be at most a year ahead.')
  return { kind: 'once', at }
}

/** This computer's local time, to the minute — what the person and the model both read. */
export function formatLocalTime(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function describeReminderSchedule(schedule: ReminderSchedule): string {
  switch (schedule.kind) {
    case 'once': return `once at ${formatLocalTime(schedule.at)}`
    case 'every': return `every ${schedule.every}`
    case 'cron': return `on cron "${schedule.cron}"`
  }
}

/**
 * What the digital human reads when a reminder comes due. It carries what it
 * needs to act without any memory of setting it up: that this is its own
 * reminder, who asked, when it was meant for, and the words it wrote — and,
 * when the conversation was busy for a while, how many more times it came due
 * meanwhile, since those were folded into this one turn.
 */
export function renderReminderTurn(reminder: ConversationReminder, dueAt: number, nowMs: number, missed = 0): string {
  const late = nowMs - dueAt > 5 * 60 * 1000 ? `, delivered late at ${formatLocalTime(nowMs)}` : ''
  const folded = missed > 0 ? `; it came due ${missed} more time${missed === 1 ? '' : 's'} while this conversation was busy` : ''
  const askedBy = reminder.setBy ? ` at the request of ${reminder.setBy.name}` : ''
  return `[Reminder you set in this conversation${askedBy} on ${formatLocalTime(reminder.createdAt)} · due ${formatLocalTime(dueAt)}${late}${folded}]\n\n${reminder.message}`
}

export function createConversationReminders(deps: ConversationRemindersDeps): ConversationReminders {
  const { scheduler } = deps
  const now = deps.now ?? (() => Date.now())

  function reminderJobs(): SchedulerJob[] {
    return scheduler.listJobs().filter(job => job.kind === REMINDER_JOB_KIND)
  }

  function listActive(filter: (reminder: ConversationReminder) => boolean): ConversationReminder[] {
    return reminderJobs()
      .filter(job => job.enabled)
      .map(fromJob)
      .filter((reminder): reminder is ConversationReminder => reminder !== null && filter(reminder))
      .sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity))
  }

  function removeWhere(filter: (reminder: ConversationReminder) => boolean): number {
    let removed = 0
    for (const job of reminderJobs()) {
      const reminder = fromJob(job)
      if (!reminder || !filter(reminder)) continue
      scheduler.removeJob(job.id)
      removed += 1
    }
    return removed
  }

  async function runDue(job: SchedulerJob): Promise<RunOutcome> {
    const reminder = fromJob(job)
    if (!reminder) return 'skipped'
    const dueAt = job.nextRunAtMs > 0 ? job.nextRunAtMs : now()
    const delivery = deps.deliver(reminder, dueAt)
    if (delivery === 'started') {
      console.log(`${LOG_TAG} Due: app=${reminder.appId} conversation=${reminder.conversationId} id=${reminder.id}`)
      return 'useful'
    }
    if (delivery === 'merged') {
      console.log(`${LOG_TAG} Due again while still waiting for its conversation; folded in: id=${reminder.id}`)
      return 'skipped'
    }
    // Left in place either way: removing a job from inside its own handler would
    // break the run log the scheduler is about to write. A one-off is disabled
    // by the scheduler now; a repeating one whose conversation is gone is swept
    // at the next start, which checks the conversation is still there.
    console.warn(`${LOG_TAG} Not delivered (${delivery}): app=${reminder.appId} conversation=${reminder.conversationId} id=${reminder.id}`)
    return 'skipped'
  }

  return {
    registerHandler() {
      scheduler.onJobDue(REMINDER_JOB_KIND, runDue)
    },

    sweep() {
      let swept = 0
      for (const job of reminderJobs()) {
        const reminder = fromJob(job)
        if (job.enabled && reminder && deps.appExists(reminder.appId) && deps.conversationExists(reminder.appId, reminder.conversationId)) continue
        scheduler.removeJob(job.id)
        swept += 1
      }
      if (swept > 0) console.log(`${LOG_TAG} Swept ${swept} finished or orphaned reminder(s)`)
    },

    isStillSet(reminderId) {
      return scheduler.getJob(jobId(reminderId)) !== null
    },

    set(input) {
      const message = input.message.trim()
      if (!message) throw new ReminderError('Say what the reminder is for — the message cannot be empty.')
      if (message.length > MAX_MESSAGE_LENGTH) throw new ReminderError(`Keep the message under ${MAX_MESSAGE_LENGTH} characters.`)
      const ofApp = listActive(r => r.appId === input.appId)
      if (ofApp.filter(r => r.conversationId === input.conversationId).length >= MAX_PER_CONVERSATION) {
        throw new ReminderError(`This conversation already has ${MAX_PER_CONVERSATION} reminders. Cancel one first.`)
      }
      if (ofApp.length >= MAX_PER_APP) {
        throw new ReminderError(`This digital human already has ${MAX_PER_APP} reminders across its conversations. Cancel some first.`)
      }
      const schedule = reminderScheduleFrom(input.when, now())
      const id = randomUUID()
      scheduler.addJob({
        id: jobId(id),
        name: `app-reminder:${input.appId}`,
        schedule: toSchedule(schedule),
        enabled: true,
        kind: REMINDER_JOB_KIND,
        metadata: {
          reminderId: id,
          appId: input.appId,
          conversationId: input.conversationId,
          message,
          ...(input.setBy ? { setBy: input.setBy } : {}),
        },
      })
      const created = scheduler.getJob(jobId(id))
      const reminder = created ? fromJob(created) : null
      if (!reminder) throw new Error('The reminder could not be saved.')
      console.log(`${LOG_TAG} Set: app=${input.appId} conversation=${input.conversationId} id=${id} ${describeReminderSchedule(schedule)}`)
      return reminder
    },

    listForConversation(appId, conversationId) {
      return listActive(r => r.appId === appId && r.conversationId === conversationId)
    },

    listForApp(appId) {
      return listActive(r => r.appId === appId)
    },

    cancel(appId, reminderId, conversationId) {
      const job = scheduler.getJob(jobId(reminderId))
      const reminder = job ? fromJob(job) : null
      if (!reminder || reminder.appId !== appId) return false
      if (conversationId !== undefined && reminder.conversationId !== conversationId) return false
      scheduler.removeJob(jobId(reminderId))
      console.log(`${LOG_TAG} Cancelled: app=${appId} id=${reminderId}`)
      return true
    },

    removeForApp(appId) {
      return removeWhere(r => r.appId === appId)
    },

    removeForChat(appId, channel, chatId) {
      return removeWhere(r => {
        if (r.appId !== appId) return false
        const parsed = parseAppChatKey(r.conversationId)
        return parsed !== null && parsed.channel === channel && parsed.chatId === chatId
      })
    },
  }
}

let active: ConversationReminders | null = null

/** Wired once by the runtime's initialisation; the chat tools and the session registry read it. */
export function setConversationReminders(reminders: ConversationReminders | null): void {
  active = reminders
}

export function getConversationReminders(): ConversationReminders | null {
  return active
}
