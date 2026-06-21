/**
 * Shared App Runtime Types
 *
 * Pure TypeScript type definitions for the Apps system.
 * These types are used by both the main process and the renderer process.
 *
 * IMPORTANT: This file must NOT import any Node.js or Electron APIs.
 * It is included in the renderer (web) tsconfig.
 *
 * All types here are manually mirrored from:
 *   - src/main/apps/manager/types.ts  (AppStatus, RunOutcome, InstalledApp)
 *   - src/main/apps/runtime/types.ts  (ActivityEntry, AutomationAppState, EscalationResponse, etc.)
 *
 * Why manual mirror instead of re-export?
 * - The renderer tsconfig does not include src/main/
 * - Importing from src/main/ would pull in Node.js types and Zod schemas
 * - Keeps the renderer bundle free of server-only code
 *
 * When the source types change, update this file to match.
 */

// ============================================
// Manager Types (mirrored from apps/manager/types.ts)
// ============================================

/**
 * Runtime status of an installed App.
 *
 * - active:        Running normally (automation) or available for use (mcp/skill)
 * - paused:        User manually paused; subscriptions inactive
 * - error:         Consecutive failures hit threshold; auto-disabled
 * - needs_login:   AI Browser detected expired login session
 * - waiting_user:  AI triggered escalation; awaiting user decision
 * - uninstalled:   Soft-deleted; hidden from default views, can be reinstalled or permanently deleted
 */
export type AppStatus = 'active' | 'paused' | 'error' | 'needs_login' | 'waiting_user' | 'uninstalled'

/**
 * Outcome of a single App execution run.
 */
export type RunOutcome = 'useful' | 'noop' | 'error' | 'skipped'

/**
 * Full representation of an installed App instance.
 *
 * Each installed App has a unique `id` (UUID). It may belong to a specific
 * `spaceId` or be global (`spaceId = null`), available across all spaces.
 * Stores a snapshot of the AppSpec at install time plus user configuration.
 */
export interface InstalledApp {
  /** Unique installation ID (UUID v4) */
  id: string

  /** App specification identifier (from spec.name or a registry ID) */
  specId: string

  /** Space this App is installed in (null = global, available in all spaces) */
  spaceId: string | null

  /** Full AppSpec (initially set at install time, updatable via updateSpec) */
  spec: import('./spec-types').AppSpec

  /** Current runtime status */
  status: AppStatus

  /**
   * Opaque escalation ID set when status is 'waiting_user'.
   * Points to an activity_entries record (managed by apps/runtime).
   */
  pendingEscalationId?: string

  /** User-provided configuration values (corresponds to spec.config_schema) */
  userConfig: Record<string, unknown>

  /** User overrides for subscription frequencies and other tunable settings */
  userOverrides: {
    frequency?: Record<string, string>  // subscriptionId -> frequency string
    /** Notification level: 'all' | 'important' | 'none'. Defaults to 'important'. */
    notificationLevel?: 'all' | 'important' | 'none'
    /** Override AI source for this App. When set, uses this source instead of the global one. */
    modelSourceId?: string
    /** Override model within the selected AI source. Used together with modelSourceId. */
    modelId?: string
    /** When true, the login notice bar is permanently dismissed for this app */
    loginNoticeDismissed?: boolean
  }

  /** Permission grants and denials */
  permissions: {
    granted: string[]
    denied: string[]
  }

  /** Unix timestamp (ms) when the App was installed */
  installedAt: number

  /** Unix timestamp (ms) of the last execution run */
  lastRunAt?: number

  /** Outcome of the last execution run */
  lastRunOutcome?: RunOutcome

  /** Error message from the last failed run or status change */
  errorMessage?: string

  /** Unix timestamp (ms) when the App was soft-deleted (uninstalled). Undefined if active. */
  uninstalledAt?: number

  /**
   * User-controlled upgrade strategy.
   *
   * - 'auto'    (default): patch/minor versions install silently; majors notify
   * - 'notify':  surface every available update as a notification
   * - 'manual':  no automatic checks; user-triggered only
   */
  upgradeStrategy: UpgradeStrategy
}

/** User-controlled per-app upgrade strategy. */
export type UpgradeStrategy = 'auto' | 'notify' | 'manual'

