/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Agent Module - Session Manager
 *
 * Manages V2 Session lifecycle including creation, reuse, cleanup,
 * and invalidation on config changes.
 *
 * V2 Session enables process reuse: subsequent messages in the same conversation
 * reuse the running CC process, avoiding process restart each time (cold start ~3-5s).
 */

import path from 'path'
import os from 'os'
import { existsSync, copyFileSync, mkdirSync } from 'fs'
import { app } from 'electron'
import { createSession } from './resolved-sdk'
import { getConfig, onApiConfigChange, getCredentialsGeneration } from '../../foundation/config.service'
import { getConversation } from '../conversation.service'
import type {
  V2SDKSession,
  V2SessionInfo,
  SessionConfig,
  SessionState,
} from './types'
import {
  getHeadlessElectronPath,
  getWorkingDir,
  getApiCredentials,
  getDbMcpServers
} from './helpers'
import { isImSessionKey } from '../../../shared/apps/im-keys'
import { emitAgentEvent } from './events'
import { registerProcess, unregisterProcess, getCurrentInstanceId } from '../health'
import { resolveCredentialsForSdk, buildBaseSdkOptions } from './sdk-config'
import { createHaloAppsMcpServer } from '../app-bridge'
import { createWebSearchMcpServer } from '../web-search'
import { startConsumer, type ConsumerHandle } from './session-consumer'
import { hasActiveTeamTasks } from './subagent-handler'

// ============================================
// Session Maps
// ============================================

/**
 * Active sessions map: conversationId -> SessionState
 * Tracks in-flight requests with abort controllers and accumulated thoughts.
 * Used by legacy callers (app-chat.ts, execute.ts). Consumer-based chat
 * conversations use the `consumers` map instead.
 */
export const activeSessions = new Map<string, SessionState>()

/**
 * V2 Sessions map: conversationId -> V2SessionInfo
 * Persistent sessions that can be reused across multiple messages
 */
export const v2Sessions = new Map<string, V2SessionInfo>()

/**
 * Consumer handles map: conversationId -> ConsumerHandle
 * Persistent REPL consumers that run for the lifetime of a V2 session.
 * Created alongside V2 sessions (for chat conversations only, not automation apps).
 */
const consumers = new Map<string, ConsumerHandle>()

/**
 * Sessions that should be invalidated after current in-flight request finishes
 * (e.g., model switch during streaming). For legacy callers (app-chat/execute).
 */
const pendingInvalidations = new Set<string>()

/**
 * Consumer sessions that should be rebuilt after current turn completes.
 * When API config changes during an active consumer turn, we mark it here
 * instead of killing the session mid-turn. The consumer checks this flag
 * after each turn and breaks its loop, triggering rebuild on next sendMessage.
 */
const pendingConsumerRebuilds = new Set<string>()

/**
 * Check if a session is busy (has an in-flight request).
 * Covers both legacy activeSessions (app-chat/execute) and
 * consumer-based chat conversations.
 */
function isSessionBusy(conversationId: string): boolean {
  if (activeSessions.has(conversationId)) return true
  const consumer = consumers.get(conversationId)
  if (!consumer?.isRunning) return false
  // Actively processing a turn — definitely busy.
  if (consumer.getActiveSessionState()) return true
  // Consumer is idle between turns (waiting in stream()), but the CC subprocess
  // may still have team agents running. Their results will arrive as a future turn.
  // Treat such sessions as busy to prevent the 30-min cleanup from killing them.
  return hasActiveTeamTasks(consumer.getLastTurnThoughts())
}

// ============================================
// Session Cleanup Helper
// ============================================

/**
 * Clean up a single V2 session: close, unregister, remove from map.
 *
 * This is the single source of truth for session cleanup logic.
 * All cleanup paths should use this function to ensure consistency.
 *
 * @param conversationId - Conversation ID to clean up
 * @param reason - Reason for cleanup (for logging)
 * @param skipMapCheck - If true, skip checking if session exists in map (for batch operations)
 */
function cleanupSession(conversationId: string, reason: string, skipMapCheck = false): void {
  const info = v2Sessions.get(conversationId)
  if (!info && !skipMapCheck) return

  console.log(`[Agent][${conversationId}] Cleaning up session: ${reason}`, new Error('cleanupSession caller trace').stack)

  // Stop the persistent consumer first (if any)
  const consumer = consumers.get(conversationId)
  if (consumer) {
    consumer.stop()
    consumers.delete(conversationId)
    console.log(`[Agent][${conversationId}] Consumer stopped during cleanup`)
  }
  pendingConsumerRebuilds.delete(conversationId)

  if (info) {
    try {
      info.session.close()  // Release FDs (stdin/stdout/stderr pipes)
    } catch (e) {
      // Ignore close errors - session may already be dead
    }
  }

  unregisterProcess(conversationId, 'v2-session')
  v2Sessions.delete(conversationId)
}

