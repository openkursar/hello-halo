/**
 * Agent Module - Session Consumer
 *
 * Persistent REPL consumer that mirrors CC's REPL model.
 * Unlike the old do-while loop inside processStream, this consumer runs for the
 * entire lifetime of a V2 session — it never exits between turns.
 *
 * Architecture:
 *   CC subprocess is a REPL: it loops forever, processing messages from any source
 *   (user sends, team agent internal messages, etc.) and producing output.
 *
 *   The consumer mirrors this: a persistent `while` loop that keeps calling
 *   `v2Session.stream()` to consume turn outputs. Each `stream()` call yields
 *   events for one CC turn and completes when CC produces a `result`.
 *   The loop then re-enters `stream()` to wait for the next turn.
 *
 *   Because the loop never leaves the stream, output produced between user
 *   messages (background-task notifications, team-agent turns) is consumed as it
 *   appears. A surface that instead reads the stream once per user message
 *   leaves such a turn queued in the pipe, and the next message picks it up as
 *   if it were its own answer — every later reply then lags one turn behind.
 *
 * Turn types:
 *   1. User-initiated: caller calls v2Session.send() → CC processes → consumer picks up
 *   2. Autonomous: CC gets internal input (team agent message) → consumer picks up
 *   The consumer doesn't distinguish — it processes whatever comes out.
 *
 * Surface-specific behavior (persistence, delivery) lives behind {@link TurnSink};
 * this module knows nothing about conversations, JSONL, or IM channels.
 *
 * Lifecycle:
 *   - Started when V2 session is created (startConsumer)
 *   - Stopped when V2 session is closed/rebuilt (consumer.stop())
 *   - Never exits between turns
 */

import type { V2SDKSession, SessionState, Thought } from './types'
import { processStream } from './stream-processor'
import type { TurnSink } from './turn-sink'
import { emitAgentEvent } from './events'
import { createSessionState, consumePendingRebuild, markTurnInitReceived } from './session-manager'
import { hasActiveTeamTasks, isTeamLifecycleThought } from './subagent-handler'

// ============================================
// Types
// ============================================

/**
 * Handle returned by startConsumer.
 * Callers use this to control the consumer lifecycle.
 */
export interface ConsumerHandle {
  /** Stop the consumer (e.g., session close/rebuild). Idempotent. */
  stop(): void
  /** True if the consumer loop is still running */
  readonly isRunning: boolean
  /** Get the current turn's SessionState (for injection, stop, etc.) */
  getActiveSessionState(): SessionState | null
  /** Get team lifecycle thoughts (Agent team spawns / TeamDelete) accumulated
   * across all completed turns of this session. Used by session-manager and
   * control to detect active team agents while the consumer idles between
   * turns — the spawn may be several turns in the past. */
  getTeamLifecycleThoughts(): Thought[]
  /** Update the display model name used for thought parsing (and the
   * source-resolved context window shown in token usage).
   * Called by sendMessage to keep both in sync after model switches
   * without requiring a full session rebuild. */
  updateDisplayModel(displayModel: string, contextWindow?: number): void
}

/** Everything a consumer needs beyond the session itself. */
export interface ConsumerContext {
  spaceId: string
  conversationId: string
  /** Display model name for thought parsing */
  displayModel: string
  /** Source-resolved context window for token-usage display */
  contextWindow?: number
  /** Surface-specific persistence + delivery for each consumed turn */
  sink: TurnSink
}

/**
 * Internal consumer state — tracks everything the consumer needs across turns.
 */
interface ConsumerState {
  spaceId: string
  conversationId: string
  displayModel: string
  /** Source-resolved context window for token-usage display (see ProcessStreamParams) */
  contextWindow?: number
  sink: TurnSink
  /** AbortController for the consumer loop itself (not per-turn) */
  consumerAbort: AbortController
  /** True when consumer is inside for-await (processing a turn) */
  processingTurn: boolean
  /** Current turn's SessionState (created fresh each turn) */
  currentSessionState: SessionState | null
  /** Running flag */
  running: boolean
  /** Team lifecycle thoughts (Agent team spawns / TeamDelete) accumulated
   * across completed turns. Persists between turns so session-manager can
   * detect active team agents while the consumer idles; reset when the team
   * is disbanded. */
  teamLifecycleThoughts: Thought[]
}

// ============================================
// Consumer Factory
// ============================================

/**
 * Start a persistent consumer for a V2 session.
 *
 * The consumer runs in the background (fire-and-forget async loop).
 * It processes all turns (user-initiated and autonomous) until stopped.
 *
 * @param v2Session - The V2 SDK session to consume
 * @param context - Routing identity, display model, and the turn sink
 * @returns ConsumerHandle for lifecycle control
 */
