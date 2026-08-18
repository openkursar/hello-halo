/**
 * In-process message bus for team member coordination.
 *
 * Must NOT import the session layer (app-chat / orchestration / report-tool);
 * waking a target and observing busyness are injected via TeamDeliveryHooks.
 */

import { randomUUID } from 'crypto'
import { broadcastToAll } from '../../../http/websocket'
import { sendToRenderer } from '../../../foundation/window.service'
import {
  buildTeamSessionKey,
  TEAM_EVENTS,
  TEAM_CIRCUIT_DEFAULTS,
  toActivitySubject,
} from '../../../../shared/apps/team-types'
import { parseTeamSessionKey } from '../../../../shared/apps/im-keys'
import type { TeamStore } from '../../team'
import type { PostActivityInput } from './blackboard'
import type {
  CollabMode,
  TeamActivityStatus,
  TeamEnvelope,
  TeamTriggerContext,
  TeamSendAsyncResult,
  TeamSendSyncResult,
} from '../../../../shared/apps/team-types'

const LOG_TAG = '[TeamBus]'

function appIdFromSessionKey(sessionKey: string): string | null {
  return parseTeamSessionKey(sessionKey)?.appId ?? null
}

// ── Integration seam (implemented by the session layer) ─────────────────────

export interface TeamDeliveryHooks {
  /** Resolves when the turn is accepted/started, NOT when it finishes. */
  wakeTarget(params: {
    sessionKey: string
    appId: string
    teamId: string
    epochId: string
    envelope: TeamEnvelope
    trigger: TeamTriggerContext
  }): Promise<void>
  isBusy(sessionKey: string): boolean
  /**
   * Immediate reachability of a member's OWNER at send time. False only for a
   * remote owner that is offline/unreachable; a locally owned member is always
   * reachable. Absent → treated as reachable (non-federated runtimes).
   */
  checkReachable?(appId: string, teamId: string): boolean
}

/**
 * How a woken turn ENDED. A status, never a reply: nothing here is forwarded as
 * a message, since the only way to answer a teammate is an explicit `team_send`.
 * `result` content survives only for the completion receipt and the failure record.
 */
export type TurnCompletion =
  | { kind: 'result'; content: string; taskId?: string }
  | { kind: 'escalation'; content: string }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
  // The wake never reached the target, or no completion signal returned. Distinct
  // from 'result' with empty content (the turn ran and said nothing) and from
  // 'timeout' (reachable but slow), so the sender can decide to reassign.
  | { kind: 'undelivered'; reason: string }

// ── Bus errors ──────────────────────────────────────────────────────────────

/** Base class so the tool layer can detect bus rejections in one check. */
export class TeamBusError extends Error {}

export class TopologyError extends TeamBusError {
  constructor(public readonly toMemberName: string) {
    super(`You are not allowed to contact "${toMemberName}".`)
    this.name = 'TopologyError'
  }
}

export class UnknownMemberError extends TeamBusError {
  constructor(public readonly memberName: string) {
    super(`No member named "${memberName}" in this team.`)
    this.name = 'UnknownMemberError'
  }
}

export class CircuitBreakerError extends TeamBusError {
  constructor(public readonly reason: CircuitBreachReason, message: string) {
    super(message)
    this.name = 'CircuitBreakerError'
  }
}

// ── Circuit breaker ─────────────────────────────────────────────────────────

export type CircuitBreachReason = 'maxMessages' | 'maxForwardDepth' | 'maxDurationMs'

export interface CircuitLimits {
  maxMessages: number
  maxForwardDepth: number
  maxDurationMs: number
}

export interface EpochStats {
  messageCount: number
  maxForwardDepthSeen: number
  firstSendAt: number | null
  breached: boolean
  breachReason: CircuitBreachReason | null
}

export interface CircuitBreachEvent {
  teamId: string
  epochId: string
  reason: CircuitBreachReason
  limits: CircuitLimits
  stats: EpochStats
}

// ── Bus public API ──────────────────────────────────────────────────────────

export interface SendInput {
  teamId: string
  epochId: string
  /**
   * The teammate sending, or null when a PERSON is (a 1:1 member chat). A
   * person's message is delivered and nothing else — no office record, no
   * circuit charge, no flow signal.
   */
  fromAppId: string | null
  /** Member name, resolved to appId via the store. */
  to: string
  message: string
  /**
   * Hold the send until the woken turn ends, and resolve with a delivery receipt.
   *
   * Not a teammate primitive — `team_send` cannot set it. It exists for a
   * person's cross-machine 1:1 chat (`teamService.sendToMember`), whose UI must
   * be able to say "not delivered". The receipt reports status only; the reply
   * itself reaches the person through the member's own transcript.
   */
  wait?: boolean
  /** Guards against ping-pong: initial lead wake is 0, each forwarded wake increments. */
  forwardDepth?: number
  taskRef?: string
}

