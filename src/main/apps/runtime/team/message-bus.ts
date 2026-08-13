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
   * Immediate reachability of a member's OWNER at send time. True for a locally
   * owned member (always runnable) and for a remote owner that is currently online
   * + connected; false only when a remote owner is offline/unreachable. Absent →
   * treated as reachable (non-federated runtimes). Used by the wait=false path to
   * report a non-delivery NOW instead of a false "sent".
   */
  checkReachable?(appId: string, teamId: string): boolean
}

/**
 * Turn outcome. The result is the turn's final message (via onReply), not
 * a voluntary report call — report is only for escalation.
 */
export type TurnCompletion =
  | { kind: 'result'; content: string; taskId?: string }
  | { kind: 'escalation'; content: string }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
  // The wake never reached the target (owner offline/unreachable) or no completion
  // signal ever returned. Distinct from 'result' with empty content (a real but
  // silent reply) and from 'timeout' (reachable but slow): the sender must be able
  // to tell "not delivered" apart so it can reassign rather than assume a reply.
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
   * person's message rides this bus because that is how it reaches a member on
   * another machine, but it is not team traffic: it is delivered and nothing
   * else — no office record, no circuit charge, no flow signal.
   */
  fromAppId: string | null
  /** Member name, resolved to appId via the store. */
  to: string
  message: string
  wait?: boolean
  /** Guards against ping-pong: initial lead wake is 0, each completion-wake increments. */
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
   * receipt and does not charge the circuit breaker, but goes through the SAME
   * busy gate as `send`: the bus is the only component that knows whether a
   * session already has a turn running or a wake in flight, so a path that calls
   * the session layer directly can start a second concurrent turn on one session
   * key — which tears down the subprocess the first turn is still streaming.
   */
  deliverRuntimeWake(params: {
    envelope: TeamEnvelope
    trigger: TeamTriggerContext
    onBusy: BusyDisposition
  }): Promise<WakeDisposition>
  completeTurn(params: {
    sessionKey: string
    trigger: TeamTriggerContext
    outcome: TurnCompletion
  }): void
  assertCanContact(teamId: string, fromAppId: string, toAppId: string, collabMode: CollabMode): void
  resolveMemberAppId(teamId: string, memberName: string): string
  /**
   * Immediately resolve every wait=true pending entry targeting `appId` (e.g. a
   * member confirmed offline) so a blocked sender unblocks instead of hanging to
   * the sync-wait timeout. Returns how many waiters were resolved.
   */
  resolvePendingWaitsForMember(appId: string, outcome: TurnCompletion): number
  getEpochStats(epochId: string): EpochStats
  resetEpoch(epochId: string): void
  onBreach(listener: (event: CircuitBreachEvent) => void): () => void
  hasBufferedMessages(epochId: string): boolean
  /**
   * Liveness nudge: attempt one buffered delivery for a session that (may
   * have) just gone idle. `completeTurn` drains after every BUS-driven turn,
   * but a team session also runs turns the bus never sees — a human 1:1 chat
   * with a member occupies the same session key — and their completions must
   * drain the mailbox too, or mail buffered behind them strands forever. The
   * session layer calls this from its turn-end path; a busy/reserved session
   * is a no-op (the eventual completeTurn picks the mail up).
   */
  drainMailbox(sessionKey: string): void
}

export interface MessageBusDeps {
  store: TeamStore
  hooks: TeamDeliveryHooks
  circuitOverrides?: Partial<CircuitLimits>
  syncWaitTimeoutMs?: number
  /**
   * Append one act to the office record (the blackboard's activity stream).
   * Directed messages are recorded HERE rather than in the tool layer because
   * this is the one place every teammate message path converges — a member's
   * `team_send`, an escalation routed to the lead — so the record does not
   * depend on each caller remembering. Late-bound by the runtime factory (the
   * bus is constructed before the blackboard). Absent → no record kept.
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
  /** The sender, so an unblocked wait can be recorded as an answer TO someone. */
  fromAppId: string | null
  /** The target member, so a confirmed-offline member can unblock its waiters. */
  toAppId: string
}

interface BufferedDelivery {
  envelope: TeamEnvelope
  trigger: TeamTriggerContext
  appId: string
}

const DEFAULT_SYNC_WAIT_TIMEOUT_MS = TEAM_CIRCUIT_DEFAULTS.maxDurationMs

