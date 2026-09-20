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
import { readSessionMessages } from './session-store'
import { legacySessionEnvironmentKey } from './execution-environment'
import { getActiveTeamRuntime } from './team'
import { truncateUtf16Safe } from './text-truncate'
import { getSpace } from '../../services/space.service'
import { getEscalationQuestions, formatEscalationAnswer } from '../../../shared/apps/app-types'
import type { ImSessionRecord } from '../../../shared/types/im-channel'
import { broadcastToAll } from '../../http/websocket'
import { sendToRenderer } from '../../foundation/window.service'
import { notifyAppEvent } from '../../services/notification.service'

// ============================================
// Constants
// ============================================

/** Default max concurrent automation runs */
const DEFAULT_MAX_CONCURRENT = 10

/** Max consecutive errors before auto-pausing */
const MAX_CONSECUTIVE_ERRORS = 5

/** Keep-alive reason string for the background service */
const KEEP_ALIVE_REASON = 'automation-apps-active'

/** How often to check for timed-out escalations (5 minutes) */
const ESCALATION_CHECK_INTERVAL_MS = 5 * 60 * 1000

/** Minimum interval between data prune runs (24 hours) */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Recorded on runs whose process died before they could finish. */
const INTERRUPTED_RUN_MESSAGE = 'Interrupted — Halo stopped while this run was in progress.'

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
  const activeRunControllers = new Map<string, AbortController>()
  const continuationDispatches = new Set<string>()
  let continuationInterval: ReturnType<typeof setInterval> | null = null
  let shuttingDown = false
  let drainingContinuations = false
  const { store, appManager, scheduler, eventRouter, memory, background } = deps
  const imSessionRegistry = deps.imSessionRegistry ?? null

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
  // Keyed by unique execution key ("{appId}:{counter}") -- NOT by appId alone.
  // This avoids concurrent runs for the same App overwriting each other's
  // abort controller, ensuring deactivate() can cancel ALL running instances.
  const runningAbortControllers = new Map<string, AbortController>()
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

  /** Max recent conversation turns (user + bot reply) to include per IM session */
  const IM_HISTORY_TURN_LIMIT = 15

  /** Max total characters for the IM context section (keeps trigger concise) */
  const IM_HISTORY_MAX_CHARS = 3000

  /** Max characters per individual message line (truncate long bot responses) */
  const IM_MESSAGE_TRUNCATE = 500

  /**
   * Prefixes written by the old proactive push path (buildTriggerMessage).
   * These are internal trigger signals, not real user messages — skip them.
   */
  const IM_TRIGGER_PREFIXES = ['[schedule]', '[event]', '[manual]']

  /**
   * Build an IM conversation history section for injection into trigger context.
   *
   * Groups raw JSONL messages into clean conversation turns: each turn is one
   * user message paired with the bot's FINAL reply (intermediate tool-call
   * narration is collapsed away, matching what IM users actually see).
   *
   * Internal trigger messages ([schedule]/[event]/[manual]) are filtered out.
   * Returns null if no usable history exists.
   */
  function buildImContextForTrigger(
    app: InstalledApp,
    sessions: ImSessionRecord[]
  ): string | null {
    const space = app.spaceId ? getSpace(app.spaceId) : null
    const sections: string[] = []

    for (const session of sessions) {
      // Derive JSONL runId — mirrors deriveRunId() in app-chat.ts
      const chatRunId = `chat-${session.channel}-${session.chatType}-${session.chatId}`
      const sessionKey = `app-chat:${app.id}:${session.channel}:${session.chatType}:${session.chatId}`
      const environment = store.getSessionEnvironment(sessionKey)
        ?? store.getSessionEnvironment(legacySessionEnvironmentKey(app.id, chatRunId))
      const spacePath = environment?.spacePath ?? space?.path
      if (!spacePath) {
        console.warn('[Runtime] IM trigger history unavailable: missing session environment', { appId: app.id, sessionKey })
        continue
      }
      const messages = readSessionMessages(spacePath, app.id, chatRunId)
      if (messages.length === 0) continue

      // ── Group into turns ──────────────────────────────────────────────────
      // Each turn = one real user message + the bot's last reply for that turn.
      // Multiple consecutive bot messages (tool-call narration) are collapsed
      // to the final one — that's what the IM user actually received.
      const turns: Array<{ user: string; botFinal: string }> = []
      let pendingUser: string | null = null
      let pendingBotFinal: string | null = null

      for (const m of messages) {
        if (m.role === 'user') {
          // Flush completed turn before starting a new one
          if (pendingUser !== null && pendingBotFinal !== null) {
            turns.push({ user: pendingUser, botFinal: pendingBotFinal })
          }
          // Skip internal trigger signals — not real user messages
          if (IM_TRIGGER_PREFIXES.some(p => m.content.startsWith(p))) {
            pendingUser = null
            pendingBotFinal = null
            continue
          }
          pendingUser = m.content
          pendingBotFinal = null
        } else {
          // Bot message — keep overwriting so we always have the last one
          if (pendingUser !== null) {
            pendingBotFinal = m.content
          }
        }
      }
      // Flush the last turn
      if (pendingUser !== null && pendingBotFinal !== null) {
        turns.push({ user: pendingUser, botFinal: pendingBotFinal })
      }

      if (turns.length === 0) continue

      // ── Format recent turns ───────────────────────────────────────────────
      const recentTurns = turns.slice(-IM_HISTORY_TURN_LIMIT)
      let totalChars = 0
      const lines: string[] = []

      for (const turn of recentTurns) {
        const userLine = truncateUtf16Safe(turn.user, IM_MESSAGE_TRUNCATE)
        const botLine = `[bot] ${truncateUtf16Safe(turn.botFinal, IM_MESSAGE_TRUNCATE)}`
        const turnText = `${userLine}\n${botLine}`
        totalChars += turnText.length
        if (totalChars > IM_HISTORY_MAX_CHARS) break
        lines.push(turnText)
      }

      if (lines.length > 0) {
        const header = session.displayName || session.chatId
        sections.push(
          `#### ${header} (recent ${lines.length} exchanges)\n\n${lines.join('\n\n')}`
        )
      }
    }

    if (sections.length === 0) return null

    return (
      `### IM Conversation History\n\n` +
      `Recent exchanges from IM channels where this App is active.\n` +
      `Each entry: a user message followed by the bot's final reply.\n` +
      `Use this to understand what users have been asking about and tailor your output accordingly.\n\n` +
      sections.join('\n\n')
    )
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
    interactive?: boolean
  ): TriggerContext {
    return {
      type: 'continue_followup',
      description: `User-initiated continue for "${app.spec.name}". ` +
        `Time: ${new Date().toISOString()}`,
      continue: {
        sessionId,
        userMessage,
        interactive,
      },
    }
  }

  // ── Helper: Broadcast app state change ──────────────
  function broadcastAppStatus(appId: string): void {
    try {
      const state = service.getAppState(appId)
      broadcastToAll('app:status_changed', { appId, state: state as unknown as Record<string, unknown> })
      sendToRenderer('app:status_changed', { appId, state })
    } catch (error) {
      console.error('[Runtime] Failed to publish execution state', { appId, error })
    }
  }

  // ── Helper: Insert + broadcast activity entry ──────
  function emitActivityEntry(entry: ActivityEntry): void {
    store.insertEntry(entry)
    sendToRenderer('app:activity_entry:new', { appId: entry.appId, entry })
    broadcastToAll('app:activity_entry:new', { appId: entry.appId, entry: entry as unknown as Record<string, unknown> })
  }

  /**
   * Whether the app already has an execution running or waiting for a slot.
   *
   * One execution per app at a time — a second concurrent run duplicates work
   * (a monitoring app would run 50 identical checks) and races the first one's
   * state. Every trigger entry must consult this, not just the manual one.
   */
  function isAppBusy(appId: string): boolean {
    const running = Array.from(runningAbortControllers.keys()).some(k => k.startsWith(`${appId}:`))
    return running || (pendingTriggers.get(appId) ?? 0) > 0
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

    // ── Inject IM conversation history into trigger ─────
    // Use getAllSessions (not the deprecated getProactiveSessions which
    // filters by the removed `proactive` flag and always returns empty).
    const imSessions = imSessionRegistry?.getAllSessions(appId)
    if (imSessions && imSessions.length > 0) {
      const imContext = buildImContextForTrigger(app, imSessions)
      if (imContext) {
        trigger.description += '\n\n' + imContext
      }
    }

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
    runningAbortControllers.set(executionKey, abortController)

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
          activeRunControllers.set(runId, abortController)
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
        activeRunControllers.delete(executingRunId)
        intentionallyStoppedRuns.delete(executingRunId)
      }
      runningAbortControllers.delete(executionKey)
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
      sendToRenderer('app:activity_entry:new', { appId: entry.appId, entry })
      broadcastToAll('app:activity_entry:new', { appId: entry.appId, entry: entry as unknown as Record<string, unknown> })
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
        state.keepAliveDisposer = background.registerKeepAliveReason(
          `${KEEP_ALIVE_REASON}:${appId}`
        )
      }

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
      for (const key of runningAbortControllers.keys()) {
        const appId = key.slice(0, key.indexOf(':'))
        const row = result[appId] ??= { runningCount: 0, queued: false }
        row.runningCount++
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
      return Object.fromEntries(appManager.listApps({ type: 'automation' }).map(app => [app.id, service.getAppState(app.id)]))
    },

    getAppState(appId: string): AutomationAppState {
      const app = appManager.getApp(appId)
      if (!app) {
        return {
          status: 'idle',
        }
      }

      // Map AppStatus to AutomationAppState.status
      let status: AutomationAppState['status']
      const appPrefix = `${appId}:`
      const isRunning = Array.from(runningAbortControllers.keys()).some(k => k.startsWith(appPrefix))
      const isQueued = (pendingTriggers.get(appId) ?? 0) > 0

      const counts = store.getDecisionCounts(appId)
      const automaticEnabled = app.status === 'active' || app.status === 'waiting_user'
      status = isRunning ? 'running' : isQueued || counts.continuations > 0 ? 'queued'
        : counts.pending > 0 ? 'waiting_user' : app.status === 'needs_login' ? 'needs_login'
        : automaticEnabled ? 'idle' : app.status === 'paused' ? 'paused' : 'error'

      const state: AutomationAppState = {
        status,
        automaticEnabled,
        runningCount: Array.from(runningAbortControllers.keys()).filter(key => key.startsWith(appPrefix)).length,
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
          state.runningAtMs = latestRun.startedAt
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

    async stopRun(appId: string, runId: string): Promise<void> {
      const run = store.getRun(runId)
      if (!run || run.appId !== appId) throw new Error('Task not found')
      const controller = activeRunControllers.get(runId)
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
      if (activeRunControllers.has(runId)) intentionallyStoppedRuns.add(runId)
      activeRunControllers.get(runId)?.abort()
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

    async injectIntoRun(appId: string, runId: string, text: string): Promise<void> {
      const app = appManager.getApp(appId)
      if (!app) {
        throw new Error(`App not found: ${appId}`)
      }
      const trimmed = text.trim()
      if (!trimmed) {
        throw new Error('Cannot send an empty message')
      }

      // Live run → inject into the current turn; the AI absorbs it at the next
      // tool boundary (steer an in-progress run).
      if (isRunActive(runId)) {
        injectIntoActiveRun(appId, runId, trimmed)
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
      const trigger = buildContinueTriggerContext(app, run.sessionId, trimmed, interactive)
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
      for (const controller of runningAbortControllers.values()) controller.abort()
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
  // IM conversation history from proactive sessions is injected into the
  // trigger context, and the run result is forwarded to IM after completion.
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

    // ── Inject IM conversation history into trigger ─────
    const imSessions = imSessionRegistry?.getAllSessions(appId)
    if (imSessions && imSessions.length > 0) {
      const imContext = buildImContextForTrigger(app, imSessions)
      if (imContext) {
        trigger.description += '\n\n' + imContext
      }
    }

    try {
      const result = await executeWithConcurrency(app, trigger)

      // IM forwarding is now AI-driven via notify_bot tool (no more system auto-push)

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
      const state = service.getAppState(appId)
      broadcastToAll('app:status_changed', { appId, state: state as unknown as Record<string, unknown> })
      sendToRenderer('app:status_changed', { appId, state })
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
    for (const [key, controller] of runningAbortControllers) if (key.startsWith(`${app.id}:`)) controller.abort()
    for (const controller of queuedAutomatic.get(app.id) ?? []) controller.abort()
    announceListChange(app.id, 'uninstalled')
  })

  return service
}
