/**
 * Conversation goal — read and set the engine session's goal on the user's behalf.
 *
 * The engine owns the goal (it persists it with the session and tells the model
 * about host-side changes on its next turn); this module only routes a request
 * to the conversation's live session, creating it the same way a conversation
 * switch does when none is live yet. Before a conversation has an engine
 * session id the goal is also kept as a draft (see draft.ts).
 *
 * Only engines advertising `features.goal` take part; every other engine reads
 * as "no goal" and refuses a set.
 */

import type { Goal, GoalInput } from '../../../../shared/types/goal'
import { getConversation } from '../../conversation.service'
import { emitAgentEvent } from '../events'
import { getEngineCapabilities } from '../resolved-sdk'
import { ensureSessionWarm, v2Sessions } from '../session-manager'
import type { V2SDKSession } from '../types'
import { getGoalDraft, setGoalDraft } from './draft'

type GoalSession = V2SDKSession & Required<Pick<V2SDKSession, 'getGoal' | 'setGoal'>>

export function isGoalSupported(): boolean {
  return getEngineCapabilities()?.features.goal === true
}

/** Current goal of a conversation, or null when it has none or the engine keeps no goals. */
export async function getConversationGoal(spaceId: string, conversationId: string): Promise<Goal | null> {
  if (!isGoalSupported()) return null
  if (!getConversation(spaceId, conversationId)) return null
  const { session } = await resolveGoalSession(spaceId, conversationId)
  if (session) return session.getGoal()
  return getGoalDraft(conversationId)
}

/**
 * Replace the conversation's goal, or clear it with null. Does not start a
 * turn: the model learns of the change when its next turn begins.
 *
 * @throws when the engine keeps no goals, the objective is blank, or the goal
 *   cannot be held (a resumable conversation whose session failed to start).
 */
export async function setConversationGoal(
  spaceId: string,
  conversationId: string,
  input: GoalInput | null
): Promise<Goal | null> {
  assertGoalSupported()
  const normalized = input ? prepareGoalInput(input) : null
  const { session, persisted } = await resolveGoalSession(spaceId, conversationId)
  if (!session && persisted) {
    console.error(`[Agent][${conversationId}] Goal not set: the conversation's session could not be started`)
    throw new Error('The conversation session is not available; try again in a moment')
  }
  return applyUserGoal(spaceId, conversationId, session, persisted, normalized)
}

/**
 * Validate a goal the user attached to a message, before anything of the turn
 * is recorded. Returns the normalized input.
 *
 * @throws when the engine keeps no goals or the objective is blank.
 */
export function prepareGoalInput(input: GoalInput): GoalInput {
  assertGoalSupported()
  const objective = typeof input.objective === 'string' ? input.objective.trim() : ''
  if (!objective) {
    console.warn('[Agent] Goal refused: the objective is blank')
    throw new TypeError('Goal objective must be a non-empty string')
  }
  const doneWhen = Array.isArray(input.doneWhen)
    ? input.doneWhen
        .filter((c): c is string => typeof c === 'string')
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
    : []
  return { objective, doneWhen }
}

/**
 * Set a message's goal on the session about to receive that message, so its
 * first model step already works toward it. `persisted`: the conversation has a
 * recorded engine session id.
 */
export function setGoalForTurn(
  spaceId: string,
  conversationId: string,
  session: V2SDKSession,
  input: GoalInput,
  persisted: boolean
): Goal | null {
  const goalSession = session.getGoal && session.setGoal ? (session as GoalSession) : null
  if (!goalSession) {
    console.error(`[Agent][${conversationId}] Session exposes no goal methods; the message's goal is kept as a draft only`)
  }
  return applyUserGoal(spaceId, conversationId, goalSession, persisted, input)
}

function applyUserGoal(
  spaceId: string,
  conversationId: string,
  session: GoalSession | null,
  persisted: boolean,
  input: GoalInput | null
): Goal | null {
  const goal = session ? session.setGoal(input) : input ? draftFrom(input) : null
  setGoalDraft(conversationId, persisted ? null : goal)

  console.log(
    `[Agent][${conversationId}] Goal ${goal ? 'set' : 'cleared'} by user ` +
    `(${session ? 'live session' : 'draft'})`
  )
  // The engine echoes the change with seenByModel once its next step picks it up.
  emitAgentEvent('agent:goal-updated', spaceId, conversationId, { goal, source: 'user', seenByModel: false })
  return goal
}

function assertGoalSupported(): void {
  if (!isGoalSupported()) {
    console.warn('[Agent] Goal refused: the active engine keeps no goals')
    throw new Error('The active agent engine does not support goals')
  }
}

/**
 * The conversation's live goal-capable session, started if needed. `persisted`
 * means the engine session has an id recorded on the conversation, so its goal
 * lives with that session and the draft no longer applies.
 */
async function resolveGoalSession(
  spaceId: string,
  conversationId: string
): Promise<{ session: GoalSession | null; persisted: boolean }> {
  const conversation = getConversation(spaceId, conversationId)
  // Only space conversations have a goal. Digital-human and IM sessions share
  // the live-session map, so an unknown id must not reach it.
  if (!conversation) {
    console.warn(`[Agent][${conversationId}] Goal refused: not a space conversation`)
    throw new Error(`Conversation not found: ${conversationId}`)
  }
  const persisted = Boolean(conversation.sessionId)
  if (persisted) setGoalDraft(conversationId, null)

  let session = liveGoalSession(conversationId)
  if (!session) {
    // Shares any creation already in flight, so a set racing the
    // conversation-switch warm-up lands on the session that warm-up creates.
    await ensureSessionWarm(spaceId, conversationId)
    session = liveGoalSession(conversationId)
  }
  return { session, persisted }
}

function liveGoalSession(conversationId: string): GoalSession | null {
  const session = v2Sessions.get(conversationId)?.session
  return session?.getGoal && session.setGoal ? (session as GoalSession) : null
}

function draftFrom(input: GoalInput): Goal {
  return {
    objective: input.objective,
    doneWhen: input.doneWhen ?? [],
    status: 'active',
    updatedBy: 'user',
    updatedAt: new Date().toISOString(),
  }
}