export function startConsumer(
  v2Session: V2SDKSession,
  context: ConsumerContext
): ConsumerHandle {
  const { conversationId } = context
  const state: ConsumerState = {
    spaceId: context.spaceId,
    conversationId,
    displayModel: context.displayModel,
    contextWindow: context.contextWindow,
    sink: context.sink,
    consumerAbort: new AbortController(),
    processingTurn: false,
    currentSessionState: null,
    running: true,
    teamLifecycleThoughts: [],
  }

  // Fire and forget — errors are logged but don't propagate
  consumeLoop(v2Session, state).catch((err) => {
    if (!state.consumerAbort.signal.aborted) {
      console.error(`[Consumer][${conversationId}] Fatal error in consume loop:`, err)
    }
  }).finally(() => {
    state.running = false
    state.currentSessionState = null
    // Sinks that hand out per-turn promises settle their outstanding ones here;
    // nothing else will arrive on this session.
    try {
      state.sink.onConsumerStopped?.()
    } catch (err) {
      console.error(`[Consumer][${conversationId}] sink.onConsumerStopped failed:`, err)
    }
    console.log(`[Consumer][${conversationId}] Consumer loop exited`)
  })

  const handle: ConsumerHandle = {
    stop() {
      if (!state.consumerAbort.signal.aborted) {
        state.consumerAbort.abort()
        console.log(`[Consumer][${conversationId}] Stop requested`)
      }
      // Also abort the current turn if one is in progress
      if (state.currentSessionState) {
        state.currentSessionState.abortController.abort()
      }
    },
    get isRunning() {
      return state.running
    },
    getActiveSessionState() {
      return state.currentSessionState
    },
    getTeamLifecycleThoughts() {
      return state.teamLifecycleThoughts
    },
    updateDisplayModel(newDisplayModel: string, newContextWindow?: number) {
      if (state.displayModel !== newDisplayModel) {
        console.log(`[Consumer][${conversationId}] Display model updated: ${state.displayModel} → ${newDisplayModel}`)
        state.displayModel = newDisplayModel
      }
      state.contextWindow = newContextWindow
    },
  }

  return handle
}

// ============================================
// Consumer Loop
// ============================================

/**
 * The persistent consume loop.
 * Runs for the lifetime of the V2 session, processing one turn per iteration.
 */
