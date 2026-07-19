/**
 * apps/runtime -- Active Run Registry
 *
 * Tracks automation runs that are currently executing so a user can inject a
 * mid-run supplement ("nudge the AI back on track") from the run-detail view.
 *
 * This is the run-scoped analogue of the agent service's `inject-message.ts`:
 * - inject-message.ts pushes into a conversation V2 session and persists to
 *   conversation.service (the wrong store for automation runs).
 * - This module pushes into the run's SDK session and persists to the run's
 *   JSONL transcript (session-store), keeping automation storage isolated from
 *   the user's conversation list (see runtime/DESIGN.md §2.2).
 *
 * Lifecycle: `executeRun` registers a handle right after the session is created
 * and unregisters it in its `finally`. The registry therefore only ever holds
 * runs that are genuinely live and injectable.
 */

import type { SessionWriter } from './session-store'

/** A live, injectable automation run. */
export interface ActiveRunHandle {
  /** Authoritative run id (UUID, also the JSONL file name). */
  runId: string
  /** Owning app id — used to authorize injection requests. */
  appId: string
  /** Space the app belongs to. */
  spaceId: string
  /** The run's V2 SDK session. Only `send` is required for injection. */
  session: { send: (message: string) => void }
  /** JSONL writer for the run transcript (absent when no space path resolved). */
  writer?: SessionWriter
}

/** runId -> live run handle. */
const activeRuns = new Map<string, ActiveRunHandle>()

/** Register a run as live + injectable. Called once per run after session creation. */
export function registerActiveRun(handle: ActiveRunHandle): void {
  activeRuns.set(handle.runId, handle)
}

/** Remove a run from the registry. Idempotent; called in executeRun's finally. */
export function unregisterActiveRun(runId: string): void {
  activeRuns.delete(runId)
}

/** Look up a live run by id. */
export function getActiveRun(runId: string): ActiveRunHandle | undefined {
  return activeRuns.get(runId)
}

/** Whether a run is currently live + injectable. */
export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId)
}

/**
 * Inject a user supplement into a live automation run.
 *
 * 1. Validates the run is active and owned by `appId`.
 * 2. Persists the message to the run JSONL as a user turn, so "View process"
 *    reload and remote clients render it in order.
 * 3. Sends it to the CC subprocess — absorbed at the next tool boundary within
 *    the current turn (same mechanism as agent/inject-message.ts).
 *
 * @throws if the message is empty, the run is not active, or it belongs to a
 *         different app (defends against a stale/forged runId).
 */
export function injectIntoActiveRun(appId: string, runId: string, text: string): void {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error('Cannot inject an empty message')
  }

  const run = activeRuns.get(runId)
  if (!run) {
    throw new Error(`No active run to inject into: ${runId}`)
  }
  if (run.appId !== appId) {
    throw new Error(`Run ${runId} does not belong to app ${appId}`)
  }

  // Persist first so the message survives reload even if the turn ends immediately.
  run.writer?.writeTrigger(trimmed)

  // Push into the live turn. CC enqueues it at the next tool-round boundary.
  run.session.send(trimmed)

  console.log(`[ActiveRuns][${runId.slice(0, 8)}] Injected mid-run supplement (${trimmed.length} chars)`)
}
