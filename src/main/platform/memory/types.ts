/**
 * platform/memory -- Type Definitions
 *
 * Public types for the memory subsystem.
 * Consumed by apps/runtime and other platform modules.
 */

import type { MemoryPromptOptions } from './prompt'

// ============================================================================
// Memory Scopes
// ============================================================================

/**
 * Memory scope determines which memory file is targeted.
 *
 * - 'user':  Global user preferences, stored at {haloDir}/user-memory.md
 * - 'space': Per-space memory, stored at {spacePath}/.halo/memory.md
 * - 'app':   Per-app private memory, stored at {spacePath}/.halo/apps/{appId}/memory.md
 */
export type MemoryScopeType = 'user' | 'space' | 'app'

/**
 * Identity of the caller requesting memory operations.
 *
 * For user sessions: { type: 'user', spaceId, spacePath }
 * For app sessions:  { type: 'app',  spaceId, spacePath, appId }
 */
export interface MemoryCallerScope {
  /** 'user' for direct user sessions, 'app' for app-initiated sessions */
  type: 'user' | 'app'
  /** Space ID (used for logging / identification) */
  spaceId: string
  /** Absolute path to the space data directory */
  spacePath: string
  /** App identifier (required when type === 'app') */
  appId?: string
  /** Trusted identity storage root supplied by the app manager, never by a tool caller. */
  appDataPath?: string
}

// ============================================================================
// Session Summary
// ============================================================================

export interface SessionSummaryParams {
  /** Markdown summary content */
  content: string
  /** Optional slug for the filename (e.g., 'debug-api-timeout'). If omitted, timestamp-based. */
  slug?: string
}

// ============================================================================
// Turn Modes
// ============================================================================

/**
 * Where the turn sits. It decides only HOW memory reached the agent — the agent
 * is the same one with the same memory wherever it works.
 *
 * - `run`     — an automation run: fresh context per trigger, so the snapshot is
 *               injected and a `# History` heading pre-inserted every time
 * - `session` — an ongoing session (chat, IM, team): the snapshot is injected when
 *               the session starts and stays in context for the turns that follow
 */
export type MemoryTurnMode = 'run' | 'session'

// ============================================================================
// MemoryService Interface
// ============================================================================

/**
 * The memory service handed to apps/runtime at bootstrap.
 *
 * Everything else — layouts, snapshots, rendering, consolidation primitives, the
 * write guard — is stateless and imported from this module's index directly.
 */
export interface MemoryService {
  /**
   * Save an automation run's record under run/.
   *
   * @param caller - Who is saving
   * @param scope - Which scope to save under
   * @param params - Summary content and optional slug
   */
  saveSessionSummary(
    caller: MemoryCallerScope,
    scope: MemoryScopeType,
    params: SessionSummaryParams
  ): Promise<void>

  /**
   * The system prompt fragment that teaches the agent to keep its memory.
   *
   * @param mode - What the caller actually does for this turn, so the
   *               instructions never promise an injection that did not happen
   * @param opts - Owner kind and declared tracked items
   */
  getPromptInstructions(mode: MemoryTurnMode, opts?: MemoryPromptOptions): string
}
