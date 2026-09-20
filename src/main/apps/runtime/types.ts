/**
 * apps/runtime -- Type Definitions
 *
 * Public types for the App execution engine.
 * Consumed by IPC handlers, renderer (via shared types), and bootstrap.
 */

import type { RunOutcome, AppStatus } from '../manager'
import type { AppRunStartInfo } from '../../../shared/apps/app-types'

// ============================================
// Trigger Types
// ============================================

/** What caused a run to execute */
export type TriggerType = 'schedule' | 'event' | 'manual' | 'escalation_followup' | 'continue_followup'

/** Structured trigger context passed to the AI */
export interface TriggerContext {
  type: TriggerType
  /** Human-readable description of the trigger */
  description: string
  /** Scheduler job ID (for schedule triggers) */
  jobId?: string
  /** Event data (for event triggers) */
  eventPayload?: Record<string, unknown>
  /** Escalation context (for escalation follow-ups) */
  escalation?: {
    originalQuestion: string
    /**
     * Every decision that was asked, normalised. Absent on a context persisted
     * before escalations could ask more than one, which `originalQuestion`
     * still describes on its own.
     */
    questions?: EscalationQuestion[]
    userResponse: EscalationResponse
    /** V2 session ID from the escalation run, used to restore conversation context */
    sessionId?: string
  }
  /** Continue context (for user-initiated continue / free-text follow-up on a run) */
  continue?: {
    /** V2 session ID from the prior run, used to restore full conversation context */
    sessionId?: string
    /** Free-text follow-up to send as the resumed turn. Falls back to "Continue." */
    userMessage?: string
    /**
     * True when this is a free-text follow-up to a run that already completed
     * successfully (report_to_user was called). Such a turn is conversational,
     * not task execution, so executeRun skips the report_to_user auto-continue
     * enforcement and does not treat a missing report as an error. Unset for the
     * premature-error "Continue" recovery, which must still drive the task to a
     * report_to_user.
     */
    interactive?: boolean
  }
}

// ============================================
// Run Status & Result
// ============================================

/** Status of a single automation run */
export type RunStatus = 'running' | 'ok' | 'error' | 'skipped' | 'waiting_user'

/** Result of a completed App execution run */
export interface AppRunResult {
  appId: string
  runId: string
  sessionKey: string
  outcome: RunOutcome
  startedAt: number
  finishedAt: number
  durationMs: number
  tokensUsed?: number
  errorMessage?: string
  /** Final text output from the AI (used for fallback activity entry) */
  finalText?: string
}

/**
 * Admission result of a non-blocking trigger: the run was accepted, not completed.
 *
 * `queued` carries no runId because the run row is only created once a global
 * concurrency slot is granted.
 */
export type { AppRunStartInfo } from '../../../shared/apps/app-types'

// ============================================
// Automation Run (DB record)
// ============================================

/** Persistent record of an automation run */
export type { ExecutionEnvironment } from '../../../shared/apps/app-types'
import type { ExecutionEnvironment } from '../../../shared/apps/app-types'

export interface AutomationRun {
  environment?: ExecutionEnvironment
  runId: string
  appId: string
  sessionKey: string
  status: RunStatus
  triggerType: TriggerType
  triggerData?: Record<string, unknown>
  startedAt: number
  finishedAt?: number
  durationMs?: number
  tokensUsed?: number
  errorMessage?: string
  /** V2 session ID for escalation context recovery */
  sessionId?: string
}

// ============================================
// Activity Entries
// ============================================

export type {
  ActivitySource, ActivityEntryType, ActivityEntryContent, EscalationQuestion,
  EscalationAnswer, EscalationResponse, ActivityEntry, AutomationAppState,
  ActivityQueryOptions, EscalationContinuation, PendingDecisionQuery,
} from '../../../shared/apps/app-types'
import type {
  ActivityEntry, ActivityQueryOptions, PendingDecisionQuery, AutomationAppState, EscalationQuestion,
  EscalationResponse,
} from '../../../shared/apps/app-types'