/**
 * What to do with a runtime wake whose target is already occupied.
 * - `buffer`: mailbox it and deliver when the current turn ends. For a wake that
 *   must not be lost (an escalation answer the member is blocked on).
 * - `skip`: drop it. For a wake that repeats on its own rhythm (a periodic
 *   check) — queueing those only piles up rounds the member already missed.
 */
export type BusyDisposition = 'buffer' | 'skip'

export type WakeDisposition = 'dispatched' | 'buffered' | 'skipped'

export interface MessageBus {
  send(input: SendInput): Promise<TeamSendAsyncResult | TeamSendSyncResult>
  /**
   * Start a turn the RUNTIME itself asked for (escalation resume, self-nudge,
   * periodic check) rather than a member's `team_send`. Carries no delivery
   * receipt and does not charge the circuit breaker, but must go through the
   * SAME busy gate as `send`: only the bus knows whether a session already has a
   * turn running or a wake in flight, and a second concurrent turn on one
   * session key tears down the subprocess the first is still streaming.
   */
  deliverRuntimeWake(params: {
    envelope: TeamEnvelope
    trigger: TeamTriggerContext
    onBusy: BusyDisposition
  }): Promise<WakeDisposition>
  /**
   * Run a turn this node was ASKED to run by another node — a federation wake
   * landing on the member's owner. Shares the busy gate and the mailbox with
   * every other delivery, and nothing else.
   *
   * It cannot go through `deliverRuntimeWake`: the turn's input was already
   * rendered and booked by the sending node, so re-entering `wakeTarget` would
   * render a second header, file a duplicate act, and sweep quiescence on a node
   * that does not own the run. Only the gate is needed here.
   *
   * `run` is invoked once a slot is free (immediately, or when the current turn
   * ends); its promise settles this call's and releases the slot. A hard epoch
   * reset rejects a still-queued run rather than stranding the caller.
   */
  runRelayedTurn<T>(params: { sessionKey: string; run: () => Promise<T> }): Promise<T>
  /**
   * A woken team turn ended. Releases the session's slot, drains its mailbox, and
   * records the outcome when it is a failure. It delivers NOTHING: a teammate
   * hears the turn's last words only if the member chose to `team_send` them.
   */
  completeTurn(params: {
    sessionKey: string
    trigger: TeamTriggerContext
    outcome: TurnCompletion
  }): void
  assertCanContact(teamId: string, fromAppId: string, toAppId: string, collabMode: CollabMode): void
  resolveMemberAppId(teamId: string, memberName: string): string
  /**
   * Resolve every pending completion receipt targeting `appId` (e.g. a member
   * confirmed offline) so a blocked caller unblocks instead of hanging to the
   * receipt timeout. Returns how many waiters were resolved.
   */
  resolvePendingWaitsForMember(appId: string, outcome: TurnCompletion): number
  getEpochStats(epochId: string): EpochStats
  resetEpoch(epochId: string): void
  onBreach(listener: (event: CircuitBreachEvent) => void): () => void
  hasBufferedMessages(epochId: string): boolean
  /**
   * Attempt one buffered delivery for a session that may have just gone idle.
   * `completeTurn` drains after every bus-driven turn, but a team session also
   * runs turns the bus never sees (a human 1:1 chat occupies the same session
   * key) and mail buffered behind those would strand forever. A busy/reserved
   * session is a no-op — the eventual `completeTurn` picks the mail up.
   */
  drainMailbox(sessionKey: string): void
}

export interface MessageBusDeps {
  store: TeamStore
  hooks: TeamDeliveryHooks
  circuitOverrides?: Partial<CircuitLimits>
  /** Ceiling on a completion receipt (`SendInput.wait`). Defaults to the run's max duration. */
  syncWaitTimeoutMs?: number
  /**
   * Append one act to the office record (the blackboard's activity stream).
   * Recorded here rather than in the tool layer because this is where every
   * teammate message path converges, so the record does not depend on each
   * caller remembering. Late-bound by the runtime factory (the bus is
   * constructed before the blackboard). Absent → no record kept.
   */
  recordActivity?: (input: PostActivityInput) => void
}

// ── Internal state ──────────────────────────────────────────────────────────

interface PendingWait {
  resolve: (result: TeamSendSyncResult) => void
  fromMemberName: string
  timer: NodeJS.Timeout
  forwardDepth: number
  teamId: string
  /** The epoch this wait belongs to, so resetEpoch only clears its own waiters. */
  epochId: string
  /** The sender, so a failed wait can be recorded against the right message. */
  fromAppId: string | null
  /** The target member, so a confirmed-offline member can unblock its waiters. */
  toAppId: string
}

