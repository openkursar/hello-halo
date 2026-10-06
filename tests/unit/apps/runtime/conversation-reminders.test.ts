/**
 * Reminders a digital human sets in a conversation live on the real scheduler:
 * one kept per request, refused when it is not a reminder for a person, handed
 * to delivery when due, and gone with the conversation or digital human they
 * belong to — never with a /clear.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { initScheduler, resetSchedulerForTest, type SchedulerJob, type SchedulerService } from '../../../../src/main/platform/scheduler'
import {
  createConversationReminders,
  renderReminderTurn,
  REMINDER_JOB_KIND,
  ReminderError,
  setConversationReminders,
  type ConversationReminders,
} from '../../../../src/main/apps/runtime/reminders'
import { ImSessionRegistry } from '../../../../src/main/apps/runtime/im-session-registry'

const APP = 'app-1'
const MAIN = `app-chat:${APP}`
const GROUP = `app-chat:${APP}:wecom-bot:group:g-1`
const NOW = new Date(2026, 9, 6, 10, 30).getTime()
const MIN = 60_000

let scheduler: SchedulerService
let reminders: ConversationReminders
let due: (job: SchedulerJob) => Promise<string>
const deliver = vi.fn()
const installed = new Set([APP])
const conversations = new Set<string>()

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  scheduler = await initScheduler({ db: createDatabaseManager(':memory:') })
  const onJobDue = vi.spyOn(scheduler, 'onJobDue')
  deliver.mockReset().mockReturnValue('started')
  conversations.clear()
  for (const id of [MAIN, GROUP, 'app-chat:app-2', 'app-chat:removed-app']) conversations.add(id)
  reminders = createConversationReminders({
    scheduler, deliver,
    appExists: appId => installed.has(appId),
    conversationExists: (_appId, conversationId) => conversations.has(conversationId),
  })
  reminders.registerHandler()
  due = onJobDue.mock.calls[0][1] as unknown as typeof due
})

afterEach(async () => {
  setConversationReminders(null)
  await resetSchedulerForTest()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const jobOf = (id: string) => scheduler.getJob(`app-reminder:${id}`)!

describe('setting a reminder', () => {
  it('keeps it on the scheduler, due when asked, and lists it for its conversation only', () => {
    const reminder = reminders.set({ appId: APP, conversationId: GROUP, message: 'Tell the group the hour is up.', when: { afterMinutes: 60 }, setBy: { id: 'u-1', name: 'Li' } })

    expect(reminder).toMatchObject({ schedule: { kind: 'once', at: NOW + 60 * MIN }, nextAt: NOW + 60 * MIN, setBy: { id: 'u-1', name: 'Li' } })
    expect(jobOf(reminder.id).kind).toBe(REMINDER_JOB_KIND)
    expect(reminders.listForConversation(APP, GROUP).map(r => r.id)).toEqual([reminder.id])
    expect(reminders.listForConversation(APP, MAIN)).toEqual([])
    expect(reminders.listForApp(APP).map(r => r.id)).toEqual([reminder.id])
  })

  it('takes a local time, an interval or a cron', () => {
    const at = reminders.set({ appId: APP, conversationId: MAIN, message: 'Stand-up', when: { at: '2026-10-07T09:00' } })
    const every = reminders.set({ appId: APP, conversationId: MAIN, message: 'Water', when: { every: '2h' } })
    const cron = reminders.set({ appId: APP, conversationId: MAIN, message: 'Report', when: { cron: '0 9 * * *' } })

    expect(at.nextAt).toBe(new Date(2026, 9, 7, 9, 0).getTime())
    expect(every.schedule).toEqual({ kind: 'every', every: '2h' })
    expect(cron.nextAt).toBe(new Date(2026, 9, 7, 9, 0).getTime())
  })

  it('refuses what is not a reminder for a person, with a reason the model can act on', () => {
    const set = (when: Record<string, unknown>, message = 'x') => () => reminders.set({ appId: APP, conversationId: MAIN, message, when })

    expect(set({})).toThrow(ReminderError)
    expect(set({ afterMinutes: 5, every: '1h' })).toThrow('exactly one')
    expect(set({ at: '2026-10-06T09:00' })).toThrow('already passed')
    expect(set({ at: 'tomorrow' })).toThrow('not a date')
    expect(set({ every: '1m' })).toThrow('at least 5 minutes')
    expect(set({ cron: '* * * * *' })).toThrow('at least 5 minutes')
    expect(set({ afterMinutes: 60 * 24 * 400 })).toThrow('at most a year')
    expect(set({ afterMinutes: 5 }, '   ')).toThrow('cannot be empty')
  })

  it('holds a conversation to twenty', () => {
    for (let i = 0; i < 20; i++) reminders.set({ appId: APP, conversationId: MAIN, message: `r${i}`, when: { afterMinutes: 10 + i } })

    expect(() => reminders.set({ appId: APP, conversationId: MAIN, message: 'one more', when: { afterMinutes: 90 } })).toThrow('already has 20')
    expect(() => reminders.set({ appId: APP, conversationId: GROUP, message: 'elsewhere', when: { afterMinutes: 90 } })).not.toThrow()
  })

  it('holds a digital human to a hundred across its conversations', () => {
    for (let chat = 0; chat < 5; chat++) {
      for (let i = 0; i < 20; i++) {
        reminders.set({ appId: APP, conversationId: `app-chat:${APP}:http:direct:c-${chat}`, message: `r${i}`, when: { afterMinutes: 10 + i } })
      }
    }

    expect(() => reminders.set({ appId: APP, conversationId: MAIN, message: 'one more', when: { afterMinutes: 90 } })).toThrow('already has 100')
    expect(() => reminders.set({ appId: 'app-2', conversationId: 'app-chat:app-2', message: 'another digital human', when: { afterMinutes: 90 } })).not.toThrow()
  })
})

describe('a reminder coming due', () => {
  it('is handed to delivery with the time it was due', async () => {
    const reminder = reminders.set({ appId: APP, conversationId: GROUP, message: 'Time is up.', when: { afterMinutes: 60 } })

    expect(await due(jobOf(reminder.id))).toBe('useful')
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: reminder.id, conversationId: GROUP, message: 'Time is up.' }), NOW + 60 * MIN)
  })

  it('is left in place, not failed, when its conversation is gone; the next start sweeps it', async () => {
    const reminder = reminders.set({ appId: APP, conversationId: GROUP, message: 'Every morning.', when: { every: '1d' } })
    const elsewhere = reminders.set({ appId: APP, conversationId: MAIN, message: 'Still here.', when: { every: '1d' } })
    deliver.mockReturnValue('gone')

    expect(await due(jobOf(reminder.id))).toBe('skipped')
    expect(scheduler.getJob(`app-reminder:${reminder.id}`)).not.toBeNull()

    // The digital human is still installed; only the chat went (lost or evicted without a removal reaching here).
    conversations.delete(GROUP)
    reminders.sweep()
    expect(scheduler.getJob(`app-reminder:${reminder.id}`)).toBeNull()
    expect(reminders.isStillSet(elsewhere.id)).toBe(true)
  })

  it('folds a coming-due into the one still waiting, without failing the schedule', async () => {
    const reminder = reminders.set({ appId: APP, conversationId: GROUP, message: 'Water.', when: { every: '5m' } })
    deliver.mockReturnValue('merged')

    expect(await due(jobOf(reminder.id))).toBe('skipped')
  })

  it('reads as the digital human’s own reminder: who asked, when it was set and due, and when it is late', () => {
    const reminder = reminders.set({ appId: APP, conversationId: GROUP, message: 'Tell the group the hour is up.', when: { afterMinutes: 60 }, setBy: { id: 'u-1', name: 'Li' } })

    const onTime = renderReminderTurn(reminder, NOW + 60 * MIN, NOW + 60 * MIN)
    expect(onTime).toBe('[Reminder you set in this conversation at the request of Li on 2026-10-06 10:30 · due 2026-10-06 11:30]\n\nTell the group the hour is up.')
    expect(renderReminderTurn(reminder, NOW + 60 * MIN, NOW + 200 * MIN)).toContain('due 2026-10-06 11:30, delivered late at 2026-10-06 13:50]')
    expect(renderReminderTurn(reminder, NOW + 60 * MIN, NOW + 60 * MIN, 3)).toContain('; it came due 3 more times while this conversation was busy]')
  })
})

describe('cancelling and cleaning up', () => {
  it('lets a conversation cancel only its own reminders, and the page any of them', () => {
    const inGroup = reminders.set({ appId: APP, conversationId: GROUP, message: 'group', when: { afterMinutes: 30 } })

    expect(reminders.cancel(APP, inGroup.id, MAIN)).toBe(false)
    expect(reminders.cancel('other-app', inGroup.id)).toBe(false)
    expect(reminders.isStillSet(inGroup.id)).toBe(true)
    expect(reminders.cancel(APP, inGroup.id)).toBe(true)
    expect(reminders.listForApp(APP)).toEqual([])
    expect(reminders.isStillSet(inGroup.id)).toBe(false)
  })

  it('counts a one-off that came due but was not cancelled as still set until it is delivered', () => {
    const once = reminders.set({ appId: APP, conversationId: MAIN, message: 'once', when: { afterMinutes: 30 } })
    scheduler.updateJob(`app-reminder:${once.id}`, { enabled: false })

    expect(reminders.isStillSet(once.id)).toBe(true)
  })

  it('drops a fired one-off and the reminders of a removed digital human at the next start', () => {
    const fired = reminders.set({ appId: APP, conversationId: MAIN, message: 'once', when: { afterMinutes: 30 } })
    const kept = reminders.set({ appId: APP, conversationId: MAIN, message: 'daily', when: { every: '1d' } })
    reminders.set({ appId: 'removed-app', conversationId: 'app-chat:removed-app', message: 'orphan', when: { every: '1d' } })
    scheduler.updateJob(`app-reminder:${fired.id}`, { enabled: false })

    reminders.sweep()

    expect(scheduler.listJobs().filter(job => job.kind === REMINDER_JOB_KIND).map(job => job.metadata?.reminderId)).toEqual([kept.id])
  })

  it('goes with the chat it belongs to when the chat is removed, and not otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'halo-reminders-registry-'))
    try {
      const registry = new ImSessionRegistry(join(dir, 'im-sessions.json'))
      registry.register(APP, 'wecom-bot', 'g-1', 'group', 'inst-1', { displayName: 'Ops group' })
      setConversationReminders(reminders)
      const inGroup = reminders.set({ appId: APP, conversationId: GROUP, message: 'group', when: { afterMinutes: 30 } })
      const inMain = reminders.set({ appId: APP, conversationId: MAIN, message: 'main', when: { afterMinutes: 30 } })

      registry.removeSession(APP, 'wecom-bot', 'g-1')

      expect(reminders.listForApp(APP).map(r => r.id)).toEqual([inMain.id])
      expect(scheduler.getJob(`app-reminder:${inGroup.id}`)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('goes with an API chat the registry evicts as idle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'halo-reminders-registry-'))
    try {
      const registry = new ImSessionRegistry(join(dir, 'im-sessions.json'))
      setConversationReminders(reminders)
      registry.register(APP, 'http', 'old-client', 'direct', 'http')
      const idle = reminders.set({ appId: APP, conversationId: `app-chat:${APP}:http:direct:old-client`, message: 'idle', when: { every: '1d' } })

      // Thirty-one days later another API chat arrives and the idle one is evicted.
      vi.setSystemTime(NOW + 31 * 24 * 60 * MIN)
      registry.register(APP, 'http', 'new-client', 'direct', 'http')

      expect(registry.findSession(APP, 'http', 'old-client')).toBeUndefined()
      expect(reminders.isStillSet(idle.id)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('goes with its digital human', () => {
    reminders.set({ appId: APP, conversationId: MAIN, message: 'main', when: { afterMinutes: 30 } })
    reminders.set({ appId: 'app-2', conversationId: 'app-chat:app-2', message: 'other', when: { afterMinutes: 30 } })

    expect(reminders.removeForApp(APP)).toBe(1)
    expect(reminders.listForApp('app-2')).toHaveLength(1)
  })
})
