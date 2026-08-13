/**
 * platform/memory -- Type Definitions
 *
 * Public types for the memory subsystem.
 * Consumed by apps/runtime and other platform modules.
 */

// ============================================================================
// Memory Scopes
// ============================================================================

/**
 * Memory scope determines which memory file is targeted.
 *
 * - 'user':  Global user preferences, stored at {haloDir}/user-memory.md
 * - 'space': Per-space knowledge, stored at {spacePath}/.halo/memory.md
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
}

// ============================================================================
// Read / Write Parameters
// ============================================================================

/**
 * Read mode for memory read operations.
 *
 * - 'full':     Return the entire memory file (default)
 * - 'headers':  Return only markdown heading lines with line numbers (low token cost)
 * - 'section':  Return a specific section matched by heading text
 * - 'tail':     Return the last N lines of the file
 */
export type MemoryReadMode = 'full' | 'headers' | 'section' | 'tail'

export interface MemoryReadParams {
  /** Which memory scope to read from */
  scope: MemoryScopeType
  /** Optional: specific file path within the memory/ subdirectory */
  path?: string
  /** Read mode. Defaults to 'full' for backward compatibility. */
  mode?: MemoryReadMode
  /** Heading text to match when mode='section'. Case-insensitive substring match. */
  section?: string
  /** Number of lines to return when mode='tail'. Defaults to 50. */
  limit?: number
}

export interface MemoryWriteParams {
  /** Which memory scope to write to */
  scope: MemoryScopeType
  /** Content to write */
  content: string
  /** Write mode: 'append' adds to end, 'replace' overwrites entire file */
  mode: 'append' | 'replace'
}

export interface MemoryListParams {
  /** Which memory scope to list files from */
  scope: MemoryScopeType
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
// Compaction
// ============================================================================

/** Size threshold in bytes before compaction is triggered (100KB) */
export const COMPACTION_THRESHOLD_BYTES = 100 * 1024

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
 * The public interface of the memory module.
 *
 * Consumed by apps/runtime (via initMemory()) to:
 * - Read/write memory programmatically
 * - Manage session lifecycle (flush, compaction, summaries)
 * - Generate system prompt fragments
 */
export interface MemoryService {
  /**
   * Read memory content.
   *
   * @param caller - Who is reading
   * @param params - What to read (scope + optional path)
   * @returns Content string, or null if file does not exist
   * @throws If the caller lacks permission to read the requested scope
   */
  read(caller: MemoryCallerScope, params: MemoryReadParams): Promise<string | null>

  /**
   * Write memory content.
   *
   * @param caller - Who is writing
   * @param params - What to write (scope, content, mode)
   * @throws If the caller lacks permission or violates isolation rules
   */
  write(caller: MemoryCallerScope, params: MemoryWriteParams): Promise<void>

  /**
   * List files in the memory/ subdirectory for a given scope.
   *
   * @param caller - Who is listing
   * @param params - Which scope to list
   * @returns Array of relative file paths, or empty array if directory doesn't exist
   */
  list(caller: MemoryCallerScope, params: MemoryListParams): Promise<string[]>

  /**
   * Flush in-progress memory before context compaction.
   *
   * Called by apps/runtime just before the Agent SDK performs context compaction.
   * The implementation appends any pending notes from the current session.
   * In V1 this is a no-op placeholder (no in-memory buffer to flush).
   */
  flushBeforeCompaction(caller: MemoryCallerScope): Promise<void>

  /**
   * Compact a memory.md file that has grown too large.
   *
   * Moves the current memory.md to memory/YYYY-MM-DD-HHmm.md (archive)
   * and creates a fresh memory.md. The caller (apps/runtime) is responsible
   * for generating a compacted summary via LLM and writing it to the new file.
   *
   * @param caller - Who is compacting
   * @param scope - Which scope to compact
   * @returns Object with { archived: string (archive path), needsSummary: boolean }
   */
  compact(caller: MemoryCallerScope, scope: MemoryScopeType): Promise<{ archived: string; needsSummary: boolean }>

  /**
   * Save a session summary to the memory/ archive directory.
   *
   * Called by apps/runtime when a session ends. The summary is stored as
   * a markdown file in the memory/ subdirectory.
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
   * Get system prompt instructions for memory usage.
   *
   * Returns a markdown fragment to be appended to the agent's system prompt.
   * Guides the AI to use native file tools (Read/Edit/Write) on memory.md.
   *
   * @param mode - What the caller actually does for this turn, so the
   *               instructions never promise an injection that did not happen
   * @returns Prompt fragment string
   */
  getPromptInstructions(mode: MemoryTurnMode): string

  /**
   * Check if a memory file exceeds the compaction threshold.
   *
   * @param caller - Who is checking
   * @param scope - Which scope to check
   * @returns true if the file size exceeds COMPACTION_THRESHOLD_BYTES
   */
  needsCompaction(caller: MemoryCallerScope, scope: MemoryScopeType): Promise<boolean>
}
