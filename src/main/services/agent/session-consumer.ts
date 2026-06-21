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
 * Turn types:
 *   1. User-initiated: sendMessage() calls v2Session.send() → CC processes → consumer picks up
 *   2. Autonomous: CC gets internal input (team agent message) → consumer picks up
 *   The consumer doesn't distinguish — it processes whatever comes out.
 *
 * Lifecycle:
 *   - Started when V2 session is created (startConsumer)
 *   - Stopped when V2 session is closed/rebuilt (consumer.stop())
 *   - Never exits between turns
 */

import type { V2SDKSession, SessionState, Thought } from './types'
import type { StreamResult } from './stream-processor'
import { processStream } from './stream-processor'
import { emitAgentEvent } from './events'
import {
  addMessage,
  updateLastMessage
} from '../conversation.service'
import { saveSessionId } from '../conversation.service'
import { notifyTaskComplete } from '../notification.service'
import { getConversation } from '../conversation.service'
import { type FileChangesSummary, extractFileChangesSummaryFromThoughts } from '../../../shared/file-changes'
import { createSessionState, consumePendingRebuild } from './session-manager'

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
  /** Get thoughts accumulated in the most recently completed turn.
   * Used by session-manager to detect active team agents between turns. */
  getLastTurnThoughts(): Thought[]
  /** Update the display model name used for thought parsing (and the
   * source-resolved context window shown in token usage).
   * Called by sendMessage to keep both in sync after model switches
   * without requiring a full session rebuild. */
  updateDisplayModel(displayModel: string, contextWindow?: number): void
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
  /** AbortController for the consumer loop itself (not per-turn) */
  consumerAbort: AbortController
  /** True when consumer is inside for-await (processing a turn) */
  processingTurn: boolean
  /** Current turn's SessionState (created fresh each turn) */
  currentSessionState: SessionState | null
  /** Running flag */
  running: boolean
  /** Thoughts from the most recently completed turn.
   * Persists between turns so session-manager can detect active team agents
   * even while the consumer is idle (waiting for the next turn). */
  lastTurnThoughts: Thought[]
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
 * @param spaceId - Space ID for persistence and event routing
 * @param conversationId - Conversation ID for persistence and event routing
 * @param displayModel - Display model name for thought parsing
 * @param contextWindow - Source-resolved context window for token-usage display
 * @returns ConsumerHandle for lifecycle control
 */