async function consumeLoop(v2Session: V2SDKSession, state: ConsumerState): Promise<void> {
  const { spaceId, conversationId, sink } = state

  console.log(`[Consumer][${conversationId}] Consumer started`)

  // Track consecutive empty iterations for exponential backoff (M2 fix)
  let consecutiveEmptyIterations = 0
  const MAX_EMPTY_ITERATIONS = 5
  const BACKOFF_BASE_MS = 100

  while (!state.consumerAbort.signal.aborted) {
    // Create a fresh per-turn AbortController
    const turnAbort = new AbortController()

    // Link consumer-level abort to per-turn abort
    const onConsumerAbort = () => turnAbort.abort()
    state.consumerAbort.signal.addEventListener('abort', onConsumerAbort, { once: true })

    // Create fresh session state for this turn.
    // IMPORTANT: Do NOT set state.currentSessionState here. It is set in onTurnInit
    // (when CC emits system:init) so that idle-waiting consumers are correctly
    // identified as idle. Setting it here caused getOrCreateV2Session to mistake
    // an idle consumer (blocked on stream()) for an actively-processing one,
    // deferring session rebuilds by one turn — the "model switch one step late" bug.
    const sessionState = createSessionState(spaceId, conversationId, turnAbort)
    state.processingTurn = true

    const turnStartTime = Date.now()
    let receivedAnyEvent = false
    let agentCompleteEmitted = false

    try {
      // processStream consumes one turn. The onTurnInit callback fires when CC
      // emits system:init — the turn boundary both the consumer and the sink
      // key off, uniformly for user-initiated and autonomous turns.

      const result = await processStream({
        v2Session,
        sessionState,
        spaceId,
        conversationId,
        displayModel: state.displayModel,
        contextWindow: state.contextWindow,
        abortController: turnAbort,
        t0: turnStartTime,
        callbacks: {
          onRawMessage: sink.onRawMessage ? (m) => sink.onRawMessage!(m) : undefined,
          onTurnInit: () => {
            receivedAnyEvent = true

            // Mark consumer as actively processing. From this point on,
            // getOrCreateV2Session will correctly defer session rebuilds
            // until this turn completes (protecting in-flight responses).
            state.currentSessionState = sessionState
            // The dispatched turn is acknowledged — hand the busy-window
            // ownership from turnsAwaitingInit over to currentSessionState.
            markTurnInitReceived(conversationId)

            sink.onTurnStart?.()

            // Notify frontend to transition to generating state
            emitAgentEvent('agent:turn-start', spaceId, conversationId, {
              type: 'turn-start',
            })
          },
        },
      })

      // Turn complete — persist result and notify frontend
      if (receivedAnyEvent) {
        // Reset empty iteration counter on successful turn
        consecutiveEmptyIterations = 0

        sink.onTurnComplete(result)

        // Accumulate team lifecycle thoughts across turns: a team spawned in an
        // earlier turn must keep blocking session rebuilds and idle cleanup while
        // the consumer idles between turns (CC subprocess still has agents working).
        // Reset once the team is disbanded (TeamDelete succeeded) so a future team
        // in this session starts from a clean slate.
        const teamThoughts = [
          ...state.teamLifecycleThoughts,
          ...result.thoughts.filter(isTeamLifecycleThought),
        ]
        state.teamLifecycleThoughts = hasActiveTeamTasks(teamThoughts) ? teamThoughts : []

        emitAgentEvent('agent:complete', spaceId, conversationId, {
          type: 'complete',
          duration: Date.now() - turnStartTime,
          tokenUsage: result.tokenUsage,
        })
        agentCompleteEmitted = true

        console.log(
          `[Consumer][${conversationId}] Turn complete:` +
          ` content=${result.finalContent.length} chars, thoughts=${result.thoughts.length},` +
          ` duration=${Date.now() - turnStartTime}ms`
        )

        // Drain timeout: the abort-drain failed to receive a result within the
        // safety timeout. The REPL pipe is dirty — continuing would read stale data.
        // Break the consumer loop; next send detects the dead consumer and
        // creates a fresh session via getOrCreateV2Session.
        if (result.drainTimedOut) {
          console.warn(`[Consumer][${conversationId}] Drain timed out — REPL pipe is dirty, breaking for session rebuild`)
          break
        }

        // API config or toolset change during this turn → break the loop so the
        // session is rebuilt with the new set on the next send.
        // Deferred while team agents are still running: breaking now would leave
        // the CC subprocess unread and the next send would kill it (and
        // every in-flight team task) as a zombie. The flag stays set and is
        // consumed after the team's final turn.
        if (!hasActiveTeamTasks(state.teamLifecycleThoughts) && consumePendingRebuild(conversationId)) {
          console.log(`[Consumer][${conversationId}] Rebuild pending, breaking for rebuild`)
          break
        }
      } else {
        // stream() returned immediately with no events — CC is idle or in bad state.
        // Apply exponential backoff to avoid tight spin (M2 fix).
        consecutiveEmptyIterations++
        const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, consecutiveEmptyIterations - 1), 5000)
        console.log(
          `[Consumer][${conversationId}] stream() returned with no events ` +
          `(${consecutiveEmptyIterations}/${MAX_EMPTY_ITERATIONS}), backoff ${backoffMs}ms`
        )

        if (consecutiveEmptyIterations >= MAX_EMPTY_ITERATIONS) {
          console.warn(
            `[Consumer][${conversationId}] ${MAX_EMPTY_ITERATIONS} consecutive empty iterations, ` +
            `process may be in bad state — exiting consumer`
          )
          break
        }

        await sleep(backoffMs)
      }
    } catch (err) {
      if (state.consumerAbort.signal.aborted) {
        break // Consumer was stopped, exit cleanly
      }

      const error = err as Error
      console.error(`[Consumer][${conversationId}] Turn error:`, error)

      // Emit error to frontend
      emitAgentEvent('agent:error', spaceId, conversationId, {
        type: 'error',
        error: error.message || 'Unknown error. Check logs in Settings > System > Logs.',
      })

      sink.onTurnError?.(error, receivedAnyEvent)

      // Reset empty iteration counter — errors are not empty iterations
      consecutiveEmptyIterations = 0

      // Emit complete so frontend transitions out of generating state
      emitAgentEvent('agent:complete', spaceId, conversationId, {
        type: 'complete',
        duration: Date.now() - turnStartTime,
      })
      agentCompleteEmitted = true

      // If the error is fatal (process died), break the consumer loop
      if (isProcessDeadError(error)) {
        console.log(`[Consumer][${conversationId}] Process appears dead, exiting consumer`)
        break
      }
    } finally {
      // Safety net (M1 fix): guarantee agent:complete is emitted if a turn started
      // but neither the happy path nor catch path emitted it (e.g., unhandled
      // exception between the sink call and emitAgentEvent).
      if (receivedAnyEvent && !agentCompleteEmitted) {
        console.warn(`[Consumer][${conversationId}] Safety net: emitting agent:complete (missed in normal path)`)
        emitAgentEvent('agent:complete', spaceId, conversationId, {
          type: 'complete',
          duration: Date.now() - turnStartTime,
        })
      }

      state.processingTurn = false
      state.currentSessionState = null
      state.consumerAbort.signal.removeEventListener('abort', onConsumerAbort)
    }
  }

  console.log(`[Consumer][${conversationId}] Consumer loop ended`)
}

// ============================================
// Turn Handling Helpers
// ============================================

/**
 * Check if an error indicates the CC process is dead (not recoverable).
 */
function isProcessDeadError(error: Error): boolean {
  const msg = error.message || ''
  return (
    msg.includes('ProcessTransport is not ready') ||
    msg.includes('exited with code') ||
    msg.includes('process exited') ||
    msg.includes('EPIPE') ||
    msg.includes('spawn ENOENT')
  )
}

/**
 * Promise-based sleep for backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
