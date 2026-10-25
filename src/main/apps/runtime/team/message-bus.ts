/**
 * In-process message bus for team member coordination.
 *
 * Must NOT import the session layer (app-chat / orchestration / report-tool);
 * waking a target and observing busyness are injected via TeamDeliveryHooks.
 */

import { randomUUID } from 'crypto'
import { broadcastToAll } from '../../../http/websocket'
import { sendToRenderer } from '../../../foundation/window.service'
import { createTurnGate } from '../../../platform/turn-gate'
import type { TurnGate, BusyDisposition, DeliverDisposition } from '../../../platform/turn-gate'
import {
  buildTeamSessionKey,
  TEAM_EVENTS,
  TEAM_CIRCUIT_DEFAULTS,
  toActivitySubject,
  isRemoteMember,
  parseSpaceCoordinatorAppId,
} from '../../../../shared/apps/team-types'
import { parseTeamSessionKey } from '../../../../shared/apps/im-keys'
import type { TeamStore } from '../../team'
import type { PostActivityInput } from './blackboard'
import type {
  CollabMode,
  TeamActivityStatus,
  TeamEnvelope,
  TeamRequestOrigin,
  TeamTriggerContext,
  TeamSendAsyncResult,
  TeamSendSyncResult,
} from '../../../../shared/apps/team-types'

const LOG_TAG = '[TeamBus]'

function appIdFromSessionKey(sessionKey: string): string | null {
  return parseTeamSessionKey(sessionKey)?.appId ?? null
}

// ── Integration seam (implemented by the session layer) ─────────────────────

/** How a coordinating conversation took a message: a turn of its own, inside its running turn, or queued. */
export type CoordinatorDisposition = Extract<DeliverDisposition, 'dispatched' | 'mid_turn' | 'buffered'>

