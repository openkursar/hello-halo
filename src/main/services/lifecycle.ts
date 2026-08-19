/**
 * App lifecycle orchestration - the single entry point for an intentional relaunch.
 *
 * Two independent mechanisms record whether the process exited cleanly:
 *   - the foundation session marker (`session.lock`, crash diagnostics)
 *   - the health registry `lastCleanExit` flag (orphan-cleanup decisions)
 *
 * On a normal quit both are cleared (shutdownServices + shutdownHealthSystem).
 * But `app.exit()` terminates immediately WITHOUT firing `before-quit`, so any
 * relaunch path that calls `app.relaunch(); app.exit()` directly bypasses both
 * shutdown paths. Clearing the two markers here, together, is what keeps an
 * intentional restart from being misread as a crash on the next launch — and
 * keeps the two trackers from disagreeing with each other.
 */

import { app } from 'electron'
import { markSessionCleanExit } from '../foundation/session-integrity'
import { markCleanExit } from './health/process-guardian'

/**
 * Record a clean exit in both trackers, then relaunch the app.
 * `reason` is logged for attribution only. Does not return — the process exits.
 */
export function relaunchApp(reason: string): void {
  console.log(`[Lifecycle] Clean relaunch: ${reason}`)
  markSessionCleanExit()
  markCleanExit()
  app.relaunch()
  app.exit(0)
}