// ============================================
// Session Health Check
// ============================================

/**
 * Check if a V2 session's underlying process is still alive and ready.
 *
 * This checks the SDK's internal transport state, which is the Single Source of Truth
 * for process health. The transport.ready flag is set to false when:
 * - Process exits (normal or abnormal)
 * - Process is killed (OOM, signal, etc.)
 * - Transport is closed
 *
 * Why this is needed:
 * - The CC subprocess may be killed by OS (OOM, etc.) or crash unexpectedly
 * - Our v2Sessions Map doesn't automatically detect this
 * - Without this check, we'd try to reuse a dead session and get "ProcessTransport is not ready" error
 *
 * @param session - The V2 SDK session to check
 * @returns true if the session is ready for use, false if process is dead
 */
function isSessionTransportReady(session: V2SDKSession): boolean {
  try {
    // Access SDK internal state: session.query.transport
    // This is the authoritative source for process health
    const query = (session as any).query
    const transport = query?.transport

    if (!transport) {
      // No transport means session is definitely not ready
      return false
    }

    // Check using isReady() method if available (preferred)
    if (typeof transport.isReady === 'function') {
      return transport.isReady()
    }

    // Fallback to ready property
    if (typeof transport.ready === 'boolean') {
      return transport.ready
    }

    // If we can't determine state, assume it's ready (conservative approach)
    // This prevents unnecessary session recreation if SDK structure changes
    return true
  } catch (e) {
    // If any error occurs during check, log and assume session is invalid
    // Better to recreate than to fail with cryptic error
    console.error(`[Agent] Error checking session transport state:`, e)
    return false
  }
}

// ============================================
// Process Exit Listener
// ============================================

/**
 * Register a listener for process exit events.
 *
 * This is event-driven cleanup (better than polling):
 * - When the CC subprocess dies (OOM, crash, signal), we get notified immediately
 * - We then call session.close() to release resources (FDs, memory)
 * - This prevents resource leaks without waiting for the next polling cycle
 *
 * Why this is important:
 * - Each session holds 3 FDs (stdin/stdout/stderr pipes) on the parent process side
 * - If process dies but we don't close(), these FDs leak
 * - Accumulated FD leaks can cause "spawn EBADF" errors
 *
 * @param session - The V2 SDK session
 * @param conversationId - Conversation ID for logging and cleanup
 */
function registerProcessExitListener(session: V2SDKSession, conversationId: string): void {
  try {
    // Access SDK internal transport to register exit listener
    const transport = (session as any).query?.transport

    if (!transport) {
      console.warn(`[Agent][${conversationId}] Cannot register exit listener: no transport`)
      return
    }

    // SDK provides onExit(callback) method for process exit notification
    if (typeof transport.onExit === 'function') {
      const unsubscribe = transport.onExit((error: Error | undefined) => {
        const errorMsg = error ? `: ${error.message}` : ''
        cleanupSession(conversationId, `process exited${errorMsg}`)
        console.log(`[Agent][${conversationId}] Remaining sessions: ${v2Sessions.size}`)
      })

      console.log(`[Agent][${conversationId}] Process exit listener registered`)

      // Note: unsubscribe is returned but we don't need to call it
      // The listener will be automatically removed when transport.close() is called
    } else {
      console.warn(`[Agent][${conversationId}] SDK transport.onExit not available, relying on polling cleanup`)
    }
  } catch (e) {
    console.error(`[Agent][${conversationId}] Failed to register exit listener:`, e)
    // Not fatal - we still have polling cleanup as fallback
  }
}

// ============================================
// Session Cleanup (Polling Fallback)
// ============================================

// Session cleanup interval (clean up sessions not used for 30 minutes)
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000
let cleanupIntervalId: NodeJS.Timeout | null = null

/**
 * Start the session cleanup interval (polling fallback)
 *
 * This is a fallback mechanism for cases where onExit listener doesn't fire:
 * - SDK structure changes and onExit is not available
 * - Edge cases where exit event is missed
 *
 * Primary cleanup is event-driven via registerProcessExitListener().
 */
