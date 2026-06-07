/**
 * Team trigger wiring. A team is triggerable the same ways a single digital
 * human is: 'schedule' triggers become kind='team' scheduler jobs; 'webhook' |
 * 'file' | 'wecom' triggers become EventRouter subscriptions (the same
 * multi-subscriber path the app runtime uses). Both converge on runTeam().
 *
 * Overlapping runs are guarded by the team's currentEpochId, checked both in the
 * scheduler due handler and in each event subscription before runTeam().
 */

import type { SchedulerService, Schedule, SchedulerJob, RunOutcome } from '../../../platform/scheduler'
import type { TeamStore } from '../../team'
import type { TeamTrigger, TeamScheduleConfig, TeamRunTrigger } from '../../../../shared/apps/team-types'
import type { EventRouter, Unsubscribe } from '../event-router'
import type { AutomationEvent } from '../event-types'
import { sourceConfigToEventFilter } from '../event-filter-mapping'

const LOG_TAG = '[TeamTriggers]'

export const TEAM_JOB_KIND = 'team'

function jobId(teamId: string, triggerId: string): string {
  return `team:${teamId}:${triggerId}`
}

function toSchedule(config: TeamScheduleConfig | Record<string, unknown>): Schedule | null {
  const cfg = config as TeamScheduleConfig
  if (cfg.cron && cfg.cron.trim()) return { kind: 'cron', cron: cfg.cron.trim() }
  if (cfg.every && cfg.every.trim()) return { kind: 'every', every: cfg.every.trim() }
  return null
}

export interface TeamTriggerSchedulerDeps {
  scheduler: SchedulerService
  store: TeamStore
  /** Routes 'webhook' | 'file' | 'wecom' triggers; the event-kind counterpart of scheduler. */
  eventRouter: EventRouter
  runTeam: (teamId: string, trigger: TeamRunTrigger) => Promise<void>
}

export interface TeamTriggerScheduler {
  registerHandler(): void
  rehydrate(): void
  syncTeam(teamId: string): void
  removeTeam(teamId: string): void
}

