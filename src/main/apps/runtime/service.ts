/**
 * apps/runtime -- App Runtime Service
 *
 * The core orchestration layer that connects all platform modules.
 * Translates App subscriptions into scheduler jobs and event router
 * subscriptions, manages the activation lifecycle, and delegates
 * execution to executeRun().
 *
 * This is the ONLY module that crosses layer boundaries:
 *   apps/ -> platform/ -> services/
 */

import { randomUUID } from 'crypto'
import type { InstalledApp, AppManagerService, RunOutcome, AppStatus } from '../manager'
import { AppNotFoundError } from '../manager'
import type { AutomationSpec, SubscriptionDef } from '../spec'
import type { SchedulerService, SchedulerJob, SchedulerJobCreate } from '../../platform/scheduler'
import type { EventRouter } from './event-router'
import type { EventFilter } from './event-types'
import { sourceConfigToEventFilter } from './event-filter-mapping'
import type { MemoryService } from '../../platform/memory'
import type { BackgroundService } from '../../platform/background'
import type { ActivityStore } from './store'
import type {
  AppRuntimeService,
  AppRuntimeDeps,
  ActivationState,
  AutomationAppState,
  AppOverviewEntry,
  AppRunResult,
  AppRunStartInfo,
  TriggerContext,
  EscalationResponse,
  EscalationQuestion,
  ActivityQueryOptions,
  PendingDecisionQuery,
  ActivityEntry,
  AutomationRun,
  AutomationRunWithSummary,
  RunQueryOptions,
  RunStats,
  RunStartedHandler,
  RunFinishedHandler,
  RunStartedEvent,
  RunFinishedEvent,
  RuntimeUnsubscribe,
} from './types'
import { AppNotRunnableError, EscalationNotFoundError, ConcurrencyLimitError } from './errors'
import { Semaphore } from './concurrency'
import { executeRun } from './execute'
import { injectIntoActiveRun, isRunActive } from './active-runs'
import { automaticEnabled, blockedReason, deriveRuntimeStatus } from './app-state'
import { getActiveTeamRuntime } from './team'
import { getEscalationQuestions, formatEscalationAnswer } from '../../../shared/apps/app-types'
import type { ContentReference } from '../../../shared/types/content-reference'
import { broadcastToAll } from '../../http/websocket'
import { destroyChatBrowserContextsForApp } from './app-chat-browser'
import { sendToRenderer } from '../../foundation/window.service'
import { notifyAppEvent } from '../../services/notification.service'
import { RunningRuns } from './running-runs'
import { clearOldRunTranscripts } from './run-retention'

// ============================================
// Constants
// ============================================

/** Default max concurrent automation runs */
const DEFAULT_MAX_CONCURRENT = 10

/** Max consecutive errors before auto-pausing */
const MAX_CONSECUTIVE_ERRORS = 5

/** Keep-alive reason string for the background service */
const KEEP_ALIVE_REASON = 'automation-apps-active'

/** Keep-alive reason while an app has a run in flight (covers manual runs of inactive apps) */
const RUN_KEEP_ALIVE_REASON = 'automation-run'

/** Longest an app state served by getAllAppStates may lag inputs that changed without a publish */
const STATE_CACHE_TTL_MS = 60_000

/** How often to check for timed-out escalations (5 minutes) */
const ESCALATION_CHECK_INTERVAL_MS = 5 * 60 * 1000

/** Minimum interval between data prune runs (24 hours) */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Recorded on runs whose process died before they could finish. */
const INTERRUPTED_RUN_MESSAGE = 'Interrupted — Halo stopped while this run was in progress.'

/** Refusal to continue a run whose transcript and engine session the retention rule deleted. */
const RUN_PROCESS_CLEARED_MESSAGE = 'This execution can no longer be continued: its process was cleared under the retention rule'

// ============================================
// Service Factory
// ============================================

/**
 * Create the AppRuntimeService implementation.
 *
 * All state is held in closures (activation map, semaphore).
 * All persistent state is in SQLite via the ActivityStore.
 *
 * @param deps - Injected dependencies
 * @returns Fully initialized AppRuntimeService
 */