// ============================================
// Internal Activation State
// ============================================

/** Tracks resources for an activated App (not exported publicly) */
export interface ActivationState {
  appId: string
  /** Scheduler job IDs registered for this App */
  schedulerJobIds: string[]
  /** Event-bus unsubscribe functions */
  eventUnsubscribers: Array<() => void>
  /** Keep-alive disposer from background service */
  keepAliveDisposer: (() => void) | null
}

// ============================================
// Run Lifecycle Events
// ============================================

/**
 * Fired when a run enters the executing phase: after concurrency admission
 * and after the `automation_runs` row has been inserted/reopened, but BEFORE
 * the AI session is built. Subscribers can rely on (a) `runId` existing in
 * the DB by the time the event is delivered and (b) this event always
 * preceding any `RunFinishedEvent` for the same runId.
 */
export interface RunStartedEvent {
  appId: string
  runId: string
  sessionKey: string
  triggerType: TriggerType
  startedAt: number
}

/** Fired when a run leaves the executing phase (ok / error / skipped). */
export interface RunFinishedEvent {
  appId: string
  runId: string
  sessionKey: string
  triggerType: TriggerType
  outcome: RunOutcome
  /** Maps to the DB `automation_runs.status` column at the moment of emit. */
  status: 'ok' | 'error' | 'skipped'
  startedAt: number
  finishedAt: number
  durationMs: number
  tokensUsed?: number
  errorMessage?: string
}

export type RunStartedHandler = (evt: RunStartedEvent) => void
export type RunFinishedHandler = (evt: RunFinishedEvent) => void

/** Unsubscribe for runtime lifecycle handlers. */
export type RuntimeUnsubscribe = () => void

// ============================================
// Service Dependencies
// ============================================

/** Dependencies injected into the runtime service */
export interface AppRuntimeDeps {
  store: import('./store').ActivityStore
  appManager: import('../manager').AppManagerService
  scheduler: import('../../platform/scheduler').SchedulerService
  eventRouter: import('./event-router').EventRouter
  memory: import('../../platform/memory').MemoryService
  background: import('../../platform/background').BackgroundService
  getSpacePath: (spaceId: string) => string | null
  /** IM session registry for proactive push routing (null if not initialized) */
  imSessionRegistry?: import('./im-session-registry').ImSessionRegistry | null
  /**
   * @deprecated IM forwarding is now AI-driven via notify_bot tool.
   * Retained for backward compatibility — no longer used at runtime.
   */
  getChannelAdapter?: (channel: string) => import('../../../shared/types/im-channel').ImChannelAdapter | null
}

// ============================================
// Service Interface
// ============================================

/**
 * App Runtime Service -- the core execution engine.
 *
 * This is the public API consumed by IPC handlers and bootstrap.
 */
export interface AppRuntimeService {
  // ── Activation ──────────────────────────────

  /**
   * Activate an App: register scheduler jobs + event router subscriptions.
   * Idempotent -- safe to call multiple times for the same App.
   *
   * @throws AppNotFoundError if the App does not exist
   */
  activate(appId: string): Promise<void>

  /**
   * Deactivate an App: remove scheduler jobs + event router subscriptions.
   * Idempotent -- safe to call for non-activated Apps.
   */
  deactivate(appId: string): Promise<void>

  /**
   * Hot-sync all subscriptions (scheduler jobs + event-router listeners)
   * for an activated App **without interrupting running executions**.
   *
   * Re-reads the App's current spec and:
   *   - updates (remove + re-add) any scheduler jobs whose schedule changed
   *   - tears down old event-router listeners and registers new ones
   *
   * No-op if the App is not currently activated.
   */
  syncAppSubscriptions(appId: string): void

  // ── Execution ───────────────────────────────

  /**
   * Manually trigger an App execution and wait for the whole run to finish.
   * Respects concurrency limits.
   *
   * A run routinely takes minutes; callers that must stay responsive should use
   * `startManually` instead.
   */
  triggerManually(appId: string): Promise<AppRunResult>