export function startConsumer(
  v2Session: V2SDKSession,
  spaceId: string,
  conversationId: string,
  displayModel: string,
  contextWindow?: number
): ConsumerHandle {
  const state: ConsumerState = {
    spaceId,
    conversationId,
    displayModel,
    contextWindow,
    consumerAbort: new AbortController(),
    processingTurn: false,
    currentSessionState: null,
    running: true,
    lastTurnThoughts: [],
  }

  // Fire and forget — errors are logged but don't propagate
  consumeLoop(v2Session, state).catch((err) => {
    if (!state.consumerAbort.signal.aborted) {
      console.error(`[Consumer][${conversationId}] Fatal error in consume loop:`, err)
    }
  }).finally(() => {
    state.running = false
    state.currentSessionState = null
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
    getLastTurnThoughts() {
      return state.lastTurnThoughts
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
  const { spaceId, conversationId } = state

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
      // emits system:init — we create the assistant placeholder there, uniformly
      // for both user-initiated and autonomous turns.

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
          onRawMessage: undefined,
          onTurnInit: () => {
            receivedAnyEvent = true

            // Mark consumer as actively processing. From this point on,
            // getOrCreateV2Session will correctly defer session rebuilds
            // until this turn completes (protecting in-flight responses).
            state.currentSessionState = sessionState

            // Create assistant placeholder message for this turn
            addMessage(spaceId, conversationId, {
              role: 'assistant',
              content: '',
              toolCalls: [],
            })

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

        persistTurnResult(spaceId, conversationId, result)

        // Retain thoughts from this turn so session-manager can detect active team
        // agents between turns (consumer idle but CC subprocess still has work).
        state.lastTurnThoughts = result.thoughts

        // Emit agent:complete — injection messages are absorbed mid-turn by CC,
        // they do NOT produce a separate turn, so always complete normally.
        emitAgentEvent('agent:complete', spaceId, conversationId, {
          type: 'complete',
          duration: Date.now() - turnStartTime,
          tokenUsage: result.tokenUsage,
        })
        agentCompleteEmitted = true

        // System notification for task completion (if window not focused)
        const conversation = getConversation(spaceId, conversationId)
        notifyTaskComplete(conversation?.title || 'Conversation')

        console.log(
          `[Consumer][${conversationId}] Turn complete:` +
          ` content=${result.finalContent.length} chars, thoughts=${result.thoughts.length},` +
          ` duration=${Date.now() - turnStartTime}ms`
        )

        // Drain timeout: the abort-drain failed to receive a result within the
        // safety timeout. The REPL pipe is dirty — continuing would read stale data.
        // Break the consumer loop; next sendMessage detects the dead consumer (zombie)
        // and creates a fresh session via getOrCreateV2Session.
        if (result.drainTimedOut) {
          console.warn(`[Consumer][${conversationId}] Drain timed out — REPL pipe is dirty, breaking for session rebuild`)
          break
        }

        // Check if API config changed during this turn (M5 fix).
        // If so, break the loop — the session will be rebuilt with new credentials
        // on the next sendMessage via getOrCreateV2Session.
        if (consumePendingRebuild(conversationId)) {
          console.log(`[Consumer][${conversationId}] Config changed during turn, breaking for rebuild`)
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

      // Persist error to conversation.
      // If onTurnInit fired (receivedAnyEvent=true), the assistant placeholder exists
      // and we can safely update it. Otherwise, system:init never arrived — no
      // placeholder was created — so we must addMessage to avoid updateLastMessage
      // accidentally corrupting a previous turn's assistant message.
      if (receivedAnyEvent) {
        updateLastMessage(spaceId, conversationId, {
          content: '',
          error: error.message,
        })
      } else {
        addMessage(spaceId, conversationId, {
          role: 'assistant',
          content: '',
          error: error.message,
          toolCalls: [],
        })
      }

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
      // exception between persistTurnResult and emitAgentEvent).
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
 * Persist a completed turn's result to the conversation.
 */
function persistTurnResult(
  spaceId: string,
  conversationId: string,
  result: StreamResult,
): void {
  const { finalContent, hasMeaningfulContent, thoughts, tokenUsage, capturedSessionId, hasErrorThought, errorThought } = result

  // Save session ID for future resumption
  if (capturedSessionId) {
    saveSessionId(spaceId, conversationId, capturedSessionId)
  }

  // Never persist the empty-response repair placeholder as message content —
  // it would render as a blank bubble and mask the empty-response error block.
  // Still persist when only thoughts exist (thinking-only turns) so the
  // reasoning survives a reload.
  const contentToStore = hasMeaningfulContent ? finalContent : ''

  if (contentToStore || hasErrorThought || thoughts.length > 0) {
    // Extract file changes summary
    let metadata: { fileChanges?: FileChangesSummary } | undefined
    if (thoughts.length > 0) {
      try {
        const fileChangesSummary = extractFileChangesSummaryFromThoughts(thoughts)
        if (fileChangesSummary) {
          metadata = { fileChanges: fileChangesSummary }
        }
      } catch (error) {
        console.error(`[Consumer][${conversationId}] Failed to extract file changes:`, error)
      }
    }

    updateLastMessage(spaceId, conversationId, {
      content: contentToStore,
      thoughts: thoughts.length > 0 ? [...thoughts] : undefined,
      tokenUsage: tokenUsage || undefined,
      metadata,
      error: errorThought?.content,
    })
  }
}

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
