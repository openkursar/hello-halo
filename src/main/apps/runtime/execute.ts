/**
 * apps/runtime -- Run Execution Engine
 *
 * Core logic for executing a single automation App run.
 * Creates an independent V2 session, injects the App's prompt + MCP tools,
 * processes the stream, and records results to the Activity Store.
 *
 * Design decisions (see DESIGN.md):
 * - Own SDK sessions (no sendMessage modification)
 * - Stateless runs (no cross-run session persistence)
 * - Escalation as run boundary
 * - Stream processing: collect final result only
 */

import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { createSession } from '../../services/agent/resolved-sdk'
import type { InstalledApp } from '../manager'
import { resolvePermission } from '../../../shared/apps/app-types'
import type { MemoryService, MemoryCallerScope } from '../../platform/memory'
import { buildMemorySnapshot, createMemoryStatusMcpServer } from '../../platform/memory/snapshot'
import type { ActivityStore } from './store'
import type {
  TriggerContext,
  AppRunResult,
  RunStatus,
  ActivityEntry,
} from './types'
import { RunExecutionError } from './errors'
import { buildAppSystemPrompt, buildInitialMessage, buildEscalationResumeMessage } from './prompt'
import { mergeConfigWithDefaults } from './config-defaults'
import { createReportToolServer } from './report-tool'
import type { ReportToolContext } from './report-tool'
import { createNotifyToolServer } from './notify-tool'
import { FileExportGate } from './file-export-gate'
import { getImSessionRegistry } from './im-session-registry'
import { autoSyncRunResult } from './im-auto-sync'
import { getApiCredentials, getApiCredentialsForSource, getHeadlessElectronPath, getWorkingDir, getMcpServersForRequires } from '../../services/agent/helpers'
import { resolveCredentialsForSdk, buildBaseSdkOptions } from '../../services/agent/sdk-config'
import { getOrCreateV2Session } from '../../services/agent/session-manager'
import { createAIBrowserMcpServer, createScopedBrowserContext } from '../../services/ai-browser'
import { createWebSearchMcpServer } from '../../services/web-search'
import { createEmailMcpServer } from '../../services/email-mcp'
import { getConfig, resolveClaudeConfigDir } from '../../foundation/config.service'
import { getSpace, getSpaceDir } from '../../services/space.service'
import { openSessionWriter, type SessionWriter } from './session-store'
import { registerActiveRun, unregisterActiveRun } from './active-runs'

// ============================================
// Types
// ============================================

/** Options for executing a single run */
export interface ExecuteRunOptions {
  /** The installed App to execute */
  app: InstalledApp
  /** What triggered this run */
  trigger: TriggerContext
  /** Activity store for recording results */
  store: ActivityStore
  /** Memory service for AI memory tools and prompt instructions */
  memory: MemoryService
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal
  /** Insert an activity entry and broadcast it to renderer + remote clients */
  emitEntry?: (entry: ActivityEntry) => void
  /**
   * Existing run ID to reopen (user-initiated continue).
   *
   * When provided, `executeRun` skips `store.insertRun()` and reuses this run
   * record instead of creating a new one. Used by `continueFailedRun` so the
   * Activity Thread entry updates in-place (error → running → completed) rather
   * than spawning a second timeline entry.
   */
  existingRunId?: string
  /** Existing session key matching the run record (required when existingRunId is set). */
  existingSessionKey?: string
  /**
   * Fired exactly once, after the run record is inserted/reopened and before
   * the AI session is built. Used by the runtime service to dispatch the
   * `onRunStarted` lifecycle event with the authoritative runId. Errors in
   * the callback are swallowed by the caller — must never throw.
   */
  onRunStarted?: (info: {
    runId: string
    sessionKey: string
    startedAt: number
    isResuming: boolean
  }) => void
}

/** Internal result from stream processing */
interface StreamResult {
  /** Final text content from the AI */
  finalText: string
  /** Total input + output tokens consumed */
  totalTokens: number
  /** Whether the AI reported an error via report_to_user */
  aiReportedError: boolean
  /** Whether the AI called report_to_user during this stream cycle */
  reportToolCalled: boolean
  /** V2 session ID captured from the system init message (for escalation recovery) */
  sessionId?: string
}

// ============================================
// Constants
// ============================================

/** Default max turns per stream cycle for automation runs when not configured by user */
const DEFAULT_MAX_TURNS = 100

/**
 * Max auto-continue attempts when AI ends without calling report_to_user.
 *
 * LLM premature termination is almost always a backend issue (context pressure,
 * transient API behaviour), not a failure to understand the task. A higher limit
 * gives the model more chances to recover without human intervention.
 */
const MAX_AUTO_CONTINUES = 10

/**
 * Message appended to every automatic retry.
 *
 * Prepended with "Continue. " on each auto-retry cycle so the full message reads:
 *   "Continue. You ended your response without calling report_to_user. ..."
 *
 * User-initiated continues send only "Continue." (no suffix) to keep the signal
 * clean and avoid over-constraining the model.
 */
const AUTO_CONTINUE_MESSAGE =
  'You ended your response without calling report_to_user. ' +
  'Every execution MUST end with a report_to_user call. ' +
  'If your task is complete, call report_to_user now with a summary of what you did. ' +
  'If your task is not complete, continue working and call report_to_user when finished.'

/** Full auto-retry prompt: short directive + reminder */
const AUTO_CONTINUE_FULL = `Continue. ${AUTO_CONTINUE_MESSAGE}`

/** User-initiated continue: minimal prompt to avoid over-constraining the model */
const USER_CONTINUE_MESSAGE = 'Continue.'

/** Session key prefix for automation runs */
const SESSION_KEY_PREFIX = 'app-run'

// ============================================
// Core Execution
// ============================================

/**
 * Execute a single automation App run.
 *
 * Lifecycle:
 * 1. Generate run ID and session key
 * 2. Record run start in Activity Store
 * 3. Build system prompt (base + app + memory + reporting)
 * 4. Create V2 session with MCP tools (memory + report_to_user)
 * 5. Send initial message with trigger context
 * 6. Process stream, collecting results
 * 7. Record run completion
 * 8. Close session
 *
 * @param options - Execution options
 * @returns Run result including outcome, timing, and token usage
 * @throws RunExecutionError on unrecoverable failure
 */
