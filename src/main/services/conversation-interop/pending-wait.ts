/**
 * Cross-Conversation Interop — `waitForReply=true`.
 *
 * Two defects interlock, so both are fixed together:
 *
 * MISMATCH — a wait keyed only by the (source, target) PAIR resolves on the
 * next message the target happens to send the source, whether or not it is
 * actually the reply: the target answering a completely different question
 * silently eats the waiter's pending wait, and the waiter's real question
 * never gets answered (no error either — a pure silent misfire).
 *
 * DEADLOCK — the target's session is "busy" for the ENTIRE turn the wait sits
 * inside (`isNativeConversationBusy`). If the target, instead of replying,
 * itself calls `conversation_send(waitForReply:true)` back at the source, its
 * message queues in the source's mailbox behind a turn that will never end,
 * because the source is blocked waiting on the very target that is now
 * waiting on it. A→B→C→A rings deadlock the same way — and critically, a
 * guard that only checks the DIRECT reverse pair (does B wait on A?) misses
 * this: registering C's wait on A never sees B in the picture at all. See
 * `wouldCreateWaitCycle` below.
 *
 * The fix for both: a wait is scoped to the SPECIFIC TURN the waiter's
 * delivery started, not to the (source, target) pair for all time — tracked
 * by associating a single-use correlation id with "the turn currently running
 * on conversation X owes this wait an answer" (`activeCorrelationFor`), set at
 * dispatch and cleared the moment that turn ends or replies. A later, unrelated
 * message between the same two conversations can never resolve a wait whose
 * turn has already closed. And before registering a new wait, a cycle guard
 * refuses it outright if it would close a wait-for loop back to the waiter —
 * the one shape that provably cannot be helped by queueing.
 *
 * Hard requirement: the ONLY event that resolves a wait with real content is
 * the target's own EXPLICIT reply (`tryResolveAsReply`, called from
 * delivery.ts's `checkExistsSelfAndReply` when the target's own
 * `conversation_send` comes back through). A turn ending is never read for
 * its content here — `noteTurnEnded` only ever produces `no_reply`. Team's
 * `resolvePendingWait` (message-bus.ts) fills a receipt from the turn's own
 * `outcome.content` and is NOT a template to copy: that path is restricted
 * to a person's 1:1 chat (a human listener), never something an AI can set —
 * reusing its shape here is exactly how two AIs end up forwarding each
 * other's sign-offs until a breaker trips.
 */

import { randomUUID } from 'crypto'
import type { WaitOutcome } from './types'

interface PendingWait {
  correlationId: string
  /** The conversation that called waitForReply and is blocked. */
  fromConversationId: string
  /** The conversation being waited on. */
  toConversationId: string
  resolve: (outcome: WaitOutcome) => void
  timer: NodeJS.Timeout
}

const pendingWaits = new Map<string, PendingWait>()
/** conversationId -> the correlation id the conversation's CURRENTLY RUNNING turn owes an answer to, if any. */
const activeCorrelationFor = new Map<string, string>()
/**
 * conversationId -> who it is currently waiting on. A conversation can hold
 * at most one outstanding wait at a time: it is blocked inside the tool call
 * that registered it, and a turn only ever runs one tool call at a time. That
 * makes this relation a proper FUNCTION (each key maps to at most one value),
 * which is exactly what makes cycle detection a simple pointer-chase below
 * rather than a general graph search.
 */
const waitingOn = new Map<string, string>()

/**
 * Would registering a new wait `fromConversationId -> toConversationId`
 * close a cycle back to the waiter? A direct reverse check (does `to` wait on
 * `from`?) only catches a 2-party deadlock; a 3+ party ring (A waits on B, B
 * waits on C, C waits on A) sails right through it, because registering C's
 * wait on A never looks at what B is doing. Since `waitingOn` is a function,
 * closing the cycle is just walking it: start at `toConversationId` and
 * repeatedly ask "who does this conversation wait on"; reaching
 * `fromConversationId` means the new edge would complete a ring.
 */
function wouldCreateWaitCycle(fromConversationId: string, toConversationId: string): boolean {
  let current: string | undefined = toConversationId
  // Defensive bound: a cycle can't be longer than the number of live waits,
  // so this never loops beyond the graph's own size even if some invariant
  // above turns out to be wrong.
  let stepsRemaining = pendingWaits.size + 1
  while (current !== undefined && stepsRemaining > 0) {
    if (current === fromConversationId) return true
    current = waitingOn.get(current)
    stepsRemaining -= 1
  }
  return false
}

export type RegisterWaitResult =
  | { ok: true; correlationId: string; promise: Promise<WaitOutcome> }
  | { ok: false; reason: 'mutual_wait' }

/**
 * Register a new wait. Must be called BEFORE the delivery that starts the
 * target's turn, and the returned `correlationId` handed to
 * `armActiveCorrelation` once that turn is actually dispatched (a rejected or
 * buffered delivery must not arm anything yet).
 */
