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
  SessionState,
} from './types'
import {
  getHeadlessElectronPath,
  getWorkingDir,
  getApiCredentialsForConversation,
  getDbMcpServers
} from './helpers'
import { isImSessionKey } from '../../../shared/apps/im-keys'
import { purgeStaleMcpOAuth } from './mcp-auth-state'
import { emitAgentEvent } from './events'
import { registerProcess, unregisterProcess, getCurrentInstanceId } from '../health'
import { resolveCredentialsForSdk, buildBaseSdkOptions, computeCredentialsFingerprint, computeSessionInputsFingerprint } from './sdk-config'
import { applySessionReasoningEffort } from './reasoning-effort'
import { startConsumer, type ConsumerHandle, type ConsumerContext } from './session-consumer'
import { createConversationSink } from './conversation-sink'
import { hasActiveTeamTasks } from './subagent-handler'
import { setSessionInvalidator, buildCreationTimeServers } from './toolsets/broker'
import { buildToolsetSection } from './toolsets/capability-index'
import { dropConversationState, getOpenToolsets } from './toolsets/state'
import { HALO_API_TOOLSET_ID } from '../api-ref'
import { resolveConversationKnowledgeBases, resolveConversationKnowledgeBaseIds } from './knowledge-context'
import { buildKnowledgeSection } from './system-prompt'
import type { KBReference } from '../../../shared/types/tlon'

/**
 * Mask a secret for a diagnostic log line: report presence + length only, never
 * the value. The session_env log exists to debug credential *wiring* (is a key
 * set, which base URL), for which length is enough — the raw key must never hit
 * the log file, which is user-readable and often shared in bug reports.
 */
function maskSecretForLog(value: string | undefined): string {
  return value ? `set(len=${value.length})` : 'unset'
}

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
 * Stable fingerprint of what the session's Knowledge context actually is:
 * the RESOLVED knowledge-base set (ids that produced an injectable reference,
 * not the declared ids) plus the working directory. Compared against the value
 * captured at session creation to rebuild when they diverge.
 *
 * Resolved set, not declared ids: a session created while a KB is still
 * indexing resolves it to nothing — with declared ids the fingerprint would
 * never change when indexing completes, and the session would stay blind to
 * the KB forever. With the resolved set, the next turn after indexing sees a
 * different fingerprint and rebuilds (self-healing).
 *
 * workDir: a KB-chat turn runs in the KB's text/ directory while normal turns
 * run in the space directory. Without workDir in the fingerprint, alternating
 * turn kinds on one conversation would silently reuse a session rooted in the
 * wrong directory.
 */
function computeKnowledgeFingerprint(resolvedKbIds?: string[], workDir?: string): string {
  const ids = resolvedKbIds && resolvedKbIds.length > 0 ? [...resolvedKbIds].sort().join('|') : ''
  if (!ids && !workDir) return ''
  return `${ids}::${workDir ?? ''}`
}

/**
 * Rebuild a conversation's session so a toolset toggle takes effect: the new MCP
 * set is seeded at the next session creation via buildCreationTimeServers. Frozen
 * at creation and not covered by the credentials fingerprint, so a live session
 * must be torn down to pick it up. (Knowledge-base changes take a different path —
 * they ARE fingerprinted, see computeKnowledgeFingerprint — so they self-heal on
 * the next turn without an explicit call here.) Deferred when the consumer is
 * mid-turn or a legacy turn is in flight (rebuilds after the turn, like a
 * credential change); a no-op when no session exists yet, since creation will
 * read the current state anyway.
 */