export async function executeRun(options: ExecuteRunOptions): Promise<AppRunResult> {
  const { app, trigger, store, memory, abortSignal, emitEntry, existingRunId, existingSessionKey, onRunStarted } = options

  // Guard: executeRun is only valid for automation apps.
  // This narrows app.spec to AutomationSpec for the rest of the function.
  if (app.spec.type !== 'automation') {
    throw new RunExecutionError('unknown', 'unknown', `executeRun called for non-automation app type: ${app.spec.type}`)
  }

  // For continue_followup and escalation_followup (with existingRunId), reuse the
  // existing run record. For all other triggers, generate a new run ID and insert fresh.
  const isResuming = trigger.type === 'continue_followup' ||
    (trigger.type === 'escalation_followup' && !!existingRunId)
  const runId = existingRunId ?? randomUUID()
  const sessionKey = existingSessionKey ?? `${SESSION_KEY_PREFIX}-${runId.slice(0, 8)}`
  const startedAt = Date.now()

  const runTag = runId.slice(0, 8)
  console.log(
    `[Runtime][${runTag}] ▶ Starting run: app=${app.id}, trigger=${trigger.type}, ` +
    `appName="${app.spec.name}", spaceId=${app.spaceId}` +
    (isResuming ? ` (resuming existing run)` : '')
  )

  // Record run start — skip for resuming runs since the run was already
  // reopened (error/waiting_user → running) by the caller before calling executeRun.
  if (!isResuming) {
    store.insertRun({
      runId,
      appId: app.id,
      sessionKey,
      status: 'running',
      triggerType: trigger.type,
      triggerData: trigger.eventPayload ?? (trigger.escalation ? { escalation: trigger.escalation } : undefined),
      startedAt,
    })
  }

  // Emit run-started lifecycle hook. Fires after the DB row exists and before
  // the AI session is built, so subscribers see "running" runs in real time.
  // Callback errors are isolated in the caller — this site never throws.
  if (onRunStarted) {
    try {
      onRunStarted({ runId, sessionKey, startedAt, isResuming })
    } catch (err) {
      console.warn(`[Runtime][${runTag}] onRunStarted callback threw:`, err)
    }
  }

  // Track escalation from report_to_user callback
  let escalationEntryId: string | undefined

  // Session reference for cleanup
  let session: any = null

  // Scoped browser context for this run (created in try, cleaned up in finally)
  let scopedBrowserCtx: ReturnType<typeof createScopedBrowserContext> | undefined

  // ── Build memory scope (before try so it's available in catch) ─────
  const memoryScope: MemoryCallerScope = {
    type: 'app',
    spaceId: app.spaceId!, // Automation apps always have a spaceId
    // Use space.path (not workingDir) to match the directory layout that
    // AppManager creates: {space.path}/.halo/apps/{appId}/memory/
    spacePath: getSpace(app.spaceId!)?.path ?? '',
    appId: app.id,
  }

  try {
    // ── 1. Resolve credentials and working directory ─────
    //    (needed early: workDir feeds into system prompt,
    //     modelInfo feeds into base prompt's model display)
    const config = getConfig()
    const credentials = app.userOverrides?.modelSourceId
      ? await getApiCredentialsForSource(config, app.userOverrides.modelSourceId, app.userOverrides.modelId)
      : await getApiCredentials(config)
    const resolvedCreds = await resolveCredentialsForSdk(credentials)
    const electronPath = getHeadlessElectronPath()
    const workDir = getWorkingDir(app.spaceId!)

    console.log(
      `[Runtime][${runTag}] Credentials resolved: provider=${credentials.provider}, ` +
      `model=${resolvedCreds.displayModel}, workDir=${workDir}`
    )

    // ── 2. Build system prompt ─────────────────────────────
    const memoryInstructions = memory.getPromptInstructions()
    const usesAIBrowser = resolvePermission(app, 'ai-browser')
    const usesEmail = resolvePermission(app, 'email', false) // default false — higher trust
    const usesImPush = resolvePermission(app, 'im-push') // default true — AI-driven IM push

    // ── Merge config_schema defaults into userConfig ─────
    //    Ensures defaults are available even if the user never opened the config panel.
    const mergedConfig = mergeConfigWithDefaults(app.userConfig, app.spec.config_schema)

    console.log(
      `[Runtime][${runTag}] Memory scope: type=${memoryScope.type}, spaceId=${memoryScope.spaceId}, ` +
      `appId=${memoryScope.appId}, hasMemoryInstructions=${memoryInstructions.length > 0}`
    )

    // Auto-sync awareness: include subscribed sessions only when the app has
    // im-push enabled. The prompt builder skips the fragment when the array is
    // empty, so this branch keeps the lookup off the hot path otherwise.
    const autoSyncSessions = usesImPush
      ? (getImSessionRegistry()?.getProactiveSessions(app.id) ?? [])
      : []

    const systemPrompt = buildAppSystemPrompt({
      appSpec: app.spec,
      memoryInstructions,
      triggerContext: trigger.description,
      userConfig: mergedConfig,
      usesAIBrowser,
      workDir,
      modelInfo: resolvedCreds.displayModel,
      autoSyncSessions,
    })

    console.log(
      `[Runtime][${runTag}] ── SYSTEM PROMPT ──────────────────────────\n` +
      systemPrompt +
      `\n[Runtime][${runTag}] ── END SYSTEM PROMPT ──────────────────────`
    )

    // ── 3. Build initial message ───────────────────────────
    //    Build memory snapshot for trigger-time injection.
    //    This gives the AI immediate memory context without a tool call.
    const memorySnapshot = await buildMemorySnapshot(memoryScope)
    console.log(
      `[Runtime][${runTag}] Memory snapshot: exists=${memorySnapshot.exists}, ` +
      `lines=${memorySnapshot.totalLines}, size=${memorySnapshot.sizeBytes}B, ` +
      `headers=${memorySnapshot.headers.length}, archive=${memorySnapshot.archiveTotalCount}`
    )

    // ── 3a. Pre-insert timestamp heading in # History ─────
    //    Gives the AI a ready-made heading to Edit with its summary.
    //    Uses the same YYYY-MM-DD-HHmm format as run file names.
    //    Reuses rawContent from the snapshot to avoid a redundant file read.
    const runTimestamp = formatRunTimestamp(new Date())
    await preInsertHistoryHeading(memorySnapshot.memoryFilePath, runTimestamp, memorySnapshot.rawContent)
    console.log(`[Runtime][${runTag}] Pre-inserted History heading: ## ${runTimestamp}`)

    // Resuming runs (continue or escalation follow-up) send minimal messages
    // so the model can resume naturally from its restored session context.
    // A full trigger message would interfere with the in-progress task state.
    const initialMessage = trigger.type === 'continue_followup'
      ? (trigger.continue?.userMessage ?? USER_CONTINUE_MESSAGE)
      : (trigger.type === 'escalation_followup' && existingRunId && trigger.escalation)
        ? buildEscalationResumeMessage(trigger.escalation)
        : buildInitialMessage({
            triggerContext: trigger.description,
            userConfig: mergedConfig,
            appName: app.spec.name,
            memorySnapshot,
          })

    console.log(
      `[Runtime][${runTag}] ── INITIAL MESSAGE ────────────────────────\n` +
      initialMessage +
      `\n[Runtime][${runTag}] ── END INITIAL MESSAGE ────────────────────`
    )

    // ── 3b. Create scoped browser context for this run ────
    //    Scoped context isolates activeViewId from user's interactive browser
    //    and other concurrent runs, while sharing the same session/cookies.
    scopedBrowserCtx = usesAIBrowser
      ? createScopedBrowserContext(null)
      : undefined

    // ── 4. Create MCP servers ──────────────────────────────
    //    Register the lightweight memory_status tool (structural metadata only).
    //    The AI uses native Read/Edit/Write on memory.md directly.
    const memoryMcpServer = createMemoryStatusMcpServer(memoryScope)

    // Resolve plans directory for file-based data_path guidance in report_to_user.
    // Uses the same CC config directory that the SDK session uses for consistency.
    const configDir = resolveClaudeConfigDir(config.agent?.configDirMode)
    const plansDir = join(configDir, 'plans')

    const reportContext: ReportToolContext = {
      appId: app.id,
      appName: app.spec.name,
      runId,
      sessionKey,
      notificationLevel: app.userOverrides.notificationLevel,
      plansDir,
    }

    const reportMcpServer = createReportToolServer(
      store,
      reportContext,
      (entryId: string) => {
        escalationEntryId = entryId
        console.log(`[Runtime] Escalation created: entry=${entryId}, app=${app.id}`)
      },
      emitEntry
    )

    // Create halo-notify MCP server for AI-driven notifications.
    // FileExportGate roots = the space's working directory (matches the AI's
    // cwd) + tmpdir. memoryScope.spacePath is intentionally NOT reused here:
    // memory lives under space.path (internal storage), while exportable
    // files live under workingDir||path — see getSpaceDir().
    const exportGate = new FileExportGate([getSpaceDir(app.spaceId!), tmpdir()])
    const imSessions = usesImPush
      ? (getImSessionRegistry()?.getAllSessions(app.id) ?? [])
      : []
    const notifyMcpServer = createNotifyToolServer({
      appId: app.id,
      appName: app.spec.name,
      runId,
      imSessions,
      usesImPush,
      exportGate,
    })

    // ── 5. Create V2 session ───────────────────────────────
    //    (credentials, electronPath, workDir resolved in step 1)

    // Create an abort controller that respects the external signal
    const abortController = new AbortController()
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort()
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true })
      }
    }

    // Resolve MCPs declared in requires.mcps from the installed apps database.
    // Only injects explicitly declared MCPs (least-privilege: automation gets only what it declares).
    // Automation apps always have a spaceId (enforced earlier in this function).
    const requiredMcpServers = getMcpServersForRequires(
      (app.spec.requires?.mcps as Array<{ id: string }> | undefined),
      app.spaceId!
    )

    const sdkOptions = buildBaseSdkOptions({
      credentials: resolvedCreds,
      workDir,
      electronPath,
      spaceId: app.spaceId!,
      conversationId: sessionKey, // Use session key as conversation ID
      stderrHandler: (data: string) => {
        console.error(`[Runtime][${app.id}] CLI stderr:`, data)
      },
      mcpServers: {
        ...requiredMcpServers,              // declared MCP dependencies
        'halo-memory': memoryMcpServer,     // built-in: persistent memory
        'halo-report': reportMcpServer,     // built-in: completion signal
        'halo-notify': notifyMcpServer,     // built-in: user notification
        'web-search': createWebSearchMcpServer(), // built-in: web search
        ...(usesAIBrowser ? { 'ai-browser': createAIBrowserMcpServer(scopedBrowserCtx, workDir) } : {}),
        ...(usesEmail && config.notificationChannels?.email?.enabled
          ? { 'halo-email': createEmailMcpServer(config.notificationChannels.email) }
          : {}),
      },
    })

    // Override SDK options for automation context
    sdkOptions.systemPrompt = systemPrompt
    sdkOptions.maxTurns = config.agent?.maxTurns ?? DEFAULT_MAX_TURNS
    // Token-level partials OFF: a run is headless and emits no renderer events,
    // so there is no live consumer for token frames. processStream persists one
    // aggregate block-level message (thinking / tool-call / tool-result / text) per
    // completed block to the run JSONL; the run-detail view reads that transcript
    // back by polling (see DESIGN.md §2.10), which is enough to watch a run's steps.
    sdkOptions.includePartialMessages = false
    // Enable extended thinking for automation runs (same as interactive chat)
    sdkOptions.maxThinkingTokens = 10240

    const mcpServerNames = sdkOptions.mcpServers ? Object.keys(sdkOptions.mcpServers) : []
    console.log(
      `[Runtime][${runTag}] Creating V2 session: workDir=${workDir}, ` +
      `promptLen=${systemPrompt.length}, maxTurns=${sdkOptions.maxTurns}, ` +
      `mcpServers=[${mcpServerNames.join(', ')}], aiBrowser=${usesAIBrowser}, email=${usesEmail}`
    )
    console.debug(`[Runtime][${runTag}] SDK options: model=${sdkOptions.model}, allowedTools=${(sdkOptions.allowedTools || []).length}, disallowedTools=${(sdkOptions.disallowedTools || []).length}, maxThinkingTokens=${sdkOptions.maxThinkingTokens}`)

    // Session creation strategy:
    //   escalation_followup / continue_followup → restore existing session via
    //     getOrCreateV2Session to recover full conversation context.
    //   All other triggers → create a fresh session.
    const escalationResumeId = trigger.escalation?.sessionId
    const continueResumeId = trigger.continue?.sessionId

    if (trigger.type === 'escalation_followup' && escalationResumeId) {
      console.log(`[Runtime][${runTag}] Restoring session for escalation followup: ${escalationResumeId}`)
      session = await getOrCreateV2Session(
        app.spaceId!,
        sessionKey,
        sdkOptions,
        escalationResumeId,
        undefined,
        workDir
      )
    } else if (trigger.type === 'continue_followup' && continueResumeId) {
      console.log(`[Runtime][${runTag}] Restoring session for user-initiated continue: ${continueResumeId}`)
      session = await getOrCreateV2Session(
        app.spaceId!,
        sessionKey,
        sdkOptions,
        continueResumeId,
        undefined,
        workDir
      )
    } else {
      if (trigger.type === 'continue_followup') {
        console.warn(`[Runtime][${runTag}] continue_followup has no sessionId — starting fresh session`)
      }
      session = await createSession(sdkOptions)
    }
    console.log(`[Runtime][${runTag}] V2 session created, sending initial message`)

    // ── 5b. Open session writer for "View process" ────────
    const spacePath = getSpace(app.spaceId!)?.path ?? ''
    let sessionWriter: SessionWriter | undefined
    if (spacePath) {
      sessionWriter = openSessionWriter(spacePath, app.id, runId)
      sessionWriter.writeTrigger(initialMessage)
    }

    // ── 5c. Make the run injectable ────────────────────────
    //    Registering in the active-run registry lets the run-detail input box
    //    inject a mid-run supplement (active-runs.ts): it writes the supplement to
    //    the run JSONL and pushes it into the live SDK session. The run itself is
    //    headless — it emits no renderer events; the run-detail view reads the JSONL.
    registerActiveRun({
      runId,
      appId: app.id,
      spaceId: app.spaceId!,
      session,
      writer: sessionWriter,
    })

    // ── 6. Process stream (headless: persist JSONL + detect report_to_user) ──
    let streamResult = await processStream(session, initialMessage, abortController, runTag, sessionWriter)

    // A free-text follow-up to an already-completed run (continue.interactive) is
    // a conversational turn: reply once and stop. The report_to_user auto-continue
    // enforcement below applies only to autonomous execution and the premature-error
    // "Continue" recovery — never to a chat follow-up, which must not be nagged.
    const isInteractiveFollowup =
      trigger.type === 'continue_followup' && trigger.continue?.interactive === true

    // report_to_user is the only completion signal; any other end (silent stop,
    // SDK is_error, transport failure) is transient and must be retried.
    let autoContinueCount = 0
    while (
      !isInteractiveFollowup &&
      !streamResult.reportToolCalled &&
      !abortController.signal.aborted &&
      autoContinueCount < MAX_AUTO_CONTINUES
    ) {
      autoContinueCount++

      console.log(
        `[Runtime][${runTag}] ⟳ Auto-continue #${autoContinueCount}/${MAX_AUTO_CONTINUES}: ` +
        `AI ended without calling report_to_user`
      )

      // Log the continue prompt to the session file for "View process" drill-down
      if (sessionWriter) {
        sessionWriter.writeTrigger(`[Auto-continue #${autoContinueCount}] ${AUTO_CONTINUE_FULL}`)
      }

      const nextResult = await processStream(session, AUTO_CONTINUE_FULL, abortController, runTag, sessionWriter)

      // Merge results: accumulate text and tokens, take latest flags
      streamResult = {
        finalText: streamResult.finalText + nextResult.finalText,
        totalTokens: streamResult.totalTokens + nextResult.totalTokens,
        aiReportedError: nextResult.aiReportedError,
        reportToolCalled: nextResult.reportToolCalled,
        sessionId: streamResult.sessionId || nextResult.sessionId,
      }
    }

    if (autoContinueCount > 0) {
      console.log(
        `[Runtime][${runTag}] Auto-continue finished: attempts=${autoContinueCount}, ` +
        `reportCalled=${streamResult.reportToolCalled}, ` +
        `error=${streamResult.aiReportedError}`
      )
    }

    // ── 7. Record completion ───────────────────────────────
    const finishedAt = Date.now()
    const durationMs = finishedAt - startedAt

    let finalStatus: RunStatus
    let outcome: AppRunResult['outcome']

    // Escalation is detected via the onEscalation callback closure,
    // which sets escalationEntryId when report_to_user(type="escalation") is called.
    if (escalationEntryId) {
      finalStatus = 'waiting_user'
      outcome = 'useful'
    } else if (streamResult.aiReportedError) {
      finalStatus = 'error'
      outcome = 'error'
    } else if (!streamResult.reportToolCalled && !isInteractiveFollowup) {
      // AI never called report_to_user despite auto-continue prompts —
      // treat as error so it shows in Activity Thread and counts toward
      // consecutive error tracking. Interactive chat follow-ups are exempt:
      // a conversational reply has nothing to report, so it completes normally.
      finalStatus = 'error'
      outcome = 'error'
      console.warn(
        `[Runtime][${runTag}] AI never called report_to_user after ` +
        `${autoContinueCount} auto-continue attempt(s) — marking as error`
      )
    } else {
      finalStatus = 'ok'
      outcome = streamResult.finalText.length > 0 ? 'useful' : 'noop'
    }

    store.completeRun(runId, {
      status: finalStatus,
      finishedAt,
      durationMs,
      tokensUsed: streamResult.totalTokens || undefined,
    })

    // Persist the CC session id for every outcome. The subprocess is closed in
    // `finally` to free resources, but the on-disk session stays resumable — this
    // is what lets a user reopen a finished run and keep talking to it with full
    // context (escalation reply, "Continue", or a free-text follow-up correction).
    if (streamResult.sessionId) {
      store.updateRunSessionId(runId, streamResult.sessionId)
      console.log(
        `[Runtime][${runTag}] Session ID saved for resume (${finalStatus}): ${streamResult.sessionId}`
      )
    }

    // Insert an error activity entry when AI never called report_to_user,
    // so the failure is visible in the Activity Thread.
    if (outcome === 'error' && !streamResult.reportToolCalled && !escalationEntryId) {
      const noReportEntry: ActivityEntry = {
        id: randomUUID(),
        appId: app.id,
        runId,
        type: 'run_error',
        ts: finishedAt,
        sessionKey,
        content: {
          summary: `AI ended without reporting results after ${autoContinueCount} auto-continue attempt(s). ` +
            'The model may have encountered an issue or exhausted its context.',
          status: 'error',
          durationMs,
          error: 'report_to_user not called',
        },
      }
      try {
        emitEntry ? emitEntry(noReportEntry) : store.insertEntry(noReportEntry)
      } catch (insertErr) {
        console.error('[Runtime] Failed to insert no-report error entry:', insertErr)
      }
    }

    console.log(
      `[Runtime][${runTag}] ✓ Run completed: outcome=${outcome}, status=${finalStatus}, ` +
      `duration=${durationMs}ms, tokens=${streamResult.totalTokens}, ` +
      `textLen=${streamResult.finalText.length}, ` +
      `escalation=${escalationEntryId ? 'yes' : 'no'}`
    )

    // ── 7b. Auto-sync result to subscribed IM contacts ────
    //    Fires only on a clean completion (no escalation, no error). The
    //    function internally short-circuits when no contacts have been
    //    subscribed, so the call is cheap and safe to make unconditionally
    //    on success.
    if (finalStatus === 'ok') {
      await autoSyncRunResult({
        appId: app.id,
        appName: app.spec.name,
        runId,
        finalText: streamResult.finalText,
        runTag,
      })
    }

    // ── 7c. Save session summary to memory ────────────────
    await saveRunSessionSummary(memory, memoryScope, {
      appName: app.spec.name,
      runId,
      trigger,
      outcome,
      durationMs,
      tokensUsed: streamResult.totalTokens,
      finalText: streamResult.finalText,
      escalation: !!escalationEntryId,
      runTag,
    })

    // ── 7d. Check if memory needs compaction ─────────────
    await checkAndCompactMemory(memory, memoryScope, app, runTag)

    return {
      appId: app.id,
      runId,
      sessionKey,
      outcome,
      startedAt,
      finishedAt,
      durationMs,
      tokensUsed: streamResult.totalTokens || undefined,
      finalText: streamResult.finalText || undefined,
    }
  } catch (err) {
    const finishedAt = Date.now()
    const durationMs = finishedAt - startedAt
    const errorMessage = err instanceof Error ? err.message : String(err)

    console.error(`[Runtime][${runTag}] ✗ Run failed: app=${app.id}, duration=${durationMs}ms:`, err)

    // Record failure
    store.completeRun(runId, {
      status: 'error',
      finishedAt,
      durationMs,
      errorMessage,
    })

    // Insert a run_error activity entry so it shows in the Activity Thread
    const errorEntry: ActivityEntry = {
      id: randomUUID(),
      appId: app.id,
      runId,
      type: 'run_error',
      ts: finishedAt,
      sessionKey,
      content: {
        summary: `Run failed: ${errorMessage}`,
        status: 'error',
        durationMs,
        error: errorMessage,
      },
    }

    try {
      emitEntry ? emitEntry(errorEntry) : store.insertEntry(errorEntry)
    } catch (insertErr) {
      console.error('[Runtime] Failed to insert error activity entry:', insertErr)
    }

    // Save error session summary to memory
    await saveRunSessionSummary(memory, memoryScope, {
      appName: app.spec.name,
      runId,
      trigger,
      outcome: 'error',
      durationMs,
      tokensUsed: 0,
      finalText: `Error: ${errorMessage}`,
      escalation: false,
      runTag,
    })

    return {
      appId: app.id,
      runId,
      sessionKey,
      outcome: 'error',
      startedAt,
      finishedAt,
      durationMs,
      errorMessage,
    }
  } finally {
    // ── 8. Stop accepting injections ───────────────────────
    //    Unregister BEFORE closing the session so a late injection can't push into
    //    a closing session. No renderer event is emitted here: runs are headless.
    //    The run-detail view detects completion from the app runtime status
    //    (broadcast separately by the service) and reloads the JSONL transcript.
    unregisterActiveRun(runId)

    // ── 9. Close session ────────────────────────────────────
    // Always close the session. Escalation follow-up recovers context
    // via CC's disk-based resume (sessionId), not process reuse.
    if (session) {
      try {
        session.close()
        console.log(`[Runtime][${runTag}] Session closed`)
      } catch (closeErr) {
        console.error(`[Runtime] Failed to close session: run=${runId}:`, closeErr)
      }
    }

    // ── 10. Destroy scoped browser context (cleans up owned views) ──
    if (scopedBrowserCtx) {
      scopedBrowserCtx.destroy()
      console.log(`[Runtime][${runTag}] Scoped browser context destroyed`)
    }
  }
}