/**
 * Upper bound of buffered deliveries per busy member session. The mailbox is
 * volatile coordination state (never replicated, dropped on epoch seal), so an
 * unbounded buffer is pure OOM exposure under a runaway sender. Overflow sheds
 * the OLDEST entry with a warning: the newest instruction is the one most worth
 * keeping, and the blackboard — not the mailbox — is the durable driver a lead
 * falls back to for anything shed.
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
  const mailboxBuffers = new Map<string, BufferedDelivery[]>()
  const epochStats = new Map<string, EpochStats>()
  const breachListeners = new Set<(event: CircuitBreachEvent) => void>()
  // Session keys with a wake dispatched but the turn not yet completed. The
  // busy probe (hooks.isBusy) only turns true once the session layer REGISTERS
  // the turn, which happens asynchronously after wakeTarget is invoked — two
  // deliveries inside that window both read "idle" and race two concurrent
  // turns onto one session. Reserving the key SYNCHRONOUSLY before dispatch
  // closes the window: the second delivery buffers instead. Released by
  // completeTurn (every bus turn ends there, success or error) or on a wake
  // dispatch failure.
  const wakesInFlight = new Set<string>()
  // One pending mailbox recheck per session: a delivery buffered against a
  // busy probe can race the target going idle between the probe and the push
  // (no turn-end will fire for it). The recheck is a cheap backstop; the
  // turn-end drains (completeTurn + the session layer's drainMailbox) remain
  // the primary liveness path.
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

  function assertCanContact(
    teamId: string,
    fromAppId: string,
    toAppId: string,
    collabMode: CollabMode
  ): void {
    if (collabMode === 'free') return
    if (!store.isEdgeAllowed(teamId, fromAppId, toAppId)) {
      const target = store
        .listMembersByTeam(teamId)
        .find((m) => m.appId === toAppId)
      throw new TopologyError(target?.memberName ?? toAppId)
    }
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
   * Record that the turn a message started has ended. Append-only: this is a NEW
   * act pointing back at the message through its correlationId, never an edit of
   * the message row — which is what keeps "answered / awaiting reply" derivable
   * without a mutable status column, and keeps replication a single idempotent
   * insert.
   *
   * Only messages get an answer: a completion wake (fromAppId null) or a periodic
   * check answers nobody, so recording one would invent a reply.
   */
  function recordReply(trigger: TeamTriggerContext, finisherAppId: string, outcome: TurnCompletion): void {
    if (!trigger.fromAppId || trigger.kind !== 'message') return
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

  function bufferDelivery(sessionKey: string, entry: BufferedDelivery): void {
    const buffer = mailboxBuffers.get(sessionKey) ?? []
    if (buffer.length >= MAILBOX_BUFFER_CAP) {
      const shed = buffer.shift()
      console.warn(
        `${LOG_TAG} Mailbox full (${MAILBOX_BUFFER_CAP}); shed oldest: session=${sessionKey} messageId=${shed?.envelope.id}`
      )
    }
    buffer.push(entry)
    mailboxBuffers.set(sessionKey, buffer)
    console.log(`${LOG_TAG} Target busy, buffered: session=${sessionKey} bufferSize=${buffer.length}`)
    scheduleMailboxRecheck(sessionKey)
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

  /**
   * The single dispatch gate: buffer (or skip) if the target is mid-turn or a
   * wake is in flight; otherwise wake now. Every path that starts a team turn
   * goes through here, so the reservation below is the whole concurrency story.
   */
  async function deliver(
    env: TeamEnvelope,
    trigger: TeamTriggerContext,
    onBusy: BusyDisposition = 'buffer'
  ): Promise<WakeDisposition> {
    const sessionKey = buildTeamSessionKey(env.toAppId, env.teamId, env.epochId)
    if (hooks.isBusy(sessionKey) || wakesInFlight.has(sessionKey)) {
      if (onBusy === 'skip') {
        console.log(`${LOG_TAG} Target busy, skipped: session=${sessionKey} kind=${trigger.kind}`)
        return 'skipped'
      }
      bufferDelivery(sessionKey, { envelope: env, trigger, appId: env.toAppId })
      return 'buffered'
    }
    wakesInFlight.add(sessionKey)
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

  async function send(input: SendInput): Promise<TeamSendAsyncResult | TeamSendSyncResult> {
    const wait = input.wait ?? false
    const forwardDepth = input.forwardDepth ?? 0
    // Null = a person wrote this. Every piece of team bookkeeping below is gated
    // on it: the record, the budget and the flow signal all describe what the
    // digital humans do among themselves, and a person's chat is none of it.
    const fromAppId = input.fromAppId

    const toAppId = resolveMemberAppId(input.teamId, input.to)

    // Immediate outbound reachability gate (async sends only). A wait=false send to
    // a remote member whose owner is offline/unreachable will NEVER be delivered —
    // there is no persistent offline outbox — so report it NOW rather than a false
    // "sent" that only self-corrects at the hours-long backstop. A local or online
    // target proceeds normally (a busy-but-reachable target is buffered = queued);
    // the wait=true path keeps its richer three-state via the completion receipt.
    if (!wait && hooks.checkReachable && !hooks.checkReachable(toAppId, input.teamId)) {
      console.warn(
        `${LOG_TAG} send: target owner unreachable, not delivered: team=${input.teamId} to=${input.to} app=${toAppId}`
      )
      const messageId = randomUUID()
      // Recorded, not swallowed: "tried and did not arrive" is a different fact
      // from "never tried", and the sender's later digest must not nag about a
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
    // The budget guards AI loops, which a person cannot start: every message
    // they send costs them a keystroke, so charging one would only let a chat
    // burn the run's allowance and start its clock before the team even begins.
    if (fromAppId) chargeCircuit(input.teamId, input.epochId, forwardDepth)

    const correlationId = randomUUID()
    const envelope: TeamEnvelope = {
      id: randomUUID(),
      teamId: input.teamId,
      epochId: input.epochId,
      fromAppId,
      toAppId,
      body: input.message,
      wait,
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
      await deliver(envelope, trigger)
      return { messageId: envelope.id }
    }

    return new Promise<TeamSendSyncResult>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingWaits.delete(correlationId)) {
          console.warn(`${LOG_TAG} wait=true timed out: corr=${correlationId}`)
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
          console.error(`${LOG_TAG} wakeTarget failed for wait=true send:`, err)
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
      // The wait is over, so the record has to say so — otherwise the sender's
      // digest keeps reporting a message "still waiting" that nothing will
      // answer. A person's wait has no message row to close and no digest.
      if (pending.fromAppId) {
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
      // A confirmed-offline unblock keeps timeout semantics but tells the sender
      // explicitly that the teammate is gone so it can reassign (naming them so a
      // lead waiting on several teammates knows exactly who dropped).
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
        pending.resolve({
          from: pending.fromMemberName,
          message: outcome.kind === 'escalation' ? outcome.content : outcome.content,
          status: 'ok',
        })
      }
      resolved += 1
    }
    if (resolved > 0) {
      console.log(`${LOG_TAG} resolvePendingWaitsForMember: app=${appId} resolved=${resolved} outcome=${outcome.kind}`)
    }
    return resolved
  }

  function describeCompletion(outcome: TurnCompletion): string {
    switch (outcome.kind) {
      case 'result':
        return outcome.content.trim() || '(the teammate ended its turn without a message)'
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
    // The turn this wake reserved is over — release the key so the drain below
    // (and any new delivery) can dispatch the next turn.
    wakesInFlight.delete(sessionKey)
    console.log(
      `${LOG_TAG} completeTurn: session=${sessionKey} corr=${trigger.correlationId} ` +
        `wait=${trigger.wait} outcome=${outcome.kind}`
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

    if (trigger.wait) {
      resolvePendingWait(trigger.correlationId, outcome)
    } else if (trigger.fromAppId) {
      // Escalations are routed by the session layer, not re-woken as a peer completion.
      if (outcome.kind !== 'escalation') {
        const depth =
          (trigger as TeamTriggerContext & { forwardDepth?: number }).forwardDepth ?? 1
        const completionEnv: TeamEnvelope = {
          id: randomUUID(),
          teamId: trigger.teamId,
          epochId: trigger.epochId,
          fromAppId: finisherAppId,
          toAppId: trigger.fromAppId,
          body: describeCompletion(outcome),
          wait: false,
          correlationId: trigger.correlationId,
          taskRef: trigger.taskId,
          createdAt: Date.now(),
        }
        // fromAppId=null makes the sender's own turn end terminal (no reply loop).
        const completionTrigger: TeamTriggerContext = {
          teamId: trigger.teamId,
          epochId: trigger.epochId,
          correlationId: randomUUID(),
          fromAppId: null,
          wait: false,
          taskId: trigger.taskId,
          kind: 'completion',
        }
        ;(completionTrigger as TeamTriggerContext & { forwardDepth?: number }).forwardDepth = depth
        void deliver(completionEnv, completionTrigger).catch((err) => {
          console.error(`${LOG_TAG} Failed to wake sender with completion:`, err)
        })
      }
    }

    drainMailbox(sessionKey)
  }

  function drainMailbox(sessionKey: string): void {
    const buffer = mailboxBuffers.get(sessionKey)
    if (!buffer || buffer.length === 0) return
    if (hooks.isBusy(sessionKey) || wakesInFlight.has(sessionKey)) return

    const next = buffer.shift()!
    if (buffer.length === 0) mailboxBuffers.delete(sessionKey)
    console.log(`${LOG_TAG} Draining buffered envelope: session=${sessionKey} remaining=${buffer.length}`)
    wakesInFlight.add(sessionKey)
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
      if (key.endsWith(`:${epochId}`)) {
        droppedEnvelopes += mailboxBuffers.get(key)?.length ?? 0
        mailboxBuffers.delete(key)
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