function startSessionCleanup(): void {
  if (cleanupIntervalId) return

  cleanupIntervalId = setInterval(() => {
    const now = Date.now()
    console.debug(`[Agent] Session cleanup sweep: ${v2Sessions.size} sessions, ${consumers.size} consumers`)
    // Avoid TS downlevelIteration requirement (main process tsconfig doesn't force target=es2015)
    for (const [convId, info] of Array.from(v2Sessions.entries())) {
      // Check 1: Clean up sessions with dead processes (killed by OS, crashed, etc.)
      if (!isSessionTransportReady(info.session)) {
        cleanupSession(convId, 'process not ready (polling fallback)')
        continue
      }

      // Check 2: Clean up idle sessions (not used for 30 minutes)
      // Skip sessions with an in-flight request — they are not idle.
      // Covers both legacy activeSessions and consumer-based conversations.
      if (isSessionBusy(convId)) {
        info.lastUsedAt = now // keep the clock fresh so timeout resets after task ends
        continue
      }
      if (now - info.lastUsedAt > SESSION_IDLE_TIMEOUT_MS) {
        cleanupSession(convId, 'idle timeout (30 min)')
      }
    }
  }, 60 * 1000) // Check every minute
}

/**
 * Stop the session cleanup interval
 */
export function stopSessionCleanup(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId)
    cleanupIntervalId = null
  }
}

// ============================================
// Session Migration
// ============================================

/**
 * Migrate session file from old config directory to new config directory on demand.
 *
 * Background: We changed CLI config directory from ~/.claude/ to
 * ~/Library/Application Support/halo/claude-config/ (via CLAUDE_CONFIG_DIR env)
 * to isolate Halo from user's own Claude Code configuration.
 *
 * This causes historical conversations to fail because their sessionId points to
 * session files in the old directory. This function migrates session files on demand
 * when user opens a historical conversation.
 *
 * Session file path structure:
 *   $CLAUDE_CONFIG_DIR/projects/<project-dir>/<session-id>.jsonl
 *
 * Project directory naming rule (cross-platform):
 *   Replace all non-alphanumeric characters with '-' (same as Claude Code CLI)
 *   e.g., /Users/fly/Desktop/myproject -> -Users-fly-Desktop-myproject
 *   e.g., /Volumes/one_tb/code2/hello-halo -> -Volumes-one-tb-code2-hello-halo
 *
 * @param workDir - Working directory (used to compute project directory name)
 * @param sessionId - Session ID
 * @returns true if session file exists in new directory (or migration succeeded),
 *          false if not found in either directory
 */
function migrateSessionIfNeeded(workDir: string, sessionId: string): boolean {
  // 1. Compute project directory name using the same rule as Claude Code CLI:
  //    Replace all non-alphanumeric characters with '-'
  const projectDir = workDir.replace(/[^a-zA-Z0-9]/g, '-')
  const sessionFile = `${sessionId}.jsonl`

  console.log(`[Agent] Migration check: workDir="${workDir}" -> projectDir="${projectDir}"`)

  // 2. Build old and new paths
  const newConfigDir = path.join(app.getPath('userData'), 'claude-config')
  const oldConfigDir = path.join(os.homedir(), '.claude')

  const newPath = path.join(newConfigDir, 'projects', projectDir, sessionFile)
  const oldPath = path.join(oldConfigDir, 'projects', projectDir, sessionFile)

  console.log(`[Agent] Checking paths:`)
  console.log(`[Agent]   New: ${newPath}`)
  console.log(`[Agent]   Old: ${oldPath}`)

  // 3. Check if already exists in new directory
  if (existsSync(newPath)) {
    console.log(`[Agent] ✓ Session file already exists in new directory: ${sessionId}`)
    return true
  }

  // 4. Check if exists in old directory
  if (!existsSync(oldPath)) {
    console.log(`[Agent] ✗ Session file not found in old directory: ${sessionId}`)
    return false
  }

  // 5. Ensure new project directory exists
  const newProjectDir = path.join(newConfigDir, 'projects', projectDir)
  if (!existsSync(newProjectDir)) {
    mkdirSync(newProjectDir, { recursive: true })
  }

  // 6. Copy file (not move - preserve old directory for user's own Claude Code)
  try {
    copyFileSync(oldPath, newPath)
    console.log(`[Agent] Migrated session file: ${sessionId}`)
    console.log(`[Agent]   From: ${oldPath}`)
    console.log(`[Agent]   To: ${newPath}`)
    return true
  } catch (error) {
    console.error(`[Agent] Failed to migrate session file: ${sessionId}`, error)
    return false
  }
}

// ============================================
// Session Config Comparison
// ============================================

