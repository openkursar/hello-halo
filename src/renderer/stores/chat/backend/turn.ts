/**
 * Session state transitions every backend shares: a turn starting, a send that
 * failed, a turn's streamed state being retired. Kept here so the two backends
 * cannot disagree about what "generating" or "finished" looks like.
 */
import { createEmptySessionState } from '../internal'
import type { ChatSet, SessionState } from '../internal'

/** State of a session whose turn is starting (a send or an autonomous turn). */
export function startedTurnState(previous: SessionState | undefined): SessionState {
  return {
    ...createEmptySessionState(),
    isGenerating: true,
    isThinking: true,
    turnId: (previous?.turnId ?? 0) + 1,
    turnStartedAt: Date.now(),
  }
}

export function beginTurn(set: ChatSet, conversationId: string): void {
  set((state) => {
    const sessions = new Map(state.sessions)
    sessions.set(conversationId, startedTurnState(sessions.get(conversationId)))
    return { sessions }
  })
}

/** A message no agent event will ever answer: end "generating" and show why. */
export function endTurnWithError(session: SessionState | undefined, error: string | null): SessionState {
  return { ...(session ?? createEmptySessionState()), error, isGenerating: false, isThinking: false }
}

/**
 * The session once its turn is persisted and the transcript re-read. An
 * `interrupted` error arrives after `agent:complete` through its own event, so
 * it may already be on the session by now and must survive; any other error is
 * persisted in the message and cleared here.
 */
export function finishedTurnState(session: SessionState): SessionState {
  const keepError = session.errorType === 'interrupted'
  return {
    ...session,
    isGenerating: false,
    streamingContent: '',
    compactInfo: null,
    pendingQuestion: null,
    queuedMessages: [],
    error: keepError ? session.error : null,
    errorType: keepError ? session.errorType : null,
  }
}