export function createTeamTriggerScheduler(deps: TeamTriggerSchedulerDeps): TeamTriggerScheduler {
  const { scheduler, store, eventRouter, runTeam } = deps

  /** EventRouter unsubscribers per team — the event-kind parallel of scheduler jobs. */
  const eventUnsubs = new Map<string, Unsubscribe[]>()

  function addTriggerJob(trigger: TeamTrigger): void {
    if (trigger.sourceType !== 'schedule') return // event-kind triggers route via EventRouter
    const schedule = toSchedule(trigger.config)
    if (!schedule) {
      console.warn(`${LOG_TAG} trigger ${trigger.id} has no valid schedule config, skipping`)
      return
    }
    const id = jobId(trigger.teamId, trigger.id)
    const job = {
      id,
      name: `team:${trigger.teamId}`,
      schedule,
      enabled: true,
      kind: TEAM_JOB_KIND,
      metadata: { teamId: trigger.teamId, triggerId: trigger.id },
    }
    try {
      // Idempotent: scheduler jobs persist across restarts, so rehydrate must not
      // blindly re-insert (UNIQUE id). Reuse an existing job when the schedule is
      // unchanged (preserves its anchor); re-create only when it changed.
      const existing = scheduler.getJob(id)
      if (existing) {
        if (JSON.stringify(existing.schedule) !== JSON.stringify(schedule)) {
          scheduler.removeJob(id)
          scheduler.addJob(job)
        } else {
          scheduler.resumeJob(id)
        }
      } else {
        scheduler.addJob(job)
      }
    } catch (err) {
      console.error(`${LOG_TAG} failed to add job for trigger ${trigger.id}:`, err)
    }
  }

  function removeTeamJobs(teamId: string): void {
    const jobs = scheduler.listJobs({ metadata: { teamId } })
    for (const job of jobs) {
      if ((job.kind ?? 'app') === TEAM_JOB_KIND) scheduler.removeJob(job.id)
    }
  }

  /** Subscribe an event-kind trigger to the EventRouter; skip schedule/invalid. */
  function addEventSubscription(trigger: TeamTrigger): void {
    if (trigger.sourceType === 'schedule') return
    const filter = sourceConfigToEventFilter(
      trigger.sourceType,
      trigger.config as Record<string, unknown>
    )
    if (!filter) {
      console.warn(`${LOG_TAG} trigger ${trigger.id} (${trigger.sourceType}) produced no filter, skipping`)
      return
    }
    const unsub = eventRouter.on(filter, async (event: AutomationEvent) => {
      // Reentrancy guard mirrors the scheduler due handler: skip if the team is
      // gone or already running an epoch.
      const team = store.getTeamById(trigger.teamId)
      if (!team) return
      if (team.currentEpochId) {
        console.log(`${LOG_TAG} team ${trigger.teamId} already running (epoch=${team.currentEpochId}); skip event ${event.type}`)
        return
      }
      try {
        await runTeam(trigger.teamId, { type: 'event', triggerId: trigger.id })
      } catch (err) {
        console.error(`${LOG_TAG} event-triggered runTeam failed for team ${trigger.teamId}:`, err)
      }
    })
    const arr = eventUnsubs.get(trigger.teamId) ?? []
    arr.push(unsub)
    eventUnsubs.set(trigger.teamId, arr)
  }

  function removeEventSubscriptions(teamId: string): void {
    const arr = eventUnsubs.get(teamId)
    if (!arr) return
    for (const unsub of arr) {
      try {
        unsub()
      } catch (err) {
        console.error(`${LOG_TAG} failed to unsubscribe event handler for team ${teamId}:`, err)
      }
    }
    eventUnsubs.delete(teamId)
  }

  return {
    registerHandler(): void {
      scheduler.onJobDue(TEAM_JOB_KIND, async (job: SchedulerJob): Promise<RunOutcome> => {
        const teamId = (job.metadata as { teamId?: string } | undefined)?.teamId
        const triggerId = (job.metadata as { triggerId?: string } | undefined)?.triggerId
        if (!teamId) {
          console.warn(`${LOG_TAG} job ${job.id} has no teamId in metadata`)
          return 'skipped'
        }

        // Reentrancy guard: skip if the team is gone or already running an epoch.
        const team = store.getTeamById(teamId)
        if (!team) {
          console.warn(`${LOG_TAG} team ${teamId} not found; removing orphan job ${job.id}`)
          scheduler.removeJob(job.id)
          return 'skipped'
        }
        if (team.currentEpochId) {
          console.log(`${LOG_TAG} team ${teamId} already running (epoch=${team.currentEpochId}); skip`)
          return 'skipped'
        }

        try {
          await runTeam(teamId, { type: 'schedule', triggerId })
          return 'useful'
        } catch (err) {
          console.error(`${LOG_TAG} runTeam failed for team ${teamId}:`, err)
          return 'error'
        }
      })
      console.log(`${LOG_TAG} registered scheduler handler for kind='${TEAM_JOB_KIND}'`)
    },

    rehydrate(): void {
      const triggers = store.listAllEnabledTriggers()
      let scheduleCount = 0
      let eventCount = 0
      for (const trigger of triggers) {
        if (trigger.sourceType === 'schedule') {
          addTriggerJob(trigger)
          scheduleCount++
        } else {
          addEventSubscription(trigger)
          eventCount++
        }
      }
      console.log(`${LOG_TAG} rehydrated ${scheduleCount} schedule + ${eventCount} event trigger(s)`)
    },

    syncTeam(teamId: string): void {
      removeTeamJobs(teamId)
      removeEventSubscriptions(teamId)
      for (const trigger of store.listTriggersByTeam(teamId)) {
        if (!trigger.enabled) continue
        if (trigger.sourceType === 'schedule') addTriggerJob(trigger)
        else addEventSubscription(trigger)
      }
    },

    removeTeam(teamId: string): void {
      removeTeamJobs(teamId)
      removeEventSubscriptions(teamId)
    },
  }
}
