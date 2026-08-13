/**
 * Periodic checks — "from now on, every half hour, take a look at this".
 *
 * One member leaves a standing instruction for another; the target wakes on that
 * rhythm until someone stops it. The check belongs to the thing it was set
 * inside (a run or a conversation) and disappears with it.
 *
 * Two rules shape everything here:
 *   - The alarm lives on the machine that OWNS the target. Whoever set it can
 *     shut their computer without stopping it, and a target whose owner is away
 *     simply does not wake — which is honest, because that digital human could
 *     not have done the work either.
 *   - The row is office-shared. It is published on the same replication plane as
 *     the board, so every node shows the same list and any member can stop any
 *     check. Publishing is injected; without it this degrades to a single
 *     machine, which is exactly right for a team that lives on one.
 *
 * Kernel-pure: talks to the store, the platform scheduler, and injected seams.
 * It never imports the federation transport or the session layer.
 */

import { randomUUID } from 'crypto'
import { isRemoteMember } from '../../../../shared/apps/team-types'
import type {
  TeamCheck,
  TeamCheckSchedule,
  TeamCheckView,
} from '../../../../shared/apps/team-types'
import type { TeamStore } from '../../team'
import type { BusyDisposition, WakeDisposition } from './message-bus'
import type { RunOutcome, SchedulerService } from '../../../platform/scheduler'
import { computeNextRun } from '../../../platform/scheduler'

const LOG_TAG = '[TeamChecks]'

/** Scheduler job kind, kept apart from the team-level trigger kind. */
export const TEAM_CHECK_JOB_KIND = 'team_check'

function jobId(checkId: string): string {
  return `team-check:${checkId}`
}

/** Thrown for a refusal the calling agent is meant to read and act on. */
export class TeamCheckError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamCheckError'
  }
}

export interface ScheduleCheckInput {
  teamId: string
  epochId: string
  /** The member asking for the check (self-checks are allowed). */
  createdByAppId: string
  targetAppId: string
  instruction: string
  schedule: TeamCheckSchedule
}

export interface TeamChecksDeps {
  store: TeamStore
  /** Absent → checks are recorded and shared but no alarm rings (test runtimes). */
  scheduler?: SchedulerService | null
  /**
   * Start the target's turn with the rendered standing instruction. `onBusy`
   * carries what a busy target means for this particular check. Returns what
   * actually happened to the wake: the bus owns the final busy gate (it also sees
   * wakes in flight, which {@link TeamChecksDeps.isBusy} cannot), so a round can
   * still be skipped after this module has decided to go ahead — and a skipped
   * round is not counted as run.
   */
  wake: (params: {
    teamId: string
    epochId: string
    appId: string
    body: string
    onBusy: BusyDisposition
  }) => Promise<WakeDisposition>
  /** True while the target is mid-turn — a due check is skipped, never queued. */
  isBusy: (teamId: string, epochId: string, appId: string) => boolean
  /**
   * Share a change office-wide. Injected by bootstrap onto the federation
   * replication plane; absent → single-machine team.
   */
  publish?: (change: { op: 'upsert' | 'delete'; check: TeamCheck }) => void
  /** Notify observers (renderer refresh) that this team's checks changed. */
  onChanged?: (teamId: string) => void
  /**
   * Whether a member's owner is answering right now. A check on an unreachable
   * owner is still set but cannot fire, and the board/panel must say so rather
   * than let it look alive. Absent → everyone treated as reachable.
   */
  isReachable?: (appId: string, teamId: string) => boolean
  now?: () => number
}

export interface TeamChecks {
  /** Register the scheduler handler. Call once, before the scheduler starts. */
  registerHandler(): void
  /** Re-arm alarms for locally-owned targets after a restart. */
  rehydrate(): void
  schedule(input: ScheduleCheckInput): TeamCheck
  /**
   * Stop checks on one member: a specific one by id, or all of them. Returns the
   * checks actually stopped so the caller can report what happened.
   */
  cancel(params: { teamId: string; epochId: string; targetAppId?: string; checkId?: string }): TeamCheck[]
  /** Stop one check by id from anywhere (the panel's stop button). */
  cancelById(checkId: string): boolean
  listForEpoch(teamId: string, epochId: string): TeamCheck[]
  /** Every check of a team, resolved for display (open epochs and all). */
  viewForTeam(teamId: string): TeamCheckView[]
  viewForEpoch(teamId: string, epochId: string): TeamCheckView[]
  /** The thing this check belonged to ended — drop them all. */
  clearEpoch(teamId: string, epochId: string): void
  /** Apply a replicated row authored elsewhere (never re-published). */
  applyReplicated(check: TeamCheck): void
  /** Apply a replicated removal authored elsewhere (never re-published). */
  applyReplicatedDelete(checkId: string): void
}