// ============================================
// Stream Processing
// ============================================

/**
 * Process the V2 session stream for a headless automation run.
 *
 * Runs are headless: this loop consumes the SDK stream to (a) persist each
 * assistant/user message to the run JSONL (the run-detail view reads it back via
 * app:get-session), (b) detect the `report_to_user` completion signal, and
 * (c) collect the final text, token usage, and CC session id. It deliberately
 * emits NO `agent:*` renderer events — watching a run is a read over its JSONL
 * transcript (SessionDetailView polls), not a live event subscription. This keeps
 * the unwatched majority of runs (up to maxConcurrent at once) off the renderer
 * event path entirely. `includePartialMessages` is false, so only aggregate
 * block-level messages arrive — one JSONL append per completed block.
 *
 * Returns the StreamResult shape the completion logic in executeRun expects.
 */
async function processStream(
  session: any,
  message: string,
  abortController: AbortController,
  runTag: string,
  writer?: SessionWriter
): Promise<StreamResult> {
  const result: StreamResult = {
    finalText: '',
    totalTokens: 0,
    aiReportedError: false,
    reportToolCalled: false,
  }

  session.send(message)

  let messageCount = 0
  let toolUseCount = 0

  try {
    for await (const sdkMessage of session.stream()) {
      if (abortController.signal.aborted) {
        console.log(`[Runtime][${runTag}] Run aborted during stream processing`)
        break
      }
      if (!sdkMessage || typeof sdkMessage !== 'object') continue

      const msgType = (sdkMessage as { type?: string }).type
      messageCount++

      // Persist assistant/user messages to the run JSONL for "View process" reload.
      // (No stream_event frames arrive — partials are off.)
      if (writer && (msgType === 'assistant' || msgType === 'user')) {
        writer.writeEvent(sdkMessage as Record<string, unknown>)
      }

      if (msgType === 'assistant') {
        const content = (sdkMessage as any).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              result.finalText += block.text
            }
            if (block.type === 'tool_use') {
              toolUseCount++
              // report_to_user (MCP name: mcp__halo-report__report_to_user) is the
              // definitive completion signal for automation runs.
              if (typeof block.name === 'string' && block.name.includes('report_to_user')) {
                result.reportToolCalled = true
              }
            }
          }
        }
      }

      if (msgType === 'result') {
        const m = sdkMessage as any
        if (m.usage) {
          result.totalTokens = (m.usage.input_tokens || 0) + (m.usage.output_tokens || 0)
        }
        if (m.cumulative_usage) {
          result.totalTokens =
            (m.cumulative_usage.input_tokens || 0) + (m.cumulative_usage.output_tokens || 0)
        }
        if (m.is_error || m.error_during_execution) {
          result.aiReportedError = true
          console.warn(`[Runtime][${runTag}] AI reported error in result message`)
        }
      }

      // Capture the CC session id so a user can later resume / continue this run.
      if (msgType === 'system' && (sdkMessage as any).subtype === 'init' && (sdkMessage as any).session_id) {
        result.sessionId = (sdkMessage as any).session_id
      }
    }
  } catch (streamErr) {
    if (abortController.signal.aborted) {
      console.log(`[Runtime][${runTag}] Stream aborted (expected)`)
    } else {
      console.error(`[Runtime][${runTag}] Stream processing error:`, streamErr)
      throw new RunExecutionError(
        'unknown',
        'unknown',
        streamErr instanceof Error ? streamErr.message : String(streamErr)
      )
    }
  }

  console.log(
    `[Runtime][${runTag}] Stream cycle finished: messages=${messageCount}, ` +
    `toolCalls=${toolUseCount}, textLen=${result.finalText.length}, ` +
    `reportToolCalled=${result.reportToolCalled}`
  )

  return result
}

