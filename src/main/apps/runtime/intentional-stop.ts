/**
 * apps/runtime -- Intentional Stop Marker
 *
 * Distinguishes a human-initiated stop from a genuine crash/error for
 * team-turn reporting (turn-report.ts). The stop entry points — `ipc/agent.ts`
 * and `controllers/agent.controller.ts` — sit outside both `services/agent`
 * and `apps/runtime`, so neither the agent layer nor this layer's own turn
 * end-of-turn handling can otherwise tell a hard stop apart from a crash: team
 * mode's stop path (`services/agent/control.ts`'s `stopGeneration`) kills the
 * CC subprocess outright rather than interrupting gracefully, and that lands
 * in the exact same unconditional-reject paths a genuine crash does. Marking
 * intent at the point of ACTION (the stop entry points) and reading it back
 * at the point of OUTCOME (`app-chat.ts`'s turn-end handling) closes that gap
 * without teaching `services/agent` this concept exists.
 *
 * Keyed by conversationId, self-expiring: a mark not consumed within
 * `MARK_TTL_MS` is treated as stale — the stop it described already resolved
 * some other way, or nothing followed it — rather than risking a mislabel of
 * an unrelated LATER ending on the same conversation.
 */

const MARK_TTL_MS = 30_000

const markedAt = new Map<string, number>()

/** Call immediately before actually stopping generation for `conversationId`. */
export function markIntentionalStop(conversationId: string): void {
  markedAt.set(conversationId, Date.now())
}

/**
 * Consume (read-and-clear) whether `conversationId`'s most recent stop was
 * intentional. One-shot: a second call for the same ending returns false, so
 * a stale mark can never attach itself to more than one turn's outcome.
 */
export function consumeIntentionalStop(conversationId: string): boolean {
  const at = markedAt.get(conversationId)
  if (at === undefined) return false
  markedAt.delete(conversationId)
  return Date.now() - at <= MARK_TTL_MS
}