export function registerWait(params: {
  fromConversationId: string
  toConversationId: string
  timeoutMs: number
}): RegisterWaitResult {
  const { fromConversationId, toConversationId, timeoutMs } = params
  if (wouldCreateWaitCycle(fromConversationId, toConversationId)) {
    return { ok: false, reason: 'mutual_wait' }
  }

  const correlationId = randomUUID()
  waitingOn.set(fromConversationId, toConversationId)
  const promise = new Promise<WaitOutcome>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingWaits.delete(correlationId)) {
        if (waitingOn.get(fromConversationId) === toConversationId) waitingOn.delete(fromConversationId)
        if (activeCorrelationFor.get(toConversationId) === correlationId) {
          activeCorrelationFor.delete(toConversationId)
        }
        resolve({ status: 'timeout' })
      }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    pendingWaits.set(correlationId, { correlationId, fromConversationId, toConversationId, resolve, timer })
  })

  return { ok: true, correlationId, promise }
}

/** Shared teardown: settle `correlationId`'s wait (if still open) with `outcome` and drop all bookkeeping for it. */
function settleWait(correlationId: string, outcome: WaitOutcome): boolean {
  const wait = pendingWaits.get(correlationId)
  if (!wait) return false
  clearTimeout(wait.timer)
  pendingWaits.delete(correlationId)
  if (waitingOn.get(wait.fromConversationId) === wait.toConversationId) waitingOn.delete(wait.fromConversationId)
  if (activeCorrelationFor.get(wait.toConversationId) === correlationId) {
    activeCorrelationFor.delete(wait.toConversationId)
  }
  wait.resolve(outcome)
  return true
}

/** A wait was registered but the delivery never actually started a turn (rejected/failed before dispatch) — fail it now rather than leave it to the timeout. */
export function abandonWait(correlationId: string, outcome: WaitOutcome): void {
  settleWait(correlationId, outcome)
}

/**
 * Mark that the turn now dispatching on `conversationId` owes an answer to
 * `correlationId`. Only one turn runs on a conversation at a time, so under
 * normal operation any previous association was already cleared by that
 * turn's own `noteTurnEnded` before this can be called again — but this does
 * NOT trust that invariant blindly: if a stale correlation is still here (its
 * wait never actually got torn down), overwriting the map entry alone would
 * orphan it — its caller would hang until its own timeout instead of getting
 * an honest `no_reply` now. So a stale entry is settled as `no_reply` first.
 */
export function armActiveCorrelation(conversationId: string, correlationId: string): void {
  const stale = activeCorrelationFor.get(conversationId)
  if (stale !== undefined && stale !== correlationId) {
    settleWait(stale, { status: 'no_reply' })
  }
  activeCorrelationFor.set(conversationId, correlationId)
}

/**
 * A turn is dispatching on `conversationId` that does NOT owe any wait an
 * answer (a plain delivery, or a locally-started turn). Clears a stale
 * association so an unrelated later reply cannot be mistaken for one — and,
 * same as `armActiveCorrelation`, settles a still-open stale wait as
 * `no_reply` rather than silently orphaning it.
 */
export function clearActiveCorrelation(conversationId: string): void {
  const stale = activeCorrelationFor.get(conversationId)
  activeCorrelationFor.delete(conversationId)
  if (stale !== undefined) settleWait(stale, { status: 'no_reply' })
}

/**
 * The target conversation is explicitly replying: `fromConversationId` is the
 * target itself (the one now calling `conversation_send`), `toConversationId`
 * is who it is sending to. Resolves the wait ONLY if it is the one the
 * target's CURRENTLY RUNNING turn actually owes — never a stale or unrelated
 * pair match. Returns true if this send was consumed as a reply, in which
 * case the caller (delivery.ts) must not ALSO deliver it as a normal message
 * — never both a tool result and a message.
 */
export function tryResolveAsReply(fromConversationId: string, toConversationId: string, message: string): boolean {
  const correlationId = activeCorrelationFor.get(fromConversationId)
  if (!correlationId) return false
  const wait = pendingWaits.get(correlationId)
  if (!wait || wait.toConversationId !== fromConversationId || wait.fromConversationId !== toConversationId) {
    return false
  }
  return settleWait(correlationId, { status: 'replied', message })
}

/**
 * The turn running on `conversationId` just ended (any fate — success, error,
 * or timeout at the session layer). If it owed a wait an answer and never
 * replied, that wait becomes `no_reply` — never filled from the turn's own
 * content (see the module doc above).
 */
export function noteTurnEnded(conversationId: string): void {
  const correlationId = activeCorrelationFor.get(conversationId)
  if (!correlationId) return
  activeCorrelationFor.delete(conversationId)
  settleWait(correlationId, { status: 'no_reply' })
}