// ============================================
// Session Summary
// ============================================

/** Max length for the summary content written to memory */
const MAX_SUMMARY_LENGTH = 2000

/** Parameters for building a session summary */
interface RunSummaryContext {
  appName: string
  runId: string
  trigger: TriggerContext
  outcome: AppRunResult['outcome']
  durationMs: number
  tokensUsed: number
  finalText: string
  escalation: boolean
  runTag: string
}

/**
 * Save a session summary to the app's memory archive.
 *
 * Generates a concise markdown summary from the run context and writes it
 * to memory/{date}-{slug}.md via MemoryService.saveSessionSummary().
 * This is a best-effort operation -- failures are logged but not re-thrown.
 */
async function saveRunSessionSummary(
  memory: MemoryService,
  scope: MemoryCallerScope,
  ctx: RunSummaryContext
): Promise<void> {
  // Skip noop runs -- they have no meaningful content to summarize
  if (ctx.outcome === 'noop') {
    console.log(`[Runtime][${ctx.runTag}] Skipping session summary (noop run)`)
    return
  }

  try {
    const summaryContent = buildSummaryContent(ctx)
    const slug = buildSummarySlug(ctx)

    await memory.saveSessionSummary(scope, 'app', { content: summaryContent, slug })
    console.log(`[Runtime][${ctx.runTag}] Session summary saved (slug=${slug})`)
  } catch (err) {
    // Best-effort: do not fail the run if summary write fails
    console.error(`[Runtime][${ctx.runTag}] Failed to save session summary:`, err)
  }
}

