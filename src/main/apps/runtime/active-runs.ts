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
import type { TriggerType } from './types'
import type { ContentReference } from '../../../shared/types/content-reference'
import { formatReferencesBlock } from '../../services/agent'
import { createTurnGate } from '../../platform/turn-gate'
import { Emitter } from '../../platform/event'

/** A live, injectable automation run. */
export interface ActiveRunHandle {
  /** Authoritative run id (UUID, also the JSONL file name). */
  runId: string
  /** Owning app id — used to authorize injection requests. */
  appId: string
  /** Space the app belongs to. */
  spaceId: string
  /** What started the run. */
  triggerType: TriggerType
  /** Epoch ms the run began. */
  startedAt: number
  /** The run's V2 SDK session. Only `send` is required for injection. */
  session: {
    send: (message: string) => void
    sendIntoLiveTurn?: (message: string, options?: { onWithdrawn?: () => void }) => boolean
    hasPendingInput?: () => boolean
    withdrawUnreadInput?: () => Promise<number>
  }
  /** JSONL writer for the run transcript (absent when no space path resolved). */
  writer?: SessionWriter
}

/** runId -> live run handle. */
const activeRuns = new Map<string, ActiveRunHandle>()
const ready = new Emitter<ActiveRunHandle>()
export const onActiveRunReady = ready.event

export interface RunSupplement {
  text: string
  references?: ContentReference[]
}

/** A person stopped the run before it read these; the input ids of their records in the run's transcript. */
export type RunInputWithdrawn = (inputIds: readonly string[]) => void

const liveGate = createTurnGate<{ appId: string; messages: readonly RunSupplement[]; onWithdrawn: RunInputWithdrawn }>({
  dispatch: async () => { throw new Error('Run input must be started by the runtime') },
  isBusy: (runId) => activeRuns.has(runId),
  getJobIdentity: () => 'owner',
  getActiveIdentity: (runId) => activeRuns.has(runId) ? 'owner' : undefined,
  deliverMidTurn: (runId, job) => {
    const run = activeRuns.get(runId)
    if (!run || run.appId !== job.appId || !run.session.sendIntoLiveTurn) return false
    const text = job.messages.map((message) => formatReferencesBlock(message.references, undefined) + message.text).join('\n\n')
    const inputIds: string[] = []
    if (!run.session.sendIntoLiveTurn(text, { onWithdrawn: () => job.onWithdrawn(inputIds) })) return false
    for (const message of job.messages) {
      try {
        const written = run.writer?.writeTrigger(message.text, undefined, undefined, undefined, message.references)
        if (written) inputIds.push(written.inputId)
      } catch (error) {
        // Engine acceptance cannot be undone; retrying the input would duplicate the work.
        console.error('[ActiveRuns] Accepted input could not be recorded', { runId, error })
      }
    }
    return true
  },
})

/** Initial send has been issued; queued events may now join this run. */
export function notifyActiveRunReady(runId: string): void {
  const run = activeRuns.get(runId)
  if (run) ready.fire(run)
}

/** False leaves delivery ownership with the runtime or its durable continuation. */
export function tryInjectIntoActiveRun(appId: string, runId: string, messages: readonly RunSupplement[], onWithdrawn: RunInputWithdrawn): boolean {
  return liveGate.tryDeliverLive(runId, { appId, messages, onWithdrawn })
}

/** A person's run-detail words a stop left unread stay in the run's record, marked. */
export function markRunInputsStopped(runId: string, inputIds: readonly string[]): void {
  const writer = activeRuns.get(runId)?.writer
  if (!writer) {
    console.warn(`[ActiveRuns] Stopped input could not be marked: run=${runId} count=${inputIds.length}`)
    return
  }
  for (const inputId of inputIds) writer.writeInputOutcome(inputId, 'stopped')
}

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

/** Every live run of one app. */
export function listActiveRuns(appId: string): ActiveRunHandle[] {
  return Array.from(activeRuns.values()).filter((r) => r.appId === appId)
}

/**
 * Inject a user supplement into a live automation run.
 *
 * 1. Validates the run is active and owned by `appId`.
 * 2. Transfers ownership synchronously to the engine's live-input contract.
 * 3. Records the original message for run-detail reloads; refused input is not recorded.
 *
 * @throws if the message is empty, the run is not active, or it belongs to a
 *         different app (defends against a stale/forged runId).
 */
export function injectIntoActiveRun(appId: string, runId: string, text: string, references?: ContentReference[]): void {
  const trimmed = text.trim()
  if (!trimmed && !references?.length) {
    throw new Error('Cannot inject an empty message')
  }

  const run = activeRuns.get(runId)
  if (!run) {
    throw new Error(`No active run to inject into: ${runId}`)
  }
  if (run.appId !== appId) {
    throw new Error(`Run ${runId} does not belong to app ${appId}`)
  }

  if (!tryInjectIntoActiveRun(appId, runId, [{ text: trimmed, references }], inputIds => markRunInputsStopped(runId, inputIds))) {
    throw new Error(`Run is no longer accepting input: ${runId}`)
  }
}
