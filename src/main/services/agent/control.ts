/**
 * Agent Module - Generation Control
 *
 * Functions for controlling agent generation including:
 * - Stop/abort generation
 * - Check if generating
 * - Get active sessions
 * - Get session state for recovery
 */

import { activeSessions, v2Sessions, closeV2Session, getConsumerHandle, getRunningConsumerIds } from './session-manager'
import { getActivePendingQuestion, type RecoverablePendingQuestion } from './permission-handler'
import { withdrawUnreadLiveInput } from './live-turn'
import type { StopReason, Thought } from './types'
import type { ApiRetryState } from '../../../shared/types/api-retry'
import { snapshotApiRetry } from './api-retry'
import { Emitter, type Event } from '../../platform/event'

// ============================================
// Stop Generation
// ============================================

/**
 * `user`: a person stopped the work. Live input the engine accepted but has not
 * read is withdrawn first and never runs (its sender's `onWithdrawn` decides
 * what becomes of it).
 * `internal`: the system stopped the turn; unread input runs right after it.
 * `controller`: a collaborator stopped only the assignment it still owns.
 */
export type { StopReason } from './types'

export interface StopGenerationOptions {
  reason: StopReason
  isCurrent?: () => boolean
}

const userStop = new Emitter<string>()
const userStopSettled = new Emitter<string>()

/**
 * A person stopped this conversation's work (payload: conversation id). Fires
 * synchronously inside `stopGeneration`, before its unread input is withdrawn,
 * so a delivery gate can hold what it still buffers for that conversation.
 */
export const onUserStop: Event<string> = userStop.event
export function emitUserStop(conversationId: string): void { userStop.fire(conversationId) }

/**
 * A person's stop of this conversation has done its part: unread input is
 * withdrawn and the turn was asked to end (or its process closed). When the
 * stop withdrew a continuation nothing had started yet, no turn end follows;
 * a turn that was running still reports its end as usual.
 */
export const onUserStopSettled: Event<string> = userStopSettled.event

/**
 * Stop generation for a specific conversation or all conversations
 *
 * @param conversationId - Optional conversation ID. If not provided, stops all.
 */
export async function stopGeneration(conversationId: string | undefined, options: StopGenerationOptions): Promise<void> {
  if (options.reason === 'controller' && !conversationId) throw new Error('A controller stop must name its conversation.')
  if (options.isCurrent?.() === false) {
    console.warn(`[Agent] Stop ignored for a replaced assignment: conversation=${conversationId} reason=${options.reason}`)
    return
  }
  // Log caller stack trace for debugging spurious abort
  console.log(`[Agent] stopGeneration called, conversationId=${conversationId ?? 'ALL'}, reason=${options.reason}`, new Error('stopGeneration caller trace').stack)

  const stoppedByUser = options.reason !== 'user' ? []
    : conversationId ? [conversationId] : Array.from(new Set([...v2Sessions.keys(), ...activeSessions.keys()]))
  for (const id of stoppedByUser) emitUserStop(id)
  const withdrawn = options.reason === 'controller'
    ? conversationId ? [conversationId] : [] : stoppedByUser
  if (withdrawn.length) await Promise.all(withdrawn.map(withdrawUnreadLiveInput))
  try {
    if (options.isCurrent?.() === false) {
      console.warn(`[Agent] Stop ignored after input withdrawal for a replaced assignment: conversation=${conversationId} reason=${options.reason}`)
      return
    }
    await endGeneration(conversationId, options.reason)
  } finally {
    for (const id of stoppedByUser) userStopSettled.fire(id)
  }
}