export function createTeamChecks(deps: TeamChecksDeps): TeamChecks {
  const { store } = deps
  const now = deps.now ?? (() => Date.now())

  function memberOf(teamId: string, appId: string) {
    return store.getMember(teamId, appId)
  }

  function memberName(teamId: string, appId: string): string {
    return memberOf(teamId, appId)?.memberName ?? appId
  }

  /** True when the target runs on THIS machine, so the alarm belongs here. */
  function ownedHere(teamId: string, appId: string): boolean {
    const member = memberOf(teamId, appId)
    return member != null && !isRemoteMember(member)
  }

  function notifyChanged(teamId: string): void {
    try {
      deps.onChanged?.(teamId)
    } catch (err) {
      console.error(`${LOG_TAG} onChanged observer failed:`, err)
    }
  }

  function publish(op: 'upsert' | 'delete', check: TeamCheck): void {
    try {
      deps.publish?.({ op, check })
    } catch (err) {
      // Sharing is best-effort relative to the local write, which already stuck.
      console.error(`${LOG_TAG} publish failed (local write kept):`, err)
    }
    notifyChanged(check.teamId)
  }

  // ── Alarms (only for targets this machine owns) ──

  function armJob(check: TeamCheck): void {
    if (!deps.scheduler || !ownedHere(check.teamId, check.targetAppId)) return
    const id = jobId(check.id)
    const existing = deps.scheduler.getJob(id)
    if (existing) {
      if (JSON.stringify(existing.schedule) === JSON.stringify(check.schedule)) return
      deps.scheduler.removeJob(id)
    }
    try {
      deps.scheduler.addJob({
        id,
        name: `team-check:${check.teamId}`,
        schedule: check.schedule,
        enabled: true,
        kind: TEAM_CHECK_JOB_KIND,
        metadata: { checkId: check.id, teamId: check.teamId },
      })
    } catch (err) {
      console.error(`${LOG_TAG} could not arm check=${check.id}:`, err)
    }
  }

  function disarmJob(checkId: string): void {
    if (!deps.scheduler) return
    try {
      deps.scheduler.removeJob(jobId(checkId))
    } catch (err) {
      console.error(`${LOG_TAG} could not disarm check=${checkId}:`, err)
    }
  }

  // ── Writes ──

  function schedule(input: ScheduleCheckInput): TeamCheck {
    const target = memberOf(input.teamId, input.targetAppId)
    if (!target) throw new TeamCheckError('That teammate is not in this team.')

    // The owner's answer travels with the member row, so a refusal is immediate
    // and readable wherever the request is made. The owning machine re-checks on
    // apply, which is where the decision is actually binding.
    if (target.acceptsChecks === false) {
      throw new TeamCheckError(
        `"${target.memberName}" does not accept periodic checks — its owner turned that off. ` +
          `Ask them directly with team_send instead.`
      )
    }

    const epoch = store.getEpochById(input.epochId)
    if (!epoch || epoch.endedAt !== null) {
      throw new TeamCheckError('This piece of work is already finished, so a periodic check cannot be set on it.')
    }

    // Fail fast on a schedule that can never fire (bad interval, bad cron, a
    // one-shot time already gone) so the agent fixes it now, not in an hour.
    assertSchedulable(input.schedule)

    const instruction = input.instruction.trim()
    if (!instruction) throw new TeamCheckError('Say what to look at each time — the instruction cannot be empty.')

    const ts = now()
    const check: TeamCheck = {
      id: randomUUID(),
      teamId: input.teamId,
      epochId: input.epochId,
      targetAppId: input.targetAppId,
      createdByAppId: input.createdByAppId,
      instruction,
      schedule: input.schedule,
      runCount: 0,
      createdAt: ts,
      updatedAt: ts,
      lastRunAt: null,
    }
    store.upsertCheck(check)
    armJob(check)
    console.log(
      `${LOG_TAG} set: team=${check.teamId} epoch=${check.epochId} target=${check.targetAppId} ` +
        `by=${check.createdByAppId} id=${check.id}`
    )
    publish('upsert', check)
    return check
  }

  function cancel(params: {
    teamId: string
    epochId: string
    targetAppId?: string
    checkId?: string
  }): TeamCheck[] {
    const candidates = store
      .listChecksByEpoch(params.teamId, params.epochId)
      .filter((c) => (params.checkId ? c.id === params.checkId : true))
      .filter((c) => (params.targetAppId ? c.targetAppId === params.targetAppId : true))

    for (const check of candidates) removeLocally(check)
    return candidates
  }

  function cancelById(checkId: string): boolean {
    const check = store.getCheckById(checkId)
    if (!check) return false
    removeLocally(check)
    return true
  }

  function removeLocally(check: TeamCheck): void {
    store.deleteCheck(check.id)
    disarmJob(check.id)
    console.log(`${LOG_TAG} stopped: team=${check.teamId} id=${check.id}`)
    publish('delete', check)
  }

  function clearEpoch(teamId: string, epochId: string): void {
    const removed = store.deleteChecksByEpoch(teamId, epochId)
    for (const check of removed) {
      disarmJob(check.id)
      publish('delete', check)
    }
    if (removed.length > 0) {
      console.log(`${LOG_TAG} cleared ${removed.length} check(s) with epoch=${epochId}`)
    }
  }

  // ── Replicated writes (authored on another node) ──

  function applyReplicated(check: TeamCheck): void {
    const target = memberOf(check.teamId, check.targetAppId)
    // The owning machine has the final say: a check set against a member whose
    // owner does not accept them is withdrawn here, not merely ignored, so the
    // setter's board stops showing something that will never happen.
    if (target && !isRemoteMember(target) && target.acceptsChecks === false) {
      console.warn(`${LOG_TAG} refusing replicated check for a member that declines checks: ${check.id}`)
      store.deleteCheck(check.id)
      disarmJob(check.id)
      publish('delete', check)
      return
    }
    store.upsertCheck(check)
    armJob(check)
    notifyChanged(check.teamId)
  }

  function applyReplicatedDelete(checkId: string): void {
    const existing = store.getCheckById(checkId)
    store.deleteCheck(checkId)
    disarmJob(checkId)
    if (existing) notifyChanged(existing.teamId)
  }

  // ── Reads ──

  function listForEpoch(teamId: string, epochId: string): TeamCheck[] {
    return store.listChecksByEpoch(teamId, epochId)
  }

  function toView(check: TeamCheck): TeamCheckView {
    const target = memberOf(check.teamId, check.targetAppId)
    const remote = target ? isRemoteMember(target) : false
    return {
      id: check.id,
      epochId: check.epochId,
      targetAppId: check.targetAppId,
      targetMemberName: target?.memberName ?? check.targetAppId,
      createdByMemberName: memberName(check.teamId, check.createdByAppId),
      instruction: check.instruction,
      schedule: check.schedule,
      runCount: check.runCount,
      lastRunAt: check.lastRunAt,
      reachable: deps.isReachable?.(check.targetAppId, check.teamId) !== false,
      ...(remote ? { targetOwner: target?.ownerDisplayName ?? null } : {}),
    }
  }

  function viewForTeam(teamId: string): TeamCheckView[] {
    return store.listChecksByTeam(teamId).map(toView)
  }

  function viewForEpoch(teamId: string, epochId: string): TeamCheckView[] {
    return store.listChecksByEpoch(teamId, epochId).map(toView)
  }

  // ── Due-alarm handling ──

  async function runDue(checkId: string): Promise<RunOutcome> {
    const check = store.getCheckById(checkId)
    if (!check) {
      disarmJob(checkId)
      return 'skipped'
    }
    if (!ownedHere(check.teamId, check.targetAppId)) {
      // The member moved away (or this row arrived before the roster did): the
      // alarm belongs on its owner's machine, not here.
      disarmJob(checkId)
      return 'skipped'
    }
    const epoch = store.getEpochById(check.epochId)
    if (!epoch || epoch.endedAt !== null) {
      removeLocally(check)
      return 'skipped'
    }
    // A one-shot has no second chance, so the two rules that keep a recurring
    // check cheap are wrong for it: skipping a busy round would throw the whole
    // thing away, and keeping the row afterwards would leave the board showing
    // something that can never run again.
    const oneShot = check.schedule.kind === 'once'

    // Busy means skip, not queue: the next round comes anyway, and stacking
    // wake-ups on a member already working is how a check turns into a pile-up.
    if (!oneShot && deps.isBusy(check.teamId, check.epochId, check.targetAppId)) {
      console.log(`${LOG_TAG} target busy, skipping this round: id=${check.id}`)
      return 'skipped'
    }

    // Counted only once the wake is actually taken. The bus applies the same
    // busy rule one layer down and can still skip this round; persisting first
    // would inflate "run #N" and lastRunAt for a round that never ran — and
    // that pair is what both the panel and the agent read.
    const attempt: TeamCheck = {
      ...check,
      runCount: check.runCount + 1,
      lastRunAt: now(),
      updatedAt: now(),
    }
    const disposition = await deps.wake({
      teamId: check.teamId,
      epochId: check.epochId,
      appId: check.targetAppId,
      body: renderCheckWake(attempt, memberName(check.teamId, check.createdByAppId)),
      onBusy: oneShot ? 'buffer' : 'skip',
    })
    if (disposition === 'skipped') {
      console.log(`${LOG_TAG} wake skipped, round not counted: id=${check.id}`)
      return 'skipped'
    }

    if (oneShot) {
      retire(check)
      return 'useful'
    }

    store.upsertCheck(attempt)
    publish('upsert', attempt)
    return 'useful'
  }

  /**
   * A one-shot has been handed over — queued counts, the mailbox delivers it at
   * the end of the turn in the way. Drop the row so no board keeps offering to
   * stop something that will never run again; the turn it starts is the record
   * of it, in the transcript where it lands.
   *
   * Retiring the alarm is left to the scheduler, which does that for a one-shot
   * job by itself. Deleting the job here would pull it out from under the run
   * log the scheduler writes once this handler returns; the disabled leftover is
   * swept at startup instead.
   */
  function retire(check: TeamCheck): void {
    store.deleteCheck(check.id)
    console.log(`${LOG_TAG} one-shot done: team=${check.teamId} id=${check.id}`)
    publish('delete', check)
  }

  function registerHandler(): void {
    if (!deps.scheduler) return
    deps.scheduler.onJobDue(TEAM_CHECK_JOB_KIND, async (job) => {
      const checkId = typeof job.metadata?.checkId === 'string' ? job.metadata.checkId : null
      if (!checkId) return 'skipped'
      try {
        return await runDue(checkId)
      } catch (err) {
        console.error(`${LOG_TAG} due handler failed for check=${checkId}:`, err)
        return 'error'
      }
    })
    console.log(`${LOG_TAG} handler registered (kind=${TEAM_CHECK_JOB_KIND})`)
  }

  function rehydrate(): void {
    if (!deps.scheduler) return
    let armed = 0
    for (const check of store.listAllChecks()) {
      const epoch = store.getEpochById(check.epochId)
      if (!epoch || epoch.endedAt !== null) {
        // Its run/conversation ended while this node was down.
        store.deleteCheck(check.id)
        disarmJob(check.id)
        continue
      }
      if (!ownedHere(check.teamId, check.targetAppId)) continue
      armJob(check)
      armed++
    }
    sweepOrphanAlarms()
    console.log(`${LOG_TAG} rehydrated ${armed} local alarm(s)`)
  }

  /**
   * Alarms with no check left behind them: a retired one-shot leaves its own
   * (already disabled) job, and a crash between the two writes leaves the same
   * debris. Nothing else clears them, and they are invisible to everyone but
   * this sweep.
   */
  function sweepOrphanAlarms(): void {
    const scheduler = deps.scheduler
    if (!scheduler) return
    let swept = 0
    for (const job of scheduler.listJobs()) {
      if (job.kind !== TEAM_CHECK_JOB_KIND) continue
      const checkId = typeof job.metadata?.checkId === 'string' ? job.metadata.checkId : null
      if (checkId && store.getCheckById(checkId)) continue
      scheduler.removeJob(job.id)
      swept++
    }
    if (swept > 0) console.log(`${LOG_TAG} swept ${swept} alarm(s) with no check left`)
  }

  return {
    registerHandler,
    rehydrate,
    schedule,
    cancel,
    cancelById,
    listForEpoch,
    viewForTeam,
    viewForEpoch,
    clearEpoch,
    applyReplicated,
    applyReplicatedDelete,
  }
}

// ── Pure helpers (exported for the tool layer and tests) ──

/** Reject a schedule that can never produce a future run, with a readable reason. */
export function assertSchedulable(schedule: TeamCheckSchedule, nowMs = Date.now()): void {
  let next: number | undefined
  try {
    next = computeNextRun(schedule, nowMs, nowMs)
  } catch (err) {
    throw new TeamCheckError((err as Error).message)
  }
  if (next === undefined) {
    throw new TeamCheckError('That schedule has no future run time. Pick a time ahead of now.')
  }
}

/** How a schedule reads to a person or an agent. */
export function describeSchedule(schedule: TeamCheckSchedule): string {
  switch (schedule.kind) {
    case 'every':
      return `every ${schedule.every}`
    case 'cron':
      return `on schedule ${schedule.cron}`
    case 'once':
      return `once at ${new Date(schedule.once).toISOString()}`
  }
}

/**
 * What the woken member reads. It carries the three facts that let it act
 * without any memory of being set up: who asked, what they asked verbatim, and
 * how many times this has already happened.
 */
export function renderCheckWake(check: TeamCheck, setterName: string): string {
  return `[Periodic check · set by ${setterName} · run #${check.runCount}]\n\n${check.instruction}`
}