/**
 * Check if session config requires rebuild
 * Only "process-level" params need rebuild; runtime params use setXxx() methods
 */
export function needsSessionRebuild(existing: V2SessionInfo, newConfig: SessionConfig): boolean {
  return existing.config.aiBrowserEnabled !== newConfig.aiBrowserEnabled
}

/**
 * Close and remove an existing V2 session (internal helper for rebuild)
 *
 * IMPORTANT: Pre-aborts the old session's AbortController before cleanup.
 *
 * In SDK ≥2.1, streamInput() waits for waitForFirstResult() before calling
 * transport.endInput() when hasBidirectionalNeeds() is true (canUseTool or
 * SDK MCP servers present). Without aborting, the old process's stdin stays
 * open for up to 5 seconds (the fz.close() abort timer), keeping the old
 * CLI process alive. If a new session is spawned in this window, both
 * processes compete for shared resources (config dir, version locks, etc.),
 * causing the new process to exit immediately (code 0) — an intermittent
 * race condition.
 *
 * By aborting the old AbortController first:
 * 1. waitForFirstResult() resolves immediately (abort signal listener fires)
 * 2. streamInput() calls transport.endInput() — old process gets stdin EOF
 * 3. The abort signal also fires SIGTERM via the spawn signal option
 * Both ensure the old process exits promptly before the new one starts.
 */
function closeV2SessionForRebuild(conversationId: string): void {
  const info = v2Sessions.get(conversationId)
  if (info) {
    try {
      const ac = (info.session as any).abortController
      if (ac && !ac.signal.aborted) {
        ac.abort()
      }
    } catch (e) {
      // AbortController may not be accessible — proceed with cleanup
    }
  }
  cleanupSession(conversationId, 'rebuild required')
}

// ============================================
// Session Creation
// ============================================

/**
 * Get or create V2 Session
 *
 * V2 Session enables process reuse: subsequent messages in the same conversation
 * reuse the running CC process, avoiding process restart each time (cold start ~3-5s).
 *
 * Note: Requires SDK patch for full parameter pass-through.
 * When sessionId is provided, CC restores conversation history from disk.
 *
 * @param spaceId - Space ID
 * @param conversationId - Conversation ID
 * @param sdkOptions - SDK options for session creation
 * @param sessionId - Optional session ID for resumption
 * @param config - Session configuration for rebuild detection
 * @param workDir - Working directory (required for session migration when sessionId is provided)
 * @param displayModel - Display model name for thought parsing (when provided, starts persistent consumer)
 */