  /**
   * Manually trigger an App execution, resolving as soon as the run is admitted
   * rather than when it finishes. The run continues in the background; its
   * result is observed through `getAppState` / the activity entries.
   *
   * Admission checks (app runnable, per-app dedup) still reject before the run
   * starts, so a caller learns about those the same way `triggerManually` does.
   */
  startManually(appId: string): Promise<AppRunStartInfo>

  // ── State Queries ───────────────────────────

  /**
   * Get the real-time state of an automation App.
   * Combines manager state with runtime scheduling info.
   */
  getAppState(appId: string): AutomationAppState
  getAllAppStates(): Record<string, AutomationAppState>
  getDirectoryRuntimeSnapshot(): import('../../../shared/apps/people-directory').DirectoryRuntimeSnapshot

  // ── Escalation ──────────────────────────────

  /**
   * Respond to an escalation: triggers a follow-up run with
   * the escalation context and user's response.
   */
  retryEscalationContinuation(appId: string, entryId: string): Promise<void>
  confirmEscalationDeadline(appId: string, entryId: string, deadlineAt: number | null): void
  closeRun(appId: string, runId: string): Promise<void>
  stopRun(appId: string, runId: string): Promise<void>
  getPendingEntries(appId: string, options?: PendingDecisionQuery): ActivityEntry[]
  getPendingInbox(options?: PendingDecisionQuery): import('../../../shared/apps/app-types').PendingDecisionInbox
  respondToEscalation(
    appId: string,
    entryId: string,
    response: EscalationResponse
  ): Promise<ActivityEntry>

  /**
   * User-initiated continue for a run that ended prematurely (LLM stopped without
   * calling report_to_user and all auto-retries were exhausted).
   *
   * Reopens the same run (error → running), restores the V2 session, sends
   * "Continue." as the initial message, then resumes the standard auto-retry
   * loop (up to MAX_AUTO_CONTINUES attempts).
   *
   * @throws Error if the run is not found or not in error state
   */
  continueFailedRun(appId: string, runId: string): Promise<void>

  /**
   * Send a user message to a run from the run-detail view.
   *
   * - Live run: injected into the current turn (absorbed at the next tool boundary).
   * - Finished run: reopens the run and resumes its session so the user can keep
   *   talking to it with full context (e.g. "this part is wrong, fix it").
   *
   * @throws Error if the run/app is not found, or the app is busy with another run.
   */
  injectIntoRun(appId: string, runId: string, text: string): Promise<void>

  // ── Activity Queries ────────────────────────

  /** Get activity entries for an App */
  getActivityEntries(appId: string, options?: ActivityQueryOptions): ActivityEntry[]
  getActivityEntry(appId: string, entryId: string): ActivityEntry | null

  /** Get the activity entries a single run produced, newest first */
  getEntriesForRun(runId: string): ActivityEntry[]

  /** Get a specific run record */
  getRun(runId: string): AutomationRun | null

  /** Get runs for an App */
  getRunsForApp(appId: string, limit?: number): AutomationRun[]

  // ── Lifecycle ───────────────────────────────

  /** Activate all Apps with status='active'. Called at bootstrap. */
  activateAll(): Promise<void>

  /** Deactivate all Apps. Called at shutdown. */
  deactivateAll(): Promise<void>

  // ── Lifecycle Events ────────────────────────

  /**
   * Register a listener for run-started events. Fired once per run after it
   * passes concurrency admission and before the AI is invoked.
   * Handler exceptions are swallowed — business flow is never affected.
   */
  onRunStarted(handler: RunStartedHandler): RuntimeUnsubscribe

  /**
   * Register a listener for run-finished events. Fired once per run after
   * its DB record has been finalized (ok / error / skipped).
   * Handler exceptions are swallowed — business flow is never affected.
   */
  onRunFinished(handler: RunFinishedHandler): RuntimeUnsubscribe
}