function requestSessionRebuild(conversationId: string, reason = 'session rebuild'): void {
  const info = v2Sessions.get(conversationId)
  if (!info) {
    // Session mid-creation: it is being seeded with the pre-change state, so flag
    // it for a rebuild once its consumer starts. When not under creation there is
    // genuinely no session and creation will read the current state anyway.
    if (sessionsUnderCreation.has(conversationId)) {
      pendingConsumerRebuilds.add(conversationId)
    }
    return
  }

  // Legacy callers (app-chat/execute) close on turn idle via unregisterActiveSession.
  if (activeSessions.has(conversationId)) {
    pendingInvalidations.add(conversationId)
    return
  }

  // A user turn is dispatched but CC has not yet emitted system:init — the
  // consumer looks idle, but cleanup now would destroy the in-flight message.
  if (turnsAwaitingInit.has(conversationId)) {
    pendingConsumerRebuilds.add(conversationId)
    return
  }

  // Consumer mid-turn: defer so we don't kill an in-flight response; the
  // consumer breaks after the turn and the next sendMessage rebuilds.
  const consumer = consumers.get(conversationId)
  if (consumer?.isRunning && consumer.getActiveSessionState()) {
    pendingConsumerRebuilds.add(conversationId)
    return
  }

  // Consumer idle between turns but the CC subprocess still has team agents
  // running — cleanup now would kill them all. Defer: the consumer only
  // consumes the pending flag once no team tasks remain (see consumeLoop).
  if (consumer?.isRunning && hasActiveTeamTasks(consumer.getTeamLifecycleThoughts())) {
    pendingConsumerRebuilds.add(conversationId)
    return
  }

  // Abort-first close, same as every other rebuild path: without the pre-abort
  // the old process lingers on stdin EOF for up to seconds, and a successor
  // created inside that window used to be torn down by the predecessor's exit.
  closeV2SessionForRebuild(conversationId, reason)
}

// Wire the toolset broker's rebuild trigger (DI seam, avoids module cycle)
setSessionInvalidator((conversationId) => requestSessionRebuild(conversationId, 'toolset change'))

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
 * Conversations whose V2 session is mid-creation (inside `await createSession`).
 * A toolset toggle that lands in this window would otherwise be lost: the
 * session is not in v2Sessions yet, so the invalidator has nothing to act on,
 * and once stored it carries the pre-toggle MCP set with a credentials
 * fingerprint that never triggers a rebuild. Flagging such a conversation for a
 * deferred rebuild (see requestSessionRebuild) closes the gap.
 */
const sessionsUnderCreation = new Set<string>()

/**
 * Conversations with a user turn dispatched to the CC REPL but not yet
 * acknowledged by system:init. In this window the consumer looks idle
 * (currentSessionState is set only at onTurnInit), so an immediate session
 * rebuild would destroy the in-flight message. The renderer hides the toolset
 * toggle while generating, but the main process must not rely on that: remote
 * clients (HTTP/mobile) can toggle at any time. Cleared on init and on cleanup;
 * a turn that never inits is recycled by the idle-timeout sweep.
 */
const turnsAwaitingInit = new Set<string>()

/** Called by send-message right before dispatching a user turn to the REPL. */
export function markTurnDispatched(conversationId: string): void {
  turnsAwaitingInit.add(conversationId)
}

/** Called by the session consumer when CC acknowledges the turn (system:init). */
export function markTurnInitReceived(conversationId: string): void {
  turnsAwaitingInit.delete(conversationId)
}

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
  return hasActiveTeamTasks(consumer.getTeamLifecycleThoughts())
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

  console.log(`[Agent][${conversationId}] Cleaning up session: ${reason}`)

  // Stop the persistent consumer first (if any)
  const consumer = consumers.get(conversationId)
  if (consumer) {
    consumer.stop()
    consumers.delete(conversationId)
    console.log(`[Agent][${conversationId}] Consumer stopped during cleanup`)
  }
  pendingConsumerRebuilds.delete(conversationId)

  if (info) {
    // Detach the exit listener first: session.close() never reaches
    // transport.close(), so without this the listener outlives the session and
    // can fire against a successor (see registerProcessExitListener guard).
    try {
      info.exitUnsubscribe?.()
    } catch (e) {
      // Ignore - process may already be gone
    }
    try {
      info.session.close()  // Release FDs (stdin/stdout/stderr pipes)
    } catch (e) {
      // Ignore close errors - session may already be dead
    }
  }

  unregisterProcess(conversationId, 'v2-session')
  v2Sessions.delete(conversationId)
  turnsAwaitingInit.delete(conversationId)

  // Drop the in-memory toolset open-set. Persisted toolset selection on the
  // conversation record is preserved and rehydrated on the next session, so
  // this is safe on rebuild.
  dropConversationState(conversationId)
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
 * @returns Unsubscribe function to detach the listener, or undefined when
 *          registration was not possible. Callers MUST invoke it on cleanup:
 *          session.close() never calls transport.close(), so the process
 *          'exit' listener survives the session it belongs to otherwise.
 */