/**
 * Build a concise markdown summary from the run context.
 */
function buildSummaryContent(ctx: RunSummaryContext): string {
  const lines: string[] = []

  lines.push(`**App:** ${ctx.appName}`)
  lines.push(`**Trigger:** ${ctx.trigger.type}`)
  lines.push(`**Outcome:** ${ctx.outcome}`)
  lines.push(`**Duration:** ${ctx.durationMs}ms`)

  if (ctx.tokensUsed > 0) {
    lines.push(`**Tokens:** ${ctx.tokensUsed}`)
  }

  if (ctx.escalation) {
    lines.push(`**Escalation:** yes`)
  }

  // Include the AI's output (truncated to keep file sizes manageable)
  if (ctx.finalText.trim()) {
    const truncated = ctx.finalText.length > MAX_SUMMARY_LENGTH
      ? ctx.finalText.slice(0, MAX_SUMMARY_LENGTH) + '\n\n*(truncated)*'
      : ctx.finalText
    lines.push('')
    lines.push('## Output')
    lines.push('')
    lines.push(truncated)
  }

  return lines.join('\n')
}

/**
 * Generate a filename slug from the run context.
 * Produces slugs like "run-daily-report" or "run-error".
 */
function buildSummarySlug(ctx: RunSummaryContext): string {
  const prefix = ctx.outcome === 'error' ? 'error' : 'run'
  // Use first few words of the app name for a human-readable slug
  const appSlug = ctx.appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30)
  return `${prefix}-${appSlug}`
}

