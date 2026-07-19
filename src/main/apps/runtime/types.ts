/**
 * apps/runtime -- Type Definitions
 *
 * Public types for the App execution engine.
 * Consumed by IPC handlers, renderer (via shared types), and bootstrap.
 */

import type { RunOutcome, AppStatus } from '../manager'

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

// ============================================
// Automation Run (DB record)
// ============================================

/** Persistent record of an automation run */
export interface AutomationRun {
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

/** Types of activity entries written by the AI via report_to_user */
export type ActivityEntryType =
  | 'run_complete'
  | 'run_skipped'
  | 'run_error'
  | 'milestone'
  | 'escalation'
  | 'output'

/** Content of an activity entry */
export interface ActivityEntryContent {
  /** Human-readable summary (required, written by AI) */
  summary: string
  /** Run status indicator */
  status?: 'ok' | 'error' | 'skipped'
  /** Run duration in milliseconds */
  durationMs?: number
  /** Error message */
  error?: string
  /** Next retry time (for run_error) */
  nextRetryMs?: number
  /** Structured output data (tables, lists, short inline markdown) */
  data?: unknown
  /** Absolute path to a markdown file written by AI (replaces inline data for large content) */
  dataPath?: string
  /** Question for the user (escalation only) */
  question?: string
  /** Preset choices for escalation */
  choices?: string[]
  /** File URL for output type */
  outputUrl?: string
}

/** User response to an escalation */
export interface EscalationResponse {
  ts: number
  choice?: string
  text?: string
}

/** A single Activity Thread entry */
export interface ActivityEntry {
  id: string
  appId: string
  runId: string
  type: ActivityEntryType
  ts: number
  sessionKey?: string
  content: ActivityEntryContent
  userResponse?: EscalationResponse
}

// ============================================
// App Runtime State
// ============================================

/** Real-time state of an automation App (for UI display) */
export interface AutomationAppState {
  /**
   * - running:      Actively executing a run right now
   * - queued:       Manually triggered; waiting for a global concurrency slot
   * - idle:         Active and scheduled, no run in progress
   * - paused:       User paused the app; subscriptions inactive
   * - waiting_user: AI escalated; awaiting user decision
   * - error:        Consecutive failures hit threshold; auto-disabled
   */
  status: 'running' | 'queued' | 'idle' | 'paused' | 'waiting_user' | 'error'
  nextRunAtMs?: number
  runningAtMs?: number
  /** Run ID of the currently executing run (only set when status === 'running') */
  runningRunId?: string
  /** Session key of the currently executing run (only set when status === 'running') */
  runningSessionKey?: string
  lastRunAtMs?: number
  lastStatus?: 'ok' | 'error' | 'skipped'
  lastError?: string
  lastDurationMs?: number
  consecutiveErrors?: number
  pendingEscalationId?: string
}

// ============================================
// Query Options
// ============================================

/** Options for querying activity entries */
export interface ActivityQueryOptions {
  limit?: number
  offset?: number
  type?: ActivityEntryType
  since?: number
}

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
   * Manually trigger an App execution.
   * Respects concurrency limits.
   */
  triggerManually(appId: string): Promise<AppRunResult>

  // ── State Queries ───────────────────────────

  /**
   * Get the real-time state of an automation App.
   * Combines manager state with runtime scheduling info.
   */
  getAppState(appId: string): AutomationAppState

  // ── Escalation ──────────────────────────────

  /**
   * Respond to an escalation: triggers a follow-up run with
   * the escalation context and user's response.
   */
  respondToEscalation(
    appId: string,
    entryId: string,
    response: EscalationResponse
  ): Promise<void>

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
