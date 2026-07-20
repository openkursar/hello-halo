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
import { hasActiveTeamTasks } from './subagent-handler'
import type { Thought } from './types'

// ============================================
// Stop Generation
// ============================================

/**
 * Stop generation for a specific conversation or all conversations
 *
 * @param conversationId - Optional conversation ID. If not provided, stops all.
 */
export async function stopGeneration(conversationId?: string): Promise<void> {
  // Log caller stack trace for debugging spurious abort
  console.log(`[Agent] stopGeneration called, conversationId=${conversationId ?? 'ALL'}`, new Error('stopGeneration caller trace').stack)

  if (conversationId) {
    // Try consumer-based stop first (new REPL consumer model for chat conversations)
    const consumer = getConsumerHandle(conversationId)
    if (consumer && consumer.isRunning) {
      const sessionState = consumer.getActiveSessionState()
      const thoughts = sessionState?.thoughts || []

      const v2Session = v2Sessions.get(conversationId)
      // Team detection must include lifecycle thoughts carried across turns:
      // the team may have been spawned several turns ago, and stopping it via
      // interrupt() would leave its agents running in the subprocess.
      if (v2Session && hasActiveTeamTasks([...thoughts, ...consumer.getTeamLifecycleThoughts()])) {
        // Team mode: close() kills the entire CC subprocess (main agent + all team members).
        // interrupt() + drain is insufficient because team agents run independently in the
        // same subprocess — interrupt only stops the current SDK turn, not the agents.
        console.log(`[Agent] Team active — closing V2 session (kills subprocess + all agents)`)
        try {
          v2Session.session.close()
        } catch (e) {
          console.error(`[Agent] Failed to close V2 session:`, e)
        }
        closeV2Session(conversationId)  // This also stops the consumer
      } else if (v2Session) {
        // Normal mode: interrupt current turn — consumer handles the drain via stream()
        try {
          await (v2Session.session as any).interrupt()
          console.log(`[Agent] V2 session interrupted (consumer handles drain)`)
        } catch (e) {
          console.error(`[Agent] Failed to interrupt V2 session:`, e)
        }
      }

      // Abort the current turn's AbortController
      if (sessionState) {
        sessionState.abortController.abort()
      }

      console.log(`[Agent] Stopped generation for conversation (consumer): ${conversationId}`)
      return
    }

    // Fallback: legacy activeSessions-based stop (for app-chat.ts / execute.ts)
    const session = activeSessions.get(conversationId)
    if (session) {
      session.abortController.abort()
      activeSessions.delete(conversationId)

      const v2Session = v2Sessions.get(conversationId)
      if (v2Session) {
        if (hasActiveTeamTasks(session.thoughts)) {
          console.log(`[Agent] Team active — closing V2 session (kills subprocess + all agents)`)
          try {
            v2Session.session.close()
          } catch (e) {
            console.error(`[Agent] Failed to close V2 session:`, e)
          }
          closeV2Session(conversationId)
        } else {
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
      }

      console.log(`[Agent] Stopped generation for conversation: ${conversationId}`)
    }
  } else {
    // Stop all sessions: use interrupt for non-team sessions, close for team sessions
    for (const [convId, session] of Array.from(activeSessions)) {
      session.abortController.abort()

      const v2Session = v2Sessions.get(convId)
      if (v2Session) {
        if (hasActiveTeamTasks(session.thoughts)) {
          // Team mode: close() kills the entire subprocess (main agent + all team members)
          try {
            v2Session.session.close()
          } catch (e) {
            console.error(`[Agent] Failed to close V2 session ${convId}:`, e)
          }
        } else {
          // Non-team: interrupt first for graceful shutdown, then close
          try {
            await (v2Session.session as any).interrupt()
          } catch (e) {
            // Interrupt may fail if process already exiting — proceed to close
          }
          try {
            v2Session.session.close()
          } catch (e) {
            console.error(`[Agent] Failed to close V2 session ${convId}:`, e)
          }
        }
        closeV2Session(convId)
      }

      console.log(`[Agent] Stopped generation for conversation: ${convId}`)
    }
    activeSessions.clear()

    // Also close all V2 sessions with consumers (chat conversations not in activeSessions)
    for (const convId of Array.from(v2Sessions.keys())) {
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
} {
  // Check consumer model first (chat conversations)
  const consumer = getConsumerHandle(conversationId)
  if (consumer && consumer.isRunning) {
    const sessionState = consumer.getActiveSessionState()
    if (sessionState) {
      return {
        isActive: true,
        thoughts: [...sessionState.thoughts],
        spaceId: sessionState.spaceId
      }
    }
  }

  // Fallback: legacy activeSessions (app-chat.ts, execute.ts)
  const session = activeSessions.get(conversationId)
  if (!session) {
    return { isActive: false, thoughts: [] }
  }
  return {
    isActive: true,
    thoughts: [...session.thoughts],
    spaceId: session.spaceId
  }
}