export async function getOrCreateV2Session(
  spaceId: string,
  conversationId: string,
  sdkOptions: Record<string, any>,
  sessionId?: string,
  config?: SessionConfig,
  workDir?: string,
  displayModel?: string
): Promise<V2SessionInfo['session']> {
  // Check if we have an existing session for this conversation
  const existing = v2Sessions.get(conversationId)
  if (existing) {
    // CRITICAL: First check if the underlying process is still alive
    // The CC subprocess may have been killed by OS (OOM, etc.) or crashed,
    // but our v2Sessions Map still holds a reference to the dead session.
    // We must check SDK's transport state (Single Source of Truth) before reusing.
    if (!isSessionTransportReady(existing.session)) {
      console.log(`[Agent][${conversationId}] Session transport not ready (process dead), recreating...`)
      closeV2SessionForRebuild(conversationId)
      // Fall through to create new session
    } else if (consumers.get(conversationId)?.isRunning === false) {
      // Consumer exited (e.g., race between session recreation and invalidateAllSessions
      // during OAuth token refresh). The CC process is alive but nobody is reading its
      // output — a zombie session. Rebuild to restore a healthy session + consumer.
      console.log(`[Agent][${conversationId}] Consumer exited, session is zombie — rebuilding`)
      closeV2SessionForRebuild(conversationId)
      // Fall through to create new session
    } else {
      // Check if credentials have changed since session was created
      // This catches race conditions where session was created with stale credentials
      // (e.g., warm-up started before config save completed)
      const currentGen = getCredentialsGeneration()
      const needsCredentialRebuild = existing.credentialsGeneration !== currentGen
      const needsConfigRebuild = config && needsSessionRebuild(existing, config)

      if (needsCredentialRebuild || needsConfigRebuild) {
        const consumer = consumers.get(conversationId)

        // Guard 1: Consumer is actively processing a turn (mid-API-call, mid-tool, etc.)
        // Killing it now would destroy the in-flight response — the user loses the answer.
        // Instead, mark for deferred rebuild: the consumer checks pendingConsumerRebuilds
        // after each turn completes (session-consumer.ts consumePendingRebuild) and breaks
        // its loop, triggering a clean rebuild on the next sendMessage.
        const isActivelyProcessing = consumer?.isRunning && consumer.getActiveSessionState() !== null
        if (isActivelyProcessing) {
          pendingConsumerRebuilds.add(conversationId)
          const reason = needsCredentialRebuild
            ? `gen ${existing.credentialsGeneration}→${currentGen}`
            : 'config changed'
          console.log(
            `[Agent][${conversationId}] Session rebuild deferred — consumer is actively processing a turn ` +
            `(${reason}). Will rebuild after turn completes.`
          )
          existing.lastUsedAt = Date.now()
          return existing.session
        }

        // Guard 2: Consumer is idle between turns but CC subprocess has active team agents.
        // Their results arrive as a future autonomous turn. Killing the session now would
        // abort all in-flight agent tasks.
        const isIdleBetweenTurns = consumer?.isRunning && !consumer.getActiveSessionState()
        if (isIdleBetweenTurns && hasActiveTeamTasks(consumer!.getLastTurnThoughts())) {
          // Clear the flag that invalidateAllSessions may have set — we don't want
          // the consumer to break after the next team turn while messages are queued.
          pendingConsumerRebuilds.delete(conversationId)
          console.log(
            `[Agent][${conversationId}] Session rebuild deferred — active team agents detected ` +
            `(${needsCredentialRebuild ? `gen ${existing.credentialsGeneration}→${currentGen}` : 'config changed'}). ` +
            `Will rebuild after team tasks complete.`
          )
          existing.lastUsedAt = Date.now()
          return existing.session
        }

        // No active processing and no team agents — safe to rebuild now.
        if (needsCredentialRebuild) {
          console.log(`[Agent][${conversationId}] Credentials changed (gen ${existing.credentialsGeneration} → ${currentGen}), recreating session`)
        } else {
          console.log(`[Agent][${conversationId}] Config changed (aiBrowser: ${existing.config.aiBrowserEnabled} → ${config!.aiBrowserEnabled}), rebuilding session...`)
        }
        closeV2SessionForRebuild(conversationId)
        // Fall through to create new session
      } else {
        // Session is alive and config is compatible, reuse it
        console.log(`[Agent][${conversationId}] Reusing existing V2 session`)
        existing.lastUsedAt = Date.now()
        return existing.session
      }
    }
  }

  // Create new session
  // If sessionId exists, pass resume to let CC restore history from disk
  // After first message, the process stays alive and maintains context in memory
  console.log(`[Agent][${conversationId}] Creating new V2 session...`)
  console.debug(`[Agent][${conversationId}] SDK options: model=${sdkOptions.model}, maxTurns=${sdkOptions.maxTurns}, mcpServers=[${Object.keys(sdkOptions.mcpServers || {}).join(', ')}], resume=${!!sessionId}`)

  // Handle session resumption with migration support
  let effectiveSessionId = sessionId
  if (sessionId && workDir) {
    // Attempt to migrate session file from old config directory if needed
    const sessionExists = migrateSessionIfNeeded(workDir, sessionId)
    if (sessionExists) {
      console.log(`[Agent][${conversationId}] With resume: ${sessionId}`)
    } else {
      // Session file not found in either directory - start fresh conversation
      console.log(`[Agent][${conversationId}] Session ${sessionId} not found, starting fresh conversation`)
      effectiveSessionId = undefined
    }
  } else if (sessionId) {
    console.log(`[Agent][${conversationId}] With resume: ${sessionId}`)
  }
  const startTime = Date.now()

  // Requires SDK patch: resume parameter lets CC restore history from disk
  // Native SDK V2 Session doesn't support resume parameter
  if (effectiveSessionId) {
    sdkOptions.resume = effectiveSessionId
  }
  // resolved-sdk handles sdkEngine switch (Halo SDK vs CC SDK) transparently
  const session = (await createSession(sdkOptions)) as unknown as V2SDKSession

  // Log PID for health system verification (via SDK patch)
  const pid = (session as any).pid
  console.log(`[Agent][${conversationId}] V2 session created in ${Date.now() - startTime}ms, PID: ${pid ?? 'unavailable'}`)

  const sdkEnv = ((sdkOptions as Record<string, unknown>).env || {}) as Record<string, string | undefined>
  console.log(`[Agent] session_create conv=${conversationId} pid=${pid ?? ''} model=${sdkOptions.model || ''} base_url=${sdkEnv.ANTHROPIC_BASE_URL || ''}`)
  console.log(`[SDK Config] session_env conv=${conversationId} ANTHROPIC_BASE_URL=${sdkEnv.ANTHROPIC_BASE_URL || ''} ANTHROPIC_API_KEY=${sdkEnv.ANTHROPIC_API_KEY || ''} HTTP_PROXY=${sdkEnv.HTTP_PROXY || ''} HTTPS_PROXY=${sdkEnv.HTTPS_PROXY || ''} NO_PROXY=${sdkEnv.NO_PROXY || ''}`)

  // Register with health system for orphan detection
  const instanceId = getCurrentInstanceId()
  if (instanceId) {
    registerProcess({
      id: conversationId,
      pid: pid ?? null,
      type: 'v2-session',
      instanceId,
      startedAt: Date.now()
    })
  }

  // Register process exit listener for immediate cleanup
  // This is event-driven (better than polling) - when process dies, we clean up immediately
  registerProcessExitListener(session, conversationId)

  // Store session with config and current credentials generation
  // Generation is used to detect stale credentials on session reuse
  v2Sessions.set(conversationId, {
    session,
    spaceId,
    conversationId,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    config: config || { aiBrowserEnabled: false },
    credentialsGeneration: getCredentialsGeneration()
  })

  // Start cleanup if not already running
  startSessionCleanup()

  // Start persistent consumer for chat conversations (when displayModel is provided).
  // Automation apps (app-chat.ts, execute.ts) don't pass displayModel and handle
  // their own processStream() calls, so they don't get a consumer.
  if (displayModel) {
    const consumer = startConsumer(session, spaceId, conversationId, displayModel)
    consumers.set(conversationId, consumer)
    console.log(`[Agent][${conversationId}] Persistent consumer started`)
  }

  return session
}

