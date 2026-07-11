/**
 * In-process message bus for team member coordination.
 *
 * Must NOT import the session layer (app-chat / orchestration / report-tool);
 * waking a target and observing busyness are injected via TeamDeliveryHooks.
 */

import { randomUUID } from 'crypto'
import { broadcastToAll } from '../../../http/websocket'
import { sendToRenderer } from '../../../foundation/window.service'
import { buildTeamSessionKey, TEAM_EVENTS, TEAM_CIRCUIT_DEFAULTS } from '../../../../shared/apps/team-types'
import { parseTeamSessionKey } from '../../../../shared/apps/im-keys'
import type { TeamStore } from '../../team'
import type {
  CollabMode,
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
  fromAppId: string
  /** Member name, resolved to appId via the store. */
  to: string
  message: string
  wait?: boolean
  /** Guards against ping-pong: initial lead wake is 0, each completion-wake increments. */
  forwardDepth?: number
  taskRef?: string
  /** Human-originated 1:1 send (see TeamTriggerContext.humanOrigin). */
  humanOrigin?: boolean
}

export interface MessageBus {
  send(input: SendInput): Promise<TeamSendAsyncResult | TeamSendSyncResult>
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
}

export interface MessageBusDeps {
  store: TeamStore
  hooks: TeamDeliveryHooks
  circuitOverrides?: Partial<CircuitLimits>
  syncWaitTimeoutMs?: number
}

// ── Internal state ──────────────────────────────────────────────────────────

interface PendingWait {
  resolve: (result: TeamSendSyncResult) => void
  fromMemberName: string
  timer: NodeJS.Timeout
  forwardDepth: number
  /** The epoch this wait belongs to, so resetEpoch only clears its own waiters. */
  epochId: string
  /** The target member, so a confirmed-offline member can unblock its waiters. */
  toAppId: string
}

interface BufferedDelivery {
  envelope: TeamEnvelope
  trigger: TeamTriggerContext
  appId: string
}

const DEFAULT_SYNC_WAIT_TIMEOUT_MS = TEAM_CIRCUIT_DEFAULTS.maxDurationMs

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

  function emitMessageEvent(env: TeamEnvelope): void {
    const payload = {
      teamId: env.teamId,
      epochId: env.epochId,
      fromAppId: env.fromAppId,
      toAppId: env.toAppId,
      fromMemberName: memberNameOf(env.teamId, env.fromAppId),
      toMemberName: memberNameOf(env.teamId, env.toAppId),
      messageId: env.id,
      ts: env.createdAt,
    }
    broadcastToAll(TEAM_EVENTS.message, payload)
    sendToRenderer(TEAM_EVENTS.message, payload)
  }

  /** Buffer if the target is mid-turn; otherwise wake immediately. */
  async function deliver(env: TeamEnvelope, trigger: TeamTriggerContext): Promise<void> {
    const sessionKey = buildTeamSessionKey(env.toAppId, env.teamId, env.epochId)
    if (hooks.isBusy(sessionKey)) {
      const buffer = mailboxBuffers.get(sessionKey) ?? []
      buffer.push({ envelope: env, trigger, appId: env.toAppId })
      mailboxBuffers.set(sessionKey, buffer)
      console.log(`${LOG_TAG} Target busy, buffered: session=${sessionKey} bufferSize=${buffer.length}`)
      return
    }
    await hooks.wakeTarget({
      sessionKey,
      appId: env.toAppId,
      teamId: env.teamId,
      epochId: env.epochId,
      envelope: env,
      trigger,
    })
  }

  async function send(input: SendInput): Promise<TeamSendAsyncResult | TeamSendSyncResult> {
    const wait = input.wait ?? false
    const forwardDepth = input.forwardDepth ?? 0

    const toAppId = resolveMemberAppId(input.teamId, input.to)
    // Topology is enforced at the tool layer (assertCanContact before send).
    chargeCircuit(input.teamId, input.epochId, forwardDepth)

    const correlationId = randomUUID()
    const envelope: TeamEnvelope = {
      id: randomUUID(),
      teamId: input.teamId,
      epochId: input.epochId,
      fromAppId: input.fromAppId,
      toAppId,
      body: input.message,
      wait,
      correlationId,
      taskRef: input.taskRef,
      createdAt: Date.now(),
    }
    emitMessageEvent(envelope)

    const trigger: TeamTriggerContext = {
      teamId: input.teamId,
      epochId: input.epochId,
      correlationId,
      fromAppId: input.fromAppId,
      wait,
      taskId: input.taskRef,
      kind: 'message',
      ...(input.humanOrigin ? { humanOrigin: true } : {}),
    }
    ;(trigger as TeamTriggerContext & { forwardDepth?: number }).forwardDepth = forwardDepth + 1

    console.log(
      `${LOG_TAG} send: team=${input.teamId} epoch=${input.epochId} ` +
        `from=${input.fromAppId} to=${input.to}(${toAppId}) wait=${wait} depth=${forwardDepth}`
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
        epochId: input.epochId,
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
      // A confirmed-offline unblock keeps timeout semantics but tells the sender
      // explicitly that the teammate is gone so it can reassign.
      if (outcome.kind === 'timeout') {
        pending.resolve({
          from: pending.fromMemberName,
          message: 'The teammate is unavailable right now; reassign or proceed without them.',
          status: 'timeout',
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

    if (trigger.wait) {
      resolvePendingWait(trigger.correlationId, outcome)
    } else if (trigger.fromAppId) {
      // Escalations are routed by the session layer, not re-woken as a peer completion.
      if (outcome.kind !== 'escalation') {
        const depth =
          (trigger as TeamTriggerContext & { forwardDepth?: number }).forwardDepth ?? 1
        const finisherAppId = appIdFromSessionKey(sessionKey) ?? trigger.fromAppId
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
    if (hooks.isBusy(sessionKey)) return

    const next = buffer.shift()!
    if (buffer.length === 0) mailboxBuffers.delete(sessionKey)
    console.log(`${LOG_TAG} Draining buffered envelope: session=${sessionKey} remaining=${buffer.length}`)
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
        console.error(`${LOG_TAG} Failed to deliver buffered envelope:`, err)
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
    completeTurn,
    assertCanContact,
    resolveMemberAppId,
    resolvePendingWaitsForMember,
    getEpochStats,
    resetEpoch,
    onBreach,
    hasBufferedMessages,
  }
}