/**
 * One queued turn for a busy session. Two shapes, one FIFO: an ENVELOPE is
 * dispatched through `hooks.wakeTarget` (the session layer renders and books it),
 * a RELAYED turn is already rendered and booked by the node that sent it and only
 * needs its `run` called. One queue, so a session has one line, one cap and one
 * drain regardless of where the work came from.
 */
type MailboxEntry =
  | { kind: 'envelope'; envelope: TeamEnvelope; trigger: TeamTriggerContext; appId: string }
  | {
      kind: 'relayed'
      /** Called with the session slot already reserved; releases it when it settles. */
      start: () => void
      /** The queue was discarded (epoch reset) — fail the caller rather than strand it. */
      cancel: (reason: string) => void
    }

const DEFAULT_SYNC_WAIT_TIMEOUT_MS = TEAM_CIRCUIT_DEFAULTS.maxDurationMs

/**
 * Upper bound of buffered deliveries per busy member session. The mailbox is
 * volatile (never replicated, dropped on epoch seal), so an unbounded buffer is
 * OOM exposure under a runaway sender. Overflow sheds the OLDEST entry: the
 * newest instruction is worth most, and the blackboard is the durable fallback
 * for anything shed.
 */
const MAILBOX_BUFFER_CAP = 128

/** Backstop recheck after buffering (see mailboxRechecks). */
const MAILBOX_RECHECK_MS = 3000

