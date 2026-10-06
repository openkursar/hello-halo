/**
 * Keeping a digital human's run transcripts bounded.
 *
 * Every run writes the transcript "View process" reads, and the engine stores
 * its own session so the run can be continued. Neither was ever deleted, so a
 * person running every few minutes piled up a gigabyte within weeks. Only the
 * newest RUN_TRANSCRIPTS_KEPT runs of a person keep them; an older run keeps
 * its line on the timeline (result, summary, failure) and can no longer be
 * continued.
 *
 * The rule runs when one of the person's executions ends and clears at most
 * RUN_TRANSCRIPTS_CLEARED_PER_PASS runs, so a backlog drains over the next runs
 * instead of in one pause; nothing scans at startup. Files are removed by exact
 * run id, never by pattern: the same folder holds the person's chats.
 */

import { deleteStoredSession } from '../../services/agent'
import type { ActivityStore } from './store'
import { deleteRunTranscript } from './session-store'

export const RUN_TRANSCRIPTS_KEPT = 200
export const RUN_TRANSCRIPTS_CLEARED_PER_PASS = 50

/**
 * Clear the transcripts and engine sessions of the person's runs beyond its
 * newest RUN_TRANSCRIPTS_KEPT.
 *
 * @param currentSpacePath the person's space, where a run recorded before runs
 *   kept their environment wrote its transcript
 * @returns how many runs were cleared
 */
export function clearOldRunTranscripts(store: ActivityStore, appId: string, currentSpacePath: string | null): number {
  let cleared = 0
  for (const run of store.listRunsPastTranscriptRetention(appId, RUN_TRANSCRIPTS_KEPT, RUN_TRANSCRIPTS_CLEARED_PER_PASS)) {
    const spacePath = run.environment?.spacePath ?? currentSpacePath
    try {
      if (spacePath) deleteRunTranscript(spacePath, appId, run.runId)
    } catch (error) {
      // Not marked, so a later pass tries again.
      console.warn(`[Runtime] Could not delete the transcript of run ${run.runId}:`, error)
      continue
    }
    // Best effort: which engine stored the session is not recorded, and one
    // that cannot be deleted must not hold the run back from being cleared.
    if (run.sessionId && run.environment?.workDir) {
      try {
        deleteStoredSession(run.environment.workDir, run.sessionId)
      } catch (error) {
        console.warn(`[Runtime] Could not delete the engine session of run ${run.runId}:`, error)
      }
    }
    store.markTranscriptCleared(run.runId)
    cleared++
  }
  if (cleared > 0) console.log(`[Runtime] Cleared the process of ${cleared} old run(s): app=${appId}`)
  return cleared
}
