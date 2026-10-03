/**
 * Resident chat-session budget. Each resident session keeps one engine process
 * (about 60–150 MB) alive between turns; sessions beyond the budget are closed
 * least-recently-used first and resume transparently on their next turn.
 */

export const DEFAULT_MAX_RESIDENT_SESSIONS = 10
export const MIN_MAX_RESIDENT_SESSIONS = 2
export const MAX_MAX_RESIDENT_SESSIONS = 50

/** Clamp a user-entered value into the accepted range (non-numbers → default). */
export function clampMaxResidentSessions(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_RESIDENT_SESSIONS
  return Math.min(MAX_MAX_RESIDENT_SESSIONS, Math.max(MIN_MAX_RESIDENT_SESSIONS, Math.round(value)))
}