export function createMessageBus(deps: MessageBusDeps): MessageBus {
  const { store, hooks } = deps
  const limits: CircuitLimits = {
    maxMessages: deps.circuitOverrides?.maxMessages ?? TEAM_CIRCUIT_DEFAULTS.maxMessages,
    maxForwardDepth: deps.circuitOverrides?.maxForwardDepth ?? TEAM_CIRCUIT_DEFAULTS.maxForwardDepth,
    maxDurationMs: deps.circuitOverrides?.maxDurationMs ?? TEAM_CIRCUIT_DEFAULTS.maxDurationMs,
  }
  const syncWaitTimeoutMs = deps.syncWaitTimeoutMs ?? DEFAULT_SYNC_WAIT_TIMEOUT_MS

  const pendingWaits = new Map<string, PendingWait>()
  const mailboxBuffers = new Map<string, MailboxEntry[]>()
  const epochStats = new Map<string, EpochStats>()
  const breachListeners = new Set<(event: CircuitBreachEvent) => void>()
  // Session keys with a turn dispatched but not yet completed. `hooks.isBusy`
  // only turns true once the session layer registers the turn, asynchronously
  // after dispatch — two deliveries inside that window both read "idle" and race
  // two turns onto one session. Reserving the key synchronously at dispatch
  // closes it. Released by completeTurn, by a relayed turn settling, or on a
  // dispatch failure.
  const wakesInFlight = new Set<string>()
  // One pending recheck per session: a delivery buffered against a busy probe can
  // race the target going idle between the probe and the push, and no turn-end
  // fires for it. A backstop only — the turn-end drains stay the primary path.
  const mailboxRechecks = new Map<string, NodeJS.Timeout>()

  function statsFor(epochId: string): EpochStats {
    let s = epochStats.get(epochId)
    if (!s) {
      s = { messageCount: 0, maxForwardDepthSeen: 0, firstSendAt: null, breached: false, breachReason: null }
      epochStats.set(epochId, s)
    }
    return s
  }

  function trip(teamId: string, epochId: string, reason: CircuitBreachReason): void {
    const stats = statsFor(epochId)
    if (!stats.breached) {
      stats.breached = true
      stats.breachReason = reason
      console.warn(`${LOG_TAG} Circuit breaker tripped: epoch=${epochId} reason=${reason}`)
      const event: CircuitBreachEvent = { teamId, epochId, reason, limits, stats: { ...stats } }
      for (const listener of breachListeners) {
        try {
          listener(event)
        } catch (err) {
          console.error(`${LOG_TAG} onBreach listener threw:`, err)
        }
      }
    }
  }

  function chargeCircuit(teamId: string, epochId: string, forwardDepth: number): void {
    const stats = statsFor(epochId)
    const now = Date.now()
    if (stats.firstSendAt === null) stats.firstSendAt = now

    if (now - stats.firstSendAt > limits.maxDurationMs) {
      trip(teamId, epochId, 'maxDurationMs')
      throw new CircuitBreakerError(
        'maxDurationMs',
        `Team epoch exceeded its maximum duration (${limits.maxDurationMs}ms). The run has been stopped.`
      )
    }
    if (forwardDepth > limits.maxForwardDepth) {
      trip(teamId, epochId, 'maxForwardDepth')
      throw new CircuitBreakerError(
        'maxForwardDepth',
        `Message forwarding depth limit reached (${limits.maxForwardDepth}). Stopping to prevent a loop.`
      )
    }
    if (stats.messageCount >= limits.maxMessages) {
      trip(teamId, epochId, 'maxMessages')
      throw new CircuitBreakerError(
        'maxMessages',
        `Team message limit reached (${limits.maxMessages} per run). The run has been stopped.`
      )
    }

    stats.messageCount += 1
    if (forwardDepth > stats.maxForwardDepthSeen) stats.maxForwardDepthSeen = forwardDepth
  }

  function resolveMemberAppId(teamId: string, memberName: string): string {
    const member = store.getMemberByName(teamId, memberName)
    if (!member) throw new UnknownMemberError(memberName)
    return member.appId
  }

  /**
   * Topology governs who may OPEN a conversation — never who may answer one.
   *
   * Edges are directed and the default structured topology is a one-way star
   * (`lead → member`, `service.defaultEdges`), so a forward-only check would
   * refuse a member's answer to the lead that dispatched the work. Hence the
   * reverse edge counts too: you can reach anyone who can reach you. Peer-to-peer
   * still needs a peer edge, and `free` allows everything.
   */
  function assertCanContact(
    teamId: string,
    fromAppId: string,
    toAppId: string,
    collabMode: CollabMode
  ): void {
    if (collabMode === 'free') return
    if (store.isEdgeAllowed(teamId, fromAppId, toAppId)) return
    if (store.isEdgeAllowed(teamId, toAppId, fromAppId)) return
    const target = store.listMembersByTeam(teamId).find((m) => m.appId === toAppId)
    throw new TopologyError(target?.memberName ?? toAppId)
  }

  function memberNameOf(teamId: string, appId: string): string {
    return store.listMembersByTeam(teamId).find((m) => m.appId === appId)?.memberName ?? appId
  }

  function emitMessageEvent(env: TeamEnvelope, fromAppId: string): void {
    const payload = {
      teamId: env.teamId,
      epochId: env.epochId,
      fromAppId,
      toAppId: env.toAppId,
      fromMemberName: memberNameOf(env.teamId, fromAppId),
      toMemberName: memberNameOf(env.teamId, env.toAppId),
      messageId: env.id,
      ts: env.createdAt,
    }
    broadcastToAll(TEAM_EVENTS.message, payload)
    sendToRenderer(TEAM_EVENTS.message, payload)
  }

  /** Never let bookkeeping break coordination: the act already happened. */
  function recordActivity(input: PostActivityInput): void {
    if (!deps.recordActivity) return
    try {
      deps.recordActivity(input)
    } catch (err) {
      console.error(`${LOG_TAG} recordActivity failed (the act itself stands):`, err)
    }
  }

  /** How the turn a message started ended, in the record's vocabulary. */
  function replyStatusOf(outcome: TurnCompletion): TeamActivityStatus {
    switch (outcome.kind) {
      case 'result':
        return 'ok'
      case 'escalation':
        return 'escalation'
      case 'error':
        return 'error'
      case 'timeout':
        return 'timeout'
      case 'undelivered':
        return 'undelivered'
    }
  }

  /**
   * Whether a message's fate is one the sender cannot learn any other way — the
   * endings the member cannot report itself because it is not running. A turn
   * that ran reports itself: its `team_send` files its own act, and an escalation
   * routes on its own path.
   */
  function isRecordableFate(outcome: TurnCompletion): boolean {
    return outcome.kind === 'error' || outcome.kind === 'timeout' || outcome.kind === 'undelivered'
  }

  /**
   * Record the FATE of a message whose turn has ended, only when that fate is a
   * failure — the endings the sender cannot learn any other way. A turn that ran
   * reports itself, and filing its closing line here would quote it back at the
   * sender as if it were an answer.
   *
   * Append-only, keyed by correlationId, so replication stays one idempotent
   * insert.
   */
  function recordReply(trigger: TeamTriggerContext, finisherAppId: string, outcome: TurnCompletion): void {
    if (!trigger.fromAppId || trigger.kind !== 'message') return
    if (!isRecordableFate(outcome)) return
    recordActivity({
      teamId: trigger.teamId,
      epochId: trigger.epochId,
      kind: 'reply',
      actorAppId: finisherAppId,
      targetAppId: trigger.fromAppId,
      subject: toActivitySubject(describeCompletion(outcome)),
      correlationId: trigger.correlationId,
      status: replyStatusOf(outcome),
    })
  }

  function describeMailboxEntry(entry: MailboxEntry): string {
    return entry.kind === 'envelope' ? `messageId=${entry.envelope.id}` : 'relayed turn'
  }

  function bufferEntry(sessionKey: string, entry: MailboxEntry): void {
    const buffer = mailboxBuffers.get(sessionKey) ?? []
    if (buffer.length >= MAILBOX_BUFFER_CAP) {
      const shed = buffer.shift()
      console.warn(
        `${LOG_TAG} Mailbox full (${MAILBOX_BUFFER_CAP}); shed oldest: session=${sessionKey} ` +
          `${shed ? describeMailboxEntry(shed) : ''}`
      )
      // A shed relayed turn has a caller on another node holding a promise;
      // failing it now beats leaving it to a backstop measured in hours.
      if (shed?.kind === 'relayed') shed.cancel('mailbox overflow')
    }
    buffer.push(entry)
    mailboxBuffers.set(sessionKey, buffer)
    console.log(
      `${LOG_TAG} Target busy, buffered: session=${sessionKey} ` +
        `${describeMailboxEntry(entry)} bufferSize=${buffer.length}`
    )
    scheduleMailboxRecheck(sessionKey)
  }

  /**
   * Take the session's single turn slot, or report that it is taken. A session
   * runs at most one turn, whoever asked for it and from whichever machine.
   */
  function tryReserve(sessionKey: string): boolean {
    if (hooks.isBusy(sessionKey) || wakesInFlight.has(sessionKey)) return false
    wakesInFlight.add(sessionKey)
    return true
  }

  function releaseAndDrain(sessionKey: string): void {
    wakesInFlight.delete(sessionKey)
    drainMailbox(sessionKey)
  }

  function scheduleMailboxRecheck(sessionKey: string): void {
    if (mailboxRechecks.has(sessionKey)) return
    const timer = setTimeout(() => {
      mailboxRechecks.delete(sessionKey)
      drainMailbox(sessionKey)
    }, MAILBOX_RECHECK_MS)
    if (typeof timer.unref === 'function') timer.unref()
    mailboxRechecks.set(sessionKey, timer)
  }

  async function deliver(
    env: TeamEnvelope,
    trigger: TeamTriggerContext,
    onBusy: BusyDisposition = 'buffer'
  ): Promise<WakeDisposition> {
    const sessionKey = buildTeamSessionKey(env.toAppId, env.teamId, env.epochId)
    if (!tryReserve(sessionKey)) {
      if (onBusy === 'skip') {
        console.log(`${LOG_TAG} Target busy, skipped: session=${sessionKey} kind=${trigger.kind}`)
        return 'skipped'
      }
      bufferEntry(sessionKey, { kind: 'envelope', envelope: env, trigger, appId: env.toAppId })
      return 'buffered'
    }
    try {
      await hooks.wakeTarget({
        sessionKey,
        appId: env.toAppId,
        teamId: env.teamId,
        epochId: env.epochId,
        envelope: env,
        trigger,
      })
    } catch (err) {
      // The dispatch itself failed — no turn is running and no completeTurn
      // will come. Release the reservation or the session key stays fake-busy
      // and every later delivery strands in the mailbox.
      wakesInFlight.delete(sessionKey)
      throw err
    }
    return 'dispatched'
  }

  function deliverRuntimeWake(params: {
    envelope: TeamEnvelope
    trigger: TeamTriggerContext
    onBusy: BusyDisposition
  }): Promise<WakeDisposition> {
    return deliver(params.envelope, params.trigger, params.onBusy)
  }

  function runRelayedTurn<T>(params: { sessionKey: string; run: () => Promise<T> }): Promise<T> {
    const { sessionKey, run } = params
    return new Promise<T>((resolve, reject) => {
      // Called with the slot already reserved by whoever dequeued us; it is ours
      // to hand back on every exit, or the session stays fake-busy forever.
      const start = (): void => {
        let running: Promise<T>
        try {
          running = run()
        } catch (err) {
          releaseAndDrain(sessionKey)
          reject(err)
          return
        }
        running.then(
          (value) => {
            releaseAndDrain(sessionKey)
            resolve(value)
          },
          (err) => {
            releaseAndDrain(sessionKey)
            reject(err)
          }
        )
      }

      if (tryReserve(sessionKey)) {
        console.log(`${LOG_TAG} Relayed turn dispatched: session=${sessionKey}`)
        start()
        return
      }
      bufferEntry(sessionKey, {
        kind: 'relayed',
        start,
        cancel: (reason) => reject(new Error(`Relayed turn dropped before it ran: ${reason}`)),
      })
    })
  }

  async function send(input: SendInput): Promise<TeamSendAsyncResult | TeamSendSyncResult> {
    const wait = input.wait ?? false
    const forwardDepth = input.forwardDepth ?? 0
    // Null = a person wrote this; every piece of team bookkeeping below is gated
    // on it.
    const fromAppId = input.fromAppId

    const toAppId = resolveMemberAppId(input.teamId, input.to)

    // There is no persistent offline outbox, so a send to an unreachable owner
    // will never arrive: report it now instead of a false "sent" that only
    // self-corrects at the hours-long backstop. Receipted sends skip this — their
    // completion receipt already carries the richer three-state.
    if (!wait && hooks.checkReachable && !hooks.checkReachable(toAppId, input.teamId)) {
      console.warn(
        `${LOG_TAG} send: target owner unreachable, not delivered: team=${input.teamId} to=${input.to} app=${toAppId}`
      )
      const messageId = randomUUID()
      // Recorded, not swallowed, so the sender's digest does not nag about a
      // reply that can never come.
      if (fromAppId) {
        recordActivity({
          teamId: input.teamId,
          epochId: input.epochId,
          id: messageId,
          kind: 'message',
          actorAppId: fromAppId,
          targetAppId: toAppId,
          subject: toActivitySubject(input.message),
          body: input.message,
          refId: messageId,
          status: 'undelivered',
        })
      }
      return { messageId, delivery: 'undelivered' }
    }

    // Topology is enforced at the tool layer (assertCanContact before send).
    // The budget guards AI loops, which a person cannot start — charging their
    // chat would only burn the run's allowance and start its clock early.
    if (fromAppId) chargeCircuit(input.teamId, input.epochId, forwardDepth)

    const correlationId = randomUUID()
    const envelope: TeamEnvelope = {
      id: randomUUID(),
      teamId: input.teamId,
      epochId: input.epochId,
      fromAppId,
      toAppId,
      body: input.message,
      correlationId,
      taskRef: input.taskRef,
      createdAt: Date.now(),
    }
    if (fromAppId) {
      emitMessageEvent(envelope, fromAppId)
      // The envelope id doubles as the act's id, so the live UI signal and the
      // durable record refer to the same message rather than two ids for one send.
      recordActivity({
        teamId: input.teamId,
        epochId: input.epochId,
        id: envelope.id,
        kind: 'message',
        actorAppId: fromAppId,
        targetAppId: toAppId,
        subject: toActivitySubject(input.message),
        body: input.message,
        refId: envelope.id,
        correlationId,
        status: 'sent',
      })
    }

    const trigger: TeamTriggerContext = {
      teamId: input.teamId,
      epochId: input.epochId,
      correlationId,
      fromAppId,
      wait,
      taskId: input.taskRef,
      kind: fromAppId ? 'message' : 'human_message',
    }
    ;(trigger as TeamTriggerContext & { forwardDepth?: number }).forwardDepth = forwardDepth + 1

    console.log(
      `${LOG_TAG} send: team=${input.teamId} epoch=${input.epochId} ` +
        `from=${fromAppId ?? 'person'} to=${input.to}(${toAppId}) wait=${wait} depth=${forwardDepth}`
    )

    if (!wait) {
      const disposition = await deliver(envelope, trigger)
      // Nothing is auto-delivered back, so this receipt is all the sender ever
      // learns: distinguishing "queued behind their current turn" from "handed
      // over now" lets a lead pick someone else instead of waiting.
      return disposition === 'buffered'
        ? { messageId: envelope.id, delivery: 'queued' }
        : { messageId: envelope.id }
    }

    return new Promise<TeamSendSyncResult>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingWaits.delete(correlationId)) {
          console.warn(`${LOG_TAG} completion receipt timed out: corr=${correlationId}`)
          resolve({ from: input.to, message: '', status: 'timeout' })
        }
      }, syncWaitTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      pendingWaits.set(correlationId, {
        resolve,
        fromMemberName: input.to,
        timer,
        forwardDepth,
        teamId: input.teamId,
        epochId: input.epochId,
        fromAppId,
        toAppId,
      })

      // Register the waiter before delivering so a synchronous completion races safely.
      void deliver(envelope, trigger).catch((err) => {
        const pending = pendingWaits.get(correlationId)
        if (pending) {
          clearTimeout(pending.timer)
          pendingWaits.delete(correlationId)
          console.error(`${LOG_TAG} wakeTarget failed for a receipted send:`, err)
          pending.resolve({ from: input.to, message: '', status: 'timeout' })
        }
      })
    })
  }

  function resolvePendingWait(correlationId: string, outcome: TurnCompletion): boolean {
    const pending = pendingWaits.get(correlationId)
    if (!pending) return false
    clearTimeout(pending.timer)
    pendingWaits.delete(correlationId)

    if (outcome.kind === 'timeout') {
      pending.resolve({ from: pending.fromMemberName, message: '', status: 'timeout' })
    } else if (outcome.kind === 'undelivered') {
      // Never delivered / no completion — surface as a non-ok status so the sender
      // reassigns instead of reading an empty string as a reply.
      pending.resolve({
        from: pending.fromMemberName,
        message: 'This message was not delivered (the teammate is offline or unreachable).',
        status: 'undelivered',
      })
    } else if (outcome.kind === 'error') {
      pending.resolve({
        from: pending.fromMemberName,
        message: `The teammate's turn failed: ${outcome.message}`,
        status: 'ok',
      })
    } else {
      pending.resolve({ from: pending.fromMemberName, message: outcome.content, status: 'ok' })
    }
    return true
  }

  function resolvePendingWaitsForMember(appId: string, outcome: TurnCompletion): number {
    let resolved = 0
    for (const [corr, pending] of pendingWaits) {
      if (pending.toAppId !== appId) continue
      clearTimeout(pending.timer)
      pendingWaits.delete(corr)
      // This path only fires on a confirmed failure, and that failure is the one
      // thing the sender cannot learn from its own turn. A person's wait has no
      // message row to file it against.
      if (pending.fromAppId && isRecordableFate(outcome)) {
        recordActivity({
          teamId: pending.teamId,
          epochId: pending.epochId,
          kind: 'reply',
          actorAppId: pending.toAppId,
          targetAppId: pending.fromAppId,
          subject: toActivitySubject(describeCompletion(outcome)),
          correlationId: corr,
          status: replyStatusOf(outcome),
        })
      }
      // A confirmed-offline unblock keeps timeout semantics but names the teammate,
      // so a lead waiting on several knows exactly who dropped.
      if (outcome.kind === 'timeout') {
        pending.resolve({
          from: pending.fromMemberName,
          message: `"${pending.fromMemberName}" just went offline and cannot finish this now — reassign the work to an available teammate or hold it; do not keep waiting on them.`,
          status: 'timeout',
        })
      } else if (outcome.kind === 'undelivered') {
        pending.resolve({
          from: pending.fromMemberName,
          message: `"${pending.fromMemberName}" is offline — this message was not delivered. Reassign the work or retry once they are back online.`,
          status: 'undelivered',
        })
      } else if (outcome.kind === 'error') {
        pending.resolve({
          from: pending.fromMemberName,
          message: `The teammate's turn failed: ${outcome.message}`,
          status: 'ok',
        })
      } else {
        pending.resolve({ from: pending.fromMemberName, message: outcome.content, status: 'ok' })
      }
      resolved += 1
    }
    if (resolved > 0) {
      console.log(`${LOG_TAG} resolvePendingWaitsForMember: app=${appId} resolved=${resolved} outcome=${outcome.kind}`)
    }
    return resolved
  }

  /** How a turn ended, for a receipt or a record — never for delivery to a teammate. */
  function describeCompletion(outcome: TurnCompletion): string {
    switch (outcome.kind) {
      case 'result':
        return outcome.content.trim() || '(the member ended its turn without a message)'
      case 'escalation':
        return outcome.content
      case 'error':
        return `The member's turn failed: ${outcome.message}`
      case 'timeout':
        return 'The member did not finish in time (timeout). Read the board to reconcile.'
      case 'undelivered':
        return 'The message was not delivered (the member is offline or unreachable). Reassign or retry later.'
      default:
        return '(no result)'
    }
  }

  function completeTurn(params: {
    sessionKey: string
    trigger: TeamTriggerContext
    outcome: TurnCompletion
  }): void {
    const { trigger, outcome, sessionKey } = params
    // Released before the epoch guard below: a sealed epoch must not leave the
    // session fake-busy forever.
    wakesInFlight.delete(sessionKey)
    console.log(
      `${LOG_TAG} completeTurn: session=${sessionKey} corr=${trigger.correlationId} ` +
        `receipted=${!!trigger.wait} outcome=${outcome.kind}`
    )

    // Key on the epoch's own endedAt, NOT team.currentEpochId: conversation
    // epochs (IM) deliberately don't occupy currentEpochId but must still route.
    const team = store.getTeamById(trigger.teamId)
    const epoch = store.getEpochById(trigger.epochId)
    if (!team || !epoch || epoch.endedAt !== null) {
      console.log(
        `${LOG_TAG} completeTurn dropped (epoch sealed/missing): epoch=${trigger.epochId} ` +
          `ended=${epoch?.endedAt ?? 'n/a'}`
      )
      return
    }

    const finisherAppId = appIdFromSessionKey(sessionKey) ?? trigger.fromAppId ?? ''
    if (finisherAppId) recordReply(trigger, finisherAppId, outcome)

    // The one thing a completion may resolve: a receipt someone is holding. Never
    // a teammate — one chat window has two listeners (the person and the
    // teammate) and nothing here can tell which the member's closing line meant,
    // so a teammate hears back only through an explicit `team_send`.
    if (trigger.wait) resolvePendingWait(trigger.correlationId, outcome)

    drainMailbox(sessionKey)
  }

  function drainMailbox(sessionKey: string): void {
    const buffer = mailboxBuffers.get(sessionKey)
    if (!buffer || buffer.length === 0) return
    if (hooks.isBusy(sessionKey) || wakesInFlight.has(sessionKey)) {
      // Re-arm: this recheck is already consumed, so leaving now would pin the
      // mail on the current turn ending — a turn that may hang for minutes.
      scheduleMailboxRecheck(sessionKey)
      return
    }

    const next = buffer.shift()!
    if (buffer.length === 0) mailboxBuffers.delete(sessionKey)
    console.log(
      `${LOG_TAG} Draining mailbox: session=${sessionKey} ` +
        `${describeMailboxEntry(next)} remaining=${buffer.length}`
    )
    wakesInFlight.add(sessionKey)

    if (next.kind === 'relayed') {
      // Already rendered and booked by the node that sent it: just run it. It
      // releases the slot and drains the next entry when it settles.
      next.start()
      return
    }

    void hooks
      .wakeTarget({
        sessionKey,
        appId: next.appId,
        teamId: next.envelope.teamId,
        epochId: next.envelope.epochId,
        envelope: next.envelope,
        trigger: next.trigger,
      })
      .catch((err) => {
        wakesInFlight.delete(sessionKey)
        console.error(`${LOG_TAG} Failed to deliver buffered envelope:`, err)
        // The rest of the buffer must not strand behind a failed dispatch.
        scheduleMailboxRecheck(sessionKey)
      })
  }

  function getEpochStats(epochId: string): EpochStats {
    return { ...statsFor(epochId) }
  }

  function resetEpoch(epochId: string): void {
    epochStats.delete(epochId)
    // Filter by epoch so a concurrent epoch's pending sends aren't falsely timed out.
    for (const [corr, pending] of pendingWaits) {
      if (pending.epochId !== epochId) continue
      clearTimeout(pending.timer)
      pending.resolve({ from: pending.fromMemberName, message: '', status: 'timeout' })
      pendingWaits.delete(corr)
    }
    // A hard seal abandons undelivered deliveries (re-waking would reignite the
    // run we're stopping); count the drop so it isn't silent.
    let droppedEnvelopes = 0
    for (const key of [...mailboxBuffers.keys()]) {
      if (!key.endsWith(`:${epochId}`)) continue
      const dropped = mailboxBuffers.get(key) ?? []
      droppedEnvelopes += dropped.length
      mailboxBuffers.delete(key)
      // A queued relayed turn has a caller on another node awaiting completion;
      // dropping it silently would hang that node until its hours-long backstop.
      for (const entry of dropped) {
        if (entry.kind === 'relayed') entry.cancel('the run was stopped')
      }
    }
    for (const [key, timer] of [...mailboxRechecks]) {
      if (key.endsWith(`:${epochId}`)) {
        clearTimeout(timer)
        mailboxRechecks.delete(key)
      }
    }
    for (const key of [...wakesInFlight]) {
      if (key.endsWith(`:${epochId}`)) wakesInFlight.delete(key)
    }
    if (droppedEnvelopes > 0) {
      console.warn(
        `${LOG_TAG} resetEpoch dropped ${droppedEnvelopes} undelivered buffered envelope(s): epoch=${epochId}`
      )
    }
  }

  function onBreach(listener: (event: CircuitBreachEvent) => void): () => void {
    breachListeners.add(listener)
    return () => breachListeners.delete(listener)
  }

  function hasBufferedMessages(epochId: string): boolean {
    for (const key of mailboxBuffers.keys()) {
      if (key.endsWith(`:${epochId}`)) {
        const buf = mailboxBuffers.get(key)
        if (buf && buf.length > 0) return true
      }
    }
    return false
  }

  return {
    send,
    deliverRuntimeWake,
    runRelayedTurn,
    completeTurn,
    assertCanContact,
    resolveMemberAppId,
    resolvePendingWaitsForMember,
    getEpochStats,
    resetEpoch,
    onBreach,
    hasBufferedMessages,
    drainMailbox,
  }
}
