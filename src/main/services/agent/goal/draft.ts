/**
 * Goals held for conversations whose engine session has no id of its own yet.
 *
 * The engine persists a goal under its session id, and a conversation learns
 * that id only when its first turn completes. Until then the user's goal is
 * kept here and seeded into every fresh session created for the conversation,
 * so it survives a session that was never created, and one rebuilt before the
 * first turn (which starts under a new id and would otherwise lose it).
 * Drafts live in memory only: quitting during that first turn loses the goal,
 * as it loses the turn's transcript.
 *
 * Imported by session-manager, so it must not import it (or ./index) back.
 */

import type { Goal, GoalInput } from '../../../../shared/types/goal'
import { getEngineCapabilities } from '../resolved-sdk'

/** conversationId -> goal */
const drafts = new Map<string, Goal>()

export function getGoalDraft(conversationId: string): Goal | null {
  return drafts.get(conversationId) ?? null
}

export function setGoalDraft(conversationId: string, goal: Goal | null): void {
  if (goal) drafts.set(conversationId, goal)
  else drafts.delete(conversationId)
}

/**
 * Seed a fresh (non-resumed) session with the conversation's draft goal.
 * The engine ignores the seed when the session already has a goal.
 */
export function applyGoalDraft(sdkOptions: Record<string, unknown>, conversationId: string): void {
  const draft = drafts.get(conversationId)
  if (!draft) return
  if (getEngineCapabilities()?.features.goal !== true) {
    console.warn(`[Agent][${conversationId}] Goal draft not seeded: the active engine keeps no goals`)
    return
  }
  const seed: GoalInput = { objective: draft.objective, doneWhen: [...draft.doneWhen] }
  sdkOptions.goal = seed
  console.log(`[Agent][${conversationId}] Seeding new session with the user's goal`)
}