// ============================================
// Memory Compaction
// ============================================

/** Max content length to send for LLM compaction (to control token usage) */
const MAX_COMPACTION_INPUT_LENGTH = 50000

/**
 * Max LLM output tokens for compaction.
 *
 * Set deliberately high so the model is never the truncation constraint.
 * Actual output length is guided by prompt instructions (target 60-120 lines),
 * not by this limit. A hard cutoff would produce malformed markdown.
 */
const COMPACTION_MAX_TOKENS = 16384

/** Max retry attempts when LLM output fails format validation */
const COMPACTION_MAX_RETRIES = 2

/**
 * Check if app memory needs compaction and perform it if necessary.
 *
 * Flow:
 * 1. Check if memory.md exceeds the compaction threshold (100KB)
 * 2. Read the current content before archiving
 * 3. Archive the old memory.md to memory/ directory
 * 4. Generate a concise LLM summary with format validation and retry
 * 5. Write the summary as the new memory.md
 *
 * This is a best-effort operation -- failures are logged but not re-thrown.
 */
async function checkAndCompactMemory(
  memory: MemoryService,
  scope: MemoryCallerScope,
  app: InstalledApp,
  runTag: string
): Promise<void> {
  try {
    const needsCompaction = await memory.needsCompaction(scope, 'app')
    if (!needsCompaction) return

    console.log(`[Runtime][${runTag}] Memory compaction triggered for app=${app.id}`)

    // Read the current content BEFORE archiving (so we can summarize it)
    const currentContent = await memory.read(scope, { scope: 'app', mode: 'full' })
    if (!currentContent) {
      console.log(`[Runtime][${runTag}] Memory file empty/missing, skipping compaction`)
      return
    }

    // Archive the old memory.md
    const { archived, needsSummary } = await memory.compact(scope, 'app')
    if (!needsSummary) {
      console.log(`[Runtime][${runTag}] Compaction complete, no summary needed`)
      return
    }

    console.log(`[Runtime][${runTag}] Memory archived to ${archived}, generating LLM summary...`)

    // Generate compaction summary via LLM (with validation + retry)
    const summary = await generateCompactionSummary(
      currentContent,
      app.spec.name,
      app,
      runTag
    )

    // Write the summary as the new memory.md
    await memory.write(scope, {
      scope: 'app',
      content: summary,
      mode: 'replace'
    })

    console.log(
      `[Runtime][${runTag}] Memory compacted: ` +
      `old=${(currentContent.length / 1024).toFixed(1)}KB → ` +
      `new=${(summary.length / 1024).toFixed(1)}KB`
    )
  } catch (err) {
    // Best-effort: compaction failure should not break the run
    console.error(`[Runtime][${runTag}] Memory compaction failed:`, err)
  }
}