export function createAppRuntimeService(deps: AppRuntimeDeps): AppRuntimeService {
  const queuedAutomatic = new Map<string, Set<AbortController>>()
  const intentionallyStoppedRuns = new Set<string>()
  // By run id. `startedAt` is this execution's own start: a continued run keeps
  // its first start in the database.
  const activeExecutions = new Map<string, { controller: AbortController; startedAt: number }>()
  const continuationDispatches = new Set<string>()
  let continuationInterval: ReturnType<typeof setInterval> | null = null
  let shuttingDown = false
  let drainingContinuations = false
  const { store, appManager, scheduler, eventRouter, memory, background } = deps

  // ── Internal State ──────────────────────────────────
  const activations = new Map<string, ActivationState>()
  const semaphore = new Semaphore(DEFAULT_MAX_CONCURRENT)
  // Lifecycle event listeners (used by analytics; handlers are isolated).
  const runStartedHandlers: RunStartedHandler[] = []
  const runFinishedHandlers: RunFinishedHandler[] = []

  function emitRunStarted(evt: RunStartedEvent): void {
    for (const handler of runStartedHandlers) {
      try {
        handler(evt)
      } catch (err) {
        console.error('[Runtime] onRunStarted handler error:', err)
      }
    }
  }

  function emitRunFinished(evt: RunFinishedEvent): void {
    for (const handler of runFinishedHandlers) {
      try {
        handler(evt)
      } catch (err) {
        console.error('[Runtime] onRunFinished handler error:', err)
      }
    }
  }

  /** Map RunOutcome -> the DB-aligned status used in RunFinishedEvent. */
  function outcomeToStatus(outcome: RunOutcome): 'ok' | 'error' | 'skipped' {
    if (outcome === 'error') return 'error'
    if (outcome === 'skipped' || outcome === 'noop') return 'skipped'
    return 'ok'
  }
  // Each run has its own execution key ("{appId}:{counter}") so concurrent runs
  // of one App never overwrite each other's abort controller. While an app has
  // a run in flight it holds the process alive (a closed window must not end it).
  const runKeepAlive = new Map<string, () => void>()
  const runningRuns = new RunningRuns((appId, busy) => {
    if (busy) {
      runKeepAlive.set(appId, background.registerKeepAliveReason(`${RUN_KEEP_ALIVE_REASON}:${appId}`))
    } else {
      runKeepAlive.get(appId)?.()
      runKeepAlive.delete(appId)
    }
  })
  let executionCounter = 0
  /**
   * Reference-counted map of app IDs waiting for a global semaphore slot.
   * Value = number of runs currently queued for that app. Used to:
   *   (a) expose 'queued' status to the renderer, and
   *   (b) enforce per-app dedup (reject a second trigger while one is queued/running).
   * A Map (vs Set) is required because the same app can be queued multiple times
   * (e.g. a scheduled run and an event run arrive simultaneously). Each caller
   * independently increments/decrements so the flag stays accurate until the last
   * queued run acquires its slot.
   */
  const pendingTriggers = new Map<string, number>()
  /** Interval handle for escalation timeout checker */
  let escalationCheckInterval: ReturnType<typeof setInterval> | null = null
  /** Timestamp of last successful prune (avoid running too frequently) */
  let lastPruneAtMs = 0

  // ── Helper: Build trigger context ───────────────────
  function buildScheduleTriggerContext(job: SchedulerJob, app: InstalledApp): TriggerContext {
    const subId = (job.metadata as any)?.subscriptionId || 'unknown'
    const schedule = job.schedule
    let scheduleDesc: string

    if (schedule.kind === 'every') {
      scheduleDesc = `every ${schedule.every}`
    } else if (schedule.kind === 'cron') {
      scheduleDesc = `cron: ${schedule.cron}`
    } else {
      scheduleDesc = `once at ${new Date(schedule.once).toISOString()}`
    }

    return {
      type: 'schedule',
      description: `Scheduled run for "${app.spec.name}" (${scheduleDesc}). ` +
        `Time: ${new Date().toISOString()}`,
      jobId: job.id,
    }
  }

  function buildEventTriggerContext(
    eventType: string,
    eventPayload: Record<string, unknown>,
    app: InstalledApp
  ): TriggerContext {
    return {
      type: 'event',
      description: `Triggered by event "${eventType}" for "${app.spec.name}". ` +
        `Time: ${new Date().toISOString()}`,
      eventPayload,
    }
  }

  function buildManualTriggerContext(app: InstalledApp): TriggerContext {
    return {
      type: 'manual',
      description: `Manually triggered run for "${app.spec.name}". ` +
        `Time: ${new Date().toISOString()}`,
    }
  }

  function buildEscalationTriggerContext(
    app: InstalledApp,
    originalQuestion: string,
    questions: EscalationQuestion[],
    response: EscalationResponse,
    sessionId?: string
  ): TriggerContext {
    return {
      type: 'escalation_followup',
      description: `Follow-up run for "${app.spec.name}" after user responded to escalation. ` +
        `Original question: "${originalQuestion}". ` +
        `User response: "${formatEscalationAnswer(questions, response) || '(no text)'}". ` +
        `Time: ${new Date().toISOString()}`,
      escalation: {
        originalQuestion,
        questions,
        userResponse: response,
        sessionId,
      },
    }
  }

  function buildContinueTriggerContext(
    app: InstalledApp,
    sessionId?: string,
    userMessage?: string,
    interactive?: boolean,
    references?: ContentReference[]
  ): TriggerContext {
    return {
      type: 'continue_followup',
      description: `User-initiated continue for "${app.spec.name}". ` +
        `Time: ${new Date().toISOString()}`,
      continue: {
        sessionId,
        userMessage,
        interactive,
        ...(references?.length ? { references } : {}),
      },
    }
  }

  // ── Helper: Broadcast app state change ──────────────
  // Last state published per app, and the state cache getAllAppStates reads.
  // A state is recomputed on every publish; an app whose inputs change without
  // a publish is at most STATE_CACHE_TTL_MS stale in getAllAppStates.
  const lastPublishedState = new Map<string, string>()
  const stateCache = new Map<string, { state: AutomationAppState; at: number }>()

  function computeAppState(appId: string): AutomationAppState {
    const state = service.getAppState(appId)
    stateCache.set(appId, { state, at: Date.now() })
    return state
  }

  function forgetAppState(appId: string): void {
    lastPublishedState.delete(appId)
    stateCache.delete(appId)
  }

  /** Publish an app's state to every client, unless it is what they already have. */
  function publishAppState(appId: string): void {
    const state = computeAppState(appId)
    const serialized = JSON.stringify(state)
    if (lastPublishedState.get(appId) === serialized) return
    lastPublishedState.set(appId, serialized)
    broadcastToAll('app:status_changed', { appId, state: state as unknown as Record<string, unknown> })
    sendToRenderer('app:status_changed', { appId, state })
  }

  function broadcastAppStatus(appId: string): void {
    try {
      publishAppState(appId)
    } catch (error) {
      console.error('[Runtime] Failed to publish execution state', { appId, error })
    }
  }

  // ── Helper: Insert + broadcast activity entry ──────
  /** Clients upsert by id, so this both announces a new entry and replaces a changed one. */
  function publishEntry(entry: ActivityEntry): void {
    sendToRenderer('app:activity_entry:new', { appId: entry.appId, entry })
    broadcastToAll('app:activity_entry:new', { appId: entry.appId, entry: entry as unknown as Record<string, unknown> })
  }

  function emitActivityEntry(entry: ActivityEntry): void {
    store.insertEntry(entry)
    publishEntry(entry)
  }

  /**
   * Whether the app already has an execution running or waiting for a slot.
   *
   * One execution per app at a time — a second concurrent run duplicates work
   * (a monitoring app would run 50 identical checks) and races the first one's
   * state. Every trigger entry must consult this, not just the manual one.
   */
  function isAppBusy(appId: string): boolean {
    return runningRuns.has(appId) || (pendingTriggers.get(appId) ?? 0) > 0
  }

  /**
   * Admit a run the app started by itself (a schedule tick or a subscribed
   * event), or explain why it may not start. Unlike a manual trigger this must
   * never resume a stopped app or displace work already under way, so a refusal
   * is a skip rather than an error.
   */
  function admitAutomaticRun(appId: string): { app: InstalledApp } | { skipReason: string } {
    const app = appManager.getApp(appId)
    if (!app) return { skipReason: 'app no longer installed' }
    if (app.status !== 'active' && app.status !== 'waiting_user') return { skipReason: `status=${app.status}` }

    // A question put to the user is the app declaring it cannot proceed alone.
    // Starting the next run regardless would work around the person it just
    // asked. Read from the stored questions rather than the app's status, which
    // is a cache of the same fact and can be absent.
    if (store.hasPendingSoloEscalation(appId)) return { skipReason: 'awaiting a user decision' }

    // The previous run may still be going when the next trigger lands (a long
    // run, or one held behind the global slot limit).
    if (isAppBusy(appId) || store.hasQueuedSoloContinuation(appId)) return { skipReason: 'previous run still active or continuation queued' }

    return { app }
  }

  // ── Helper: Admit a manual run ──────────────────────
  /**
   * Run every check a manual trigger must pass and build its trigger context.
   *
   * Shared by the blocking (`triggerManually`) and non-blocking
   * (`startManually`) entries so both reject an unrunnable or already-busy app
   * identically, before any execution starts.
   *
   * @throws AppNotFoundError | AppNotRunnableError | ConcurrencyLimitError
   */
  function admitManualRun(appId: string): { app: InstalledApp; trigger: TriggerContext } {
    const app = appManager.getApp(appId)
    if (!app) {
      throw new AppNotFoundError(appId)
    }

    if (!['active', 'waiting_user', 'paused', 'error'].includes(app.status)) {
      throw new AppNotRunnableError(appId, app.status)
    }
    if (isAppBusy(appId) || store.hasQueuedSoloContinuation(appId)) {
      throw new ConcurrencyLimitError(DEFAULT_MAX_CONCURRENT, appId)
    }

    const trigger = buildManualTriggerContext(app)

    return { app, trigger }
  }

  function recordSkippedAutomatic(app: InstalledApp, trigger: TriggerContext, reason: string): AppRunResult {
    const now = Date.now()
    const runId = randomUUID()
    const sessionKey = `${app.id}:${runId}`
    store.insertRun({ runId, appId: app.id, sessionKey, status: 'skipped', triggerType: trigger.type, startedAt: now })
    store.completeRun(runId, { status: 'skipped', finishedAt: now, durationMs: 0 })
    emitActivityEntry({ id: randomUUID(), appId: app.id, runId, sessionKey, type: 'run_skipped', ts: now, content: { summary: reason, status: 'skipped' } })
    console.log('[Runtime] Queued automatic execution skipped', { appId: app.id, runId, reason })
    return { appId: app.id, runId, sessionKey, outcome: 'noop', startedAt: now, finishedAt: now, durationMs: 0 }
  }

  /**
   * Say on the run's latest entry how many of the person's scheduled times came
   * due while this execution kept it busy. Each was skipped (one run per
   * person) and left no other trace on the timeline.
   */
  function noteSkippedSchedules(appId: string, runId: string, busySince: number): void {
    const until = Date.now()
    let skipped = 0
    for (const jobId of activations.get(appId)?.schedulerJobIds ?? []) {
      skipped += scheduler.countDueTimes(jobId, busySince, until)
    }
    if (skipped === 0) return
    const latest = store.getEntriesForRun(runId)[0]
    const updated = latest ? store.addSkippedSchedules(latest.id, skipped) : null
    if (updated) publishEntry(updated)
    console.log(`[Runtime][${runId.slice(0, 8)}] ${skipped} scheduled time(s) came due during the run and were skipped`)
  }

  // ── Helper: Execute with concurrency control ────────
  async function executeWithConcurrency(
    app: InstalledApp,
    trigger: TriggerContext,
    options?: {
      existingRunId?: string
      existingSessionKey?: string
      /** Fired when no global slot was free and the run entered the queue. */
      onQueued?: () => void
      /** Fired once the run row exists and execution is underway. */
      onStarted?: (info: { runId: string; sessionKey: string; startedAt: number }) => void
    }
  ): Promise<AppRunResult> {
    // From here the person is busy (queued or running): its scheduled times are skipped.
    const busySince = Date.now()
    // Try to acquire a slot immediately without blocking.
    // If no slot is available, transition to 'queued' state and block.
    const immediateSlot = semaphore.tryAcquire()
    if (!immediateSlot) {
      // Slot not available — mark as queued and broadcast so the UI shows
      // the 'queued' status before we block on semaphore.acquire().
      pendingTriggers.set(app.id, (pendingTriggers.get(app.id) ?? 0) + 1)
      broadcastAppStatus(app.id)
      console.log(`[Runtime] app:queued (waiting for global slot): ${app.id}`)
      options?.onQueued?.()

      const queuedController = new AbortController()
      const automatic = trigger.type === 'schedule' || trigger.type === 'event'
      if (automatic) {
        const queued = queuedAutomatic.get(app.id) ?? new Set<AbortController>()
        queued.add(queuedController)
        queuedAutomatic.set(app.id, queued)
      }
      try {
        await semaphore.acquire(queuedController.signal)
      } catch (error) {
        if (!queuedController.signal.aborted) throw error
        return recordSkippedAutomatic(app, trigger, typeof queuedController.signal.reason === 'string' ? queuedController.signal.reason : 'Queued automatic execution cancelled')
      } finally {
        const automaticQueue = queuedAutomatic.get(app.id)
        automaticQueue?.delete(queuedController)
        if (automaticQueue?.size === 0) queuedAutomatic.delete(app.id)
        // Whether we got the slot or were rejected (e.g. shutdown), decrement queued count.
        // Only remove the key when the last queued run for this app has been resolved.
        const remaining = (pendingTriggers.get(app.id) ?? 1) - 1
        if (remaining <= 0) {
          pendingTriggers.delete(app.id)
        } else {
          pendingTriggers.set(app.id, remaining)
        }
        if (queuedController.signal.aborted) {
          broadcastAppStatus(app.id)
          drainContinuations()
        }
      }
    }

    const currentApp = appManager.getApp(app.id)
    if (!currentApp || currentApp.status === 'uninstalled') {
      semaphore.release()
      console.warn('[Runtime] Execution cancelled after resource wait: person unavailable', { appId: app.id, runId: options?.existingRunId })
      throw new AppNotFoundError(app.id)
    }
    // Permissions may be revoked while this execution waits for a resource slot.
    app = currentApp
    if (trigger.type === 'schedule' || trigger.type === 'event') {
      const current = currentApp
      if (!current || !['active', 'waiting_user'].includes(current.status) || store.hasPendingSoloEscalation(app.id) || store.hasQueuedSoloContinuation(app.id)) {
        semaphore.release()
        return recordSkippedAutomatic(app, trigger, 'Automatic execution is paused or waiting for a decision')
      }
    }
    if (options?.existingRunId && store.isRunClosed(options.existingRunId)) {
      semaphore.release()
      throw new Error('The original task was closed before continuing')
    }
    let executingRunId: string | undefined
    const abortController = new AbortController()
    // Use a unique per-run key so concurrent runs of the same App
    // each get their own abort controller entry.
    const executionKey = `${app.id}:${++executionCounter}`
    runningRuns.add(app.id, executionKey, abortController)

    // Broadcast run-start status (app transitions from 'queued'/'idle' to 'running')
    broadcastAppStatus(app.id)

    try {
      if (options?.existingRunId) store.reopenRun(options.existingRunId)
      const result = await executeRun({
        app,
        trigger,
        store,
        memory,
        abortSignal: abortController.signal,
        emitEntry: emitActivityEntry,
        existingRunId: options?.existingRunId,
        existingSessionKey: options?.existingSessionKey,
        // Fire the `onRunStarted` lifecycle event at the *real* start of the
        // run (after DB row insertion, before AI session build). This keeps
        // the started/finished event pair semantically meaningful for
        // dashboards that count in-flight runs.
        //
        // Also re-broadcast app status here: the broadcast above (line ~394)
        // fires before this run's DB row exists, so getAppState()'s
        // runningRunId lookup (keyed off the latest DB run) still points at
        // the *previous* run and comes back empty. The Activity Thread's
        // live "Working..." card requires both status:'running' AND
        // runningRunId, so without this second broadcast it never appears —
        // the UI only catches up once the run finishes and the finally-block
        // broadcast fires. Continue/escalation-followup don't need this
        // because they reopen an existing DB row (with the same runId)
        // before their first broadcast.
        onRunStarted: ({ runId, sessionKey, startedAt }) => {
          executingRunId = runId
          activeExecutions.set(runId, { controller: abortController, startedAt })
          emitRunStarted({
            appId: app.id,
            runId,
            sessionKey,
            triggerType: trigger.type,
            startedAt,
          })
          broadcastAppStatus(app.id)
          options?.onStarted?.({ runId, sessionKey, startedAt })
        },
      })

      // ── Emit finished lifecycle event (analytics subscribers) ──
      // executeRun() finalizes the DB row before returning, so we can emit
      // finished here with authoritative timestamps. Handler exceptions
      // are swallowed by emitRunFinished.
      emitRunFinished({
        appId: app.id,
        runId: result.runId,
        sessionKey: result.sessionKey,
        triggerType: trigger.type,
        outcome: result.outcome,
        status: outcomeToStatus(result.outcome),
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        tokensUsed: result.tokensUsed,
        errorMessage: result.errorMessage,
      })

      const runTag = result.runId.slice(0, 8)

      // ── Fallback activity entry ──────────────────────
      // If the AI didn't call report_to_user (e.g., non-Anthropic model
      // couldn't find the tool, or simply didn't report), insert a synthetic
      // activity entry so the Activity Thread is never empty for a completed run.
      if (result.outcome !== 'error') {
        try {
          const existingEntries = store.getEntriesForRun(result.runId)
          if (existingEntries.length === 0) {
            const fallbackSummary = result.finalText
              ? result.finalText.slice(0, 500)
              : `${app.spec.name} completed (${result.durationMs}ms)`

            const fallbackEntry: ActivityEntry = {
              id: randomUUID(),
              appId: app.id,
              runId: result.runId,
              type: result.outcome === 'noop' ? 'run_skipped' : 'run_complete',
              ts: result.finishedAt,
              sessionKey: result.sessionKey,
              content: {
                summary: fallbackSummary,
                status: result.outcome === 'noop' ? 'skipped' : 'ok',
                durationMs: result.durationMs,
              },
            }

            emitActivityEntry(fallbackEntry)
            console.log(`[Runtime][${runTag}] Fallback activity entry created (AI did not call report_to_user)`)
          }
        } catch (fallbackErr) {
          console.error(`[Runtime][${runTag}] Failed to create fallback activity entry:`, fallbackErr)
        }
      }

      try {
        noteSkippedSchedules(app.id, result.runId, busySince)
      } catch (skipErr) {
        console.error(`[Runtime][${runTag}] Failed to note skipped scheduled times:`, skipErr)
      }

      try {
        clearOldRunTranscripts(store, app.id, app.spaceId ? deps.getSpacePath(app.spaceId) : null)
      } catch (retentionErr) {
        console.error(`[Runtime][${runTag}] Failed to clear old run transcripts:`, retentionErr)
      }

      // Update manager with run outcome
      const outcome = result.outcome as RunOutcome
      appManager.updateLastRun(app.id, outcome, result.errorMessage)

      // Handle consecutive errors -> auto-pause
      if (outcome === 'error' && !intentionallyStoppedRuns.has(result.runId)) {
        const recentRuns = store.getRunsForApp(app.id, MAX_CONSECUTIVE_ERRORS)
        const consecutiveErrors = countConsecutiveErrors(recentRuns)
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && ['active', 'waiting_user'].includes(appManager.getApp(app.id)?.status ?? '')) {
          console.warn(
            `[Runtime] Auto-pausing app=${app.id}: ${consecutiveErrors} consecutive errors`
          )
          try {
            appManager.updateStatus(app.id, 'error', {
              errorMessage: `Auto-disabled after ${consecutiveErrors} consecutive errors`,
            })
            // Deactivate to stop scheduling
            await service.deactivate(app.id)
          } catch (statusErr) {
            console.error('[Runtime] Failed to auto-pause app:', statusErr)
          }
        }
      }

      // Desktop notification on run completion (system notification only).
      // External channel notifications are now AI-driven via notify_channel / notify_bot tools.
      // Respects per-app notificationLevel: 'none' = skip, 'important' = skip (run_complete is not important), 'all' = send.
      // Only sends if the AI did NOT already call report_to_user (which handles its own notification in report-tool.ts).
      const notificationLevel = app.userOverrides?.notificationLevel ?? 'important'
      if (outcome !== 'error' && notificationLevel === 'all') {
        try {
          // Query entries for THIS run only — avoid showing stale content from previous runs
          const runEntries = store.getEntriesForRun(result.runId)
          const completionEntry = runEntries.find(e => e.type === 'run_complete' || e.type === 'output')
          // Only send if AI didn't report (report-tool.ts already sent its own notification)
          if (!completionEntry) {
            const body = result.finalText
              ? result.finalText.slice(0, 200)
              : `${app.spec.name} completed`
            notifyAppEvent(app.spec.name, body, {
              appId: app.id,
              runId: result.runId,
            })
          }
        } catch (notifyErr) {
          console.error('[Runtime] Failed to send desktop notification:', notifyErr)
        }
      }

      return result
    } catch (error) {
      if (options?.existingRunId) {
        const message = error instanceof Error ? error.message : String(error)
        for (const failed of store.failRuns([options.existingRunId], message)) {
          console.error('[Runtime] Continuation failed before execution could settle', { appId: app.id, runId: failed.runId, error })
          emitActivityEntry({ id: randomUUID(), appId: app.id, runId: failed.runId,
            sessionKey: failed.sessionKey, type: 'run_error', ts: failed.finishedAt ?? Date.now(),
            content: { summary: message, error: message, status: 'error' } })
        }
      }
      throw error
    } finally {
      if (executingRunId) {
        activeExecutions.delete(executingRunId)
        intentionallyStoppedRuns.delete(executingRunId)
      }
      runningRuns.remove(app.id, executionKey)
      semaphore.release()
      drainContinuations()

      // Broadcast run-end status (app transitions back to 'idle' or other state)
      broadcastAppStatus(app.id)
    }
  }

  // ── Helper: Count consecutive errors ────────────────
  function countConsecutiveErrors(runs: AutomationRun[]): number {
    let count = 0
    for (const run of runs) {
      if (run.status === 'error' && !store.wasRunStopped(run.runId) && !store.isRunClosed(run.runId)) {
        count++
      } else {
        break
      }
    }
    return count
  }

  function publishDecision(entry: ActivityEntry): void {
    try {
      publishEntry(entry)
      if (entry.userResponse) {
        const payload = { appId: entry.appId, entryId: entry.id, response: entry.userResponse, ...entry.content.teamContext }
        sendToRenderer('app:escalation:resolved', payload)
        broadcastToAll('app:escalation:resolved', payload)
      }
      broadcastAppStatus(entry.appId)
    } catch (error) {
      console.error('[Runtime] Decision persisted but live update failed', { appId: entry.appId, entryId: entry.id, error })
    }
  }

  function finishContinuation(entry: ActivityEntry, error?: string): void {
    continuationDispatches.delete(entry.id)
    store.updateContinuation(entry.id, error ? shuttingDown ? 'queued' : 'failed' : 'completed', error)
    console[error ? 'error' : 'log']('[Runtime] Decision continuation settled', { appId: entry.appId, entryId: entry.id, error })
    const current = store.getEntry(entry.id)
    if (current) publishDecision(current)
    drainContinuations()
  }

  function drainContinuations(): void {
    if (shuttingDown || drainingContinuations) return
    drainingContinuations = true
    try {
      dispatchContinuations()
    } catch (error) {
      console.error('[Runtime] Durable continuation dispatch failed; retained for retry', error)
    } finally {
      drainingContinuations = false
    }
  }

  function dispatchContinuations(): void {
    for (const entry of store.getQueuedContinuations()) {
      if (continuationDispatches.has(entry.id)) continue
      const team = entry.content.teamContext
      if (!team && isAppBusy(entry.appId)) continue
      const app = appManager.getApp(entry.appId)
      if (!app || !entry.userResponse || entry.content.resolution || store.isRunClosed(entry.runId)) {
        console.warn('[Runtime] Cancelled unavailable continuation', { entryId: entry.id, appId: entry.appId })
        store.updateContinuation(entry.id, 'cancelled')
        continue
      }
      if (team && !getActiveTeamRuntime()) continue
      continuationDispatches.add(entry.id)
      const onStarted = (): void => {
        store.updateContinuation(entry.id, 'running')
        publishDecision(store.getEntry(entry.id)!)
      }
      if (team) {
        const decision = formatEscalationAnswer(getEscalationQuestions(entry.content), entry.userResponse)
        try {
          if (store.needsDecisionReceipt(entry.id)) {
            getActiveTeamRuntime()!.blackboard.postActivity({
              id: `decision:${entry.id}`, teamId: team.teamId, epochId: team.epochId,
              kind: 'decision', actorAppId: entry.appId, subject: entry.content.question || entry.content.summary,
              body: decision, status: 'ok', refId: entry.id,
            })
            store.markDecisionReceiptPublished(entry.id)
          }
        } catch (error) {
          console.error('[Runtime] Could not publish durable answer receipt', { entryId: entry.id, teamId: team.teamId, error })
        }
        void getActiveTeamRuntime()!.resumeFromEscalation({
          teamId: team.teamId, epochId: team.epochId, appId: entry.appId, taskId: team.taskId,
          external: team.external,
          continuationId: entry.id, response: decision, question: entry.content.question || entry.content.summary,
          onDeferred: () => continuationDispatches.delete(entry.id),
          onStarted,
          onSettled: error => finishContinuation(entry, error),
        }).then(accepted => {
          if (!accepted) finishContinuation(entry, 'The original team task is unavailable')
        }).catch(error => finishContinuation(entry, error instanceof Error ? error.message : String(error)))
      } else {
        const run = store.getRun(entry.runId)
        if (!run?.sessionId) {
          finishContinuation(entry, 'The original execution context is unavailable; no replacement task was started')
          continue
        }
        const trigger = buildEscalationTriggerContext(app, entry.content.question || entry.content.summary,
          getEscalationQuestions(entry.content), entry.userResponse, run.sessionId)
        void executeWithConcurrency(app, trigger, { existingRunId: run.runId, existingSessionKey: run.sessionKey, onStarted })
          .then(result => finishContinuation(entry, result.outcome === 'error' ? result.errorMessage || 'Continuation failed' : undefined))
          .catch(error => finishContinuation(entry, error instanceof Error ? error.message : String(error)))
      }
    }
  }

  // ── Helper: Check and auto-timeout stale escalations ──
  /**
   * Prune old runs and activity entries if enough time has passed
   * since the last prune. Runs at most once per PRUNE_INTERVAL_MS (24h).
   */
  function pruneOldDataIfNeeded(): void {
    const now = Date.now()
    if (now - lastPruneAtMs < PRUNE_INTERVAL_MS) return

    try {
      const pruned = store.pruneOldData()
      lastPruneAtMs = now
      if (pruned > 0) {
        console.log(`[Runtime] Pruned ${pruned} old automation runs (and their activity entries)`)
      }
    } catch (err) {
      console.error('[Runtime] Failed to prune old data:', err)
    }
  }

  /**
   * Settle runs a previous process left mid-flight.
   *
   * A run is only ever moved out of 'running' by the process executing it, so a
   * crash or a forced quit leaves the row claiming to be live: the timeline
   * shows no outcome, the "view progress" affordance points at a run nothing is
   * driving, and pruning skips it forever. Nothing of that process survived, so
   * on startup every such run is failed and given a timeline entry saying why —
   * which also makes it resumable through the normal continue path.
   */
  function settleInterruptedRuns(): void {
    try {
      // Anything this process is actually driving is excluded, so the sweep
      // stays safe if it is ever reached outside of startup.
      const stranded = store.listRunningRuns().filter(run => !isRunActive(run.runId))
      const interrupted = store.failRuns(stranded.map(run => run.runId), INTERRUPTED_RUN_MESSAGE)
      if (interrupted.length === 0) return

      for (const run of interrupted) {
        emitActivityEntry({
          id: randomUUID(),
          appId: run.appId,
          runId: run.runId,
          type: 'run_error',
          ts: run.finishedAt ?? Date.now(),
          sessionKey: run.sessionKey,
          content: {
            summary: INTERRUPTED_RUN_MESSAGE,
            status: 'error',
            error: INTERRUPTED_RUN_MESSAGE,
          },
        })
      }

      console.log(`[Runtime] Settled ${interrupted.length} run(s) interrupted by a previous shutdown`)
    } catch (err) {
      console.error('[Runtime] Failed to settle interrupted runs:', err)
    }
  }

  function checkEscalationTimeouts(): void {
    try {
      for (const entry of store.expireDecisions(Date.now())) {
        console.log('[Runtime] Decision expired', { appId: entry.appId, entryId: entry.id, runId: entry.runId })
        publishDecision(entry)
        getActiveTeamRuntime()?.reconcileAwaitingDecision(entry.appId)
        const run = store.getRun(entry.runId)
        if (run && !store.getEntriesForRun(run.runId).some(item => item.type === 'escalation' && !item.userResponse && !item.content.resolution)) {
          store.updateRunStatus(run.runId, 'error', 'Decision deadline expired without an answer')
        }
      }
      console.log('[Runtime] Durable continuation state', store.getContinuationSummary())
      pruneOldDataIfNeeded()
    } catch (error) {
      console.error('[Runtime] Decision expiration failed', error)
    }
  }

  // ── Helper: Map subscription to scheduler job ───────
  function subscriptionToSchedulerJob(
    app: InstalledApp,
    sub: SubscriptionDef,
    index: number
  ): SchedulerJobCreate | null {
    const subId = sub.id ?? String(index)

    if (sub.source.type === 'schedule') {
      const config = sub.source.config

      if (config.every) {
        const every = config.every
        return {
          id: `${app.id}:${subId}`,
          name: `${app.spec.name} - ${subId}`,
          schedule: { kind: 'every', every },
          enabled: true,
          metadata: { appId: app.id, subscriptionId: subId },
        }
      }

      if (config.cron) {
        return {
          id: `${app.id}:${subId}`,
          name: `${app.spec.name} - ${subId}`,
          schedule: { kind: 'cron', cron: config.cron },
          enabled: true,
          metadata: { appId: app.id, subscriptionId: subId },
        }
      }
    }

    return null
  }

  // ── Helper: Map subscription to event filter ────────
  // Delegates to the shared source→filter mapping so the app runtime and the
  // team trigger scheduler derive identical filters from the same semantics.
  function subscriptionToEventFilter(
    sub: SubscriptionDef
  ): EventFilter | null {
    return sourceConfigToEventFilter(
      sub.source.type,
      sub.source.config as Record<string, unknown>
    )
  }

  /** Hold (or drop) the file watcher of the App's space to match its file subscriptions. */
  function syncFileWatch(state: ActivationState, app: InstalledApp | null): void {
    const wanted = app?.spaceId && app.spec.type === 'automation'
      && (app.spec.subscriptions ?? []).some((sub) => sub.source.type === 'file')
      ? app.spaceId
      : null
    const held = state.fileWatchSpaceId ?? null
    if (wanted === held) return
    const holder = `automation:${state.appId}`
    if (held) deps.fileWatch?.release(held, holder)
    if (wanted) deps.fileWatch?.retain(wanted, holder)
    state.fileWatchSpaceId = wanted
  }

  // ── Service Implementation ──────────────────────────

  const service: AppRuntimeService = {
    // ── Activation ──────────────────────────────────

    async activate(appId: string): Promise<void> {
      // Idempotent - skip if already activated
      if (activations.has(appId)) {
        console.log(`[Runtime] App already activated: ${appId}`)
        return
      }

      const app = appManager.getApp(appId)
      if (!app) {
        throw new AppNotFoundError(appId)
      }

      if (app.spec.type !== 'automation') {
        console.log(`[Runtime] Skipping non-automation app: ${appId} (type=${app.spec.type})`)
        return
      }

      const subscriptions = app.spec.subscriptions ?? []

      console.log(`[Runtime] Activating app: ${appId} (${app.spec.name})`)

      const state: ActivationState = {
        appId,
        schedulerJobIds: [],
        eventUnsubscribers: [],
        keepAliveDisposer: null,
      }

      // Register scheduler jobs for schedule-type subscriptions
      for (let i = 0; i < subscriptions.length; i++) {
        const sub = subscriptions[i]
        const jobCreate = subscriptionToSchedulerJob(app, sub, i)
        if (jobCreate) {
          // Check if job already exists (from a previous activation)
          const existingJob = scheduler.getJob(jobCreate.id)
          if (existingJob) {
            const scheduleChanged =
              JSON.stringify(existingJob.schedule) !== JSON.stringify(jobCreate.schedule)
            if (scheduleChanged) {
              // Schedule changed -- remove and re-add so anchorMs resets to now
              scheduler.removeJob(jobCreate.id)
              scheduler.addJob(jobCreate)
            } else {
              scheduler.resumeJob(jobCreate.id)
            }
          } else {
            scheduler.addJob(jobCreate)
          }
          state.schedulerJobIds.push(jobCreate.id)
          console.log(`[Runtime] Registered scheduler job: ${jobCreate.id}`)
        }
      }

      // Register event router subscriptions for event-type subscriptions
      for (let i = 0; i < subscriptions.length; i++) {
        const sub = subscriptions[i]
        const filter = subscriptionToEventFilter(sub)
        if (filter) {
          const unsub = eventRouter.on(filter, async (event) => {
            const admission = admitAutomaticRun(appId)
            if ('skipReason' in admission) {
              console.log(`[Runtime] Skipping event-triggered run: app=${appId}, ${admission.skipReason}`)
              return
            }
            const currentApp = admission.app

            console.log(`[Runtime] Event triggered: type=${event.type}, app=${appId}`)
            const trigger = buildEventTriggerContext(event.type, event.payload, currentApp)

            try {
              await executeWithConcurrency(currentApp, trigger)
            } catch (err) {
              console.error(`[Runtime] Event-triggered run failed: app=${appId}:`, err)
            }
          })
          state.eventUnsubscribers.push(unsub)
        }
      }

      // Register keep-alive reason if we have any active subscriptions
      if (state.schedulerJobIds.length > 0 || state.eventUnsubscribers.length > 0) {
        // Held for as long as the App is activated; deactivate disposes it.
        state.keepAliveDisposer = background.registerKeepAliveReason(
          `${KEEP_ALIVE_REASON}:${appId}`,
          { ttlMs: Infinity }
        )
      }

      syncFileWatch(state, app)
      activations.set(appId, state)
      console.log(
        `[Runtime] App activated: ${appId}, ` +
        `jobs=${state.schedulerJobIds.length}, events=${state.eventUnsubscribers.length}`
      )
    },

    async deactivate(appId: string): Promise<void> {
      const state = activations.get(appId)
      if (!state) {
        console.log(`[Runtime] App not activated, skip deactivate: ${appId}`)
        return
      }

      console.log(`[Runtime] Deactivating app: ${appId}`)

      // Remove scheduler jobs
      for (const jobId of state.schedulerJobIds) {
        try {
          scheduler.removeJob(jobId)
        } catch (err) {
          console.error(`[Runtime] Failed to remove scheduler job ${jobId}:`, err)
        }
      }

      // Remove event router subscriptions
      for (const unsub of state.eventUnsubscribers) {
        try {
          unsub()
        } catch (err) {
          console.error(`[Runtime] Failed to unsubscribe event handler:`, err)
        }
      }

      // Release keep-alive
      if (state.keepAliveDisposer) {
        state.keepAliveDisposer()
      }
      syncFileWatch(state, null)

      activations.delete(appId)
      console.log(`[Runtime] App deactivated: ${appId}`)
    },

    syncAppSubscriptions(appId: string): void {
      const state = activations.get(appId)
      if (!state) return // Not activated — nothing to sync

      const app = appManager.getApp(appId)
      if (!app) return
      if (app.spec.type !== 'automation') return // Only automation apps have subscriptions

      const subscriptions = app.spec.subscriptions ?? []
      syncFileWatch(state, app)

      // ── 1. Hot-sync scheduler jobs ─────────────────────
      const desiredJobIds = new Set<string>()

      for (let i = 0; i < subscriptions.length; i++) {
        const sub = subscriptions[i]
        const jobCreate = subscriptionToSchedulerJob(app, sub, i)
        if (!jobCreate) continue

        desiredJobIds.add(jobCreate.id)
        const existingJob = scheduler.getJob(jobCreate.id)

        if (existingJob) {
          const scheduleChanged =
            JSON.stringify(existingJob.schedule) !== JSON.stringify(jobCreate.schedule)
          if (scheduleChanged) {
            scheduler.removeJob(jobCreate.id)
            scheduler.addJob(jobCreate)
            console.log(`[Runtime] Schedule hot-updated: ${jobCreate.id}`)
          }
        } else {
          scheduler.addJob(jobCreate)
          if (!state.schedulerJobIds.includes(jobCreate.id)) {
            state.schedulerJobIds.push(jobCreate.id)
          }
          console.log(`[Runtime] New scheduler job added: ${jobCreate.id}`)
        }
      }

      // Remove stale jobs that are no longer in the subscription list
      for (const jobId of [...state.schedulerJobIds]) {
        if (!desiredJobIds.has(jobId)) {
          scheduler.removeJob(jobId)
          state.schedulerJobIds = state.schedulerJobIds.filter(id => id !== jobId)
          console.log(`[Runtime] Stale scheduler job removed: ${jobId}`)
        }
      }

      // ── 2. Hot-sync event-router subscriptions ─────────
      // Tear down old event listeners and register new ones.
      // This is safe because event listeners are stateless — unsubscribing
      // and re-subscribing does not affect any running execution.
      for (const unsub of state.eventUnsubscribers) {
        try {
          unsub()
        } catch (err) {
          console.error(`[Runtime] Failed to unsubscribe event handler during sync:`, err)
        }
      }
      state.eventUnsubscribers = []

      for (let i = 0; i < subscriptions.length; i++) {
        const sub = subscriptions[i]
        const filter = subscriptionToEventFilter(sub)
        if (filter) {
          const unsub = eventRouter.on(filter, async (event) => {
            const admission = admitAutomaticRun(appId)
            if ('skipReason' in admission) {
              console.log(`[Runtime] Skipping event-triggered run: app=${appId}, ${admission.skipReason}`)
              return
            }
            const currentApp = admission.app

            console.log(`[Runtime] Event triggered: type=${event.type}, app=${appId}`)
            const trigger = buildEventTriggerContext(event.type, event.payload, currentApp)

            try {
              await executeWithConcurrency(currentApp, trigger)
            } catch (err) {
              console.error(`[Runtime] Event-triggered run failed: app=${appId}:`, err)
            }
          })
          state.eventUnsubscribers.push(unsub)
        }
      }
    },

    // ── Execution ───────────────────────────────────

    async triggerManually(appId: string): Promise<AppRunResult> {
      const { app, trigger } = admitManualRun(appId)

      const result = await executeWithConcurrency(app, trigger)

      // IM forwarding is now AI-driven via notify_bot tool (no more system auto-push)

      return result
    },

    async startManually(appId: string): Promise<AppRunStartInfo> {
      const { app, trigger } = admitManualRun(appId)

      let settled = false
      let resolveAdmission!: (info: AppRunStartInfo) => void
      let rejectAdmission!: (err: unknown) => void
      const admission = new Promise<AppRunStartInfo>((resolve, reject) => {
        resolveAdmission = resolve
        rejectAdmission = reject
      })
      const settleOnce = (settleFn: () => void): void => {
        if (settled) return
        settled = true
        settleFn()
      }

      executeWithConcurrency(app, trigger, {
        onQueued: () => settleOnce(() => resolveAdmission({ outcome: 'queued' })),
        onStarted: (info) => settleOnce(() => resolveAdmission({ outcome: 'started', ...info })),
      }).then(
        // Fallback settle: `onStarted` fires from inside executeRun, so a run
        // that fails before inserting its row never fires it. Without this the
        // caller would wait forever for an admission that can no longer come.
        (result) => settleOnce(() => resolveAdmission({
          outcome: 'started',
          runId: result.runId,
          sessionKey: result.sessionKey,
          startedAt: result.startedAt,
        })),
        (err) => {
          // Once admitted, nobody is awaiting this run — the log is the only
          // report of a background failure.
          console.error(`[Runtime] Background manual run failed: app=${appId}:`, err)
          settleOnce(() => rejectAdmission(err))
        }
      )

      return admission
    },

    // ── State Queries ───────────────────────────────

    getDirectoryRuntimeSnapshot() {
      const result: import('../../../shared/apps/people-directory').DirectoryRuntimeSnapshot = {}
      for (const [appId, count] of runningRuns.counts()) {
        const row = result[appId] ??= { runningCount: 0, queued: false }
        row.runningCount = count
      }
      for (const [appId, count] of pendingTriggers) {
        const row = result[appId] ??= { runningCount: 0, queued: false }
        row.queued = count > 0
      }
      for (const [appId, activation] of activations) {
        const row = result[appId] ??= { runningCount: 0, queued: false }
        for (const jobId of activation.schedulerJobIds) {
          const next = scheduler.getJob(jobId)?.nextRunAtMs
          if (next !== undefined && (row.nextRunAtMs === undefined || next < row.nextRunAtMs)) row.nextRunAtMs = next
        }
      }
      return result
    },

    getAllAppStates(): Record<string, AutomationAppState> {
      const now = Date.now()
      return Object.fromEntries(appManager.listApps({ type: 'automation' }).map(app => {
        const cached = stateCache.get(app.id)
        return [app.id, cached && now - cached.at < STATE_CACHE_TTL_MS ? cached.state : computeAppState(app.id)]
      }))
    },

    getAppState(appId: string): AutomationAppState {
      const app = appManager.getApp(appId)
      if (!app) {
        return {
          status: 'idle',
        }
      }

      const isRunning = runningRuns.has(appId)
      const isQueued = (pendingTriggers.get(appId) ?? 0) > 0

      const counts = store.getDecisionCounts(appId)
      const state: AutomationAppState = {
        status: deriveRuntimeStatus({
          appStatus: app.status,
          running: isRunning,
          queued: isQueued || counts.continuations > 0,
          pendingDecisions: counts.pending,
        }),
        automaticEnabled: automaticEnabled(app.status),
        blocked: blockedReason(app.status),
        runningCount: runningRuns.count(appId),
        pendingDecisionCount: counts.pending,
        pendingSoloDecisionCount: counts.solo,
        continuationCount: counts.continuations,
        pendingEscalationId: app.pendingEscalationId,
      }

      // Get latest run info
      const latestRun = store.getLatestRunForApp(appId)
      if (latestRun) {
        state.lastRunAtMs = latestRun.startedAt
        state.lastDurationMs = latestRun.durationMs
        if (latestRun.status === 'ok') state.lastStatus = 'ok'
        else if (latestRun.status === 'error') state.lastStatus = 'error'
        else if (latestRun.status === 'skipped') state.lastStatus = 'skipped'

        if (latestRun.status === 'running') {
          state.runningAtMs = activeExecutions.get(latestRun.runId)?.startedAt ?? latestRun.startedAt
          state.runningRunId = latestRun.runId
          state.runningSessionKey = latestRun.sessionKey
        }
      }

      // Get consecutive errors
      const recentRuns = store.getRunsForApp(appId, MAX_CONSECUTIVE_ERRORS)
      state.consecutiveErrors = countConsecutiveErrors(recentRuns)

      // Get last error
      if (app.errorMessage) {
        state.lastError = app.errorMessage
      }

      // Get next run time from scheduler
      const activation = activations.get(appId)
      if (activation && activation.schedulerJobIds.length > 0) {
        let earliestNextRun = Infinity
        for (const jobId of activation.schedulerJobIds) {
          const job = scheduler.getJob(jobId)
          if (job && job.nextRunAtMs < earliestNextRun) {
            earliestNextRun = job.nextRunAtMs
          }
        }
        if (earliestNextRun !== Infinity) {
          state.nextRunAtMs = earliestNextRun
        }
      }

      return state
    },

    // ── Escalation ──────────────────────────────────

    async respondToEscalation(appId: string, entryId: string, response: EscalationResponse): Promise<ActivityEntry> {
      if (!appManager.getApp(appId)) throw new AppNotFoundError(appId)
      const existing = store.getEntry(entryId)
      if (!existing || existing.appId !== appId) throw new EscalationNotFoundError(appId, entryId)
      const entry = store.acceptDecision(appId, entryId, response)
      if (!entry.content.teamContext) for (const controller of queuedAutomatic.get(appId) ?? []) controller.abort('An accepted answer takes priority over queued automatic work')
      console.log('[Runtime] Decision accepted durably', { appId, entryId, continuation: entry.continuation?.status })
      publishDecision(entry)
      getActiveTeamRuntime()?.reconcileAwaitingDecision(appId)
      drainContinuations()
      return store.getEntry(entryId)!
    },

    async dismissEscalation(appId: string, entryId: string): Promise<void> {
      if (!appManager.getApp(appId)) throw new AppNotFoundError(appId)
      const existing = store.getEntry(entryId)
      if (!existing || existing.appId !== appId) throw new EscalationNotFoundError(appId, entryId)
      const entry = store.dismissDecision(entryId)
      if (!entry) throw new Error('This request was already answered or closed')
      console.log('[Runtime] Decision dismissed by user', { appId, entryId })
      publishDecision(entry)
      getActiveTeamRuntime()?.reconcileAwaitingDecision(appId)
      // Nothing will answer it now, so release the wait it was holding.
      if (appManager.getApp(appId)?.status === 'waiting_user' &&
        !store.getAllPendingEscalations().some(item => item.appId === appId)) {
        appManager.updateStatus(appId, 'active')
      }
      broadcastAppStatus(appId)
    },

    async retryEscalationContinuation(appId: string, entryId: string): Promise<void> {
      const entry = store.getEntry(entryId)
      if (!entry || entry.appId !== appId || !entry.userResponse || entry.continuation?.status !== 'failed') throw new Error('No failed continuation to retry')
      if (entry.content.resolution || store.isRunClosed(entry.runId)) throw new Error('This task is closed')
      store.updateContinuation(entryId, 'queued')
      console.log('[Runtime] Decision continuation retry queued', { appId, entryId })
      publishDecision(store.getEntry(entryId)!)
      drainContinuations()
    },

    confirmEscalationDeadline(appId: string, entryId: string, deadlineAt: number | null): void {
      publishDecision(store.confirmDeadline(appId, entryId, deadlineAt))
    },

    adoptAuthorVersion(appId: string, entryId: string, fields: string[]): ActivityEntry {
      const entry = store.getEntry(entryId)
      const note = entry?.appId === appId ? entry.content.upgrade : undefined
      if (!entry || !note) throw new Error('This upgrade note no longer exists')
      if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string')) {
        throw new Error('fields must be a list of field names')
      }
      // Only what the note kept: it is what the user is looking at.
      const requested = fields.filter(field => note.kept.includes(field))
      const changed = appManager.adoptAuthorVersion(appId, requested)
      if (changed.includes('subscriptions')) service.syncAppSubscriptions(appId)
      const updated = store.markUpgradeAdopted(entryId, requested) ?? entry
      publishEntry(updated)
      return updated
    },

    async stopRun(appId: string, runId: string): Promise<void> {
      const run = store.getRun(runId)
      if (!run || run.appId !== appId) throw new Error('Task not found')
      const controller = activeExecutions.get(runId)?.controller
      if (!controller) throw new Error('This execution is no longer running')
      intentionallyStoppedRuns.add(runId)
      store.markRunStopped(runId)
      controller.abort()
      console.log('[Runtime] Execution attempt stopped; decisions retained', { appId, runId })
    },

    async closeRun(appId: string, runId: string): Promise<void> {
      const run = store.getRun(runId)
      if (!run || run.appId !== appId) throw new Error('Task not found')
      for (const entry of store.closeRun(runId)) publishDecision(entry)
      if (activeExecutions.has(runId)) intentionallyStoppedRuns.add(runId)
      activeExecutions.get(runId)?.controller.abort()
      console.log('[Runtime] Task closed', { appId, runId })
      broadcastAppStatus(appId)
    },

    getPendingInbox(options?: PendingDecisionQuery): import('../../../shared/apps/app-types').PendingDecisionInbox {
      return store.getPendingInbox(options)
    },

    getPendingEntries(appId: string, options?: PendingDecisionQuery): ActivityEntry[] {
      return store.getPendingEntries(appId, options)
    },

    // ── User-initiated Continue ─────────────────────

    async continueFailedRun(appId: string, runId: string): Promise<void> {
      const app = appManager.getApp(appId)
      if (!app) {
        throw new Error(`App not found: ${appId}`)
      }

      const run = store.getRun(runId)
      if (!run || run.appId !== appId) {
        throw new Error(`Run not found: ${runId}`)
      }
      if (store.isRunClosed(runId)) throw new Error('This task is closed')
      if (run.transcriptClearedAt) throw new Error(RUN_PROCESS_CLEARED_MESSAGE)
      if (run.status !== 'error') {
        throw new Error(`Run ${runId} is not in error state (status: ${run.status})`)
      }

      if (!run.sessionId) throw new Error('The original execution context is unavailable')
      if (store.hasUnfinishedRunDecision(runId)) throw new Error('Answer or retry the original decision to continue this task')

      const appIsRunning = isAppBusy(appId) || store.hasQueuedSoloContinuation(appId)
      if (appIsRunning) {
        throw new Error(`App ${appId} already has a running execution — cannot continue simultaneously`)
      }

      console.log(
        `[Runtime] User-initiated continue: app=${appId}, run=${runId}, ` +
        `sessionId=${run.sessionId ?? 'none'}`
      )

      const trigger = buildContinueTriggerContext(app, run.sessionId)

      // Execute asynchronously — continueFailedRun returns once the run is queued.
      executeWithConcurrency(app, trigger, {
        existingRunId: run.runId,
        existingSessionKey: run.sessionKey,
      }).catch((err) => {
        console.error(`[Runtime] Continue run failed: app=${appId}, run=${runId}:`, err)
      })
    },

    async injectIntoRun(appId: string, runId: string, text: string, references?: ContentReference[]): Promise<void> {
      const app = appManager.getApp(appId)
      if (!app) {
        throw new Error(`App not found: ${appId}`)
      }
      const trimmed = text.trim()
      if (!trimmed && !references?.length) {
        throw new Error('Cannot send an empty message')
      }

      // Live run → inject into the current turn; the AI absorbs it at the next
      // tool boundary (steer an in-progress run).
      if (isRunActive(runId)) {
        injectIntoActiveRun(appId, runId, trimmed, references)
        console.log(`[Runtime] Injected into live run: app=${appId}, run=${runId.slice(0, 8)}`)
        return
      }

      // Finished run → reopen it and resume its session so the user can keep
      // talking to that run with full context (the subprocess was closed to free
      // resources, but the CC session id was persisted for resume).
      const run = store.getRun(runId)
      if (!run || run.appId !== appId) {
        throw new Error(`Run not found: ${runId}`)
      }
      if (store.isRunClosed(runId)) throw new Error('This task is closed')
      if (run.transcriptClearedAt) throw new Error(RUN_PROCESS_CLEARED_MESSAGE)
      const appIsRunning = isAppBusy(appId) || store.hasQueuedSoloContinuation(appId)
      if (appIsRunning) {
        throw new Error(`App ${appId} is busy with another run — try again once it finishes`)
      }

      // A follow-up to a run that already completed successfully (status 'ok' ⇒
      // report_to_user was called) is a conversation, not task execution: mark it
      // interactive so executeRun replies without the report_to_user enforcement.
      // A follow-up to a prematurely-ended run (status 'error', report never
      // called) is left non-interactive so it still drives the task to completion.
      const interactive = run.status === 'ok'
      const trigger = buildContinueTriggerContext(app, run.sessionId, trimmed, interactive, references)
      executeWithConcurrency(app, trigger, {
        existingRunId: run.runId,
        existingSessionKey: run.sessionKey,
      }).catch((err) => {
        console.error(`[Runtime] Resume run failed: app=${appId}, run=${runId}:`, err)
      })
      console.log(`[Runtime] Resumed finished run with follow-up: app=${appId}, run=${runId.slice(0, 8)}`)
    },

    // ── Activity Queries ────────────────────────────

    getActivityEntry(appId: string, entryId: string): ActivityEntry | null {
      const entry = store.getEntry(entryId)
      return entry?.appId === appId ? entry : null
    },

    getActivityEntries(appId: string, options?: ActivityQueryOptions): ActivityEntry[] {
      return store.getEntriesForApp(appId, options)
    },

    getEntriesForRun(runId: string): ActivityEntry[] {
      return store.getEntriesForRun(runId)
    },

    getRun(runId: string): AutomationRun | null {
      return store.getRun(runId)
    },

    getRunsForApp(appId: string, limit?: number): AutomationRun[] {
      return store.getRunsForApp(appId, limit)
    },

    getRunsForAppWithSummary(appId: string, options?: RunQueryOptions): AutomationRunWithSummary[] {
      return store.getRunsForAppWithSummary(appId, options)
    },

    getRunStats(appId: string, window?: number): RunStats {
      return store.getRunStats(appId, window)
    },

    getOverview(spaceId?: string): AppOverviewEntry[] {
      const filter = spaceId !== undefined ? { spaceId, type: 'automation' as const } : { type: 'automation' as const }
      const apps = appManager.listApps(filter).filter(a => a.status !== 'uninstalled')

      return apps.map((app): AppOverviewEntry => {
        const state = service.getAppState(app.id)

        const latestEntry = store.getLatestOutputEntry(app.id)
        const latestSummary = latestEntry
          ? { type: latestEntry.type, summary: latestEntry.content.summary, ts: latestEntry.ts }
          : undefined

        return {
          appId: app.id,
          state,
          latestSummary,
          recentRunStatuses: store.getRecentRunStatuses(app.id),
        }
      })
    },

    // ── Lifecycle ───────────────────────────────────

    async activateAll(): Promise<void> {
      shuttingDown = false
      settleInterruptedRuns()
      const recovered = store.recoverContinuations()
      console.log('[Runtime] Restored durable continuation queue', { recovered })
      drainContinuations()
      if (!continuationInterval) continuationInterval = setInterval(drainContinuations, 5000)

      console.log('[Runtime] Activating all active automation apps...')
      const apps = appManager.listApps({ type: 'automation' }).filter(app => app.status === 'active' || app.status === 'waiting_user')

      let activated = 0
      for (const app of apps) {
        try {
          await service.activate(app.id)
          activated++
        } catch (err) {
          console.error(`[Runtime] Failed to activate app ${app.id}:`, err)
        }
      }

      // Start escalation timeout checker
      if (!escalationCheckInterval) {
        // Run once immediately at startup to catch any escalations that timed
        // out while the app was not running.
        checkEscalationTimeouts()
        escalationCheckInterval = setInterval(checkEscalationTimeouts, ESCALATION_CHECK_INTERVAL_MS)
        console.log(`[Runtime] Escalation timeout checker started (interval=${ESCALATION_CHECK_INTERVAL_MS / 60000}m)`)
      }

      console.log(`[Runtime] Activated ${activated}/${apps.length} automation apps`)
    },

    async deactivateAll(): Promise<void> {
      shuttingDown = true
      if (continuationInterval) { clearInterval(continuationInterval); continuationInterval = null }
      runningRuns.abortAll()
      console.log('[Runtime] Deactivating all apps...')
      const appIds = Array.from(activations.keys())

      for (const appId of appIds) {
        try {
          await service.deactivate(appId)
        } catch (err) {
          console.error(`[Runtime] Failed to deactivate app ${appId}:`, err)
        }
      }

      // Stop escalation timeout checker
      if (escalationCheckInterval) {
        clearInterval(escalationCheckInterval)
        escalationCheckInterval = null
        console.log('[Runtime] Escalation timeout checker stopped')
      }

      // Reject all waiting semaphore callers
      semaphore.rejectAll('Runtime shutting down')

      console.log(`[Runtime] Deactivated ${appIds.length} apps`)
    },

    onRunStarted(handler: RunStartedHandler): RuntimeUnsubscribe {
      runStartedHandlers.push(handler)
      return () => {
        const idx = runStartedHandlers.indexOf(handler)
        if (idx > -1) runStartedHandlers.splice(idx, 1)
      }
    },

    onRunFinished(handler: RunFinishedHandler): RuntimeUnsubscribe {
      runFinishedHandlers.push(handler)
      return () => {
        const idx = runFinishedHandlers.indexOf(handler)
        if (idx > -1) runFinishedHandlers.splice(idx, 1)
      }
    },
  }

  // ── Register scheduler handler ──────────────────────
  // This connects the scheduler's onJobDue to our execution logic.
  scheduler.onJobDue('app', async (job: SchedulerJob): Promise<RunOutcome> => {
    const appId = (job.metadata as any)?.appId
    if (!appId) {
      console.warn(`[Runtime] Scheduler job ${job.id} has no appId in metadata`)
      return 'skipped'
    }

    const admission = admitAutomaticRun(appId)
    if ('skipReason' in admission) {
      console.log(`[Runtime] Skipping scheduled run: app=${appId}, ${admission.skipReason}`)
      return 'skipped'
    }
    const app = admission.app

    const trigger = buildScheduleTriggerContext(job, app)

    try {
      const result = await executeWithConcurrency(app, trigger)

      // IM forwarding is now AI-driven via notify_bot tool (no more system auto-push)

      // Stopping or closing a run is not its schedule failing: the scheduler
      // must neither back the next time off nor disable the job after repeats.
      if (result.outcome === 'error' && (store.wasRunStopped(result.runId) || store.isRunClosed(result.runId))) {
        return 'noop'
      }
      return result.outcome as RunOutcome
    } catch (err) {
      console.error(`[Runtime] Scheduled run failed: app=${appId}, job=${job.id}:`, err)
      return 'error'
    }
  })

  // ── Listen for App status changes ───────────────────
  appManager.onAppStatusChange((appId: string, _oldStatus: AppStatus, newStatus: AppStatus) => {
    // When an app is paused, deactivate it
    if (newStatus === 'paused' || newStatus === 'error') {
      for (const controller of queuedAutomatic.get(appId) ?? []) controller.abort('Automatic execution paused before it started')
      service.deactivate(appId).catch(err => {
        console.error(`[Runtime] Failed to deactivate on status change: ${appId}:`, err)
      })
    }
    // When an app is resumed/activated, activate it
    if (newStatus === 'active') {
      service.activate(appId).catch(err => {
        console.error(`[Runtime] Failed to activate on status change: ${appId}:`, err)
      })
    }

    // Broadcast status change to all connected remote clients for real-time UI
    try {
      publishAppState(appId)
    } catch (err) {
      console.warn(`[Runtime] Failed to broadcast status change for app=${appId}:`, err)
    }
  })

  // ── Announce membership changes of the installed-App set ────────────────
  // Installs happen behind a client's back (a team provisioning its lead, an App
  // creating another App, a Store install from a different window); without this
  // signal its list only refreshes when a view remounts. Distinct from
  // app:status_changed, which reports a known App's runtime state.
  function announceListChange(appId: string, change: 'installed' | 'uninstalled'): void {
    try {
      broadcastToAll('app:list_changed', { appId, change })
      sendToRenderer('app:list_changed', { appId, change })
    } catch (err) {
      console.warn(`[Runtime] Failed to broadcast list change for app=${appId}:`, err)
    }
  }

  appManager.onAppInstalled((app: InstalledApp) => announceListChange(app.id, 'installed'))
  appManager.onAppUninstalled((app: InstalledApp) => {
    runningRuns.abortApp(app.id)
    for (const controller of queuedAutomatic.get(app.id) ?? []) controller.abort()
    destroyChatBrowserContextsForApp(app.id, 'app-uninstalled')
    // Idempotent: a user uninstall already deactivated it, but a space delete or
    // a system cleanup reaches here with the schedule and subscriptions still live.
    void service.deactivate(app.id).catch(err => {
      console.warn(`[Runtime] Deactivate after uninstall failed for app=${app.id}:`, err)
    })
    forgetAppState(app.id)
    announceListChange(app.id, 'uninstalled')
  })

  // ── React to an author's upgrade ────────────────────
  // Every upgrade path (store, automatic or manual, and the bundle) ends in the
  // manager's upgradeSpec, so this is where an upgrade reaches the running
  // digital human: its triggers are rescheduled, and fields kept at the user's
  // version are written up where the user looks.
  appManager.onAppSpecUpgraded((appId, outcome) => {
    try {
      service.syncAppSubscriptions(appId)
    } catch (err) {
      console.error('[Runtime] Rescheduling after an upgrade failed; it applies on next activation', { appId, error: err })
    }
    if (outcome.kept.length === 0) return
    try {
      emitActivityEntry({
        id: randomUUID(),
        appId,
        runId: UPGRADE_NOTE_RUN_ID,
        type: 'milestone',
        ts: Date.now(),
        content: {
          summary: `Upgraded from v${outcome.fromVersion} to v${outcome.toVersion}. ` +
            `Kept the current version of what differs from the author's: ${outcome.kept.join(', ')}`,
          upgrade: { ...outcome },
          source: { kind: 'upgrade', appId },
        },
      })
    } catch (err) {
      console.error('[Runtime] Upgrade note could not be recorded', { appId, kept: outcome.kept, error: err })
    }
  })

  return service
}

/** Upgrade notes belong to no run; like chat reports, they carry a sentinel run id. */
const UPGRADE_NOTE_RUN_ID = 'upgrade'
