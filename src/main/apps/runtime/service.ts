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
import type { EventFilter, FilterRule } from './event-types'
import type { MemoryService } from '../../platform/memory'
import type { BackgroundService } from '../../platform/background'
import type { ActivityStore } from './store'
import type {
  AppRuntimeService,
  AppRuntimeDeps,
  ActivationState,
  AutomationAppState,
  AppRunResult,
  TriggerContext,
  EscalationResponse,
  ActivityQueryOptions,
  ActivityEntry,
  AutomationRun,
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
import { getSpace } from '../../services/space.service'
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

/** Default escalation timeout in hours (used when spec.escalation.timeout_hours is not set) */
const DEFAULT_ESCALATION_TIMEOUT_HOURS = 24

/** How often to check for timed-out escalations (5 minutes) */
const ESCALATION_CHECK_INTERVAL_MS = 5 * 60 * 1000

/** Minimum interval between data prune runs (24 hours) */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

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
    if (!space?.path) return null

    const sections: string[] = []

    for (const session of sessions) {
      // Derive JSONL runId — mirrors deriveRunId() in app-chat.ts
      const chatRunId = `chat-${session.channel}-${session.chatType}-${session.chatId}`
      const messages = readSessionMessages(space.path, app.id, chatRunId)
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
        const userLine = turn.user.slice(0, IM_MESSAGE_TRUNCATE)
        const botLine = `[bot] ${turn.botFinal.slice(0, IM_MESSAGE_TRUNCATE)}`
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
    response: EscalationResponse,
    sessionId?: string
  ): TriggerContext {
    return {
      type: 'escalation_followup',
      description: `Follow-up run for "${app.spec.name}" after user responded to escalation. ` +
        `Original question: "${originalQuestion}". ` +
        `User response: "${response.text || response.choice || '(no text)'}". ` +
        `Time: ${new Date().toISOString()}`,
      escalation: {
        originalQuestion,
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
    } catch (_err) {
      // Non-fatal — continue execution
    }
  }

  // ── Helper: Insert + broadcast activity entry ──────
  function emitActivityEntry(entry: ActivityEntry): void {
    store.insertEntry(entry)
    sendToRenderer('app:activity_entry:new', { appId: entry.appId, entry })
    broadcastToAll('app:activity_entry:new', { appId: entry.appId, entry: entry as unknown as Record<string, unknown> })
  }

  // ── Helper: Execute with concurrency control ────────
  async function executeWithConcurrency(
    app: InstalledApp,
    trigger: TriggerContext,
    continueOptions?: { existingRunId?: string; existingSessionKey?: string }
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

      try {
        await semaphore.acquire()
      } finally {
        // Whether we got the slot or were rejected (e.g. shutdown), decrement queued count.
        // Only remove the key when the last queued run for this app has been resolved.
        const remaining = (pendingTriggers.get(app.id) ?? 1) - 1
        if (remaining <= 0) {
          pendingTriggers.delete(app.id)
        } else {
          pendingTriggers.set(app.id, remaining)
        }
      }
    }

    const abortController = new AbortController()
    // Use a unique per-run key so concurrent runs of the same App
    // each get their own abort controller entry.
    const executionKey = `${app.id}:${++executionCounter}`
    runningAbortControllers.set(executionKey, abortController)

    // Broadcast run-start status (app transitions from 'queued'/'idle' to 'running')
    broadcastAppStatus(app.id)

    try {
      const result = await executeRun({
        app,
        trigger,
        store,
        memory,
        abortSignal: abortController.signal,
        emitEntry: emitActivityEntry,
        existingRunId: continueOptions?.existingRunId,
        existingSessionKey: continueOptions?.existingSessionKey,
        // Fire the `onRunStarted` lifecycle event at the *real* start of the
        // run (after DB row insertion, before AI session build). This keeps
        // the started/finished event pair semantically meaningful for
        // dashboards that count in-flight runs.
        onRunStarted: ({ runId, sessionKey, startedAt }) => {
          emitRunStarted({
            appId: app.id,
            runId,
            sessionKey,
            triggerType: trigger.type,
            startedAt,
          })
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

      // Handle escalation result
      if (result.outcome === 'useful' && store.getRun(result.runId)?.status === 'waiting_user') {
        // The run resulted in an escalation - find the pending escalation entry
        const entries = store.getEntriesForApp(app.id, { type: 'escalation', limit: 1 })
        const pendingEntry = entries.find(e => !e.userResponse)
        if (pendingEntry) {
          // Close any orphan escalation entries from previous runs before
          // setting the new pendingEscalationId. This prevents stale entries
          // from triggering false timeouts when the app re-enters waiting_user.
          const closed = store.closeOrphanEscalations(app.id, pendingEntry.id)
          if (closed > 0) {
            console.log(`[Runtime] Closed ${closed} orphan escalation(s) before entering waiting_user: app=${app.id}`)
          }

          appManager.updateStatus(app.id, 'waiting_user', {
            pendingEscalationId: pendingEntry.id,
          })
        }
      }

      // Handle consecutive errors -> auto-pause
      if (outcome === 'error') {
        const recentRuns = store.getRunsForApp(app.id, MAX_CONSECUTIVE_ERRORS)
        const consecutiveErrors = countConsecutiveErrors(recentRuns)
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
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
            })
          }
        } catch (notifyErr) {
          console.error('[Runtime] Failed to send desktop notification:', notifyErr)
        }
      }

      return result
    } finally {
      runningAbortControllers.delete(executionKey)
      semaphore.release()

      // Broadcast run-end status (app transitions back to 'idle' or other state)
      broadcastAppStatus(app.id)
    }
  }

  // ── Helper: Count consecutive errors ────────────────
  function countConsecutiveErrors(runs: AutomationRun[]): number {
    let count = 0
    for (const run of runs) {
      if (run.status === 'error') {
        count++
      } else {
        break
      }
    }
    return count
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
   * Periodically scans for pending escalations that have exceeded their
   * timeout (default: 24 hours). Timed-out escalations are:
   * 1. Auto-resolved with a timeout response
   * 2. Recorded as a run_error activity entry
   * 3. App status changed from waiting_user → error
   * 4. Desktop notification sent to inform the user
   */
  function checkEscalationTimeouts(): void {
    try {
      const pendingEscalations = store.getAllPendingEscalations()
      if (pendingEscalations.length === 0) return

      const now = Date.now()

      for (const entry of pendingEscalations) {
        const app = appManager.getApp(entry.appId)
        if (!app) continue

        // Only process apps that are actually in waiting_user state
        if (app.status !== 'waiting_user') continue

        // ── Orphan detection ─────────────────────────────────────
        // An orphan is a pending escalation that does NOT match the app's
        // current pendingEscalationId. This happens when the app leaves
        // waiting_user (e.g. pause → resume) without resolving the entry,
        // then later re-enters waiting_user for a NEW escalation. The old
        // entry's user_response_json is still NULL, so it appears in
        // getAllPendingEscalations(). If we timeout the orphan, the app
        // instantly errors out — which is the bug we're fixing.
        if (app.pendingEscalationId && entry.id !== app.pendingEscalationId) {
          store.closeOrphanEscalations(app.id, app.pendingEscalationId)
          console.log(
            `[Runtime] Closed orphan escalation: app=${app.id}, orphan=${entry.id}, ` +
            `active=${app.pendingEscalationId}`
          )
          continue
        }

        // Determine timeout from app spec (default: 24 hours)
        const timeoutHours = (app.spec.type === 'automation' ? app.spec.escalation?.timeout_hours : undefined) ?? DEFAULT_ESCALATION_TIMEOUT_HOURS
        const timeoutMs = timeoutHours * 60 * 60 * 1000
        const elapsed = now - entry.ts

        if (elapsed < timeoutMs) continue

        const timeoutLabel = timeoutHours >= 24
          ? `${Math.round(timeoutHours / 24)} day(s)`
          : `${timeoutHours} hour(s)`

        console.log(
          `[Runtime] Escalation timed out: app=${app.id}, entry=${entry.id}, ` +
          `elapsed=${Math.round(elapsed / 3600000)}h, timeout=${timeoutLabel}`
        )

        // 1. Auto-resolve the escalation with a timeout response
        const timeoutResponse = {
          ts: now,
          text: `[Auto-closed] User did not respond within ${timeoutLabel}.`,
        }
        store.updateEntryResponse(entry.id, timeoutResponse)

        // 2. Insert a run_error activity entry
        const errorEntry = {
          id: randomUUID(),
          appId: app.id,
          runId: entry.runId,
          type: 'run_error' as const,
          ts: now,
          sessionKey: entry.sessionKey,
          content: {
            summary: `Escalation timed out — user did not respond within ${timeoutLabel}.`,
            status: 'error' as const,
            error: `Escalation timeout (${timeoutLabel})`,
          },
        }

        emitActivityEntry(errorEntry)

        // 3. Transition app status: waiting_user → error
        try {
          appManager.updateStatus(app.id, 'error', {
            errorMessage: `Escalation timed out after ${timeoutLabel}`,
          })
        } catch (statusErr) {
          console.error(`[Runtime] Failed to update status after escalation timeout: app=${app.id}:`, statusErr)
        }

        // 4. Notify the user
        notifyAppEvent(
          app.spec.name,
          `Escalation timed out — no response within ${timeoutLabel}.`,
          { appId: app.id }
        )
      }
    } catch (err) {
      console.error('[Runtime] Escalation timeout check failed:', err)
    }

    // Piggyback data pruning on the same interval (self-throttled to 24h)
    pruneOldDataIfNeeded()
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
      // Check for user frequency override
      const overriddenFreq = app.userOverrides.frequency?.[subId]

      if (config.every || overriddenFreq) {
        const every = overriddenFreq || config.every!
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
  function subscriptionToEventFilter(
    sub: SubscriptionDef
  ): EventFilter | null {
    switch (sub.source.type) {
      case 'file': {
        const filter: EventFilter = { types: ['file.*'] }
        const rules: FilterRule[] = []

        // Apply pattern-based filtering if the subscription specifies a glob pattern
        const filePattern = sub.source.config.pattern
        if (filePattern) {
          rules.push({
            field: 'payload.relativePath',
            op: 'matches',
            value: filePattern,
          })
        }

        // Apply path-based filtering if the subscription specifies a directory
        const filePath = sub.source.config.path
        if (filePath) {
          const normalizedPath = filePath.replace(/\/+$/, '') // strip trailing slashes
          rules.push({
            field: 'payload.filePath',
            op: 'contains',
            value: normalizedPath,
          })
        }

        if (rules.length > 0) {
          filter.rules = rules
        }

        return filter
      }
      case 'webhook': {
        const filter: EventFilter = { types: ['webhook.received'] }
        // Add path-based filtering if the subscription specifies a webhook path
        const webhookPath = sub.source.config.path
        if (webhookPath) {
          filter.rules = [{
            field: 'payload.path',
            op: 'eq',
            value: webhookPath.replace(/^\/+|\/+$/g, ''), // normalize: strip leading/trailing slashes
          }]
        }
        return filter
      }
      case 'webpage':
        return { types: ['webpage.changed'] }
      case 'rss':
        return { types: ['rss.updated'] }
      case 'wecom': {
        const filter: EventFilter = { types: ['wecom.message'] }
        const wecomChatId = sub.source.config.chatId
        if (wecomChatId) {
          filter.rules = [{
            field: 'payload.chatId',
            op: 'eq',
            value: wecomChatId,
          }]
        }
        return filter
      }
      default:
        return null
    }
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
            // Check if app is still active
            const currentApp = appManager.getApp(appId)
            if (!currentApp || currentApp.status !== 'active') return

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

      // Abort all running executions for this App (handles concurrent runs)
      const prefix = `${appId}:`
      for (const [key, controller] of Array.from(runningAbortControllers.entries())) {
        if (key.startsWith(prefix)) {
          controller.abort()
          runningAbortControllers.delete(key)
        }
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
            const currentApp = appManager.getApp(appId)
            if (!currentApp || currentApp.status !== 'active') return

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
      const app = appManager.getApp(appId)
      if (!app) {
        throw new AppNotFoundError(appId)
      }

      if (app.status === 'error') {
        // Manual trigger from error state is treated as user-initiated retry.
        // Resume resets status to 'active' and re-activates the scheduler,
        // which is the same path as pause → resume in the UI.
        console.log(`[Runtime] app:trigger recovering from error state: ${appId}`)
        appManager.resume(appId)
      } else if (app.status === 'paused') {
        // Manual trigger from paused state: auto-resume so the user can
        // run on demand without a separate resume step.  The scheduler
        // is re-activated, and the trigger continues below.
        console.log(`[Runtime] app:trigger auto-resuming paused app: ${appId}`)
        appManager.resume(appId)
      } else if (app.status !== 'active') {
        // waiting_user and any other non-active states are not runnable.
        throw new AppNotRunnableError(appId, app.status)
      }

      // Per-app dedup: reject if this specific app is already running or queued.
      // Each app should have at most one active execution at a time to avoid
      // redundant work (e.g. a monitoring app running 50 identical checks).
      const appIsRunning = Array.from(runningAbortControllers.keys()).some(k => k.startsWith(`${appId}:`))
      const appIsQueued = (pendingTriggers.get(appId) ?? 0) > 0
      if (appIsRunning || appIsQueued) {
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

      const result = await executeWithConcurrency(app, trigger)

      // IM forwarding is now AI-driven via notify_bot tool (no more system auto-push)

      return result
    },

    // ── State Queries ───────────────────────────────

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

      switch (app.status) {
        case 'active':
          if (isRunning) status = 'running'
          else if (isQueued) status = 'queued'
          else status = 'idle'
          break
        case 'paused':
          status = 'paused'
          break
        case 'waiting_user':
          status = 'waiting_user'
          break
        case 'error':
        case 'needs_login':
          status = 'error'
          break
        default:
          status = 'idle'
      }

      const state: AutomationAppState = {
        status,
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

    async respondToEscalation(
      appId: string,
      entryId: string,
      response: EscalationResponse
    ): Promise<void> {
      // Verify the escalation exists and is pending
      const entry = store.getPendingEscalation(appId, entryId)
      if (!entry) {
        throw new EscalationNotFoundError(appId, entryId)
      }

      // Record the user's response
      store.updateEntryResponse(entryId, response)

      console.log(`[Runtime] Escalation responded: app=${appId}, entry=${entryId}`)

      // Broadcast escalation resolved event for multi-client sync
      broadcastToAll('app:escalation:resolved', { appId, entryId, response })
      sendToRenderer('app:escalation:resolved', { appId, entryId, response })

      // Clear the waiting_user status
      const app = appManager.getApp(appId)
      if (app && app.status === 'waiting_user') {
        appManager.updateStatus(appId, 'active')
      }

      // Resume the original run with the escalation context.
      // Unlike creating a new run, we reopen the existing run so the entire
      // escalation lifecycle (original trigger → AI work → question → response → continuation)
      // stays as a single run in the Activity Thread and session history.
      if (app) {
        const originalQuestion = entry.content.question || entry.content.summary

        // Retrieve session ID from the escalation run for context recovery.
        // The follow-up will restore the full conversation context
        // (reasoning, tool calls, intermediate results) via session resumption.
        const escalationRun = store.getRun(entry.runId)
        const sessionId = escalationRun?.sessionId
        if (sessionId) {
          console.log(`[Runtime] Escalation follow-up will resume session: ${sessionId}`)
        } else {
          console.warn(`[Runtime] No session ID found for escalation run ${entry.runId}, follow-up will start fresh`)
        }

        // Reopen the original run: waiting_user → running.
        // This causes getAppState() to return status:'running' + runningRunId
        // so the UI immediately reflects the live state without a new timeline entry.
        store.reopenRun(entry.runId)
        broadcastAppStatus(appId)

        const trigger = buildEscalationTriggerContext(app, originalQuestion, response, sessionId)

        // Execute asynchronously, reusing the original run record
        executeWithConcurrency(app, trigger, {
          existingRunId: entry.runId,
          existingSessionKey: escalationRun?.sessionKey,
        }).catch((err) => {
          console.error(
            `[Runtime] Escalation follow-up run failed: app=${appId}:`,
            err
          )
        })
      }
    },

    // ── User-initiated Continue ─────────────────────

    async continueFailedRun(appId: string, runId: string): Promise<void> {
      const app = appManager.getApp(appId)
      if (!app) {
        throw new Error(`App not found: ${appId}`)
      }

      const run = store.getRun(runId)
      if (!run) {
        throw new Error(`Run not found: ${runId}`)
      }
      if (run.status !== 'error') {
        throw new Error(`Run ${runId} is not in error state (status: ${run.status})`)
      }

      // Guard: only allow continue on runs that ended due to premature LLM termination.
      // Runs that failed for other reasons (runtime exception, AI-reported error) should
      // be retried via triggerManually, not continued from a broken session.
      if (!run.sessionId) {
        console.warn(
          `[Runtime] continueFailedRun: run ${runId} has no sessionId — ` +
          `falling back to fresh run. This is unexpected for a premature-stop error.`
        )
      }

      const appIsRunning = Array.from(runningAbortControllers.keys()).some(k => k.startsWith(`${appId}:`))
      if (appIsRunning) {
        throw new Error(`App ${appId} already has a running execution — cannot continue simultaneously`)
      }

      console.log(
        `[Runtime] User-initiated continue: app=${appId}, run=${runId}, ` +
        `sessionId=${run.sessionId ?? 'none'}`
      )

      // Reopen the run record: error → running.
      // This causes getAppState() to return status:'running' + runningRunId=runId
      // so the UI immediately reflects the live state without a new timeline entry.
      store.reopenRun(runId)
      broadcastAppStatus(appId)

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
      if (!run) {
        throw new Error(`Run not found: ${runId}`)
      }
      const appIsRunning = Array.from(runningAbortControllers.keys()).some(k => k.startsWith(`${appId}:`))
      if (appIsRunning) {
        throw new Error(`App ${appId} is busy with another run — try again once it finishes`)
      }

      store.reopenRun(runId)
      broadcastAppStatus(appId)

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

    getActivityEntries(appId: string, options?: ActivityQueryOptions): ActivityEntry[] {
      return store.getEntriesForApp(appId, options)
    },

    getRun(runId: string): AutomationRun | null {
      return store.getRun(runId)
    },

    getRunsForApp(appId: string, limit?: number): AutomationRun[] {
      return store.getRunsForApp(appId, limit)
    },

    // ── Lifecycle ───────────────────────────────────

    async activateAll(): Promise<void> {
      console.log('[Runtime] Activating all active automation apps...')
      const apps = appManager.listApps({ status: 'active', type: 'automation' })

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
  scheduler.onJobDue(async (job: SchedulerJob): Promise<RunOutcome> => {
    const appId = (job.metadata as any)?.appId
    if (!appId) {
      console.warn(`[Runtime] Scheduler job ${job.id} has no appId in metadata`)
      return 'skipped'
    }

    const app = appManager.getApp(appId)
    if (!app) {
      console.warn(`[Runtime] App not found for scheduler job: ${job.id}, appId=${appId}`)
      return 'skipped'
    }

    if (app.status !== 'active') {
      console.log(`[Runtime] Skipping scheduled run: app=${appId} status=${app.status}`)
      return 'skipped'
    }

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
  appManager.onAppStatusChange((appId: string, oldStatus: AppStatus, newStatus: AppStatus) => {
    // ── Orphan escalation cleanup ───────────────────────
    // When an app leaves waiting_user for any reason OTHER than the normal
    // timeout path (which already resolves the entry), close all remaining
    // pending escalation entries so they don't cause false timeouts later.
    if (oldStatus === 'waiting_user' && newStatus !== 'waiting_user') {
      try {
        const closed = store.closeOrphanEscalations(appId)
        if (closed > 0) {
          console.log(`[Runtime] Closed ${closed} orphan escalation(s) on state change: app=${appId}, ${oldStatus} -> ${newStatus}`)
        }
      } catch (err) {
        console.error(`[Runtime] Failed to close orphan escalations: app=${appId}:`, err)
      }
    }

    // When an app is paused, deactivate it
    if (newStatus === 'paused' || newStatus === 'error') {
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

  return service
}
