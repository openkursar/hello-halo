/**
 * Turn-end report: the only thing that reaches the lead when nobody chose to speak.
 *
 * Every other channel in this office is pull or opt-in. The board does not push,
 * the digest only rides a turn that has already started, and a teammate hears
 * from another only through an explicit `team_send`. So a member that finishes —
 * or dies, or is stopped by hand — without calling the tool leaves the lead with
 * nothing to react to AND no turn in which to notice. The run stops and no code
 * looks. That is the hole this closes.
 *
 * What it sends is the FACT that a turn ended, never a word the member said.
 * Auto-delivery of a turn's closing line was removed because one chat window has
 * two listeners (the owner and a teammate) and nothing can tell which of them a
 * sentence was meant for; a fate nobody uttered carries no such ambiguity. The
 * old rule governed CONTENT, and only content.
 *
 * Two rules keep the notice honest, and both cost more than they look:
 *
 * - **It never concludes.** "Ended without an error" is not "finished the work":
 *   a model that forgot to keep going ends exactly the same way as one that is
 *   done. Naming that state "completed" would hand the lead a reassurance the
 *   system cannot back, and reassurance is the one output that stops it looking.
 * - **It claims a member recorded NOTHING only when it watched the whole turn.**
 *   A wake that never became a turn observed nothing and therefore says nothing.
 *   That combination — stopped, and not one act filed — is the strongest evidence
 *   of a model that quit early, which is exactly why it must never be guessed.
 *
 * Acts are counted as they are FILED rather than read back from the record: on a
 * joined office a member's writes travel to the authority and return replicated,
 * so the store can still be empty at the moment its own turn ends. Watching the
 * call is the only observation that is true on every machine.
 */

import { randomUUID } from 'crypto'
import { isRemoteMember } from '../../../../shared/apps/team-types'
import type { TeamActivityKind, TeamTriggerContext } from '../../../../shared/apps/team-types'
import type { TeamStore } from '../../team'
import type { PostActivityInput } from './blackboard'
import type { MessageBus } from './message-bus'

const LOG_TAG = '[TeamTurnReport]'

/**
 * How a member's turn ended, in the only vocabulary the system can prove. There
 * is deliberately no `completed`: nothing here can see whether the work is done.
 */
export type MemberTurnFate =
  | { kind: 'ended' }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
  /** The wake never became a turn — so nothing about the member was observed. */
  | { kind: 'never_ran'; reason: string }
  /**
   * A person stopped it by hand (the renderer/HTTP stop action) — never a
   * failure to chase. Distinct from `error`: a hard stop lands in the same
   * unconditional-reject path a crash does, so without this the lead would
   * be sent after a teammate that was deliberately interrupted.
   */
  | { kind: 'stopped' }

export interface NoteTurnEndedInput {
  appId: string
  teamId: string
  epochId: string
  fate: MemberTurnFate
  /**
   * The wake this turn served, when it had one. Two reporters can describe the
   * same ending (the session layer sees the turn stop, the bus sees the wake
   * fail); the first one through wins and the other is a no-op.
   */
  correlationId?: string
  /** How the turn was framed. A person's words to their own member are not team work. */
  triggerKind?: TeamTriggerContext['kind']
}

export interface TurnReport {
  /** A member's team-channel turn began here — opens the window acts are counted in. */
  noteTurnStarted(params: { appId: string; teamId: string; epochId: string }): void
  /** …and ended, however it ended. Safe to call for any member, including the lead. */
  noteTurnEnded(input: NoteTurnEndedInput): void
  /** Watch an act as it is filed, so "recorded nothing" is observed and not inferred. */
  noteAct(input: PostActivityInput): void
  clearEpoch(epochId: string): void
}

export interface TurnReportDeps {
  store: TeamStore
  bus: MessageBus
}

/** One act a member filed, kept only long enough to describe the turn it fell in. */
interface ActNote {
  at: number
  kind: TeamActivityKind
  targetAppId: string | null
  refId: string | null
}

/** One member's ending, as the lead will read it. */
interface StopFact {
  memberName: string
  fate: MemberTurnFate
  /**
   * What the member filed during the turn. `null` when the turn was not watched
   * end to end — the difference between "recorded nothing" and "not observed",
   * which the notice must never collapse.
   */
  did: string[] | null
}

/**
 * Per-member act history kept live. Small on purpose: it answers "during this
 * turn", never "during this run" — the office record is what holds the run.
 */
const ACTS_PER_MEMBER = 32

/** Members named in one notice. Past this the notice stops being read. */
const FACTS_PER_NOTICE = 12

