/**
 * Picking up a turn that is already running when a conversation is opened
 * (page refresh, another client started it): the thoughts so far, an unanswered
 * question, a retry the engine is waiting on. The engine's session state is
 * keyed by conversation id for every kind of conversation, so this is shared.
 */
import { api, createEmptySessionState } from '../internal'
import type { Thought, Question } from '../internal'
import type { ApiRetryState } from '../../../../shared/types/api-retry'
import type { BackendContext } from './types'

interface EngineSessionState {
  isActive: boolean
  thoughts: Thought[]
  spaceId?: string
  pendingQuestion?: { id: string; questions: Question[] }
  apiRetry?: ApiRetryState
}

/** The engine's view of a session, or null when it cannot be read. */
export async function readEngineSessionState(conversationId: string): Promise<EngineSessionState | null> {
  try {
    const response = await api.getSessionState(conversationId)
    return response.success && response.data ? response.data as EngineSessionState : null
  } catch (error) {
    console.error('[ChatStore] Failed to read session state:', error)
    return null
  }
}

export async function recoverSessionState(ctx: BackendContext, conversationId: string): Promise<void> {
  const { set, get } = ctx
  const sessionState = await readEngineSessionState(conversationId)
  if (!sessionState?.isActive) return

  if (sessionState.thoughts.length > 0) {
    console.log(`[ChatStore] Recovering ${sessionState.thoughts.length} thoughts for conversation ${conversationId}`)
    set((state) => {
      const sessions = new Map(state.sessions)
      const existing = sessions.get(conversationId) || createEmptySessionState()
      sessions.set(conversationId, { ...existing, isGenerating: true, isThinking: true, thoughts: sessionState.thoughts })
      return { sessions }
    })
  }

  // A question's event is one-shot: a client that was away never saw it and the
  // agent stays blocked with no visible prompt.
  if (sessionState.pendingQuestion) {
    console.log(`[ChatStore] Recovering pending question for conversation ${conversationId}`)
    get().handleAskQuestion({
      spaceId: sessionState.spaceId ?? '',
      conversationId,
      id: sessionState.pendingQuestion.id,
      questions: sessionState.pendingQuestion.questions,
    })
  }

  if (sessionState.apiRetry) {
    get().handleAgentApiRetry({ spaceId: sessionState.spaceId ?? '', conversationId, retry: sessionState.apiRetry })
  }
}
