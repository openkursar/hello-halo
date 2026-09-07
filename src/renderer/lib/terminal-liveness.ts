/**
 * Sticky end-of-life state for a terminal view.
 *
 * The renderer's session mirror drops an entry the moment the main process
 * forgets the session, so "no entry" says nothing about whether the pty is
 * alive. A view that re-derived liveness from the entry alone would re-open its
 * keyboard onto a dead pty and drop its ended banner, letting the user type into
 * a terminal that has already exited. Ending is therefore observed once and kept.
 */

/** What the view knows about a session that has ended. */
export interface TerminalEndState {
  /** Exit code the session reported, or null if it ended without one. */
  exitCode: number | null
}

/** The mirror entry fields liveness depends on; `undefined` = no entry. */
type SessionLiveness = { state: 'running' | 'exited'; exitCode: number | null } | undefined

/**
 * Fold a mirror entry into the latched end state. Returns `prev` unchanged
 * while the session is running or the end is already latched, so callers can
 * use reference equality to skip a state update.
 */
export function latchTerminalEnd(
  prev: TerminalEndState | null,
  session: SessionLiveness
): TerminalEndState | null {
  if (prev) return prev
  if (session?.state !== 'exited') return null
  return { exitCode: session.exitCode }
}