// ============================================
// Session Warm-up
// ============================================

/**
 * Warm up V2 Session (called when user switches conversations)
 *
 * Pre-initialize or reuse V2 Session to avoid delay when sending messages.
 * Frontend calls this when user clicks a conversation, no need to wait for completion.
 *
 * Flow:
 * 1. User clicks conversation A → frontend immediately calls ensureSessionWarm()
 * 2. V2 Session initializes in background (non-blocking UI)
 * 3. User finishes typing and sends → V2 Session ready, send directly (fast)
 *
 * Important: Parameters must be identical to sendMessage for session reliability
 */
export async function ensureSessionWarm(
  spaceId: string,
  conversationId: string
): Promise<void> {

  const config = getConfig()
  const workDir = getWorkingDir(spaceId)
  const digitalHumansEnabled = config.agent?.enableDigitalHumans !== false
  const conversation = getConversation(spaceId, conversationId)
  const sessionId = conversation?.sessionId
  const electronPath = getHeadlessElectronPath()

  // Get API credentials and resolve for SDK use
  const credentials = await getApiCredentials(config)
  console.log(`[Agent] Session warm using: ${credentials.provider}, model: ${credentials.model}`)

  // Resolve credentials for SDK (handles OpenAI compat router for non-Anthropic providers)
  const resolvedCredentials = await resolveCredentialsForSdk(credentials)

  // Get MCP servers from installed apps database (global + space-scoped)
  const dbMcpServers = getDbMcpServers(spaceId)

  // Build MCP servers config (must match sendMessage to avoid session rebuild)
  const mcpServers: Record<string, any> = dbMcpServers ? { ...dbMcpServers } : {}
  if (digitalHumansEnabled) {
    const haloApps = createHaloAppsMcpServer(spaceId)
    if (haloApps) mcpServers['halo-apps'] = haloApps
  }
  mcpServers['web-search'] = createWebSearchMcpServer()

  // Build SDK options using shared configuration
  const sdkOptions = buildBaseSdkOptions({
    credentials: resolvedCredentials,
    workDir,
    electronPath,
    spaceId,
    conversationId,
    stderrHandler: (data: string) => {
      console.error(`[Agent][${conversationId}] CLI stderr (warm):`, data)
    },
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : null,
    maxTurns: config.agent?.maxTurns,
    promptProfile: config.agent?.promptProfile,
    configDirMode: config.agent?.configDirMode,
    customConfigDir: config.agent?.customConfigDir,
    enableTeams: config.agent?.enableTeams,
    disabledTools: config.agent?.disabledTools,
    digitalHumansEnabled,
  })

  try {
    const session = await getOrCreateV2Session(spaceId, conversationId, sdkOptions, sessionId, undefined, workDir, resolvedCredentials.displayModel)

    // Ensure consumer's displayModel is up-to-date (same as sendMessage)
    updateConsumerDisplayModel(conversationId, resolvedCredentials.displayModel)

    // Fetch supported commands from SDK and send to renderer
    // This provides slash commands immediately without needing to send a message
    try {
      const commands = await (session as any).query.supportedCommands()

      // Extract command names (no need to parse skills here, frontend will handle it)
      const slashCommands = commands.map((cmd: any) => cmd.name)

      // Send session-info to renderer (same format as system:init message)
      emitAgentEvent('agent:session-info', spaceId, conversationId, {
        slashCommands,
        skills: [],  // Let frontend/later logic handle classification
        agents: []   // Not available from supportedCommands
      })
    } catch (error) {
      console.error(`[Agent] Failed to fetch supported commands:`, error)
      // Non-fatal: commands will be available after first message
    }
  } catch (error) {
    console.error(`[Agent] Failed to warm up session ${conversationId}:`, error)
    // Don't throw on warm-up failure, sendMessage() will reinitialize (just slower)
  }
}

