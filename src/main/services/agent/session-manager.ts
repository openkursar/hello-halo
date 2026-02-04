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
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk'
import { getConfig, onApiConfigChange } from '../config.service'
import { getConversation } from '../conversation.service'
import type {
  V2SDKSession,
  V2SessionInfo,
  SessionConfig,
  SessionState,
  Thought
} from './types'
import {
  getHeadlessElectronPath,
  getWorkingDir,
  getApiCredentials,
  getEnabledMcpServers
} from './helpers'
import { registerProcess, unregisterProcess, getCurrentInstanceId } from '../health'
import { resolveCredentialsForSdk, buildBaseSdkOptions } from './sdk-config'

// ============================================
// Session Maps
// ============================================

/**
 * Active sessions map: conversationId -> SessionState
 * Tracks in-flight requests with abort controllers and accumulated thoughts
 */
export const activeSessions = new Map<string, SessionState>()

/**
 * V2 Sessions map: conversationId -> V2SessionInfo
 * Persistent sessions that can be reused across multiple messages
 */
export const v2Sessions = new Map<string, V2SessionInfo>()

/**
 * Sessions that should be invalidated after current in-flight request finishes
 * (e.g., model switch during streaming).
 */
const pendingInvalidations = new Set<string>()

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

  console.log(`[Agent][${conversationId}] Cleaning up session: ${reason}`)

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
    // Avoid TS downlevelIteration requirement (main process tsconfig doesn't force target=es2015)
    for (const [convId, info] of Array.from(v2Sessions.entries())) {
      // Check 1: Clean up sessions with dead processes (killed by OS, crashed, etc.)
      if (!isSessionTransportReady(info.session)) {
        cleanupSession(convId, 'process not ready (polling fallback)')
        continue
      }

      // Check 2: Clean up idle sessions (not used for 30 minutes)
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
 */
function closeV2SessionForRebuild(conversationId: string): void {
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
 */
export async function getOrCreateV2Session(
  spaceId: string,
  conversationId: string,
  sdkOptions: Record<string, any>,
  sessionId?: string,
  config?: SessionConfig,
  workDir?: string
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
    } else if (config && needsSessionRebuild(existing, config)) {
      // Config changed (e.g., aiBrowser toggle), need to rebuild
      console.log(`[Agent][${conversationId}] Config changed (aiBrowser: ${existing.config.aiBrowserEnabled} → ${config.aiBrowserEnabled}), rebuilding session...`)
      closeV2SessionForRebuild(conversationId)
      // Fall through to create new session
    } else {
      // Session is alive and config is compatible, reuse it
      console.log(`[Agent][${conversationId}] Reusing existing V2 session`)
      existing.lastUsedAt = Date.now()
      return existing.session
    }
  }

  // Create new session
  // If sessionId exists, pass resume to let CC restore history from disk
  // After first message, the process stays alive and maintains context in memory
  console.log(`[Agent][${conversationId}] Creating new V2 session...`)

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
  // Requires SDK patch: native SDK ignores most sdkOptions parameters
  // Use 'as any' to bypass type check, actual params handled by patched SDK
  const session = (await unstable_v2_createSession(sdkOptions as any)) as unknown as V2SDKSession

  // Log PID for health system verification (via SDK patch)
  const pid = (session as any).pid
  console.log(`[Agent][${conversationId}] V2 session created in ${Date.now() - startTime}ms, PID: ${pid ?? 'unavailable'}`)

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

  // Store session with config
  v2Sessions.set(conversationId, {
    session,
    spaceId,
    conversationId,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    config: config || { aiBrowserEnabled: false }
  })

  // Start cleanup if not already running
  startSessionCleanup()

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
  const conversation = getConversation(spaceId, conversationId)
  const sessionId = conversation?.sessionId
  const electronPath = getHeadlessElectronPath()

  // Create abortController - consistent with sendMessage
  const abortController = new AbortController()

  // Get API credentials and resolve for SDK use
  const credentials = await getApiCredentials(config)
  console.log(`[Agent] Session warm using: ${credentials.provider}, model: ${credentials.model}`)

  // Resolve credentials for SDK (handles OpenAI compat router for non-Anthropic providers)
  const resolvedCredentials = await resolveCredentialsForSdk(credentials)

  // Get enabled MCP servers
  const enabledMcpServers = getEnabledMcpServers(config.mcpServers || {})

  // Build SDK options using shared configuration
  const sdkOptions = buildBaseSdkOptions({
    credentials: resolvedCredentials,
    workDir,
    electronPath,
    spaceId,
    conversationId,
    abortController,
    stderrHandler: (data: string) => {
      console.error(`[Agent][${conversationId}] CLI stderr (warm):`, data)
    },
    mcpServers: enabledMcpServers
  })

  try {
    console.log(`[Agent] Warming up V2 session: ${conversationId}`)
    await getOrCreateV2Session(spaceId, conversationId, sdkOptions, sessionId, undefined, workDir)
    console.log(`[Agent] V2 session warmed up: ${conversationId}`)
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
    // If a request is in flight, defer closing until it finishes
    if (activeSessions.has(convId)) {
      pendingInvalidations.add(convId)
      console.log(`[Agent] Deferring session close until idle: ${convId}`)
      continue
    }

    cleanupSession(convId, 'API config change')
  }

  console.log('[Agent] All sessions invalidated, will use new config on next message')
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
    pendingPermissionResolve: null,
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