/** Acts described per member. The rest becomes a count. */
const ACTS_DESCRIBED = 4

/** Endings remembered as already reported, so the de-duplication cannot grow forever. */
const REPORTED_CAP = 512

/** A failure message is passed through, but a stack trace is not a notice. */
const FATE_MESSAGE_MAX = 500

/**
 * Coalescing window for report wakes. Endings arriving within this long of
 * the last flush pile into the NEXT one instead of each waking the lead —
 * time-based rather than "does the lead have an outstanding notice" (the
 * prior design): that signal only exists when the lead is on THIS machine
 * (see the removed `leadIsLocal` check), so a remote lead never cleared it
 * and every ending woke it individually. A window bounds the wake rate the
 * same way regardless of where the lead runs.
 */
export const FLUSH_WINDOW_MS = 15_000

/**
 * Hard cap on report wakes per epoch — independent of `chargeCircuit`'s
 * `messageCount`/`forwardDepth` in message-bus.ts on purpose: report-wake
 * volume scales with how many turns members run, not with member-initiated
 * `team_send` traffic, and charging it into that budget would let report
 * noise alone exhaust the allowance real team communication needs.
 *
 * A fixed backstop, not a second rate limiter: the `FLUSH_WINDOW_MS`
 * coalescing above already bounds the wake RATE (at most one per window), so
 * this only needs to catch the window somehow failing to hold. Sizing it off
 * `maxMessages` (the member-chat budget, a different and much smaller
 * quantity) tripped this cap around a perfectly healthy long run's own
 * halfway point — exactly the false positive this fixed value exists to
 * prevent.
 */
export const REPORT_WAKE_CAP = 960