// ============================================
// Session Lifecycle
// ============================================

/**
 * Close V2 session for a conversation
 */
export function closeV2Session(conversationId: string): void {
  cleanupSession(conversationId, 'explicit close')
}

/**
 * Close all V2 sessions (for app shutdown)
 */
export function closeAllV2Sessions(): void {
  const count = v2Sessions.size
  console.log(`[Agent] Closing all ${count} V2 sessions`)

  for (const convId of Array.from(v2Sessions.keys())) {
    cleanupSession(convId, 'app shutdown')
  }

  stopSessionCleanup()
}

/**
 * Get the consumer handle for a conversation (if one exists).
 * Used by send-message.ts to notify the consumer of user-initiated turns.
 */
export function getConsumerHandle(conversationId: string): ConsumerHandle | null {
  return consumers.get(conversationId) || null
}

/**
 * Update the display model on an existing consumer.
 * Called by sendMessage/ensureSessionWarm to keep displayModel in sync after
 * model switches without requiring a full session rebuild.
 */
export function updateConsumerDisplayModel(conversationId: string, displayModel: string): void {
  const consumer = consumers.get(conversationId)
  if (consumer) {
    consumer.updateDisplayModel(displayModel)
  }
}

/**
 * Check and consume a pending rebuild flag for a consumer session.
 * Called by session-consumer after each turn to determine if it should
 * break its loop (triggering session rebuild on next sendMessage).
 *
 * @returns true if the session had a pending rebuild (flag is consumed)
 */
export function consumePendingRebuild(conversationId: string): boolean {
  if (pendingConsumerRebuilds.has(conversationId)) {
    pendingConsumerRebuilds.delete(conversationId)
    return true
  }
  return false
}

/**
 * Get all conversation IDs that have a running consumer.
 * Used by control.ts to enumerate all active sessions (including consumer-based).
 */
export function getRunningConsumerIds(): string[] {
  const ids: string[] = []
  for (const [convId, consumer] of consumers.entries()) {
    if (consumer.isRunning) {
      ids.push(convId)
    }
  }
  return ids
}

// Note: checkPendingInvalidation was removed. Consumer-based sessions no longer
// use pendingInvalidations — they are skipped during invalidateAllSessions (like
// the old architecture) and force-rebuilt on the next sendMessage when
// getOrCreateV2Session detects stale credentials. pendingInvalidations is now
// only used for legacy callers (app-chat/execute) via unregisterActiveSession.

/**
 * Invalidate all V2 sessions due to API config change.
 * Called by config.service via callback when API config changes.
 *
 * Sessions are closed immediately, but users are not interrupted.
 * New sessions will be created with updated config on next message.
 */
export function invalidateAllSessions(): void {
  const count = v2Sessions.size
  if (count === 0) {
    console.log('[Agent] No active sessions to invalidate')
    return
  }

  console.log(`[Agent] Invalidating ${count} sessions due to API config change`)

  for (const convId of Array.from(v2Sessions.keys())) {
    // Legacy path (app-chat/execute): defer closing until unregisterActiveSession
    if (activeSessions.has(convId)) {
      pendingInvalidations.add(convId)
      console.log(`[Agent] Deferring session close until legacy turn idle: ${convId}`)
      continue
    }

    // Consumer path (chat conversations): mark for deferred rebuild.
    // The consumer will break its loop after the current turn completes,
    // and the next sendMessage will create a fresh session with new credentials.
    const consumer = consumers.get(convId)
    if (consumer && consumer.isRunning) {
      pendingConsumerRebuilds.add(convId)
      console.log(`[Agent] Marking consumer session for rebuild after current turn: ${convId}`)
      continue
    }

    cleanupSession(convId, 'API config change')
  }

  console.log('[Agent] All sessions invalidated, will use new config on next message')
}

