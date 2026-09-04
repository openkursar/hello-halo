/**
 * Cross-Conversation Interop — circuit breaker.
 *
 * Deliberately NOT the team's epoch-scoped `chargeCircuit` (message-bus.ts):
 * that budget is keyed to a team run and reset when the run seals. An ordinary
 * conversation has no run/epoch to scope a budget to, so this is its own
 * sliding-window limiter, always live, never reset by anything but time.
 *
 * Two independent rate guards:
 * - a (source, target) PAIR limit — kills the "A notifies B, B says thanks, A
 *   says np" loop within about a minute of real turns;
 * - a per-SOURCE total — separately catches one conversation fanning out to
 *   many different targets, which the pair limit alone would not bound.
 * Plus a structural, non-rate guard: forward-chain depth.
 *
 * A breach is a HARD STOP, not advice the model is trusted to relay. Once a
 * rate guard trips, a FIXED cooldown (not "wait for the sliding window to
 * decay") mechanically rejects further sends from the same scope (the pair,
 * or the whole source) until it expires — decay is gradual and the exact
 * unblock moment is fuzzy, which both undercuts the mechanical feel a hard
 * stop wants and risks "just unblocked, immediately re-tripped" flapping. The
 * caller (delivery.ts) uses `cooldownJustStarted` to write the one-time
 * user-visible notice — this module only tracks state, it never touches
 * conversation storage itself. Forward-depth is NOT a rate state: exceeding
 * it rejects that one message structurally and starts no cooldown (there is
 * nothing to "wait out" — a fresh chain isn't blocked by an old one).
 *
 * Check order for the three conditions — depth, then pair rate, then source
 * rate — mirrors team's `chargeCircuit` ("structural before counting").
 *
 * `forwardDepth` has no `TeamTriggerContext`-shaped object to ride on for
 * native conversations, so it is tracked here instead
 * (`recordInboundForwardDepth` / `getInboundForwardDepth`), keyed by the
 * target conversation and set at dispatch — `mcp-server.ts`'s
 * `conversation_send` handler reads it back to compute its own outgoing
 * depth + 1, mirroring team's `ctx.forwardDepth → team_send` shape without
 * sharing its counter.
 */

import { Emitter, type Event } from '../../platform/event'

export interface CircuitLimits {
  /** Sends allowed between one ordered (source, target) pair per window. */
  pairLimit: number
  /** Sends allowed from one source conversation, to any targets, per window. */
  sourceLimit: number
  /** Sliding window size used to detect a breach. */
  windowMs: number
  /** Fixed hard-stop duration once a rate guard trips — independent of `windowMs`. */
  cooldownMs: number
  /** Forward-chain depth ceiling (each hop increments, never resets). */
  maxForwardDepth: number
  /** Message body size ceiling, in characters. */
  maxMessageChars: number
}

export const DEFAULT_CIRCUIT_LIMITS: CircuitLimits = {
  pairLimit: 20,
  sourceLimit: 60,
  windowMs: 10 * 60 * 1000,
  cooldownMs: 5 * 60 * 1000,
  maxForwardDepth: 6,
  maxMessageChars: 32_000,
}

export type CircuitRejectReason = 'pair_limit' | 'source_limit' | 'forward_depth' | 'message_too_large'

export interface CircuitBreachEvent {
  reason: CircuitRejectReason
  fromConversationId: string
  toConversationId: string
}

export type ChargeResult =
  | { ok: true }
  | {
      ok: false
      reason: CircuitRejectReason
      /**
       * True only the instant a cooldown transitions from not-tripped to
       * tripped — the caller writes the user-visible notice exactly then.
       * Every rejection during an already-active cooldown reports false, so
       * repeated attempts don't re-spam the notice. Always false for
       * `forward_depth`/`message_too_large` (no cooldown state exists for
       * either).
       */
      cooldownJustStarted: boolean
      /** Minutes the cooldown lasts — only set alongside `cooldownJustStarted: true`, for the notice text. */
      cooldownMinutes?: number
    }

/**
 * One limiter instance per process, mirroring the team bus's single
 * `createMessageBus` instance — a fresh `createCircuitBreaker()` per caller
 * would let each caller reset the others' budget by never sharing state, so
 * this module exports a single shared instance rather than a factory.
 */