/**
 * Validate that compacted memory contains the two mandatory H1 headings.
 *
 * Both `# now` and `# History` must appear as standalone H1 lines.
 * Without them, downstream functions (preInsertHistoryHeading, snapshot
 * injection) will produce corrupt state.
 */
function isValidCompaction(content: string): boolean {
  return /^# now\s*$/m.test(content) && /^# History\s*$/m.test(content)
}

/** Build the compaction prompt for the LLM */
function buildCompactionPrompt(content: string, appName: string): string {
  return (
    `You are compacting the memory file for an automation app called "${appName}".\n\n` +
    `## Current Memory Content\n\n${content}\n\n` +
    `## Output Format\n\n` +
    `You MUST produce output in exactly this structure:\n\n` +
    '```\n' +
    `# now\n\n` +
    `## State | one-line summary\n` +
    `(current state values only — drop stale/superseded entries)\n\n` +
    `## EntityName\n` +
    `(active entities only — merge duplicates, drop entities not seen recently)\n\n` +
    `## Patterns\n` +
    `(proven patterns only — drop one-off observations)\n\n` +
    `## Errors\n` +
    `(unresolved errors only — drop resolved ones)\n\n` +
    `# History\n\n` +
    `## YYYY-MM-DD-HHmm | summary\n` +
    `(keep the most recent ~10 entries, drop older ones)\n` +
    '```\n\n' +
    `## Rules\n\n` +
    `- Output ONLY the compacted markdown, no explanations or commentary\n` +
    `- Every entry in \`# now\` must be current and actionable\n` +
    `- Aim for roughly 60–120 lines total\n` +
    `- Both \`# now\` and \`# History\` H1 headings are MANDATORY — never omit them\n` +
    `- Preserve the original entity names and data values exactly\n` +
    `- Older History entries are already archived in memory/run/ files, safe to drop`
  )
}

/**
 * Generate a concise summary of memory content via direct LLM API call,
 * with format validation and multi-turn retry.
 *
 * Flow:
 * 1. Send compaction prompt to LLM
 * 2. Validate output contains `# now` and `# History`
 * 3. If invalid, retry with feedback (up to COMPACTION_MAX_RETRIES times)
 * 4. After all retries exhausted, keep the last LLM output as-is
 * 5. Only fall back to code-based extraction on API-level failures
 *
 * Uses the @anthropic-ai/sdk client directly (not a full SDK session) for
 * minimal overhead. The call goes through the resolved credentials so it
 * works with all provider types (Anthropic, OpenAI-compat, OAuth).
 */
async function generateCompactionSummary(
  content: string,
  appName: string,
  app: InstalledApp,
  runTag: string
): Promise<string> {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const config = getConfig()
    const credentials = app.userOverrides?.modelSourceId
      ? await getApiCredentialsForSource(config, app.userOverrides.modelSourceId, app.userOverrides.modelId)
      : await getApiCredentials(config)
    const resolved = await resolveCredentialsForSdk(credentials)

    // Truncate input if too large
    const truncatedContent = content.length > MAX_COMPACTION_INPUT_LENGTH
      ? content.slice(0, MAX_COMPACTION_INPUT_LENGTH) + '\n\n... (truncated)'
      : content

    const client = new Anthropic({
      apiKey: resolved.anthropicApiKey,
      baseURL: resolved.anthropicBaseUrl,
    })

    const prompt = buildCompactionPrompt(truncatedContent, appName)

    // Build conversation for multi-turn retry
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: prompt },
    ]

    let lastOutput = ''

    // Attempt 1 + up to COMPACTION_MAX_RETRIES retries
    for (let attempt = 0; attempt <= COMPACTION_MAX_RETRIES; attempt++) {
      const response = await client.messages.create({
        model: resolved.sdkModel,
        max_tokens: COMPACTION_MAX_TOKENS,
        messages,
      })

      const output = response.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('')

      if (output.trim().length === 0) {
        console.warn(`[Runtime][${runTag}] Compaction attempt ${attempt + 1}: LLM returned empty output`)
        // On empty output, don't retry — go to fallback
        break
      }

      lastOutput = output

      if (isValidCompaction(output)) {
        if (attempt > 0) {
          console.log(`[Runtime][${runTag}] Compaction succeeded on retry ${attempt}`)
        }
        return output
      }

      // Validation failed — log and prepare retry
      console.warn(
        `[Runtime][${runTag}] Compaction attempt ${attempt + 1}: ` +
        `output missing required headings (has # now: ${/^# now\s*$/m.test(output)}, ` +
        `has # History: ${/^# History\s*$/m.test(output)})`
      )

      if (attempt < COMPACTION_MAX_RETRIES) {
        // Add the failed output as assistant message, then feedback as user message
        messages.push({ role: 'assistant', content: output })
        messages.push({
          role: 'user',
          content:
            'Your output is missing the required H1 headings. ' +
            'The compacted memory MUST contain both `# now` and `# History` as H1 headings ' +
            '(lines starting with exactly `# now` and `# History`). ' +
            'Please output the corrected compacted memory.',
        })
      }
    }

    // All attempts exhausted: use last LLM output if we have one, otherwise fallback
    if (lastOutput.trim().length > 0) {
      console.warn(
        `[Runtime][${runTag}] Compaction retries exhausted, ` +
        `keeping last LLM output (${lastOutput.length} chars)`
      )
      return lastOutput
    }

    console.warn(`[Runtime][${runTag}] LLM returned no usable output, using fallback`)
    return buildFallbackCompactionSummary(content)
  } catch (err) {
    console.error(`[Runtime][${runTag}] LLM compaction failed, using fallback:`, err)
    return buildFallbackCompactionSummary(content)
  }
}