/** Filter criteria for listing Apps */
export interface AppListFilter {
  /** Filter by space: string = specific space, null = global only, undefined = all */
  spaceId?: string | null
  status?: AppStatus
  type?: import('./spec-types').AppType
}

// ============================================
// Runtime Types (mirrored from apps/runtime/types.ts)
// ============================================

/** Types of activity entries written by the AI via report_to_user */
export type ActivityEntryType =
  | 'run_complete'
  | 'run_skipped'
  | 'run_error'
  | 'milestone'
  | 'escalation'
  | 'output'

/** Content of an activity entry */
export interface ActivityEntryContent {
  /** Human-readable summary (required, written by AI) */
  summary: string
  /** Run status indicator */
  status?: 'ok' | 'error' | 'skipped'
  /** Run duration in milliseconds */
  durationMs?: number
  /** Error message */
  error?: string
  /** Next retry time (for run_error) */
  nextRetryMs?: number
  /** Structured output data (tables, lists, short inline markdown) */
  data?: unknown
  /** Absolute path to a markdown file written by AI (replaces inline data for large content) */
  dataPath?: string
  /** Question for the user (escalation only) */
  question?: string
  /** Preset choices for escalation */
  choices?: string[]
  /** File URL for output type */
  outputUrl?: string
}

/** User response to an escalation */
export interface EscalationResponse {
  ts: number
  choice?: string
  text?: string
}

/** A single Activity Thread entry */
export interface ActivityEntry {
  id: string
  appId: string
  runId: string
  type: ActivityEntryType
  ts: number
  sessionKey?: string
  content: ActivityEntryContent
  userResponse?: EscalationResponse
}

/** Real-time state of an automation App (for UI display) */
export interface AutomationAppState {
  /**
   * - running:      Actively executing a run right now
   * - queued:       Manually triggered; waiting for a global concurrency slot
   * - idle:         Active and scheduled, no run in progress
   * - paused:       User paused the app; subscriptions inactive
   * - waiting_user: AI escalated; awaiting user decision
   * - error:        Consecutive failures hit threshold; auto-disabled
   */
  status: 'running' | 'queued' | 'idle' | 'paused' | 'waiting_user' | 'error'
  nextRunAtMs?: number
  runningAtMs?: number
  /** Run ID of the currently executing run (only set when status === 'running') */
  runningRunId?: string
  /** Session key of the currently executing run (only set when status === 'running') */
  runningSessionKey?: string
  lastRunAtMs?: number
  lastStatus?: 'ok' | 'error' | 'skipped'
  lastError?: string
  lastDurationMs?: number
  consecutiveErrors?: number
  pendingEscalationId?: string
}

/** Options for querying activity entries */
export interface ActivityQueryOptions {
  limit?: number
  offset?: number
  type?: ActivityEntryType
  since?: number
}

// ============================================
// IPC Response Envelopes
// ============================================

/** Standard success response with data */
export interface AppSuccessResponse<T = unknown> {
  success: true
  data: T
}

/** Standard error response */
export interface AppErrorResponse {
  success: false
  error: string
}

/** Union of success/error responses */
export type AppResponse<T = unknown> = AppSuccessResponse<T> | AppErrorResponse

// ============================================
// Permission Helpers
// ============================================

/**
 * Resolve whether a specific permission is effective for an App.
 *
 * Resolution order (user override wins over spec declaration):
 * 1. If explicitly denied  → false
 * 2. If explicitly granted → true
 * 3. Fall back to spec.permissions (default: true for ai-browser)
 *
 * The default-true fallback for 'ai-browser' ensures that most automation Apps
 * (which rely on browser capabilities) work out of the box. Users or spec authors
 * can opt out by adding 'ai-browser' to the denied list or omitting it from
 * spec.permissions respectively.
 */
export function resolvePermission(
  app: Pick<InstalledApp, 'permissions' | 'spec'>,
  permission: string,
  defaultValue = true
): boolean {
  if (app.permissions.denied.includes(permission)) return false
  if (app.permissions.granted.includes(permission)) return true
  // Fall back to spec declaration, then to the provided default
  return app.spec.permissions?.includes(permission) ?? defaultValue
}
