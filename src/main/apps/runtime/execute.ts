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
import { createMemoryStatusMcpServer } from '../../platform/memory/snapshot'
import type { ActivityStore } from './store'
import type {
  TriggerContext,
  AppRunResult,
  RunStatus,
  ActivityEntry,
} from './types'
import { RunExecutionError } from './errors'
import { buildAppSystemPrompt, buildInitialMessage, buildEscalationResumeMessage } from './prompt'
import { buildDisabledCapabilitiesGuidance, buildUnconfiguredCapabilitiesGuidance } from './prompt/capabilities'
import { resolveNotifyAvailability } from './notify-availability'
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
import { createTerminalMcpServer, getGlobalTerminalContext, isTerminalAvailable } from '../../services/ai-terminal'
import { createWebSearchMcpServer } from '../../services/web-search'
import { createOcrMcpServer } from '../../services/ocr'
import { createEmailMcpServer } from '../../services/email-mcp'
import { getConfig, resolveClaudeConfigDir } from '../../foundation/config.service'
import { getSpace, getSpaceDir } from '../../services/space.service'
import { openSessionWriter, type SessionWriter } from './session-store'
import { prepareMemoryForTurn, finalizeMemoryAfterTurn, type CompactionCredentialsProvider } from './turn/memory-lifecycle'
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
    const memoryInstructions = memory.getPromptInstructions('run')
    const usesAIBrowser = resolvePermission(app, 'ai-browser')
    const usesTerminal = resolvePermission(app, 'ai-terminal') && isTerminalAvailable()
    const usesEmail = resolvePermission(app, 'email') // gated on channel config below
    const usesImPush = resolvePermission(app, 'im-push') // AI-driven IM push

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

    // Pushable IM contacts + notify availability. Resolved before the prompt so
    // capability-awareness and notification guidance reflect the real tool set;
    // reused for the notify MCP server below (one registry lookup).
    const imSessions = usesImPush
      ? (getImSessionRegistry()?.getPushableSessions(app.id) ?? [])
      : []
    const notifyAvail = resolveNotifyAvailability(app, config.notificationChannels, imSessions)

    const systemPrompt = buildAppSystemPrompt({
      appId: app.id,
      appSpec: app.spec,
      memoryInstructions,
      triggerContext: trigger.description,
      userConfig: mergedConfig,
      usesAIBrowser,
      usesTerminal,
      workDir,
      modelInfo: resolvedCreds.displayModel,
      autoSyncSessions,
      disabledCapabilities: buildDisabledCapabilitiesGuidance(app) ?? undefined,
      unconfiguredCapabilities: buildUnconfiguredCapabilitiesGuidance(app, {
        emailChannelConfigured: notifyAvail.emailChannelConfigured,
        imContactsAvailable: notifyAvail.imContactsAvailable,
      }) ?? undefined,
      notifyToolsAvailable: notifyAvail.anyNotifyToolAvailable,
    })

    console.log(
      `[Runtime][${runTag}] ── SYSTEM PROMPT ──────────────────────────\n` +
      systemPrompt +
      `\n[Runtime][${runTag}] ── END SYSTEM PROMPT ──────────────────────`
    )

    // ── 3. Build initial message ───────────────────────────
    //    Build memory snapshot + pre-insert History heading.
    const { snapshot: memorySnapshot, runTimestamp } = await prepareMemoryForTurn(memoryScope)
    console.log(
      `[Runtime][${runTag}] Memory snapshot: exists=${memorySnapshot.exists}, ` +
      `lines=${memorySnapshot.totalLines}, size=${memorySnapshot.sizeBytes}B, ` +
      `headers=${memorySnapshot.headers.length}, archive=${memorySnapshot.archiveTotalCount}`
    )
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
      ? createScopedBrowserContext()
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
    const notifyMcpServer = createNotifyToolServer({
      appId: app.id,
      appName: app.spec.name,
      runId,
      imSessions,
      usesImPush,
      exportGate,
      // Relay provenance: automation runs act for the owner and have no human
      // subject; the trigger description gives the recipient AI the push context.
      relay: {
        sessionKey,
        isOwner: true,
        quote: trigger.description,
      },
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
      app.spec.requires?.mcps,
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
      // Built-in server ids below are mirrored in shared/apps/builtin-mcp.ts — keep in sync.
      mcpServers: {
        ...requiredMcpServers,              // declared MCP dependencies
        'halo-memory': memoryMcpServer,     // built-in: persistent memory
        'halo-report': reportMcpServer,     // built-in: completion signal
        'halo-notify': notifyMcpServer,     // built-in: user notification
        'web-search': createWebSearchMcpServer(), // built-in: web search
        'ocr': createOcrMcpServer(),              // built-in: on-device image OCR
        ...(usesAIBrowser ? { 'ai-browser': createAIBrowserMcpServer(scopedBrowserCtx, workDir) } : {}),
        ...(usesTerminal
          ? { 'ai-terminal': createTerminalMcpServer(getGlobalTerminalContext(workDir), { spaceId: app.spaceId!, workDir }) }
          : {}),
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

    // No displayModel: automation runs drive their own processStream(), so they
    // must not start a persistent session consumer (that would fight over the
    // stream). workDir is the 5th positional arg — passing it as displayModel
    // would silently spawn a consumer.
    if (trigger.type === 'escalation_followup' && escalationResumeId) {
      console.log(`[Runtime][${runTag}] Restoring session for escalation followup: ${escalationResumeId}`)
      session = await getOrCreateV2Session(
        app.spaceId!,
        sessionKey,
        sdkOptions,
        escalationResumeId,
        workDir
      )
    } else if (trigger.type === 'continue_followup' && continueResumeId) {
      console.log(`[Runtime][${runTag}] Restoring session for user-initiated continue: ${continueResumeId}`)
      session = await getOrCreateV2Session(
        app.spaceId!,
        sessionKey,
        sdkOptions,
        continueResumeId,
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

    // ── 7c. Save session summary + size-guarded compaction ─
    await finalizeMemoryAfterTurn(memory, memoryScope, {
      appName: app.spec.name,
      runId,
      trigger,
      outcome,
      durationMs,
      tokensUsed: streamResult.totalTokens,
      finalText: streamResult.finalText,
      escalation: !!escalationEntryId,
      runTag,
    }, buildCompactionCreds(app))

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

    // Save error session summary to memory (no compaction on the error path)
    await finalizeMemoryAfterTurn(memory, memoryScope, {
      appName: app.spec.name,
      runId,
      trigger,
      outcome: 'error',
      durationMs,
      tokensUsed: 0,
      finalText: `Error: ${errorMessage}`,
      escalation: false,
      runTag,
    }, buildCompactionCreds(app), { saveSessionSummary: true, compact: false })

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

// ── Compaction credentials ───────────────────────────────────────────────────

function buildCompactionCreds(app: InstalledApp): CompactionCredentialsProvider {
  return async () => {
    const config = getConfig()
    const credentials = app.userOverrides?.modelSourceId
      ? await getApiCredentialsForSource(config, app.userOverrides.modelSourceId, app.userOverrides.modelId)
      : await getApiCredentials(config)
    const resolved = await resolveCredentialsForSdk(credentials)
    return {
      anthropicApiKey: resolved.anthropicApiKey,
      anthropicBaseUrl: resolved.anthropicBaseUrl,
      sdkModel: resolved.sdkModel,
    }
  }
}