/**
 * Invalidate sessions belonging to a specific space.
 * Called when an MCP is installed/uninstalled/paused/resumed in a space.
 *
 * Global MCP changes (spaceId=null) affect all spaces → use invalidateAllSessions() instead.
 * Space-scoped MCP changes only affect that space's sessions.
 *
 * Active (in-flight) sessions are deferred via pendingInvalidations,
 * consistent with invalidateAllSessions() behavior.
 */
export function invalidateSessionsForSpace(spaceId: string): void {
  let count = 0
  for (const [convId, info] of Array.from(v2Sessions.entries())) {
    if (info.spaceId !== spaceId) continue

    // Legacy path (app-chat/execute): defer closing until unregisterActiveSession
    if (activeSessions.has(convId)) {
      pendingInvalidations.add(convId)
      console.log(`[Agent][${convId}] MCP changed, deferring session close until legacy turn idle`)
      count++
      continue
    }

    // Consumer path: mark for deferred rebuild after current turn completes
    const consumer = consumers.get(convId)
    if (consumer && consumer.isRunning) {
      pendingConsumerRebuilds.add(convId)
      console.log(`[Agent][${convId}] MCP changed, marking consumer session for rebuild`)
      count++
      continue
    }

    cleanupSession(convId, 'MCP config change')
    count++
  }

  if (count > 0) {
    console.log(`[Agent] Invalidated ${count} session(s) in space ${spaceId} due to MCP change`)
  }
}

/**
 * Invalidate all IM channel sessions (but not native Halo chat sessions).
 * Called when IM channel config is reloaded, so permission changes take effect
 * on the next inbound message without requiring a manual /halo-clear.
 *
 * Uses {@link isImSessionKey} from im-keys.ts (single source of truth for
 * key format) to distinguish IM sessions from native chat and automation runs.
 */
export function invalidateImSessions(): void {
  let count = 0
  for (const convId of Array.from(v2Sessions.keys())) {
    if (!isImSessionKey(convId)) continue

    if (activeSessions.has(convId)) {
      pendingInvalidations.add(convId)
      console.log(`[Agent][${convId}] IM config changed, deferring session close until idle`)
      count++
      continue
    }

    const consumer = consumers.get(convId)
    if (consumer && consumer.isRunning) {
      pendingConsumerRebuilds.add(convId)
      console.log(`[Agent][${convId}] IM config changed, marking consumer for rebuild`)
      count++
      continue
    }

    cleanupSession(convId, 'IM config change')
    count++
  }

  if (count > 0) {
    console.log(`[Agent] Invalidated ${count} IM session(s) due to channel config reload`)
  }
}

// ============================================
// Active Session State
// ============================================

/**
 * Create a new active session state
 */
export function createSessionState(
  spaceId: string,
  conversationId: string,
  abortController: AbortController
): SessionState {
  return {
    abortController,
    spaceId,
    conversationId,
    thoughts: []
  }
}

/**
 * Register an active session
 */
export function registerActiveSession(conversationId: string, state: SessionState): void {
  activeSessions.set(conversationId, state)
}

/**
 * Unregister an active session
 */
export function unregisterActiveSession(conversationId: string): void {
  activeSessions.delete(conversationId)

  if (pendingInvalidations.has(conversationId)) {
    pendingInvalidations.delete(conversationId)
    closeV2Session(conversationId)
  }
}

/**
 * Get an active session by conversation ID
 */
export function getActiveSession(conversationId: string): SessionState | undefined {
  return activeSessions.get(conversationId)
}

// ============================================
// Config Change Handler Registration
// ============================================

// Register for API config change notifications
// This is called once when the module loads
onApiConfigChange(() => {
  invalidateAllSessions()
})

/**
 * Invalidate sessions in response to an MCP-apps change.
 * Global changes (`spaceId === null`) invalidate all sessions; space-scoped
 * changes invalidate only that space's sessions.
 *
 * The Apps layer owns the `onMcpAppsChange` event and wires this handler to
 * it at startup (see `apps/runtime`), keeping the services→apps dependency
 * direction inverted.
 */
export function handleMcpAppsChange(spaceId: string | null): void {
  if (spaceId === null) {
    invalidateAllSessions()
  } else {
    invalidateSessionsForSpace(spaceId)
  }
}