export interface CircuitBreaker {
  /**
   * Check and, if allowed, charge the sliding-window counters. Charging is
   * atomic with the check (no separate "charge" call) so a caller cannot
   * check once and send many times against a stale answer.
   *
   * Per the fixed decision order in delivery.ts, a message that resolves an
   * existing `pending-wait` is checked and consumed BEFORE this is ever
   * called, and is fully exempt from it — resolving an existing wait
   * produces no new send volume, so charging it here would let a cooldown
   * become a new deadlock source (the same deadlock `pending-wait.ts` exists
   * to prevent).
   */
  checkAndCharge(params: {
    fromConversationId: string
    toConversationId: string
    forwardDepth: number
    messageLength: number
  }): ChargeResult
  /** Record the forward depth the dispatched turn on `conversationId` is running at. */
  recordInboundForwardDepth(conversationId: string, forwardDepth: number): void
  /** The forward depth of the delivery that started the conversation's current turn (0 = not interop-triggered). */
  getInboundForwardDepth(conversationId: string): number
  onBreach(listener: (event: CircuitBreachEvent) => void): () => void
}

function pruneOld(timestamps: number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs
  let firstLive = 0
  while (firstLive < timestamps.length && timestamps[firstLive] <= cutoff) firstLive += 1
  return firstLive === 0 ? timestamps : timestamps.slice(firstLive)
}

export function createCircuitBreaker(limits: CircuitLimits = DEFAULT_CIRCUIT_LIMITS): CircuitBreaker {
  const pairSends = new Map<string, number[]>()
  const sourceSends = new Map<string, number[]>()
  /** Hard-stop expiry timestamps — checked BEFORE the sliding windows, and independent of their decay. */
  const pairCooldownUntil = new Map<string, number>()
  const sourceCooldownUntil = new Map<string, number>()
  const inboundForwardDepth = new Map<string, number>()
  const breachEmitter = new Emitter<CircuitBreachEvent>()

  function fire(reason: CircuitRejectReason, fromConversationId: string, toConversationId: string): void {
    breachEmitter.fire({ reason, fromConversationId, toConversationId })
  }

  function checkAndCharge(params: {
    fromConversationId: string
    toConversationId: string
    forwardDepth: number
    messageLength: number
  }): ChargeResult {
    const { fromConversationId, toConversationId, forwardDepth, messageLength } = params

    if (messageLength > limits.maxMessageChars) {
      return { ok: false, reason: 'message_too_large', cooldownJustStarted: false }
    }
    if (forwardDepth > limits.maxForwardDepth) {
      fire('forward_depth', fromConversationId, toConversationId)
      return { ok: false, reason: 'forward_depth', cooldownJustStarted: false }
    }

    const now = Date.now()
    const pairKey = `${fromConversationId}:${toConversationId}`

    const pairCooldown = pairCooldownUntil.get(pairKey)
    if (pairCooldown !== undefined && pairCooldown > now) {
      return { ok: false, reason: 'pair_limit', cooldownJustStarted: false }
    }
    const sourceCooldown = sourceCooldownUntil.get(fromConversationId)
    if (sourceCooldown !== undefined && sourceCooldown > now) {
      return { ok: false, reason: 'source_limit', cooldownJustStarted: false }
    }

    const pairHistory = pruneOld(pairSends.get(pairKey) ?? [], now, limits.windowMs)
    if (pairHistory.length >= limits.pairLimit) {
      pairSends.set(pairKey, pairHistory)
      pairCooldownUntil.set(pairKey, now + limits.cooldownMs)
      fire('pair_limit', fromConversationId, toConversationId)
      return {
        ok: false,
        reason: 'pair_limit',
        cooldownJustStarted: true,
        cooldownMinutes: limits.cooldownMs / 60_000,
      }
    }

    const sourceHistory = pruneOld(sourceSends.get(fromConversationId) ?? [], now, limits.windowMs)
    if (sourceHistory.length >= limits.sourceLimit) {
      sourceSends.set(fromConversationId, sourceHistory)
      sourceCooldownUntil.set(fromConversationId, now + limits.cooldownMs)
      fire('source_limit', fromConversationId, toConversationId)
      return {
        ok: false,
        reason: 'source_limit',
        cooldownJustStarted: true,
        cooldownMinutes: limits.cooldownMs / 60_000,
      }
    }

    pairHistory.push(now)
    sourceHistory.push(now)
    pairSends.set(pairKey, pairHistory)
    sourceSends.set(fromConversationId, sourceHistory)
    return { ok: true }
  }

  function recordInboundForwardDepth(conversationId: string, forwardDepth: number): void {
    inboundForwardDepth.set(conversationId, forwardDepth)
  }

  function getInboundForwardDepth(conversationId: string): number {
    return inboundForwardDepth.get(conversationId) ?? 0
  }

  function onBreach(listener: (event: CircuitBreachEvent) => void): () => void {
    const disposable = breachEmitter.event(listener)
    return () => disposable.dispose()
  }

  return { checkAndCharge, recordInboundForwardDepth, getInboundForwardDepth, onBreach }
}

/** Shared instance — see the `CircuitBreaker` doc comment for why this isn't a bare factory export. */
export const circuitBreaker: CircuitBreaker = createCircuitBreaker()