/**
 * Fallback compaction when LLM API is completely unavailable.
 *
 * Extracts the `# now` and `# History` sections from the original content
 * and produces a valid two-tier structure. This ensures downstream functions
 * (preInsertHistoryHeading, snapshot injection) continue to work correctly.
 *
 * Strategy:
 * - `# now` block: first 50 content lines (up to `# History`)
 * - `# History` block: last 10 `## YYYY-` timestamped entry groups
 */
function buildFallbackCompactionSummary(content: string): string {
  const lines = content.split('\n')

  // ── Extract # now section ──────────────────────────────────
  let nowStart = -1
  let nowEnd = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (/^# now\s*$/.test(lines[i])) {
      nowStart = i
    } else if (nowStart >= 0 && /^# [^#]/.test(lines[i]) && !/^# now\s*$/.test(lines[i])) {
      // Hit another H1 heading — end of # now
      nowEnd = i
      break
    }
  }

  let nowLines: string[]
  if (nowStart >= 0) {
    // Take the # now section, capped at 50 content lines
    const sectionLines = lines.slice(nowStart, nowEnd)
    nowLines = sectionLines.slice(0, 51) // # now heading + up to 50 lines
  } else {
    // No # now found — create a minimal skeleton
    nowLines = ['# now', '', '## State']
  }

  // ── Extract recent # History entries ───────────────────────
  let historyStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^# History\s*$/.test(lines[i])) {
      historyStart = i
      break
    }
  }

  const historyEntries: string[][] = []
  if (historyStart >= 0) {
    let currentEntry: string[] = []
    for (let i = historyStart + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i])) {
        if (currentEntry.length > 0) {
          historyEntries.push(currentEntry)
        }
        currentEntry = [lines[i]]
      } else if (currentEntry.length > 0) {
        currentEntry.push(lines[i])
      }
    }
    if (currentEntry.length > 0) {
      historyEntries.push(currentEntry)
    }
  }

  // Keep last 10 entries (they are newest-first in the file)
  const recentEntries = historyEntries.slice(0, 10)

  // ── Assemble valid output ──────────────────────────────────
  const parts = [
    '<!-- Compacted by system (LLM unavailable) -->',
    '',
    ...nowLines,
    '',
    '# History',
    '',
    ...recentEntries.flatMap(entry => [...entry, '']),
  ]

  return parts.join('\n').trimEnd() + '\n'
}

// ============================================
// History Heading Pre-insertion
// ============================================

/**
 * Format a Date as YYYY-MM-DD-HHmm (local time, no colons).
 * This format is used consistently for:
 * - # History headings in memory.md
 * - Run file names in memory/run/
 * - Compaction archive file names
 */
function formatRunTimestamp(date: Date): string {
  const y = date.getFullYear()
  const m = (date.getMonth() + 1).toString().padStart(2, '0')
  const d = date.getDate().toString().padStart(2, '0')
  const h = date.getHours().toString().padStart(2, '0')
  const min = date.getMinutes().toString().padStart(2, '0')
  return `${y}-${m}-${d}-${h}${min}`
}

/**
 * Pre-insert a timestamp heading at the top of # History in memory.md.
 *
 * If the file doesn't exist, creates a skeleton with # now and # History.
 * If # History section exists, inserts ## YYYY-MM-DD-HHmm right after it.
 * If # History doesn't exist (old format), appends it at the end.
 *
 * @param memoryFilePath - Absolute path to memory.md
 * @param timestamp - Formatted run timestamp (YYYY-MM-DD-HHmm)
 * @param preReadContent - Pre-read file content from the snapshot, or null if file doesn't exist.
 *                         Avoids a redundant disk read when the caller already has the content.
 */
async function preInsertHistoryHeading(
  memoryFilePath: string,
  timestamp: string,
  preReadContent: string | null
): Promise<void> {
  const { readFile, writeFile, mkdir } = await import('fs/promises')
  const { dirname } = await import('path')
  const { existsSync } = await import('fs')

  const dir = dirname(memoryFilePath)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }

  const heading = `## ${timestamp}`

  if (preReadContent === null) {
    // Create skeleton with # now and # History
    const skeleton = `# now\n\n## State\n\n# History\n\n${heading}\n`
    await writeFile(memoryFilePath, skeleton, 'utf-8')
    return
  }

  const content = preReadContent

  // Find # History line
  const historyMatch = content.match(/^# History\s*$/m)
  if (historyMatch && historyMatch.index !== undefined) {
    // Insert the new heading right after "# History\n"
    const insertPos = historyMatch.index + historyMatch[0].length
    const before = content.slice(0, insertPos)
    const after = content.slice(insertPos)
    const newContent = before + `\n\n${heading}` + after
    await writeFile(memoryFilePath, newContent, 'utf-8')
  } else {
    // No # History section found — append it
    const appendContent = content.trimEnd() + `\n\n# History\n\n${heading}\n`
    await writeFile(memoryFilePath, appendContent, 'utf-8')
  }
}
