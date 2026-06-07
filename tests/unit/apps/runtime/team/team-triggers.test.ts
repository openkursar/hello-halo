/**
 * Unit tests for runtime/team/team-triggers — the team side of the scheduler
 * and the EventRouter.
 *
 * Verifies: registers under kind 'team'; rehydrate adds a job per enabled
 * schedule trigger AND an EventRouter subscription per enabled event trigger;
 * the due handler skips when the team is already running and runs otherwise;
 * RunOutcome maps useful/skipped/error; event subscriptions run the team
 * (type 'event') with the same reentrancy guard; sync/remove maintain both the
 * team's jobs and its event subscriptions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTeamTriggerScheduler, TEAM_JOB_KIND } from '../../../../../src/main/apps/runtime/team/team-triggers'
import type { SchedulerJob, JobDueHandler } from '../../../../../src/main/platform/scheduler'
import type { TeamTrigger } from '../../../../../src/main/apps/team/types'
import type { AutomationEvent, EventFilter, AutomationEventHandler } from '../../../../../src/main/apps/runtime/event-types'

function trigger(over: Partial<TeamTrigger> = {}): TeamTrigger {
  return { id: 't1', teamId: 'team-1', sourceType: 'schedule', config: { every: '30m' }, enabled: true, createdAt: 1, ...over }
}

function eventTrigger(over: Partial<TeamTrigger> = {}): TeamTrigger {
  return { id: 'e1', teamId: 'team-1', sourceType: 'webhook', config: { path: 'hook' }, enabled: true, createdAt: 1, ...over }
}

interface FakeSub { filter: EventFilter; handler: AutomationEventHandler; active: boolean }

function makeHarness() {
  const jobs = new Map<string, any>()
  let dueHandler: JobDueHandler | null = null
  const scheduler = {
    addJob: vi.fn((j: any) => { jobs.set(j.id, { ...j, kind: j.kind }); return j.id }),
    removeJob: vi.fn((id: string) => { jobs.delete(id) }),
    updateJob: vi.fn(),
    getJob: vi.fn((id: string) => jobs.get(id) ?? null),
    resumeJob: vi.fn(),
    listJobs: vi.fn((filter?: any) => {
      const all = [...jobs.values()]
      if (filter?.metadata) {
        return all.filter(j => Object.entries(filter.metadata).every(([k, v]) => j.metadata?.[k] === v))
      }
      return all
    }),
    onJobDue: vi.fn((kind: string, handler: JobDueHandler) => { if (kind === TEAM_JOB_KIND) dueHandler = handler }),
  } as any

  const eventSubs: FakeSub[] = []
  const eventRouter = {
    on: vi.fn((filter: EventFilter, handler: AutomationEventHandler) => {
      const sub: FakeSub = { filter, handler, active: true }
      eventSubs.push(sub)
      return () => { sub.active = false }
    }),
    emit: vi.fn(),
    registerSource: vi.fn(),
    removeSource: vi.fn(),
    listSources: vi.fn(() => []),
    start: vi.fn(),
    stop: vi.fn(),
  } as any

  const teams = new Map<string, any>([['team-1', { id: 'team-1', currentEpochId: null }]])
  const triggers: TeamTrigger[] = []
  const store = {
    getTeamById: vi.fn((id: string) => teams.get(id) ?? null),
    listAllEnabledTriggers: vi.fn(() => triggers.filter(t => t.enabled)),
    listTriggersByTeam: vi.fn((teamId: string) => triggers.filter(t => t.teamId === teamId)),
  } as any

  const runTeam = vi.fn(async () => {})
  const ts = createTeamTriggerScheduler({ scheduler, store, eventRouter, runTeam })
  return { ts, scheduler, eventRouter, store, runTeam, jobs, teams, triggers, eventSubs, getDueHandler: () => dueHandler }
}

function fakeEvent(over: Partial<AutomationEvent> = {}): AutomationEvent {
  return { id: 'evt-1', type: 'webhook.received', source: 'webhook', timestamp: 1, payload: { path: 'hook' }, ...over }
}

function dueJob(over: Partial<SchedulerJob> = {}): SchedulerJob {
  return {
    id: 'team:team-1:t1', name: 'team:team-1', schedule: { kind: 'every', every: '30m' },
    enabled: true, kind: TEAM_JOB_KIND, metadata: { teamId: 'team-1', triggerId: 't1' },
    anchorMs: 0, nextRunAtMs: 0, consecutiveErrors: 0, status: 'idle', createdAt: 0, updatedAt: 0,
    ...over,
  } as SchedulerJob
}

describe('createTeamTriggerScheduler', () => {
  let h: ReturnType<typeof makeHarness>
  beforeEach(() => { h = makeHarness() })

  it('registers the due handler under the team kind', () => {
    h.ts.registerHandler()
    expect(h.scheduler.onJobDue).toHaveBeenCalledWith(TEAM_JOB_KIND, expect.any(Function))
  })

  it('rehydrate adds one job per enabled schedule trigger', () => {
    h.triggers.push(trigger({ id: 't1', enabled: true }))
    h.triggers.push(trigger({ id: 't2', enabled: true, config: { cron: '0 9 * * 1-5' } }))
    h.ts.rehydrate()
    expect(h.scheduler.addJob).toHaveBeenCalledTimes(2)
    expect(h.jobs.has('team:team-1:t1')).toBe(true)
    expect(h.jobs.has('team:team-1:t2')).toBe(true)
  })

  it('rehydrate is idempotent — re-adding a persisted job does not throw or duplicate', () => {
    h.triggers.push(trigger({ id: 't1', enabled: true }))
    h.ts.rehydrate()
    expect(h.jobs.size).toBe(1)
    // Second rehydrate (e.g. another boot path) must reuse, not re-insert.
    h.ts.rehydrate()
    expect(h.jobs.size).toBe(1)
    expect(h.scheduler.resumeJob).toHaveBeenCalledWith('team:team-1:t1')
  })

  it('due handler runs the team and returns useful when idle', async () => {
    h.ts.registerHandler()
    const outcome = await h.getDueHandler()!(dueJob())
    expect(h.runTeam).toHaveBeenCalledWith('team-1', { type: 'schedule', triggerId: 't1' })
    expect(outcome).toBe('useful')
  })

  it('due handler skips when the team already has a running epoch', async () => {
    h.teams.set('team-1', { id: 'team-1', currentEpochId: 'epoch-x' })
    h.ts.registerHandler()
    const outcome = await h.getDueHandler()!(dueJob())
    expect(h.runTeam).not.toHaveBeenCalled()
    expect(outcome).toBe('skipped')
  })

  it('due handler removes the job and skips when the team is gone', async () => {
    h.teams.delete('team-1')
    h.ts.registerHandler()
    const outcome = await h.getDueHandler()!(dueJob())
    expect(outcome).toBe('skipped')
    expect(h.scheduler.removeJob).toHaveBeenCalledWith('team:team-1:t1')
  })

  it('due handler returns error when runTeam throws', async () => {
    h.runTeam.mockRejectedValueOnce(new Error('boom'))
    h.ts.registerHandler()
    const outcome = await h.getDueHandler()!(dueJob())
    expect(outcome).toBe('error')
  })

  it('syncTeam clears existing team jobs then re-adds enabled ones', () => {
    h.triggers.push(trigger({ id: 't1', enabled: true }))
    h.ts.rehydrate()
    expect(h.jobs.size).toBe(1)
    // Disable t1, add t2; syncTeam should drop t1's job and add t2.
    h.triggers.length = 0
    h.triggers.push(trigger({ id: 't2', enabled: true }))
    h.ts.syncTeam('team-1')
    expect(h.jobs.has('team:team-1:t1')).toBe(false)
    expect(h.jobs.has('team:team-1:t2')).toBe(true)
  })

  it('removeTeam removes all of the team jobs', () => {
    h.triggers.push(trigger({ id: 't1' }), trigger({ id: 't2' }))
    h.ts.rehydrate()
    h.ts.removeTeam('team-1')
    expect(h.jobs.size).toBe(0)
  })

  // ── Event-kind triggers (webhook / file / wecom) ──

  it('rehydrate subscribes the EventRouter for each enabled event trigger', () => {
    h.triggers.push(eventTrigger({ id: 'e1', sourceType: 'webhook', config: { path: 'hook' } }))
    h.triggers.push(eventTrigger({ id: 'e2', sourceType: 'file', config: { pattern: '*.csv' } }))
    h.ts.rehydrate()
    expect(h.eventRouter.on).toHaveBeenCalledTimes(2)
    expect(h.eventSubs).toHaveLength(2)
    // No scheduler jobs for event triggers.
    expect(h.scheduler.addJob).not.toHaveBeenCalled()
  })

  it('rehydrate splits schedule vs event triggers across scheduler and EventRouter', () => {
    h.triggers.push(trigger({ id: 't1' }))
    h.triggers.push(eventTrigger({ id: 'e1' }))
    h.ts.rehydrate()
    expect(h.jobs.has('team:team-1:t1')).toBe(true)
    expect(h.eventSubs).toHaveLength(1)
  })

  it('event subscription runs the team with type "event" when idle', async () => {
    h.triggers.push(eventTrigger({ id: 'e1' }))
    h.ts.rehydrate()
    await h.eventSubs[0].handler(fakeEvent())
    expect(h.runTeam).toHaveBeenCalledWith('team-1', { type: 'event', triggerId: 'e1' })
  })

  it('event subscription skips when the team already has a running epoch', async () => {
    h.teams.set('team-1', { id: 'team-1', currentEpochId: 'epoch-x' })
    h.triggers.push(eventTrigger({ id: 'e1' }))
    h.ts.rehydrate()
    await h.eventSubs[0].handler(fakeEvent())
    expect(h.runTeam).not.toHaveBeenCalled()
  })

  it('event subscription skips when the team is gone', async () => {
    h.teams.delete('team-1')
    h.triggers.push(eventTrigger({ id: 'e1' }))
    h.ts.rehydrate()
    await h.eventSubs[0].handler(fakeEvent())
    expect(h.runTeam).not.toHaveBeenCalled()
  })

  it('syncTeam unsubscribes old event subs then re-subscribes enabled ones', () => {
    h.triggers.push(eventTrigger({ id: 'e1' }))
    h.ts.rehydrate()
    expect(h.eventSubs[0].active).toBe(true)
    // Replace e1 with e2; syncTeam should tear down e1's sub and add e2's.
    h.triggers.length = 0
    h.triggers.push(eventTrigger({ id: 'e2', config: { path: 'other' } }))
    h.ts.syncTeam('team-1')
    expect(h.eventSubs[0].active).toBe(false) // e1 torn down
    expect(h.eventSubs[1].active).toBe(true)  // e2 live
  })

  it('removeTeam unsubscribes all event subscriptions', () => {
    h.triggers.push(eventTrigger({ id: 'e1' }), eventTrigger({ id: 'e2', config: { path: 'other' } }))
    h.ts.rehydrate()
    h.ts.removeTeam('team-1')
    expect(h.eventSubs.every(s => !s.active)).toBe(true)
  })

  it('disabled event triggers are not subscribed on syncTeam', () => {
    h.triggers.push(eventTrigger({ id: 'e1', enabled: false }))
    h.ts.syncTeam('team-1')
    expect(h.eventRouter.on).not.toHaveBeenCalled()
  })
})