export interface TeamDeliveryHooks {
  /** Resolves when the turn is accepted/started, NOT when it finishes. */
  wakeTarget(params: {
    sessionKey: string
    appId: string
    teamId: string
    epochId: string
    envelope: TeamEnvelope
    trigger: TeamTriggerContext
    deliveries?: readonly TeamDelivery[]
  }): Promise<void>
  isBusy(sessionKey: string): boolean
  getTurnIdentity?(sessionKey: string): string | undefined
  /**
   * Hand the envelope to the turn the target is ALREADY running, instead of
   * queueing it behind that turn. Synchronous, and false when it could not
   * land — the gate then buffers exactly as before.
   *
   * The gate decides WHEN this is allowed (see `platform/turn-gate`); this hook
   * only renders the envelope and hands it over. It starts no turn, so nothing
   * completes for it: `completeTurn` will settle the turn the message joined,
   * against that turn's own trigger, not this one.
   */
  deliverMidTurn?(params: {
    sessionKey: string
    appId: string
    teamId: string
    epochId: string
    envelope: TeamEnvelope
    trigger: TeamTriggerContext
    deliveries?: readonly TeamDelivery[]
  }): boolean
  /** Durable owner-side delivery; undefined means the target is local. */
  deliverRemote?(params: { sessionKey: string; envelope: TeamEnvelope; trigger: TeamTriggerContext; coalescingKey?: string; onCompletion: (outcome: TurnCompletion) => void }): boolean | undefined
  /**
   * Immediate reachability of a member's OWNER at send time. False only for a
   * remote owner that is offline/unreachable; a locally owned member is always
   * reachable. Absent → treated as reachable (non-federated runtimes).
   */
  checkReachable?(appId: string, teamId: string): boolean
  /**
   * Deliver an envelope addressed to a SPACE COORDINATOR — the space
   * conversation coordinating an ephemeral collaboration. There is no member
   * session behind that sentinel appId, so the turn gate plays no part: the
   * space conversation has its own exclusivity (a busy one queues the message
   * itself), and no completion ever comes back through `completeTurn`. Absent →
   * such a send fails loudly instead of waking a phantom app-chat session.
   * Resolves with how the conversation took it.
   */
  deliverToCoordinator?(params: { envelope: TeamEnvelope; trigger: TeamTriggerContext; coalescingKey?: string }): Promise<CoordinatorDisposition>
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

export type CircuitBreachReason = 'maxMessages' | 'maxForwardDepth' | 'turnReportFlood'

export interface CircuitLimits {
  maxMessages: number
  maxForwardDepth: number
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
  /**
   * Where the message's request came from, when not the owner's own machine: a
   * person's 1:1 from another machine, or a guest's request a restricted turn
   * passes on, which stays the guest's through the owner's own digital humans.
   * Travels with the message like `forwardDepth` does (see
   * {@link TeamTriggerContext.origin}).
   */
  origin?: TeamRequestOrigin
  taskRef?: string
}

/** Whole-run restarts may skip; addressed messages always use buffer/live delivery. */
export type { BusyDisposition }

export type WakeDisposition = DeliverDisposition | 'remote_accepted'

export interface MessageBus {
  send(input: SendInput): Promise<TeamSendAsyncResult | TeamSendSyncResult>
  /**
   * Start a turn the RUNTIME itself asked for (escalation resume, self-nudge,
   * periodic check, turn-end report) rather than a member's `team_send`. Carries no delivery
   * receipt and does not charge the circuit breaker, but must go through the
   * SAME busy gate as `send`: only the bus knows whether a session already has a
   * turn running or a wake in flight, and a second concurrent turn on one
   * session key tears down the subprocess the first is still streaming.
   */
  deliverRuntimeWake(params: {
    envelope: TeamEnvelope
    trigger: TeamTriggerContext
    onBusy: BusyDisposition
    coalescingKey?: string
  }): Promise<WakeDisposition>
  /** A held turn is now ready to accept compatible buffered messages. */
  notifySessionReady(sessionKey: string): void
  /**
   * A person stopped this session's work. Their own messages still waiting are
   * void (their receipts settled) and returned for the record; everything else
   * waits for the next turn of this session.
   */
  holdSession(sessionKey: string): TeamDelivery[]
  /**
   * Deliveries taken back from a stopped turn before the member read them, put
   * ahead of later mail. A receipt still waiting reads as queued, as for any
   * message that has to wait for a turn.
   */
  returnDeliveries(sessionKey: string, deliveries: readonly TeamDelivery[]): void
  /**
   * A person's stop held a woken turn back before the member read any of it: its
   * slot is handed back, the person's own words are void (receipts settled), and
   * the rest is returned as by {@link returnDeliveries}. Returns the voided ones.
   */
  returnHeldBack(sessionKey: string, deliveries: readonly TeamDelivery[]): TeamDelivery[]
  /** Reserve an exclusive callback; message delivery uses the identity-aware inbox instead. */
  runRelayedTurn<T>(params: { sessionKey: string; run: () => Promise<T> }): Promise<T>
  /**
   * A woken team turn ended. Releases the session's slot, drains its mailbox, and
   * records the outcome when it is a failure. It delivers NOTHING: a teammate
   * hears the turn's last words only if the member chose to `team_send` them.
   *
   * `sealPending` says the caller is about to seal this epoch — a fact only it
   * holds, since the epoch row still reads open — and suppresses the drain
   * alone, so nothing is started on a session that is about to be torn down.
   */
  completeTurn(params: {
    sessionKey: string
    trigger: TeamTriggerContext
    outcome: TurnCompletion
    sealPending?: boolean
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
  /**
   * Trip the SAME breach channel (`onBreach`, epoch seal, one-shot-per-epoch)
   * a message-volume circuit breach uses, for a cap this bus does not itself
   * track — e.g. `turn-report.ts`'s own report-wake flood guard. Kept
   * separate from `chargeCircuit`'s `messageCount`/`forwardDepth` on purpose:
   * report-wake volume scales with member-turn count, not member-initiated
   * `team_send` traffic, and charging it into that budget would let report
   * noise exhaust the allowance real team communication needs.
   */
  tripExternal(teamId: string, epochId: string, reason: CircuitBreachReason): void
  onBreach(listener: (event: CircuitBreachEvent) => void): () => void
  hasBufferedMessages(epochId: string): boolean
  /**
   * Whether this team session can take a turn right now — a running turn OR a
   * dispatch the gate has already reserved it for. The bus is the only component
   * that knows the second half, so every surface that reports a member's state
   * must ask here rather than probe the session layer: a member whose slot is
   * held is not available, however idle its session looks.
   */
  isSessionOccupied(sessionKey: string): boolean
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
   * Ceiling on a session slot held with no turn running, after which the gate
   * reclaims it (see `platform/turn-gate` §7). Must exceed a member turn's own
   * timeout, since the slot is held for the whole turn including the wait for a
   * concurrency slot. Omitted → no watchdog.
   */
  reservationTtlMs?: number
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

/** A person's own words to a member on this machine; anything a teammate, the runtime or another machine sent is not. */
export function isPersonsOwnDelivery(trigger: TeamTriggerContext): boolean {
  return trigger.kind === 'human_message' && !trigger.origin
}

const STOPPED_UNREAD: TurnCompletion = { kind: 'error', message: 'Stopped before it was read' }

/** A queued envelope: the job type the session-exclusivity layer buffers for us. */
export interface TeamDelivery {
  envelope: TeamEnvelope
  trigger: TeamTriggerContext
  /** Taken back after a person's stop and delivered again: its record already stands where it first arrived. */
  inputRecorded?: boolean
}

interface EnvelopeJob extends TeamDelivery {
  deliveries?: readonly TeamDelivery[]
  coalescingKey?: string
}

/**
 * Ceiling on a completion receipt (`SendInput.wait`) when the caller does not
 * pass its own `syncWaitTimeoutMs`. Independent of the circuit breaker (which
 * no longer bounds run duration) — this only stops a person's cross-machine
 * 1:1 wait from hanging forever if the completion signal is lost.
 */
const DEFAULT_SYNC_WAIT_TIMEOUT_MS = 2 * 60 * 60 * 1000

export function createMessageBus(deps: MessageBusDeps): MessageBus {
  const { store, hooks } = deps
  const limits: CircuitLimits = {
    maxMessages: deps.circuitOverrides?.maxMessages ?? TEAM_CIRCUIT_DEFAULTS.maxMessages,
    maxForwardDepth: deps.circuitOverrides?.maxForwardDepth ?? TEAM_CIRCUIT_DEFAULTS.maxForwardDepth,
  }
  const syncWaitTimeoutMs = deps.syncWaitTimeoutMs ?? DEFAULT_SYNC_WAIT_TIMEOUT_MS

  const pendingWaits = new Map<string, PendingWait>()
  const epochStats = new Map<string, EpochStats>()
  const breachListeners = new Set<(event: CircuitBreachEvent) => void>()
  // The session-exclusivity mechanics (reservation, FIFO mailbox, cap, drain,
  // recheck backstop) are generic and shared with ordinary conversations — see
  // platform/turn-gate/DESIGN.md. Team semantics (topology, circuit breaker,
  // the office record, completion receipts) stay here and call into it.
  const turnGate: TurnGate<EnvelopeJob> = createTurnGate<EnvelopeJob>(
    {
      dispatch: (sessionKey, job) =>
        hooks.wakeTarget({
          sessionKey,
          appId: job.envelope.toAppId,
          teamId: job.envelope.teamId,
          epochId: job.envelope.epochId,
          envelope: job.envelope,
          trigger: job.trigger,
          deliveries: job.deliveries ?? [job],
        }),
      isBusy: (sessionKey) => hooks.isBusy(sessionKey),
      // Same rule as appChatMessageIdentity for a team session not fronted over
      // IM: the owner's own digital humans and the runtime share the owner's
      // identity, so their messages join the owner's running turn; a request
      // from outside never does. Over IM the bus cannot tell, which only errs
      // toward queueing.
      getJobIdentity: (job) => job.trigger.origin ?? 'owner',
      getActiveIdentity: (sessionKey) => hooks.getTurnIdentity?.(sessionKey),
      mergeJobs: (jobs) => ({
        ...jobs[0],
        deliveries: jobs.flatMap((job) => job.deliveries ?? [job]),
      }),
      deliverMidTurn: (sessionKey, job) => hooks.deliverMidTurn?.({
        sessionKey,
        appId: job.envelope.toAppId,
        teamId: job.envelope.teamId,
        epochId: job.envelope.epochId,
        envelope: job.envelope,
        trigger: job.trigger,
        deliveries: job.deliveries ?? [job],
      }) ?? false,
    },
    {
      describeJob: (job) => `messageId=${job.envelope.id}`,
      getCoalescingKey: (job) => job.coalescingKey,
      ...(deps.reservationTtlMs !== undefined ? { reservationTtlMs: deps.reservationTtlMs } : {}),
    }
  )

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

  function recordDeliveryOutcome(env: TeamEnvelope, trigger: TeamTriggerContext, outcome: TurnCompletion): void {
    recordReply(trigger, env.toAppId, outcome)
    if (trigger.kind && trigger.kind !== 'message' && trigger.kind !== 'human_message' && isRecordableFate(outcome)) {
      recordActivity({
        teamId: env.teamId, epochId: env.epochId, kind: 'reply', actorAppId: env.toAppId,
        targetAppId: env.fromAppId, subject: toActivitySubject(describeCompletion(outcome)),
        correlationId: trigger.correlationId, status: replyStatusOf(outcome),
      })
    }
  }

  async function deliver(
    env: TeamEnvelope,
    trigger: TeamTriggerContext,
    onBusy: BusyDisposition = 'buffer',
    coalescingKey?: string
  ): Promise<WakeDisposition> {
    // A space coordinator has no member session: no slot to reserve, no
    // completion to wait for. Its conversation source owns live delivery and the mailbox.
    if (parseSpaceCoordinatorAppId(env.toAppId)) {
      if (!hooks.deliverToCoordinator) {
        throw new TeamBusError('The coordinating conversation is not reachable in this runtime.')
      }
      try {
        return await hooks.deliverToCoordinator({ envelope: env, trigger, coalescingKey })
      } catch (error) {
        // A turn-end notice's failed handoff is the turn report's to log and
        // retry; a row per attempt would flood the record.
        if (trigger.kind !== 'member_stopped') {
          const outcome: TurnCompletion = { kind: 'undelivered', reason: error instanceof Error ? error.message : String(error) }
          recordDeliveryOutcome(env, trigger, outcome)
        }
        throw error
      }
    }
    const sessionKey = buildTeamSessionKey(env.toAppId, env.teamId, env.epochId)
    const member = store.getMember(env.teamId, env.toAppId)
    if (member && isRemoteMember(member)) {
      const delivered = hooks.deliverRemote?.({
        sessionKey, envelope: env, trigger, coalescingKey,
        onCompletion: (outcome) => {
          recordDeliveryOutcome(env, trigger, outcome)
          if (trigger.wait) resolvePendingWait(trigger.correlationId, outcome)
        },
      })
      if (delivered === true) return 'remote_accepted'
      if (delivered === false) throw new TeamBusError("The teammate's machine could not accept this message.")
    }
    return turnGate.deliver(sessionKey, { envelope: env, trigger, coalescingKey }, onBusy)
  }

  function deliverRuntimeWake(params: {
    envelope: TeamEnvelope
    trigger: TeamTriggerContext
    onBusy: BusyDisposition
    coalescingKey?: string
  }): Promise<WakeDisposition> {
    return deliver(params.envelope, params.trigger, params.onBusy, params.coalescingKey)
  }

  function runRelayedTurn<T>(params: { sessionKey: string; run: () => Promise<T> }): Promise<T> {
    return turnGate.runExclusive(params.sessionKey, params.run)
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
    // A coordinator target is the local space conversation — always reachable,
    // and unknown to any federation presence probe.
    const coordinatorTarget = parseSpaceCoordinatorAppId(toAppId) !== null

    if (!wait && !coordinatorTarget && hooks.checkReachable && !hooks.checkReachable(toAppId, input.teamId)) {
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
      ...(input.origin ? { origin: input.origin } : {}),
    }
    ;(trigger as TeamTriggerContext & { forwardDepth?: number }).forwardDepth = forwardDepth + 1

    console.log(
      `${LOG_TAG} send: team=${input.teamId} epoch=${input.epochId} ` +
        `from=${fromAppId ?? 'person'} to=${input.to}(${toAppId}) wait=${wait} depth=${forwardDepth}`
    )

    // A receipted send to the coordinator settles on hand-over: nothing runs a
    // "turn" for the space conversation through this bus, so no completion will
    // ever arrive to resolve the receipt — waiting would only hit the ceiling.
    if (wait && coordinatorTarget) {
      await deliver(envelope, trigger)
      return {
        from: input.to,
        message: 'Delivered to the coordinating conversation. Any reply arrives there.',
        status: 'ok',
      }
    }

    if (!wait) {
      const disposition = await deliver(envelope, trigger)
      // Nothing is auto-delivered back, so this receipt is all the sender ever
      // learns, and the three outcomes call for three different next moves:
      // wait for a turn that has not started ('queued'), expect an answer from
      // work already under way ('mid_turn'), or nothing special.
      // Locality rides along because none of the three is knowable for a target
      // on another machine — it queues on its OWNER, out of sight from here.
      const remoteTarget = isRemoteMember(store.getMember(input.teamId, toAppId) ?? { origin: 'local' })
      const locality = remoteTarget ? { remoteTarget: true as const } : {}
      // The coordinating conversation answers in its own transcript; its sender
      // is told only that the message was handed over.
      if (coordinatorTarget) return { messageId: envelope.id, ...locality }
      if (disposition === 'buffered') return { messageId: envelope.id, delivery: 'queued', ...locality }
      if (disposition === 'mid_turn') return { messageId: envelope.id, delivery: 'mid_turn', ...locality }
      return { messageId: envelope.id, ...locality }
    }

    return new Promise<TeamSendSyncResult>((resolve) => {
      /** Answer the caller now and stop waiting on a completion. */
      const settleNow = (result: TeamSendSyncResult): void => {
        const pending = pendingWaits.get(correlationId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingWaits.delete(correlationId)
        pending.resolve(result)
      }

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
      void deliver(envelope, trigger).then(
        (disposition) => {
          if (disposition === 'remote_accepted') return
          if (disposition !== 'buffered' && disposition !== 'mid_turn') return
          // Either way this message started no turn, so the completion that
          // would answer this receipt belongs to a DIFFERENT one — waiting for
          // it means holding the caller until the receipt ceiling (hours) with
          // nothing to show: no error, no trace in the transcript, no change in
          // the member's state. A caller that is told what happened can decide;
          // one that is told nothing decides the session is dead and starts a
          // second one alongside it. The two are still reported apart because
          // they mean different waits: buffered is "after they finish", mid-turn
          // is "they are reading it now".
          console.log(
            `${LOG_TAG} receipted send reached the target without starting a turn ` +
              `(${disposition}): corr=${correlationId}`
          )
          settleNow({
            from: input.to,
            message: '',
            status: disposition === 'mid_turn' ? 'mid_turn' : 'queued',
          })
        },
        (err) => {
          console.error(`${LOG_TAG} wakeTarget failed for a receipted send:`, err)
          settleNow({ from: input.to, message: '', status: 'timeout' })
        }
      )
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
        return `The message was not delivered: ${outcome.reason}`
      default:
        return '(no result)'
    }
  }

  function completeTurn(params: {
    sessionKey: string
    trigger: TeamTriggerContext
    outcome: TurnCompletion
    /**
     * The caller is about to seal this epoch. Only it can know that — the epoch
     * row still reads open at this instant, because the seal is its very next
     * act — so the fact has to travel, and its consequence is exactly one thing:
     * nothing new is started from the mailbox.
     *
     * Deliberately NOT the same as the sealed-epoch guard below, which returns
     * early and skips everything. A receipt someone is holding must still be
     * settled here, or a seal turns their wait into the hours-long silence that
     * guard was written to prevent elsewhere.
     */
    sealPending?: boolean
  }): void {
    const { trigger, outcome, sessionKey } = params
    // Released before the epoch guard below: a sealed epoch must not leave the
    // session fake-busy forever.
    turnGate.release(sessionKey)
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

    if (params.sealPending) {
      // The mail stays where it is; `resetEpoch` drops it as part of the seal,
      // counted rather than silent. Draining it here would hand it a turn born
      // into the teardown that is one statement away.
      console.log(
        `${LOG_TAG} completeTurn: mailbox left for the seal to discard: epoch=${trigger.epochId}`
      )
      return
    }

    turnGate.drain(sessionKey)
  }

  function drainMailbox(sessionKey: string): void {
    turnGate.drain(sessionKey)
  }

  function isSessionOccupied(sessionKey: string): boolean {
    return turnGate.isOccupied(sessionKey)
  }

  function getEpochStats(epochId: string): EpochStats {
    return { ...statsFor(epochId) }
  }

  function voidOwnWords(deliveries: readonly TeamDelivery[]): void {
    for (const delivery of deliveries) {
      if (delivery.trigger.wait) resolvePendingWait(delivery.trigger.correlationId, STOPPED_UNREAD)
    }
  }

  function holdSession(sessionKey: string): TeamDelivery[] {
    const voided: TeamDelivery[] = []
    turnGate.discardJobs((key, job) => {
      const items = job.deliveries ?? [job]
      if (key !== sessionKey || !items.every((item) => isPersonsOwnDelivery(item.trigger))) return false
      voided.push(...items)
      return true
    }, 'stopped before it was read')
    voidOwnWords(voided)
    turnGate.park(sessionKey)
    return voided
  }

  function returnDeliveries(sessionKey: string, deliveries: readonly TeamDelivery[]): void {
    for (const { trigger } of deliveries) {
      const pending = pendingWaits.get(trigger.correlationId)
      if (!pending) continue
      clearTimeout(pending.timer)
      pendingWaits.delete(trigger.correlationId)
      pending.resolve({ from: pending.fromMemberName, message: '', status: 'queued' })
    }
    turnGate.putBack(sessionKey, deliveries.map((delivery) => ({ envelope: delivery.envelope, trigger: delivery.trigger, inputRecorded: delivery.inputRecorded })))
  }

  function returnHeldBack(sessionKey: string, deliveries: readonly TeamDelivery[]): TeamDelivery[] {
    turnGate.release(sessionKey)
    const voided = deliveries.filter((delivery) => isPersonsOwnDelivery(delivery.trigger))
    voidOwnWords(voided)
    console.log(`${LOG_TAG} woken turn held back by a stop: session=${sessionKey} returned=${deliveries.length - voided.length} voided=${voided.length}`)
    returnDeliveries(sessionKey, deliveries.filter((delivery) => !isPersonsOwnDelivery(delivery.trigger)))
    return voided
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
    // run we're stopping); count the drop so it isn't silent. A queued relayed
    // turn has a caller on another node awaiting completion — dropping it
    // silently would hang that node until its hours-long backstop, so the gate
    // rejects it with a reason instead.
    const droppedEnvelopes = turnGate.discard((key) => key.endsWith(`:${epochId}`), 'the run was stopped')
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
    return turnGate.hasAnyBuffered((key) => key.endsWith(`:${epochId}`))
  }

  return {
    send,
    deliverRuntimeWake,
    runRelayedTurn,
    notifySessionReady: (sessionKey) => turnGate.notifyReady(sessionKey),
    holdSession,
    returnDeliveries,
    returnHeldBack,
    completeTurn,
    assertCanContact,
    resolveMemberAppId,
    resolvePendingWaitsForMember,
    getEpochStats,
    resetEpoch,
    tripExternal: trip,
    onBreach,
    hasBufferedMessages,
    isSessionOccupied,
    drainMailbox,
  }
}