export function createTurnReport(deps: TurnReportDeps): TurnReport {
  const { store, bus } = deps

  /** Open turn windows, keyed by member session. */
  const turnStartedAt = new Map<string, number>()
  /** Acts filed per (epoch, member), newest last. */
  const acts = new Map<string, ActNote[]>()
  /** Endings already reported, keyed by the wake they served → its epoch. */
  const reported = new Map<string, string>()
  /** Endings waiting for a lead turn to carry them. */
  const pending = new Map<string, StopFact[]>()
  /** When each epoch's pending queue last actually went out. */
  const lastFlushAt = new Map<string, number>()
  /** A flush already scheduled for the end of the current coalescing window. */
  const flushTimer = new Map<string, ReturnType<typeof setTimeout>>()
  /** Report wakes delivered this epoch — see `REPORT_WAKE_CAP`. */
  const reportWakeCount = new Map<string, number>()

  const memberKey = (epochId: string, appId: string): string => `${epochId}:${appId}`
  const epochKey = (teamId: string, epochId: string): string => `${teamId}:${epochId}`

  function memberName(teamId: string, appId: string): string {
    return store.getMember(teamId, appId)?.memberName ?? appId
  }

  function noteTurnStarted(params: { appId: string; teamId: string; epochId: string }): void {
    turnStartedAt.set(memberKey(params.epochId, params.appId), Date.now())
  }

  function noteAct(input: PostActivityInput): void {
    const key = memberKey(input.epochId, input.actorAppId)
    const list = acts.get(key) ?? []
    list.push({
      at: Date.now(),
      kind: input.kind,
      targetAppId: input.targetAppId ?? null,
      refId: input.refId ?? null,
    })
    if (list.length > ACTS_PER_MEMBER) list.splice(0, list.length - ACTS_PER_MEMBER)
    acts.set(key, list)
  }

  /**
   * What this member filed during the turn, in the lead's words. A `reply` act is
   * excluded: the system files those about a member, not the member itself, so
   * counting one would let a failed delivery pose as work the member did.
   */
  function describeActs(teamId: string, appId: string, epochId: string, since: number): string[] {
    const list = acts.get(memberKey(epochId, appId)) ?? []
    const inTurn = list.filter((a) => a.at >= since && a.kind !== 'reply')
    const described = inTurn.slice(0, ACTS_DESCRIBED).map((a) => describeAct(teamId, a))
    const hidden = inTurn.length - described.length
    if (hidden > 0) described.push(`and ${hidden} more`)
    return described
  }

  function describeAct(teamId: string, act: ActNote): string {
    const target = act.targetAppId ? memberName(teamId, act.targetAppId) : null
    switch (act.kind) {
      case 'message':
        return target ? `messaged ${target}` : 'sent a message'
      case 'task_post':
        return target ? `assigned a task to ${target}` : 'posted a task'
      case 'task_update': {
        const title = act.refId ? store.getTaskById(act.refId)?.title : null
        return title ? `moved "${title}"` : 'moved a task'
      }
      case 'finding':
        return 'shared a finding'
      case 'check_set':
        return target ? `set a recurring check on ${target}` : 'set a recurring check'
      case 'check_stop':
        return 'stopped a recurring check'
      case 'run_end':
        return 'ended the run'
      default:
        return 'wrote to the board'
    }
  }

  function markReported(correlationId: string, epochId: string): void {
    reported.set(correlationId, epochId)
    if (reported.size > REPORTED_CAP) {
      const oldest = reported.keys().next()
      if (!oldest.done) reported.delete(oldest.value)
    }
  }

  /**
   * Flush now if it has been at least `FLUSH_WINDOW_MS` since the last one
   * for this epoch; otherwise schedule exactly one trailing flush for the
   * remainder of the window (a second call while one is already scheduled is
   * a no-op — everything queued by then rides that same flush). An isolated
   * ending — the common case — still goes out immediately, since the window
   * has necessarily elapsed since a flush that never happened.
   */
  function requestFlush(teamId: string, epochId: string): void {
    const key = epochKey(teamId, epochId)
    if (flushTimer.has(key)) return
    const since = lastFlushAt.get(key)
    const elapsed = since === undefined ? Infinity : Date.now() - since
    if (elapsed >= FLUSH_WINDOW_MS) {
      void flush(teamId, epochId)
      return
    }
    const timer = setTimeout(() => {
      flushTimer.delete(key)
      void flush(teamId, epochId)
    }, FLUSH_WINDOW_MS - elapsed)
    if (typeof timer.unref === 'function') timer.unref()
    flushTimer.set(key, timer)
  }

  function noteTurnEnded(input: NoteTurnEndedInput): void {
    const { appId, teamId, epochId, fate, correlationId, triggerKind } = input
    const startedAt = turnStartedAt.get(memberKey(epochId, appId))
    turnStartedAt.delete(memberKey(epochId, appId))

    try {
      const team = store.getTeamById(teamId)
      const leadAppId = team?.leadAppId
      if (!leadAppId) return

      // The lead's own ending never wakes the lead — that is the whole loop
      // guard. It is also the earliest moment the lead is free again, so
      // anything piled up during the window goes out now rather than waiting
      // out the rest of it.
      if (appId === leadAppId) {
        const key = epochKey(teamId, epochId)
        const timer = flushTimer.get(key)
        if (timer) {
          clearTimeout(timer)
          flushTimer.delete(key)
        }
        void flush(teamId, epochId)
        return
      }

      if (correlationId && reported.has(correlationId)) return

      // A turn is witnessed on the machine that RAN it, so only that machine may
      // describe how it ended — otherwise a remote member's ending is announced
      // twice, once by its owner and once by whoever was waiting. The two fates
      // below are the exception: no turn ran anywhere, so the waiting side is the
      // only witness there will ever be.
      const member = store.getMember(teamId, appId)
      if (!member) return
      const witnessedElsewhere =
        isRemoteMember(member) && (fate.kind === 'ended' || fate.kind === 'error' || fate.kind === 'stopped')
      if (witnessedElsewhere) return

      // A person talking to their own member 1:1 is not team work — the same
      // line the module doc draws for CONTENT applies to whether this ending
      // is even worth a wake: the person is already watching that window, so
      // waking the lead for it too would just burn a turn for nothing.
      if (triggerKind === 'human_message') return

      // A sealed epoch has nobody left to coordinate.
      const epoch = store.getEpochById(epochId)
      if (!epoch || epoch.endedAt !== null) return

      if (correlationId) markReported(correlationId, epochId)

      const fact: StopFact = {
        memberName: member.memberName,
        fate,
        did:
          fate.kind !== 'never_ran' && startedAt !== undefined
            ? describeActs(teamId, appId, epochId, startedAt)
            : null,
      }

      const key = epochKey(teamId, epochId)
      const queue = pending.get(key) ?? []
      queue.push(fact)
      if (queue.length > FACTS_PER_NOTICE) queue.splice(0, queue.length - FACTS_PER_NOTICE)
      pending.set(key, queue)

      requestFlush(teamId, epochId)
    } catch (err) {
      // The lead not hearing must never take a member's turn down with it.
      console.error(`${LOG_TAG} noteTurnEnded failed:`, err)
    }
  }

  async function flush(teamId: string, epochId: string): Promise<void> {
    const key = epochKey(teamId, epochId)
    const facts = pending.get(key)
    if (!facts || facts.length === 0) return

    const leadAppId = store.getTeamById(teamId)?.leadAppId
    if (!leadAppId) {
      pending.delete(key)
      return
    }

    pending.delete(key)
    // Set BEFORE the await, not after it resolves: `requestFlush` reads this
    // synchronously to decide whether to coalesce. Several endings can land
    // back-to-back, all before `deliverRuntimeWake` below ever resolves — if
    // this were only set on success, every one of them would still see "no
    // recent flush" and each fire its own immediate wake, exactly the burst
    // this window exists to prevent.
    lastFlushAt.set(key, Date.now())
    const correlationId = randomUUID()
    try {
      await bus.deliverRuntimeWake({
        envelope: {
          id: randomUUID(),
          teamId,
          epochId,
          fromAppId: leadAppId,
          toAppId: leadAppId,
          body: renderNotice(facts),
          correlationId,
          createdAt: Date.now(),
        },
        trigger: { teamId, epochId, correlationId, fromAppId: null, wait: false, kind: 'member_stopped' },
        onBusy: 'buffer',
      })
      const wakes = (reportWakeCount.get(key) ?? 0) + 1
      reportWakeCount.set(key, wakes)
      if (wakes > REPORT_WAKE_CAP) bus.tripExternal(teamId, epochId, 'turnReportFlood')
    } catch (err) {
      // Put them back rather than swallow them: an ending nobody hears about is
      // the exact failure this module exists to prevent.
      pending.set(key, [...facts, ...(pending.get(key) ?? [])].slice(-FACTS_PER_NOTICE))
      console.error(`${LOG_TAG} could not reach the lead:`, err)
    }
  }

  function clearEpoch(epochId: string): void {
    for (const k of [...turnStartedAt.keys()]) {
      if (k.startsWith(`${epochId}:`)) turnStartedAt.delete(k)
    }
    for (const k of [...acts.keys()]) {
      if (k.startsWith(`${epochId}:`)) acts.delete(k)
    }
    for (const [corr, epoch] of reported) {
      if (epoch === epochId) reported.delete(corr)
    }
    for (const k of [...pending.keys()]) {
      if (k.endsWith(`:${epochId}`)) pending.delete(k)
    }
    for (const k of Array.from(lastFlushAt.keys())) {
      if (k.endsWith(`:${epochId}`)) lastFlushAt.delete(k)
    }
    for (const [k, timer] of Array.from(flushTimer)) {
      if (k.endsWith(`:${epochId}`)) {
        clearTimeout(timer)
        flushTimer.delete(k)
      }
    }
    for (const k of Array.from(reportWakeCount.keys())) {
      if (k.endsWith(`:${epochId}`)) reportWakeCount.delete(k)
    }
  }

  return { noteTurnStarted, noteTurnEnded, noteAct, clearEpoch }
}

