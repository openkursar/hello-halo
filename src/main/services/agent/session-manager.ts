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
import { onApiConfigChange, getCredentialsGeneration, type ApiConfigChange } from '../../foundation/config.service'
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
import { onMcpServerRecovered } from './mcp-manager'
import { emitAgentEvent } from './events'
import { registerProcess, unregisterProcess, getCurrentInstanceId } from '../health'
import { resolveCredentialsForSdk, buildUserSessionSdkOptions, computeCredentialsFingerprint, computeSessionInputsFingerprint, getSdkSourceId } from './sdk-config'
import { resolveSpaceMemorySession } from './space-memory'
import { applySessionReasoningEffort, pickReasoningEffort } from './reasoning-effort'
import { startConsumer, type ConsumerHandle, type ConsumerContext } from './session-consumer'
import { createConversationSink } from './conversation-sink'
import { hasActiveTeamTasks } from './subagent-handler'
import { setSessionInvalidator, buildCreationTimeServers } from './toolsets/broker'
import { buildToolsetSection } from './toolsets/capability-index'
import { dropConversationState, getOpenToolsets } from './toolsets/state'
import { applyGoalDraft } from './goal/draft'
import { HALO_API_TOOLSET_ID } from '../api-ref'
import { resolveConversationKnowledgeBases, resolveConversationKnowledgeBaseIds } from './knowledge-context'
import { appendToSystemPrompt, buildKnowledgeSection } from './system-prompt'
import { assertWorkingDirCurrent } from './working-dir'
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
 * Used by headless callers (execute.ts). Consumer-based chat
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
    if (sessionsUnderCreation.has(conversationId) || inFlightSessionCreations.has(conversationId)) {
      pendingConsumerRebuilds.add(conversationId)
    }
    return
  }

  if (inFlightSessionCreations.has(conversationId)) {
    pendingConsumerRebuilds.add(conversationId)
    return
  }

  // Legacy callers (app-chat/execute) close on turn idle via unregisterActiveSession.
  if (activeSessions.has(conversationId)) {
    pendingInvalidations.add(conversationId)
    return
  }

  // Preparation and dispatch precede system:init, so the consumer still looks idle.
  if (sessionLeases.has(conversationId) || turnsAwaitingInit.has(conversationId)) {
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

  // Background results arrive through this same consumer as later turns.
  if (consumer?.isRunning && (consumer.hasRunningTasks() || hasActiveTeamTasks(consumer.getTeamLifecycleThoughts()))) {
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

interface ManagedSessionLease extends V2SessionLease {
  readonly awaitingInit: boolean
  acknowledge(): boolean
  failBeforeInit(error: Error): boolean
}

const sessionLeases = new Map<string, Set<V2SessionLease>>()
const pendingSessionTurns = new WeakMap<V2SDKSession, Set<ManagedSessionLease>>()

/** Holds the acquired instance through preparation; dispatch transfers protection to the consumer. */
export interface V2SessionLease {
  readonly session: V2SDKSession
  /** Instance ownership, independent of whether dispatch released its reservation. */
  readonly isCurrent: boolean
  /** Reports a rejection synchronously before cleanup, only while this instance is current. */
  send(message: Parameters<V2SDKSession['send']>[0], onFailure?: (error: unknown) => void): Promise<void>
  release(): void
  close(): void
}

function leaseSession(
  conversationId: string,
  session: V2SDKSession,
  onFailureBeforeInit?: (error: Error) => void
): V2SessionLease {
  if (v2Sessions.get(conversationId)?.session !== session) {
    console.warn(`[Agent][${conversationId}] Session acquisition discarded: the instance was closed or replaced`)
    throw new Error('The acquired session is no longer available')
  }
  const holders = sessionLeases.get(conversationId) ?? new Set<V2SessionLease>()
  // Reservations end at SDK acceptance; failure ownership lasts until system:init.
  const pending = pendingSessionTurns.get(session) ?? new Set<ManagedSessionLease>()
  let dispatched = false
  let acknowledged = false
  let failed = false
  const lease: ManagedSessionLease = {
    session,
    get isCurrent() {
      return !failed && v2Sessions.get(conversationId)?.session === session
    },
    get awaitingInit() { return dispatched && !acknowledged },
    acknowledge() {
      if (!dispatched) return false
      acknowledged = true
      pending.delete(lease)
      return true
    },
    failBeforeInit(error) {
      if (!pending.delete(lease)) return false
      failed = true
      try {
        onFailureBeforeInit?.(error)
      } catch (reportError) {
        console.error(`[Agent][${conversationId}] Pre-init failure reporting failed:`, reportError)
      }
      return Boolean(onFailureBeforeInit)
    },
    async send(message, onFailure) {
      if (failed || !holders.has(lease) || v2Sessions.get(conversationId)?.session !== session) {
        console.warn(`[Agent][${conversationId}] Turn dispatch refused: its session lease is no longer current`)
        throw new Error('The acquired session is no longer available')
      }
      dispatched = true
      pending.delete(lease)
      pending.add(lease)
      markTurnDispatched(conversationId)
      try {
        await session.send(message)
      } catch (error) {
        pending.delete(lease)
        if (!failed && lease.isCurrent) {
          try {
            onFailure?.(error)
          } catch (reportError) {
            console.error(`[Agent][${conversationId}] Dispatch failure reporting failed:`, reportError)
          }
        } else {
          console.warn(`[Agent][${conversationId}] Discarded retired session's dispatch failure; original caller still receives the rejection`)
        }
        lease.close()
        throw error
      } finally {
        lease.release()
      }
    },
    release() {
      if (!dispatched || acknowledged) pending.delete(lease)
      if (sessionLeases.get(conversationId) !== holders || !holders.delete(lease)) return
      if (holders.size === 0) sessionLeases.delete(conversationId)
      if (v2Sessions.get(conversationId)?.session === session &&
        hasConsumablePendingRebuild(conversationId) && !inFlightSessionCreations.has(conversationId)) {
        requestSessionRebuild(conversationId, 'pending rebuild after session lease release')
      }
    },
    close() {
      if (sessionLeases.get(conversationId) === holders && holders.has(lease) &&
        v2Sessions.get(conversationId)?.session === session) {
        closeV2SessionForRebuild(conversationId, 'leased session cleanup')
      }
    },
  }
  holders.add(lease)
  sessionLeases.set(conversationId, holders)
  pending.add(lease)
  pendingSessionTurns.set(session, pending)
  return lease
}

/** Settles this instance's unacknowledged callers before any successor can be published. */
export function failPendingSessionTurns(conversationId: string, error: Error): boolean {
  const session = v2Sessions.get(conversationId)?.session
  const pending = session && pendingSessionTurns.get(session)
  if (!pending) return false
  let reported = false
  for (const lease of [...pending]) reported = lease.failBeforeInit(error) || reported
  return reported
}

/** Called right before dispatching a user turn to the REPL. */
export function markTurnDispatched(conversationId: string): void {
  turnsAwaitingInit.add(conversationId)
}

/** Called by the session consumer when CC acknowledges the turn (system:init). */
export function markTurnInitReceived(conversationId: string): void {
  turnsAwaitingInit.delete(conversationId)
  const session = v2Sessions.get(conversationId)?.session
  if (!session) return
  const pending = pendingSessionTurns.get(session)
  if (!pending) return
  // SDK turns are correlated by dispatch order, not by a request id.
  for (const lease of pending) {
    if (lease.acknowledge()) break
  }
  if ([...pending].some(lease => lease.awaitingInit)) turnsAwaitingInit.add(conversationId)
}

/**
 * Check if a session is busy (has an in-flight request).
 * Covers caller-held leases, headless activeSessions and
 * consumer-based chat conversations. A consumer idle between turns whose team
 * agents are still working counts as busy: tearing it down would lose their
 * results.
 */
export function isSessionBusy(conversationId: string): boolean {
  if (sessionLeases.has(conversationId) || activeSessions.has(conversationId)) return true
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
 * @param failure - Unexpected termination to settle pending messages before replacement
 */
function cleanupSession(conversationId: string, reason: string, failure?: Error): void {
  const info = v2Sessions.get(conversationId)
  if (!info) return

  console.log(`[Agent][${conversationId}] Cleaning up session: ${reason}`)

  // Stop the persistent consumer first (if any)
  const consumer = consumers.get(conversationId)
  if (consumer) {
    consumer.stop()
    consumers.delete(conversationId)
    console.log(`[Agent][${conversationId}] Consumer stopped during cleanup`)
  }
  if (failure) failPendingSessionTurns(conversationId, failure)
  pendingSessionTurns.delete(info.session)
  pendingConsumerRebuilds.delete(conversationId)
  pendingInvalidations.delete(conversationId)
  if (!mcpRebuildRequested.delete(conversationId)) mcpRebuildsSpent.delete(conversationId)

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
  sessionLeases.delete(conversationId)
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
        if (current?.session !== session) {
          console.warn(`[Agent][${conversationId}] Ignoring exit of a closed or replaced session's process`)
          return
        }
        const errorMsg = error ? `: ${error.message}` : ''
        cleanupSession(conversationId, `process exited${errorMsg}`, error ?? new Error('Chat session ended before the message was processed.'))
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
        cleanupSession(convId, 'process not ready (polling fallback)', new Error('Chat session ended before the message was processed.'))
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

// ============================================
// Resident Session Limit
// ============================================

/**
 * Upper bound on resident sessions (one engine process each), set by the owner
 * of the budget policy (apps/runtime). null = unlimited.
 */
let residentSessionLimit: number | null = null
let overLimitWarned = false
let evictionCount = 0

export interface ResidentSessionInfo {
  conversationId: string
  spaceId: string
  lastUsedAt: number
  /** Mid-turn, awaiting init, holding team agents or background tasks, or being created — never evicted. */
  busy: boolean
}

/**
 * A task CC started in the background (a shell, agent or workflow) reports back
 * as a later turn of this session; evicting it would kill the task. The idle
 * sweep does not consult this, so a task whose completion never arrives cannot
 * pin the process forever.
 */
function hasRunningTasks(conversationId: string): boolean {
  const consumer = consumers.get(conversationId)
  return !!consumer?.isRunning && consumer.hasRunningTasks()
}

function isEvictionUnsafe(conversationId: string): boolean {
  return isSessionBusy(conversationId)
    || hasRunningTasks(conversationId)
    || turnsAwaitingInit.has(conversationId)
    || sessionsUnderCreation.has(conversationId)
    || inFlightSessionCreations.has(conversationId)
}

export function listResidentSessions(): ResidentSessionInfo[] {
  return Array.from(v2Sessions.values()).map((info) => ({
    conversationId: info.conversationId,
    spaceId: info.spaceId,
    lastUsedAt: info.lastUsedAt,
    busy: isEvictionUnsafe(info.conversationId),
  }))
}

/**
 * Close an idle resident session to free its engine process. Refuses busy or
 * in-creation sessions. The conversation resumes from its stored session id on
 * its next turn, exactly as after the idle-timeout sweep.
 */
export function evictIdleSession(conversationId: string, reason: string): boolean {
  if (!v2Sessions.has(conversationId) || isEvictionUnsafe(conversationId)) return false
  cleanupSession(conversationId, `evicted: ${reason}`)
  evictionCount += 1
  return true
}

/** The resident limit in force (null = unlimited), for performance reporting. */
export function getResidentSessionLimit(): number | null {
  return residentSessionLimit
}

/** Idle sessions evicted since process start (for performance reporting). */
export function getSessionEvictionCount(): number {
  return evictionCount
}

export function setResidentSessionLimit(limit: number | null): void {
  residentSessionLimit = limit === null ? null : Math.max(1, Math.floor(limit))
  overLimitWarned = false
}

/**
 * Before a new session is created, evict least-recently-used idle sessions
 * until one more fits under the limit. When every resident session is busy the
 * new one is created over the limit (never refused); warned once per crossing.
 */
function enforceResidentSessionLimit(creatingConversationId: string): void {
  const limit = residentSessionLimit
  if (limit === null) return
  const candidates = Array.from(v2Sessions.values())
    .filter((info) => info.conversationId !== creatingConversationId)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
  let resident = candidates.length
  for (const info of candidates) {
    if (resident < limit) break
    if (evictIdleSession(info.conversationId, `resident session limit ${limit}`)) resident -= 1
  }
  if (resident >= limit) {
    if (!overLimitWarned) {
      overLimitWarned = true
      console.warn(`[Agent] Resident sessions over limit: ${resident + 1}/${limit}, all others busy`)
    }
  } else {
    overLimitWarned = false
  }
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
function closeV2SessionForRebuild(conversationId: string, reason = 'rebuild required', failure?: Error): void {
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
  cleanupSession(conversationId, reason, failure)
}

/**
 * True when a deferred rebuild is flagged for this conversation AND the session
 * is safely idle (no dispatched-but-unacknowledged turn, no active turn, no
 * running background or team tasks) — i.e. the flag can be applied right now instead of
 * waiting for the consumer's next turn boundary.
 */
function hasConsumablePendingRebuild(conversationId: string): boolean {
  if (!pendingConsumerRebuilds.has(conversationId)) return false
  if (sessionLeases.has(conversationId) || activeSessions.has(conversationId)) return false
  if (turnsAwaitingInit.has(conversationId)) return false
  const consumer = consumers.get(conversationId)
  if (consumer?.isRunning && consumer.getActiveSessionState()) return false
  if (consumer?.isRunning && (consumer.hasRunningTasks() || hasActiveTeamTasks(consumer.getTeamLifecycleThoughts()))) return false
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
 * @param gates - Conditions the returned session must actually meet. See
 *   {@link SessionGates}.
 */
export function getOrCreateV2Session(
  spaceId: string,
  conversationId: string,
  sdkOptions: Record<string, any>,
  sessionId?: string,
  workDir?: string,
  consumer?: SessionConsumerOptions,
  resolvedKbIds?: string[],
  buildMcpServers?: () => Record<string, unknown> | null,
  resolveKnowledgeBases?: () => KBReference[],
  gates?: SessionGates
): Promise<V2SessionInfo['session']> {
  return getOrCreateSessionResult(
    spaceId, conversationId, sdkOptions, sessionId, workDir,
    consumer, resolvedKbIds, buildMcpServers, resolveKnowledgeBases, gates
  )
}

/** Acquires protection before handoff. Pre-init failure settles before replacement; always release in finally. */
export async function acquireV2Session(
  spaceId: string,
  conversationId: string,
  sdkOptions: Record<string, any>,
  sessionId?: string,
  workDir?: string,
  consumer?: SessionConsumerOptions,
  resolvedKbIds?: string[],
  buildMcpServers?: () => Record<string, unknown> | null,
  resolveKnowledgeBases?: () => KBReference[],
  gates?: SessionGates,
  onFailureBeforeInit?: (error: Error) => void
): Promise<V2SessionLease> {
  const request: SessionLeaseRequest = { onFailureBeforeInit }
  await getOrCreateSessionResult(
    spaceId, conversationId, sdkOptions, sessionId, workDir,
    consumer, resolvedKbIds, buildMcpServers, resolveKnowledgeBases, gates, request
  )
  return request.lease!
}

interface SessionLeaseRequest {
  lease?: V2SessionLease
  onFailureBeforeInit?: (error: Error) => void
}

async function getOrCreateSessionResult(
  spaceId: string,
  conversationId: string,
  sdkOptions: Record<string, any>,
  sessionId?: string,
  workDir?: string,
  consumer?: SessionConsumerOptions,
  resolvedKbIds?: string[],
  buildMcpServers?: () => Record<string, unknown> | null,
  resolveKnowledgeBases?: () => KBReference[],
  gates?: SessionGates,
  leaseRequest?: SessionLeaseRequest
): Promise<V2SessionInfo['session']> {
  assertWorkingDirCurrent(spaceId, workDir ?? sdkOptions.cwd)

  // Concurrent calls for the same conversation (a fire-and-forget
  // ensureSessionWarm racing the first sendMessage) must not both reach
  // createSession: the loser's v2Sessions.set/registerProcess would overwrite
  // the winner's, leaking an orphan CC process whose exit listener then tears
  // down the healthy session by conversationId. Latecomers share the in-flight
  // result; if their inputs differ (credentials/KB changed mid-flight), the
  // fingerprint check on the next call reconciles with a rebuild.
  //
  // Account switches never share; a request must not inherit another source.
  // Also, when the latecomer's options are a restriction (requireFreshInputs):
  // "reconciles on the next call" is exactly the deferral that gate exists to
  // refuse — the shared session would run this request with whatever the
  // creation in flight was built with. Share only on a matching inputs
  // fingerprint; otherwise wait the creation out and re-evaluate against the
  // finished session, where the existing stale check applies.
  const inFlight = inFlightSessionCreations.get(conversationId)
  if (inFlight) {
    const sameSource = inFlight.sourceId === getSdkSourceId(sdkOptions)
    const shareable = sameSource && (
      !gates?.requireFreshInputs ||
      (inFlight.inputsFingerprint !== undefined &&
        inFlight.inputsFingerprint === computeSessionInputsFingerprint(sdkOptions))
    )
    if (shareable) {
      if (leaseRequest) {
        if (inFlight.session) leaseRequest.lease = leaseSession(conversationId, inFlight.session, leaseRequest.onFailureBeforeInit)
        else inFlight.leaseRequests.add(leaseRequest)
      }
      console.log(`[Agent][${conversationId}] Session creation already in flight, sharing result`)
      return inFlight.promise
    }
    console.warn(
      `[Agent][${conversationId}] Session creation in flight was built on a different source or restricted inputs; ` +
      `waiting it out instead of sharing`
    )
    await inFlight.promise.catch(() => undefined)
    // The creator's own finally may not have run yet; clear the settled entry
    // (identity-checked) so the re-entry below does not share it after all.
    if (inFlightSessionCreations.get(conversationId) === inFlight) {
      inFlightSessionCreations.delete(conversationId)
    }
    return getOrCreateSessionResult(
      spaceId, conversationId, sdkOptions, sessionId, workDir,
      consumer, resolvedKbIds, buildMcpServers, resolveKnowledgeBases, gates, leaseRequest
    )
  }

  const leaseRequests = new Set<SessionLeaseRequest>(leaseRequest ? [leaseRequest] : [])
  const promise = getOrCreateV2SessionInner(
    spaceId, conversationId, sdkOptions, sessionId, workDir,
    consumer, resolvedKbIds, buildMcpServers, resolveKnowledgeBases, gates
  ).then(session => {
    record.session = session
    for (const request of leaseRequests) request.lease = leaseSession(conversationId, session, request.onFailureBeforeInit)
    return session
  })
  const record: InFlightSessionCreation = {
    spaceId,
    promise,
    leaseRequests,
    // Same opt-out as the fingerprint stored on the session: a lazy-MCP caller
    // (main chat) has no eager inputs to hash, and no gated caller either.
    inputsFingerprint: buildMcpServers ? undefined : computeSessionInputsFingerprint(sdkOptions),
    sourceId: getSdkSourceId(sdkOptions),
  }
  inFlightSessionCreations.set(conversationId, record)
  try {
    return await promise
  } finally {
    // Identity-checked: a gated latecomer may have already cleared this entry
    // and started its own creation, which must not be deleted underneath it.
    if (inFlightSessionCreations.get(conversationId) === record) {
      inFlightSessionCreations.delete(conversationId)
    }
  }
}

interface InFlightSessionCreation {
  spaceId: string
  promise: Promise<V2SessionInfo['session']>
  leaseRequests: Set<SessionLeaseRequest>
  session?: V2SDKSession
  sourceId?: string
  /** Inputs the creation was invoked with; undefined for lazy-MCP callers. */
  inputsFingerprint: string | undefined
}

/** conversationId -> in-flight getOrCreateV2Session creation. */
const inFlightSessionCreations = new Map<string, InFlightSessionCreation>()

/**
 * Consumer wiring for a newly created session. Grouped rather than passed as
 * loose positional arguments because these three values only ever travel
 * together, and their presence — not their content — is what decides whether
 * the session gets a persistent consumer at all.
 */
export type SessionConsumerOptions = Omit<ConsumerContext, 'spaceId' | 'conversationId'>

/** Conditions a caller needs the returned session to actually meet. */
export interface SessionGates {
  /**
   * Refuse rather than hand back a busy session built on different inputs
   * (system prompt, MCP set, permission rules — computeSessionInputsFingerprint).
   *
   * Reuse normally defers a rebuild while the session is busy and returns the
   * existing one — right for a model or knowledge change, where one more turn
   * on the old settings costs nothing. It is wrong when the options ARE the
   * restriction a turn must run under: the deferral would run somebody else's
   * request with the permissions of whoever used the session last.
   */
  requireFreshInputs?: boolean
  /**
   * Creation-time context outside the knowledge set that decides what the
   * session was built with (for space chat: whether the space's memory was on).
   * A different value rebuilds the session like a knowledge change does, so a
   * session warmed before a setting flipped never serves a turn built after it.
   */
  creationContext?: string
}

/**
 * Thrown when a busy session cannot serve the request: its gated inputs
 * changed ({@link SessionGates.requireFreshInputs}) or it runs on another
 * account. Nothing was sent; the request can be sent again once the session
 * is free.
 */
export class SessionOptionsStaleError extends Error {
  constructor(conversationId: string, reason: 'restricted-inputs' | 'source-switch') {
    super(reason === 'source-switch'
      ? 'This conversation is still busy on its previous account (a reply or background task is running), ' +
        'so this message was not sent. Send it again when that finishes, stop the running task, ' +
        'or start a new conversation to use the new account now.'
      : `The digital human is still busy with earlier work, so this request was not started. ` +
        `Try again once it finishes (conversation ${conversationId}).`)
    this.name = 'SessionOptionsStaleError'
  }
}

/**
 * The conditions under which a needed rebuild is deferred instead of performed,
 * one per guard in getOrCreateV2SessionInner. requireFreshInputs refuses changed
 * inputs exactly when any of them holds — computed here as the single source so a new
 * or changed guard cannot leave the refusal behind, which would silently run a
 * gated request on the previous caller's options (DESIGN.md hard rule 9).
 */
function assessRebuildDeferral(
  conversationId: string,
  consumer: ConsumerHandle | undefined
): { leased: boolean; awaitingInit: boolean; activeTurn: boolean; idleWithTeamTasks: boolean; backgroundTasks: boolean; any: boolean } {
  const leased = sessionLeases.has(conversationId)
  const awaitingInit = turnsAwaitingInit.has(conversationId)
  const activeTurn = activeSessions.has(conversationId) || Boolean(consumer?.isRunning && consumer.getActiveSessionState() !== null)
  const idleWithTeamTasks = Boolean(
    consumer?.isRunning &&
      !consumer.getActiveSessionState() &&
      hasActiveTeamTasks(consumer.getTeamLifecycleThoughts())
  )
  const backgroundTasks = Boolean(consumer?.isRunning && consumer.hasRunningTasks())
  return {
    leased,
    awaitingInit,
    activeTurn,
    idleWithTeamTasks,
    backgroundTasks,
    any: leased || awaitingInit || activeTurn || idleWithTeamTasks || backgroundTasks,
  }
}

async function getOrCreateV2SessionInner(
  spaceId: string,
  conversationId: string,
  sdkOptions: Record<string, any>,
  sessionId?: string,
  workDir?: string,
  consumerOptions?: SessionConsumerOptions,
  resolvedKbIds?: string[],
  buildMcpServers?: () => Record<string, unknown> | null,
  resolveKnowledgeBases?: () => KBReference[],
  gates?: SessionGates
): Promise<V2SessionInfo['session']> {
  const sourceId = getSdkSourceId(sdkOptions)
  // Capture before any async creation work; never stamp a newer epoch on old options.
  const creationCredentialsGeneration = sdkOptions.credentialsGeneration ?? getCredentialsGeneration(sourceId)
  const currentFingerprint = computeCredentialsFingerprint(sdkOptions)
  // Knowledge context baked into the system prompt at creation. Not part of the
  // credentials fingerprint, so tracked separately to rebuild a session whose
  // resolved KB set or working directory has diverged (attach/detach, indexing
  // completed after creation, or a KB-chat/normal turn switch).
  const currentKnowledgeFingerprint =
    computeKnowledgeFingerprint(resolvedKbIds, workDir) + (gates?.creationContext ? `::${gates.creationContext}` : '')
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
      console.warn(`[Agent][${conversationId}] Session transport not ready (process dead), recreating...`)
      closeV2SessionForRebuild(conversationId, 'process not ready on acquisition', new Error('Chat session ended before the message was processed.'))
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
      const currentGen = getCredentialsGeneration(existing.sourceId)
      const needsCredentialRebuild =
        existing.sourceId !== sourceId ||
        existing.credentialsGeneration !== currentGen ||
        existing.credentialsFingerprint !== currentFingerprint ||
        existing.knowledgeFingerprint !== currentKnowledgeFingerprint ||
        existing.inputsFingerprint !== currentInputsFingerprint

      if (needsCredentialRebuild) {
        const consumer = consumers.get(conversationId)
        const deferral = assessRebuildDeferral(conversationId, consumer)

        // The guards below trade correctness-now for not destroying work in
        // flight, and hand back the session as it stands. A caller whose options
        // ARE a restriction cannot take that trade for those options — running
        // one more turn on the old ones is exactly the thing being prevented — so
        // it is told the session is not available instead. A credential or model
        // change on the same source still defers. A source switch fails closed.
        const restrictedInputsChanged = gates?.requireFreshInputs === true &&
          existing.inputsFingerprint !== currentInputsFingerprint
        if ((restrictedInputsChanged || existing.sourceId !== sourceId) && deferral.any) {
          pendingConsumerRebuilds.add(conversationId)
          console.warn(
            `[Agent][${conversationId}] Refusing to reuse a busy session: ` +
            `${restrictedInputsChanged ? 'restricted inputs changed' : `source changed ${existing.sourceId ?? 'legacy'}→${sourceId ?? 'legacy'}`}; ` +
            `the request was not started.`
          )
          throw new SessionOptionsStaleError(conversationId, restrictedInputsChanged ? 'restricted-inputs' : 'source-switch')
        }

        if (deferral.leased) {
          if (!pendingConsumerRebuilds.has(conversationId)) {
            console.warn(`[Agent][${conversationId}] Session rebuild deferred: source=${sourceId ?? 'legacy'} preparation lease still held; retaining the acquired instance`)
          }
          pendingConsumerRebuilds.add(conversationId)
          existing.lastUsedAt = Date.now()
          return existing.session
        }

        // Guard 0: A user turn is dispatched but not yet acknowledged by
        // system:init — the consumer looks idle, but rebuilding now (e.g. a
        // warm-up racing a just-sent message after a model switch) would
        // destroy the in-flight message. Defer like Guard 1.
        if (deferral.awaitingInit) {
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
        if (deferral.activeTurn) {
          pendingConsumerRebuilds.add(conversationId)
          console.log(
            `[Agent][${conversationId}] Session rebuild deferred — consumer is actively processing a turn ` +
            `(gen ${existing.credentialsGeneration}→${currentGen}). Will rebuild after turn completes.`
          )
          existing.lastUsedAt = Date.now()
          return existing.session
        }

        // Idle background work still needs this receiver for its autonomous completion turns.
        if (deferral.idleWithTeamTasks || deferral.backgroundTasks) {
          console.log(
            `[Agent][${conversationId}] Session rebuild deferred — background or team work still needs its receiver ` +
            `(gen ${existing.credentialsGeneration}→${currentGen}). Will rebuild after tasks complete.`
          )
          pendingConsumerRebuilds.add(conversationId)
          existing.lastUsedAt = Date.now()
          return existing.session
        }

        // No active processing or outstanding tasks — safe to rebuild now.
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
  enforceResidentSessionLimit(conversationId)
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

  if (resolveKnowledgeBases && sdkOptions.systemPrompt != null) {
    sdkOptions.systemPrompt = appendToSystemPrompt(sdkOptions.systemPrompt, buildKnowledgeSection(resolveKnowledgeBases()))
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
  // Keyed on the recorded id, not effectiveSessionId: a resumable conversation
  // keeps its goal with the engine, even when its transcript went missing.
  if (!sessionId) {
    applyGoalDraft(sdkOptions, conversationId)
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

  // Keep the credential snapshot's version, even if config changed during creation.
  v2Sessions.set(conversationId, {
    session,
    spaceId,
    conversationId,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    sourceId,
    credentialsGeneration: creationCredentialsGeneration,
    credentialsFingerprint: currentFingerprint,
    knowledgeFingerprint: currentKnowledgeFingerprint,
    inputsFingerprint: currentInputsFingerprint,
  })
  const exitUnsubscribe = registerProcessExitListener(session, conversationId)
  const registered = v2Sessions.get(conversationId)
  if (registered?.session !== session) {
    exitUnsubscribe?.()
    throw new Error('The engine session ended during initialization')
  }
  registered.exitUnsubscribe = exitUnsubscribe
  if (!isSessionTransportReady(session)) {
    cleanupSession(conversationId, 'process ended during initialization')
    throw new Error('The engine session ended during initialization')
  }

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

  const workDir = getWorkingDir(spaceId)
  const conversation = getConversation(spaceId, conversationId)
  const sessionId = conversation?.sessionId
  const electronPath = getHeadlessElectronPath()

  // The conversation's pinned account, or the global selection when it has no pin.
  // Must match sendMessage's resolution exactly so the warmed session isn't
  // immediately rebuilt on the first message (fingerprint mismatch).
  const credentials = await getApiCredentialsForConversation(conversation)
  console.log(`[Agent] Session warm using: ${credentials.provider}, model: ${credentials.model}`)

  // Resolve credentials for SDK (handles OpenAI compat router for non-Anthropic providers).
  // The conversation's own level, as the first send will resolve it.
  const pickedEffort = pickReasoningEffort(conversation?.reasoningEffort)
  const resolvedCredentials = await resolveCredentialsForSdk(credentials, pickedEffort)

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
  const spaceMemory = resolveSpaceMemorySession(spaceId, conversationId)

  // Build SDK options using shared configuration
  const sdkOptions = await buildUserSessionSdkOptions({
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
    toolsetIndex: buildToolsetSection(spaceId, conversationId),
    // Must match send-message.ts, whose first turn reuses this session.
    memoryInstructions: spaceMemory?.instructions,
    memoryGuard: spaceMemory?.guard,
  })

  applySessionReasoningEffort(sdkOptions, resolvedCredentials.capabilities, pickedEffort)

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
      resolveKnowledgeBases,
      { creationContext: spaceMemory?.contextKey }
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
  mcpRebuildRequested.delete(conversationId)
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
  if (sessionLeases.has(conversationId) || turnsAwaitingInit.has(conversationId) ||
    inFlightSessionCreations.has(conversationId)) return false
  const consumer = consumers.get(conversationId)
  if (consumer?.isRunning && (consumer.hasRunningTasks() || hasActiveTeamTasks(consumer.getTeamLifecycleThoughts()))) return false
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
  for (const conversationId of inFlightSessionCreations.keys()) {
    requestSessionRebuild(conversationId, 'API config change')
  }
  const count = v2Sessions.size
  if (count === 0) {
    console.log('[Agent] No resident sessions to invalidate; in-flight creations marked for rebuild')
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

    if (sessionLeases.has(convId) || turnsAwaitingInit.has(convId)) {
      pendingConsumerRebuilds.add(convId)
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
 * Invalidate sessions belonging to a specific space: an MCP installed,
 * uninstalled, paused or resumed in it, or its working directory changed.
 *
 * Global MCP changes (spaceId=null) affect all spaces → use invalidateAllSessions() instead.
 * Space-scoped MCP changes only affect that space's sessions.
 *
 * Active (in-flight) sessions are deferred via pendingInvalidations,
 * consistent with invalidateAllSessions() behavior.
 *
 * @param reason - What changed, for the log
 */
export function invalidateSessionsForSpace(spaceId: string, reason = 'MCP change'): void {
  let count = 0
  for (const [convId, info] of Array.from(v2Sessions.entries())) {
    if (info.spaceId !== spaceId) continue

    // Legacy path (app-chat/execute): defer closing until unregisterActiveSession
    if (activeSessions.has(convId)) {
      pendingInvalidations.add(convId)
      console.log(`[Agent][${convId}] ${reason}: deferring session close until legacy turn idle`)
      count++
      continue
    }

    if (sessionLeases.has(convId) || turnsAwaitingInit.has(convId)) {
      pendingConsumerRebuilds.add(convId)
      count++
      continue
    }

    // Consumer path: mark for deferred rebuild after current turn completes
    const consumer = consumers.get(convId)
    if (consumer && consumer.isRunning) {
      pendingConsumerRebuilds.add(convId)
      console.log(`[Agent][${convId}] ${reason}: marking consumer session for rebuild`)
      count++
      continue
    }

    cleanupSession(convId, reason)
    count++
  }

  if (count > 0) {
    console.log(`[Agent] Invalidated ${count} session(s) in space ${spaceId} due to ${reason}`)
  }
}

/**
 * Whether anything in the space is running or about to: a turn being created,
 * prepared, dispatched or answered, or background work whose results come back
 * as later turns. Synchronous, so a caller can act on a "no" before anything
 * else starts.
 */
export function isSpaceBusy(spaceId: string): boolean {
  for (const state of activeSessions.values()) {
    if (state.spaceId === spaceId) return true
  }
  for (const creation of inFlightSessionCreations.values()) {
    if (creation.spaceId === spaceId) return true
  }
  for (const [conversationId, info] of v2Sessions) {
    if (info.spaceId !== spaceId) continue
    if (isSessionBusy(conversationId) || turnsAwaitingInit.has(conversationId)) return true
    const consumer = consumers.get(conversationId)
    if (consumer?.isRunning && consumer.hasRunningTasks()) return true
  }
  return false
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

    if (sessionLeases.has(convId) || turnsAwaitingInit.has(convId)) {
      pendingConsumerRebuilds.add(convId)
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
// MCP Connection Retries
// ============================================

interface McpRebuildSpent {
  stage: 'retried' | 'recovered'
  /** The session built for this stage reported the server failed again (logged once). */
  capped: boolean
  /** Set when a tool call found the server gone: the engine had reported it connected. */
  callFailedAt?: number
}

/**
 * Rebuilds already spent on a failing MCP server, per conversation: 'retried'
 * once its session reported the server failed, 'recovered' once the server was
 * seen connecting again after that. Kept across the rebuild it asked for and
 * dropped by any other teardown of the conversation's session, when the
 * session connects the server (for a failure a tool call found, only once
 * MCP_CALL_FAILURE_WINDOW_MS has passed), and on any MCP configuration change.
 * The cap matters for a server that passes Halo's probe but never connects in
 * the engine (a proxy or PATH only the engine sees): it would otherwise rebuild
 * the session at every recovery report.
 */
const mcpRebuildsSpent = new Map<string, Map<string, McpRebuildSpent>>()

/**
 * The result of a tool call whose MCP server dropped mid-session and was not
 * reconnected. Claude Code CLI 2.1.89 then fails every later call to that server
 * while its status reports still say connected; the halo engine returns the
 * same text, with a final period, while it reconnects in the background.
 */
const MCP_NOT_CONNECTED_RESULT = /^MCP server "(.+)" is not connected\.?$/

/**
 * A call that finds the server gone this soon after an earlier call failure
 * counts as the same failure, so a server that connects but cannot serve calls
 * rebuilds a conversation's session at most once in this time.
 */
const MCP_CALL_FAILURE_WINDOW_MS = 5 * 60_000

/** Conversations whose next session teardown is a rebuild asked for by an MCP failure. */
const mcpRebuildRequested = new Set<string>()

function requestMcpRebuild(conversationId: string, reason: string): void {
  mcpRebuildRequested.add(conversationId)
  requestSessionRebuild(conversationId, reason)
}

/**
 * Engines connect MCP servers when a session starts and do not retry one that
 * failed; the session goes on without its tools. A server that drops
 * mid-session can stay unusable the same way. Called with every SDK message a
 * chat consumer reads, it acts only on the per-turn status report
 * (`mcp_servers`) and on tool results saying a server is not connected: it
 * records the failed servers and rebuilds the session the way an MCP toggle
 * does — deferred past a running turn — so the next message starts with a
 * fresh connection attempt.
 */
export function noteSessionMcpStatus(conversationId: string, session: V2SDKSession, sdkMessage: unknown): void {
  const msg = sdkMessage as { type?: unknown; mcp_servers?: unknown; message?: { content?: unknown } } | null
  if (msg?.type === 'user') {
    const gone = serversFoundGoneByCalls(msg.message?.content)
    if (gone && v2Sessions.get(conversationId)?.session === session) {
      spendMcpRebuilds(conversationId, gone, true)
    }
    return
  }
  if (msg?.type !== 'system' || !Array.isArray(msg.mcp_servers)) return
  const info = v2Sessions.get(conversationId)
  if (info?.session !== session) return

  const now = Date.now()
  const spent = mcpRebuildsSpent.get(conversationId)
  const failed: string[] = []
  for (const server of msg.mcp_servers as Array<{ name?: unknown; status?: unknown }>) {
    if (typeof server?.name !== 'string') continue
    if (server.status === 'failed') failed.push(server.name)
    else if (server.status === 'connected') {
      const entry = spent?.get(server.name)
      if (entry && !isRecentCallFailure(entry, now)) spent?.delete(server.name)
    }
  }
  if (spent?.size === 0) mcpRebuildsSpent.delete(conversationId)
  info.failedMcpServers = failed.length > 0 ? failed : undefined
  spendMcpRebuilds(conversationId, failed, false, now)
}

function isRecentCallFailure(entry: McpRebuildSpent, now: number): boolean {
  return entry.callFailedAt !== undefined && now - entry.callFailedAt < MCP_CALL_FAILURE_WINDOW_MS
}

/** Servers that a tool result frame says are not connected. */
function serversFoundGoneByCalls(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined
  let names: string[] | undefined
  for (const block of content as Array<{ type?: unknown; is_error?: unknown; content?: unknown }>) {
    if (block?.type !== 'tool_result' || block.is_error !== true) continue
    const parts = block.content
    const text = typeof parts === 'string'
      ? parts
      : Array.isArray(parts) && parts.length === 1 ? (parts[0] as { text?: unknown } | null)?.text : undefined
    const name = typeof text === 'string' ? MCP_NOT_CONNECTED_RESULT.exec(text)?.[1] : undefined
    if (name && !names?.includes(name)) (names ??= []).push(name)
  }
  return names
}

/**
 * Spends the rebuild budget on servers the current session found failed —
 * at its start, or in a tool call — and asks for one rebuild if any had budget left.
 */
function spendMcpRebuilds(conversationId: string, failed: string[], byCall: boolean, now = Date.now()): void {
  if (failed.length === 0) return
  const spent = mcpRebuildsSpent.get(conversationId) ?? new Map<string, McpRebuildSpent>()
  const retry: string[] = []
  const capped: string[] = []
  for (const name of failed) {
    const entry = spent.get(name)
    if (!entry || (entry.callFailedAt !== undefined && !isRecentCallFailure(entry, now))) {
      spent.set(name, byCall ? { stage: 'retried', capped: false, callFailedAt: now } : { stage: 'retried', capped: false })
      retry.push(name)
      continue
    }
    // Failing at the start again makes a later 'connected' report proof that it works.
    if (!byCall) delete entry.callFailedAt
    if (!entry.capped && !isRebuildPending(conversationId)) {
      entry.capped = true
      const next = entry.callFailedAt !== undefined
        ? `rebuilds on a call failure after ${MCP_CALL_FAILURE_WINDOW_MS / 60_000} min`
        : entry.stage === 'retried' ? 'rebuilds once more when seen connecting' : 'no further automatic rebuilds'
      capped.push(`${name} (${next})`)
    }
  }
  mcpRebuildsSpent.set(conversationId, spent)

  if (capped.length > 0) {
    console.log(`[Agent][${conversationId}] MCP server(s) still failing after a rebuild: ${capped.join(', ')}`)
  }
  if (retry.length === 0) return

  const failure = byCall ? 'not connected in a tool call' : 'failed to connect'
  console.log(`[Agent][${conversationId}] MCP server(s) ${failure}: ${retry.join(', ')} — rebuilding the session for the next message`)
  requestMcpRebuild(conversationId, `MCP server ${failure}: ${retry.join(', ')}`)
}

/** A rebuild is already flagged for this session, or its consumer stopped for one. */
function isRebuildPending(conversationId: string): boolean {
  return pendingConsumerRebuilds.has(conversationId) ||
    pendingInvalidations.has(conversationId) ||
    consumers.get(conversationId)?.isRunning === false
}

// A server that some sessions could not use connects again (probe, connection
// test, another session): rebuild each of them once more.
onMcpServerRecovered((name) => {
  for (const [conversationId, info] of Array.from(v2Sessions)) {
    if (!info.failedMcpServers?.includes(name) || isRebuildPending(conversationId)) continue
    const spent = mcpRebuildsSpent.get(conversationId) ?? new Map<string, McpRebuildSpent>()
    if (spent.get(name)?.stage === 'recovered') continue
    spent.set(name, { stage: 'recovered', capped: false })
    mcpRebuildsSpent.set(conversationId, spent)
    console.log(`[Agent][${conversationId}] MCP server ${name} is reachable again — rebuilding the session that could not use it`)
    requestMcpRebuild(conversationId, `MCP server reachable again: ${name}`)
  }
})

// ============================================
// Config Change Handler Registration
// ============================================

// Register for API config change notifications
// This is called once when the module loads
onApiConfigChange((change?: ApiConfigChange) => {
  if (!change) {
    invalidateAllSessions()
    return
  }

  const sourceIds = new Set(change.sourceIds ?? [])
  let affected = 0
  for (const [conversationId, creation] of inFlightSessionCreations) {
    if (creation.sourceId ? sourceIds.has(creation.sourceId) : change.selectionChanged) {
      requestSessionRebuild(conversationId, 'AI source config change during creation')
      affected++
    }
  }
  for (const [conversationId, info] of v2Sessions) {
    if (inFlightSessionCreations.has(conversationId)) continue
    if (info.sourceId ? sourceIds.has(info.sourceId) : change.selectionChanged) {
      requestSessionRebuild(conversationId, 'AI source config change')
      affected++
    }
  }
  if (affected > 0) {
    console.log(`[Agent] Source config change: ${affected} session(s) closed or queued for safe rebuild`)
  }
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
  mcpRebuildsSpent.clear()
  mcpRebuildRequested.clear()
  if (spaceId === null) {
    invalidateAllSessions()
  } else {
    invalidateSessionsForSpace(spaceId)
  }
}