async function endGeneration(conversationId: string | undefined, reason: StopReason): Promise<void> {
  if (conversationId) {
    // Try consumer-based stop first (new REPL consumer model for chat conversations)
    const consumer = getConsumerHandle(conversationId)
    if (consumer && consumer.isRunning) {
      const sessionState = consumer.getActiveSessionState()
      const v2Session = v2Sessions.get(conversationId)
      // interrupt() can finish the turn before its acknowledgement arrives.
      // Its own signal fixes the cause without touching a successor turn.
      sessionState?.abortController.abort(reason)

      if (v2Session) {
        // Normal mode: interrupt current turn — consumer handles the drain via stream()
        try {
          await (v2Session.session as any).interrupt()
          console.log(`[Agent] V2 session interrupted (consumer handles drain)`)
        } catch (e) {
          console.error(`[Agent] Failed to interrupt V2 session:`, e)
        }
      }

      console.log(`[Agent] Stopped generation for conversation (consumer): ${conversationId}`)
      return
    }

    // Fallback: legacy activeSessions-based stop (for app-chat.ts / execute.ts)
    const session = activeSessions.get(conversationId)
    if (session) {
      session.abortController.abort(reason)
      activeSessions.delete(conversationId)

      const v2Session = v2Sessions.get(conversationId)
      if (v2Session) {
        // Normal mode: interrupt current turn.
        // Do NOT drain here — processStream() is already consuming the same
        // v2Session.session.stream() iterator and will drain stale messages
        // after detecting abortController.signal.aborted. Draining here would
        // race with processStream, causing one side to hang waiting for a
        // 'result' message that the other side already consumed.
        try {
          await (v2Session.session as any).interrupt()
          console.log(`[Agent] V2 session interrupted (processStream handles drain)`)
        } catch (e) {
          console.error(`[Agent] Failed to interrupt V2 session:`, e)
        }
      }

      console.log(`[Agent] Stopped generation for conversation: ${conversationId}`)
    }
  } else {
    // Stop all sessions and release their execution resources.
    for (const [convId, session] of Array.from(activeSessions)) {
      session.abortController.abort(reason)

      const v2Session = v2Sessions.get(convId)
      if (v2Session) {
        // Interrupt before closing the session resource.
        try {
          await (v2Session.session as any).interrupt()
        } catch (e) {
          console.warn(`[Agent] Interrupt failed during close: conversation=${convId}`, e)
        }
        try {
          v2Session.session.close()
        } catch (e) {
          console.error(`[Agent] Failed to close V2 session ${convId}:`, e)
        }
        closeV2Session(convId)
      }

      console.log(`[Agent] Stopped generation for conversation: ${convId}`)
    }
    activeSessions.clear()

    // Also close all V2 sessions with consumers (chat conversations not in activeSessions)
    for (const convId of Array.from(v2Sessions.keys())) {
      getConsumerHandle(convId)?.getActiveSessionState()?.abortController.abort(reason)
      closeV2Session(convId)  // This also stops consumers
    }

    console.log('[Agent] All generations stopped')
  }
}

// ============================================
// Generation Status
// ============================================

/**
 * Check if a conversation has an active generation.
 * Checks both consumer model (chat) and activeSessions (app-chat/execute).
 */
export function isGenerating(conversationId: string): boolean {
  // Check consumer model first (chat conversations)
  const consumer = getConsumerHandle(conversationId)
  if (consumer && consumer.isRunning && consumer.getActiveSessionState()) {
    return true
  }
  // Fallback: legacy activeSessions (app-chat.ts, execute.ts)
  return activeSessions.has(conversationId)
}

/**
 * Get all active session conversation IDs.
 * Includes both legacy activeSessions (app-chat/execute) and
 * consumer-based chat conversations with a running consumer.
 */
export function getActiveSessions(): string[] {
  const sessions = new Set(activeSessions.keys())

  // Include consumer-based sessions that have a running consumer
  for (const convId of getRunningConsumerIds()) {
    sessions.add(convId)
  }

  return Array.from(sessions)
}

// ============================================
// Session State Recovery
// ============================================

/**
 * Get current session state for a conversation (for recovery after refresh)
 *
 * This is used by remote clients to recover the current state when they
 * reconnect or refresh the page during an active generation.
 */
export function getSessionState(conversationId: string): {
  isActive: boolean
  thoughts: Thought[]
  spaceId?: string
  pendingQuestion?: RecoverablePendingQuestion
  /** The retry the engine is waiting on, with the wait left as of now. */
  apiRetry?: ApiRetryState
} {
  // A pending question lets reconnecting clients rebuild the question card, and
  // marks the session active on its own: the turn is blocked on the answer even
  // when the activity trackers below report nothing.
  const pendingQuestion = getActivePendingQuestion(conversationId) ?? undefined

  // Check consumer model first (chat conversations)
  const consumer = getConsumerHandle(conversationId)
  if (consumer && consumer.isRunning) {
    const sessionState = consumer.getActiveSessionState()
    if (sessionState) {
      return {
        isActive: true,
        thoughts: [...sessionState.thoughts],
        spaceId: sessionState.spaceId,
        pendingQuestion,
        ...(sessionState.apiRetry ? { apiRetry: snapshotApiRetry(sessionState.apiRetry) } : {})
      }
    }
  }

  // Fallback: legacy activeSessions (app-chat.ts, execute.ts)
  const session = activeSessions.get(conversationId)
  if (!session) {
    return pendingQuestion
      ? { isActive: true, thoughts: [], pendingQuestion }
      : { isActive: false, thoughts: [] }
  }
  return {
    isActive: true,
    thoughts: [...session.thoughts],
    spaceId: session.spaceId,
    pendingQuestion,
    ...(session.apiRetry ? { apiRetry: snapshotApiRetry(session.apiRetry) } : {})
  }
}