function registerProcessExitListener(
  session: V2SDKSession,
  conversationId: string
): (() => void) | undefined {
  try {
    // Access SDK internal transport to register exit listener
    const transport = (session as any).query?.transport

    if (!transport) {
      console.warn(`[Agent][${conversationId}] Cannot register exit listener: no transport`)
      return undefined
    }

    // SDK provides onExit(callback) method for process exit notification
    if (typeof transport.onExit === 'function') {
      const unsubscribe = transport.onExit((error: Error | undefined) => {
        // Identity guard: a replaced session's process dies AFTER its successor
        // is registered under the same conversationId (close() only sends stdin
        // EOF; the process lingers up to seconds). Without this check the
        // predecessor's exit tears down the brand-new session and its consumer.
        const current = v2Sessions.get(conversationId)
        if (current && current.session !== session) {
          console.log(`[Agent][${conversationId}] Ignoring exit of a replaced session's process`)
          return
        }
        const errorMsg = error ? `: ${error.message}` : ''
        cleanupSession(conversationId, `process exited${errorMsg}`)
        console.log(`[Agent][${conversationId}] Remaining sessions: ${v2Sessions.size}`)
      })

      console.log(`[Agent][${conversationId}] Process exit listener registered`)
      return typeof unsubscribe === 'function' ? unsubscribe : undefined
    } else {
      console.warn(`[Agent][${conversationId}] SDK transport.onExit not available, relying on polling cleanup`)
    }
  } catch (e) {
    console.error(`[Agent][${conversationId}] Failed to register exit listener:`, e)
    // Not fatal - we still have polling cleanup as fallback
  }
  return undefined
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
function closeV2SessionForRebuild(conversationId: string, reason = 'rebuild required'): void {
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
  cleanupSession(conversationId, reason)
}

/**
 * True when a deferred rebuild is flagged for this conversation AND the session
 * is safely idle (no dispatched-but-unacknowledged turn, no active turn, no
 * running team agents) — i.e. the flag can be applied right now instead of
 * waiting for the consumer's next turn boundary.
 */
function hasConsumablePendingRebuild(conversationId: string): boolean {
  if (!pendingConsumerRebuilds.has(conversationId)) return false
  if (turnsAwaitingInit.has(conversationId)) return false
  const consumer = consumers.get(conversationId)
  if (consumer?.isRunning && consumer.getActiveSessionState()) return false
  if (consumer?.isRunning && hasActiveTeamTasks(consumer.getTeamLifecycleThoughts())) return false
  return true
}

/**
 * Invariant: every in-process (sdk-type) MCP server instance seeded into a new
 * session must be unbound. The SDK's connect call is fire-and-forget — seeding
 * an instance still bound to a previous session's transport fails as a swallowed
 * rejection, leaving the server registered but dead ("No such tool available").
 * This turns that silent failure mode into a loud log line.
 */
function assertMcpInstancesUnbound(
  conversationId: string,
  mcpServers: Record<string, any> | undefined
): void {
  for (const [name, srv] of Object.entries(mcpServers ?? {})) {
    if (srv?.type !== 'sdk') continue
    const inst = srv.instance
    if (inst && (inst.transport ?? inst._transport)) {
      console.error(
        `[Agent][${conversationId}] INVARIANT VIOLATION: in-process MCP server "${name}" ` +
        `is already bound to a transport; its tools will be unavailable in the new session`
      )
    }
  }
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
 * @param workDir - Working directory (required for session migration when sessionId is provided)
 * @param consumer - Display model, context window, and the {@link TurnSink} for
 *   the persistent consumer. Supplying it is what makes a newly created session
 *   consumed continuously; omit it only for surfaces that drive their own
 *   `processStream` (automation runs), which would otherwise fight over the
 *   stream with the consumer.
 * @param resolvedKbIds - Ids of the knowledge bases that resolve for this call
 *   (registry-active + index ready; NOT the conversation's declared ids — see
 *   computeKnowledgeFingerprint for why the distinction matters)
 * @param buildMcpServers - Deferred MCP server assembly, invoked only when a new
 *   session is actually created (after any cleanup of the previous one). In-process
 *   MCP server instances bind to exactly one session transport, so they must be
 *   instantiated by the creation path itself — a record built before the
 *   reuse/rebuild decision could carry instances still bound to the torn-down
 *   session, which the SDK fails to connect silently (tools vanish mid-conversation).
 * @param resolveKnowledgeBases - Deferred knowledge resolution, invoked only at
 *   actual creation: reads each KB's index.md and appends the "# Knowledge"
 *   section to the system prompt. Deferred for cost, not correctness — a reused
 *   session would throw the resolution away (its prompt is frozen at creation).
 */
export async function getOrCreateV2Session(
  spaceId: string,
  conversationId: string,
  sdkOptions: Record<string, any>,
  sessionId?: string,
  workDir?: string,
  consumer?: SessionConsumerOptions,
  resolvedKbIds?: string[],
  buildMcpServers?: () => Record<string, unknown> | null,
  resolveKnowledgeBases?: () => KBReference[]
): Promise<V2SessionInfo['session']> {
  // Concurrent calls for the same conversation (a fire-and-forget
  // ensureSessionWarm racing the first sendMessage) must not both reach
  // createSession: the loser's v2Sessions.set/registerProcess would overwrite
  // the winner's, leaking an orphan CC process whose exit listener then tears
  // down the healthy session by conversationId. Latecomers share the in-flight
  // result; if their inputs differ (credentials/KB changed mid-flight), the
  // fingerprint check on the next call reconciles with a rebuild.
  const inFlight = inFlightSessionCreations.get(conversationId)
  if (inFlight) {
    console.log(`[Agent][${conversationId}] Session creation already in flight, sharing result`)
    return inFlight
  }

  const promise = getOrCreateV2SessionInner(
    spaceId, conversationId, sdkOptions, sessionId, workDir,
    consumer, resolvedKbIds, buildMcpServers, resolveKnowledgeBases
  )
  inFlightSessionCreations.set(conversationId, promise)
  try {
    return await promise
  } finally {
    inFlightSessionCreations.delete(conversationId)
  }
}

/** conversationId -> in-flight getOrCreateV2Session promise. */
const inFlightSessionCreations = new Map<string, Promise<V2SessionInfo['session']>>()

/**
 * Consumer wiring for a newly created session. Grouped rather than passed as
 * loose positional arguments because these three values only ever travel
 * together, and their presence — not their content — is what decides whether
 * the session gets a persistent consumer at all.
 */
export type SessionConsumerOptions = Omit<ConsumerContext, 'spaceId' | 'conversationId'>

async function getOrCreateV2SessionInner(
  spaceId: string,
  conversationId: string,
  sdkOptions: Record<string, any>,
  sessionId?: string,
  workDir?: string,
  consumerOptions?: SessionConsumerOptions,
  resolvedKbIds?: string[],
  buildMcpServers?: () => Record<string, unknown> | null,
  resolveKnowledgeBases?: () => KBReference[]
): Promise<V2SessionInfo['session']> {
  // Per-conversation credential/model fingerprint — used to rebuild this
  // conversation's session when its own model pin changes (the global
  // credentialsGeneration only tracks the current source's model).
  const currentFingerprint = computeCredentialsFingerprint(sdkOptions)
  // Knowledge context baked into the system prompt at creation. Not part of the
  // credentials fingerprint, so tracked separately to rebuild a session whose
  // resolved KB set or working directory has diverged (attach/detach, indexing
  // completed after creation, or a KB-chat/normal turn switch).
  const currentKnowledgeFingerprint = computeKnowledgeFingerprint(resolvedKbIds, workDir)
  // Tool set + system prompt baked in eagerly by app chat / automation runs.
  // Main chat builds MCP servers lazily (buildMcpServers) and drives toolset
  // changes via requestSessionRebuild, so it opts out to avoid double-handling.
  const currentInputsFingerprint = buildMcpServers
    ? undefined
    : computeSessionInputsFingerprint(sdkOptions)

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
    } else if (hasConsumablePendingRebuild(conversationId)) {
      // A rebuild was flagged while the session was busy or mid-creation and the
      // consumer has not hit a turn boundary since (it only consumes the flag at
      // turn end). Without this check the reuse path would ship one more turn on
      // the stale session — the "toolset toggle takes effect one turn late" bug.
      console.log(`[Agent][${conversationId}] Pending rebuild flagged and session idle — rebuilding now`)
      closeV2SessionForRebuild(conversationId)
      // Fall through to create new session (cleanup cleared the pending flag)
    } else {
      // Check if credentials have changed since session was created
      // This catches race conditions where session was created with stale credentials
      // (e.g., warm-up started before config save completed)
      const currentGen = getCredentialsGeneration()
      const needsCredentialRebuild =
        existing.credentialsGeneration !== currentGen ||
        existing.credentialsFingerprint !== currentFingerprint ||
        existing.knowledgeFingerprint !== currentKnowledgeFingerprint ||
        existing.inputsFingerprint !== currentInputsFingerprint

      if (needsCredentialRebuild) {
        const consumer = consumers.get(conversationId)

        // Guard 0: A user turn is dispatched but not yet acknowledged by
        // system:init — the consumer looks idle, but rebuilding now (e.g. a
        // warm-up racing a just-sent message after a model switch) would
        // destroy the in-flight message. Defer like Guard 1.
        if (turnsAwaitingInit.has(conversationId)) {
          pendingConsumerRebuilds.add(conversationId)
          console.log(
            `[Agent][${conversationId}] Session rebuild deferred — a dispatched turn is awaiting system:init.`
          )
          existing.lastUsedAt = Date.now()
          return existing.session
        }

        // Guard 1: Consumer is actively processing a turn (mid-API-call, mid-tool, etc.)
        // Killing it now would destroy the in-flight response — the user loses the answer.
        // Instead, mark for deferred rebuild: the consumer checks pendingConsumerRebuilds
        // after each turn completes (session-consumer.ts consumePendingRebuild) and breaks
        // its loop, triggering a clean rebuild on the next sendMessage.
        const isActivelyProcessing = consumer?.isRunning && consumer.getActiveSessionState() !== null
        if (isActivelyProcessing) {
          pendingConsumerRebuilds.add(conversationId)
          console.log(
            `[Agent][${conversationId}] Session rebuild deferred — consumer is actively processing a turn ` +
            `(gen ${existing.credentialsGeneration}→${currentGen}). Will rebuild after turn completes.`
          )
          existing.lastUsedAt = Date.now()
          return existing.session
        }

        // Guard 2: Consumer is idle between turns but CC subprocess has active team agents.
        // Their results arrive as a future autonomous turn. Killing the session now would
        // abort all in-flight agent tasks.
        const isIdleBetweenTurns = consumer?.isRunning && !consumer.getActiveSessionState()
        if (isIdleBetweenTurns && hasActiveTeamTasks(consumer!.getTeamLifecycleThoughts())) {
          // A pending rebuild flag (credential or toolset change) is safe to keep:
          // the consumer only consumes it once no team tasks remain (consumeLoop),
          // so it cannot break the loop mid-team while messages are queued.
          console.log(
            `[Agent][${conversationId}] Session rebuild deferred — active team agents detected ` +
            `(gen ${existing.credentialsGeneration}→${currentGen}). Will rebuild after team tasks complete.`
          )
          existing.lastUsedAt = Date.now()
          return existing.session
        }

        // No active processing and no team agents — safe to rebuild now.
        console.log(`[Agent][${conversationId}] Session inputs changed (gen ${existing.credentialsGeneration}→${currentGen}, fp ${existing.credentialsFingerprint}→${currentFingerprint}, kb ${existing.knowledgeFingerprint}→${currentKnowledgeFingerprint}, tools ${existing.inputsFingerprint ?? '∅'}→${currentInputsFingerprint ?? '∅'}), recreating session`)
        closeV2SessionForRebuild(conversationId)
        // Fall through to create new session
      } else {
        // Session is alive and credentials are current, reuse it
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

  if (buildMcpServers) {
    const record = buildMcpServers()
    if (record && Object.keys(record).length > 0) {
      sdkOptions.mcpServers = record
    } else {
      delete sdkOptions.mcpServers
    }
  }
  assertMcpInstancesUnbound(conversationId, sdkOptions.mcpServers)

  // A stale CC auth record makes the CLI skip a URL-based MCP server outright —
  // no request is sent and only an `authenticate` tool is exposed. Clear those
  // before the process spawns so the session starts with the full tool set.
  // Chat supplies servers through buildMcpServers and automations set them on
  // sdkOptions directly; both have converged by this point.
  await purgeStaleMcpOAuth(sdkOptions.mcpServers, `session:${conversationId}`)

  if (resolveKnowledgeBases && typeof sdkOptions.systemPrompt === 'string') {
    sdkOptions.systemPrompt += buildKnowledgeSection(resolveKnowledgeBases())
  }

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
  // resolved-sdk handles sdkEngine switch (Halo SDK vs CC SDK) transparently.
  // Mark the creation window so a toolset toggle arriving during this await is
  // not lost (see requestSessionRebuild / sessionsUnderCreation).
  sessionsUnderCreation.add(conversationId)
  let session: V2SDKSession
  try {
    session = (await createSession(sdkOptions)) as unknown as V2SDKSession
  } finally {
    sessionsUnderCreation.delete(conversationId)
  }

  // Log PID for health system verification (via SDK patch)
  const pid = (session as any).pid
  console.log(`[Agent][${conversationId}] V2 session created in ${Date.now() - startTime}ms, PID: ${pid ?? 'unavailable'}`)

  const sdkEnv = ((sdkOptions as Record<string, unknown>).env || {}) as Record<string, string | undefined>
  console.log(`[Agent] session_create conv=${conversationId} pid=${pid ?? ''} model=${sdkOptions.model || ''} base_url=${sdkEnv.ANTHROPIC_BASE_URL || ''}`)
  console.log(`[SDK Config] session_env conv=${conversationId} ANTHROPIC_BASE_URL=${sdkEnv.ANTHROPIC_BASE_URL || ''} ANTHROPIC_API_KEY=${maskSecretForLog(sdkEnv.ANTHROPIC_API_KEY)} HTTP_PROXY=${sdkEnv.HTTP_PROXY || ''} HTTPS_PROXY=${sdkEnv.HTTPS_PROXY || ''} NO_PROXY=${sdkEnv.NO_PROXY || ''}`)

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
  const exitUnsubscribe = registerProcessExitListener(session, conversationId)

  // Store session with current credentials generation
  // Generation is used to detect stale credentials on session reuse
  v2Sessions.set(conversationId, {
    session,
    spaceId,
    conversationId,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    credentialsGeneration: getCredentialsGeneration(),
    credentialsFingerprint: currentFingerprint,
    knowledgeFingerprint: currentKnowledgeFingerprint,
    inputsFingerprint: currentInputsFingerprint,
    exitUnsubscribe
  })

  // Start cleanup if not already running
  startSessionCleanup()

  // Start the persistent consumer for surfaces that supplied a sink (space chat,
  // app chat). Automation runs drive their own processStream() and pass none, so
  // nothing competes for the stream.
  if (consumerOptions) {
    const consumer = startConsumer(session, { spaceId, conversationId, ...consumerOptions })
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

  // Get API credentials (per-conversation pin, falling back to global) and resolve for SDK use.
  // Must match sendMessage's resolution exactly so the warmed session isn't
  // immediately rebuilt on the first message (fingerprint mismatch).
  const credentials = await getApiCredentialsForConversation(config, conversation)
  console.log(`[Agent] Session warm using: ${credentials.provider}, model: ${credentials.model}`)

  // Resolve credentials for SDK (handles OpenAI compat router for non-Anthropic providers)
  const resolvedCredentials = await resolveCredentialsForSdk(credentials)

  // Creation-time MCP servers: assembled lazily at actual session creation
  // (must match sendMessage exactly to avoid a session rebuild on the first message).
  const buildMcpServers = (): Record<string, unknown> | null => {
    const dbMcpServers = getDbMcpServers(spaceId)
    const record: Record<string, unknown> = dbMcpServers ? { ...dbMcpServers } : {}
    Object.assign(record, buildCreationTimeServers({ spaceId, conversationId, workDir }))
    return Object.keys(record).length > 0 ? record : null
  }

  // Knowledge context. Must match sendMessage exactly: the first turn reuses
  // this warm session (fingerprint unchanged), so a warm session built without
  // knowledge would leave the KB out of the model's context for the whole
  // session. Ids are resolved cheaply here for the fingerprint; the index
  // content is read only if a session is actually created.
  const resolvedKbIds = resolveConversationKnowledgeBaseIds(conversation)
  const resolveKnowledgeBases = (): KBReference[] => resolveConversationKnowledgeBases(conversation)

  // Build SDK options using shared configuration
  const sdkOptions = await buildBaseSdkOptions({
    // Must match send-message.ts: a warmed session is reused for the first
    // turn, so deriving this differently there would hand that turn a process
    // whose credentials disagree with its tools.
    selfApiAccess: getOpenToolsets(spaceId, conversationId).has(HALO_API_TOOLSET_ID),
    credentials: resolvedCredentials,
    workDir,
    electronPath,
    spaceId,
    conversationId,
    stderrHandler: (data: string) => {
      console.error(`[Agent][${conversationId}] CLI stderr (warm):`, data)
    },
    maxTurns: config.agent?.maxTurns,
    promptProfile: config.agent?.promptProfile,
    configDirMode: config.agent?.configDirMode,
    customConfigDir: config.agent?.customConfigDir,
    enableTeams: config.agent?.enableTeams,
    disabledTools: config.agent?.disabledTools,
    digitalHumansEnabled,
    toolsetIndex: buildToolsetSection(spaceId, conversationId),
  })

  applySessionReasoningEffort(sdkOptions, resolvedCredentials.capabilities)

  try {
    const session = await getOrCreateV2Session(
      spaceId, conversationId, sdkOptions, sessionId, workDir,
      {
        displayModel: resolvedCredentials.displayModel,
        contextWindow: resolvedCredentials.capabilities?.contextWindow,
        sink: createConversationSink(spaceId, conversationId),
      },
      resolvedKbIds,
      buildMcpServers,
      resolveKnowledgeBases
    )

    // Ensure consumer's displayModel is up-to-date (same as sendMessage)
    updateConsumerDisplayModel(
      conversationId, resolvedCredentials.displayModel, resolvedCredentials.capabilities?.contextWindow
    )

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
export function updateConsumerDisplayModel(
  conversationId: string,
  displayModel: string,
  contextWindow?: number
): void {
  const consumer = consumers.get(conversationId)
  if (consumer) {
    consumer.updateDisplayModel(displayModel, contextWindow)
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