/** One line, bounded — a failure message is passed through, a stack trace is not. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= FATE_MESSAGE_MAX) return flat
  return `${flat.slice(0, FATE_MESSAGE_MAX)}…`
}

function renderFate(fate: MemberTurnFate): string {
  switch (fate.kind) {
    case 'error':
      return `stopped with an error: ${oneLine(fate.message)}`
    case 'timeout':
      return 'was cut off for running past the turn time limit'
    case 'never_ran':
      return `never ran — the wake did not reach them: ${oneLine(fate.reason)}`
    case 'ended':
      return 'stopped with no error reported'
    case 'stopped':
      return 'was stopped by hand — not a failure, no need to chase it'
  }
}

function renderFact(fact: StopFact): string {
  let line = `- ${fact.memberName} — ${renderFate(fact.fate)}`
  if (fact.did === null) {
    // Not observed. Saying nothing here is the point: a claim about a turn we did
    // not watch would send the lead after someone who did the work.
  } else if (fact.did.length === 0) {
    line += ', and filed nothing during that turn — no message to anyone, no board write'
  } else {
    line += `. During that turn they: ${fact.did.join('; ')}`
  }
  line += '.'
  return line
}

/**
 * The notice itself. It ends by giving the lead explicit permission to do
 * nothing: a model woken with no reason to act will invent one, and a run full of
 * invented follow-ups is worse than the silence this replaced.
 */
function renderNotice(facts: readonly StopFact[]): string {
  return [
    '[System] Turn-end report. The system noticed these teammates stop — nobody sent this, ' +
      'and it contains nothing any of them said.',
    '',
    ...facts.map(renderFact),
    '',
    '"No error" means only that the turn ended without throwing. It is NOT a claim that the ' +
      'work is done: a model that stopped early ends exactly the same way. A member that ' +
      'stopped having filed nothing is the one worth asking about.',
    'Reassign, follow up, or end the run only if something actually needs it. If nothing does, ' +
      'end this turn without acting.',
  ].join('\n')
}
