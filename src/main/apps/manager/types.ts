/**
 * apps/manager -- Type Definitions
 *
 * Public types for the App lifecycle management layer.
 * Consumed by apps/runtime, IPC handlers, and renderer (via shared types).
 */

import type { AppSpec, AppType } from '../spec'

// ============================================
// App Status
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
 * Matches the scheduler's RunOutcome type.
 */
export type RunOutcome = 'useful' | 'noop' | 'error' | 'skipped'

// ============================================
// Installed App
// ============================================

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
  spec: AppSpec

  /** Current runtime status */
  status: AppStatus

  /**
   * Opaque escalation ID set when status is 'waiting_user'.
   * Points to an activity_entries record (managed by apps/runtime).
   * No FK constraint -- decoupled from runtime schema.
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
   * User-controlled upgrade strategy for this App.
   *
   * - 'auto'    (default): patch/minor versions install silently; majors notify
   * - 'notify':  never silent — surface every available update as a notification
   * - 'manual':  no automatic checks; user must trigger upgrade explicitly
   *
   * See `src/main/store/upgrade.service.ts` for the dispatch logic.
   */
  upgradeStrategy: UpgradeStrategy
}

/**
 * User-controlled upgrade strategy. Persisted per installed App.
 *
 * See `src/main/store/upgrade.service.ts` for how strategies are applied.
 */
export type UpgradeStrategy = 'auto' | 'notify' | 'manual'

// ============================================
// Service Interface
// ============================================

/** Filter criteria for listApps() */
export interface AppListFilter {
  /** Filter by space: string = specific space, null = global only, undefined = all */
  spaceId?: string | null
  status?: AppStatus
  type?: AppType
}

/** Callback signature for status change notifications */
export type StatusChangeHandler = (appId: string, oldStatus: AppStatus, newStatus: AppStatus) => void

/** Callback fired after a successful install. Receives the fully-persisted app. */
export type AppInstalledHandler = (app: InstalledApp) => void

/**
 * Callback fired after a successful uninstall. Receives the app record captured
 * just before the status transition so subscribers still see the full spec.
 */
export type AppUninstalledHandler = (app: InstalledApp) => void

/** Unsubscribe function returned by event registration */
export type Unsubscribe = () => void

/** Options for the uninstall operation */
export interface UninstallOptions {
  /** If true, delete the App's work directory. Default: false (preserve data). */
  purge?: boolean
}

/**
 * Options for `deleteApp`.
 *
 * `allowBuiltin` is an internal contract reserved for two callers:
 *   1. `apps/manager/builtin-loader.ts` GC, when removing a built-in row whose
 *      manifest entry has been removed (variant switch, rename in SSOT).
 *   2. `service.deleteAppsInSpace`, when the entire enclosing space is being
 *      destroyed and every row inside it must go.
 *
 * IPC and HTTP layers MUST NOT forward this option from external input —
 * doing so would defeat the user-facing protection that prevents accidental
 * permanent deletion of bundled built-in apps.
 */
export interface DeleteAppOptions {
  /** Internal: bypass the BuiltinAppProtectedError guard. Default: false. */
  allowBuiltin?: boolean
}

// ============================================
// Built-in App Helpers
// ============================================

/**
 * Returns true when the given app was installed by the built-in loader
 * (apps/manager/builtin-loader.ts) rather than by the user via the store
 * or direct IPC.
 *
 * Built-in apps:
 *   - are bundled with the application binary (resources/builtin-apps/)
 *   - get re-synced from disk on every launch (auto-upgrade)
 *   - are protected from permanent deletion (deleteApp is rejected)
 *   - honor user pause / soft-uninstall persistently across boots
 *
 * The marker lives on `spec.store.install_source === 'builtin'` so it survives
 * round-trips through SQLite (spec_json column) and IPC.
 */
export function isBuiltinApp(app: InstalledApp): boolean {
  return app.spec.store?.install_source === 'builtin'
}

/**
 * App Manager Service -- lifecycle management for installed Apps.
 *
 * This is the public API consumed by apps/runtime and IPC handlers.
 * All mutations are persisted to SQLite immediately.
 */
export interface AppManagerService {
  // ── Installation ────────────────────────────────

  /**
   * Install an App into a space (or globally).
   *
   * Creates the App record in SQLite, generates a UUID, creates the work directory
   * at `{space.path}/.halo/apps/{appId}/` (for space-scoped apps) or
   * `{haloDir}/apps/{appId}/` (for global apps).
   *
   * @param spaceId - Target space ID, or null for global install
   * @param spec - Validated AppSpec
   * @param userConfig - User-provided config values (optional)
   * @returns The generated App ID (UUID)
   * @throws AppAlreadyInstalledError if same specId+spaceId combination exists
   */
  install(spaceId: string | null, spec: AppSpec, userConfig?: Record<string, unknown>): Promise<string>

  /**
   * Uninstall an App (soft-delete).
   *
   * Sets the App status to 'uninstalled' and records uninstalled_at timestamp.
   * The App remains in the database and can be reinstalled or permanently deleted.
   *
   * @throws AppNotFoundError if the App does not exist
   */
  uninstall(appId: string, options?: UninstallOptions): Promise<void>

  /**
   * Reinstall a previously uninstalled App.
   *
   * Transitions the App from 'uninstalled' back to 'active' and clears uninstalled_at.
   *
   * @throws AppNotFoundError if the App does not exist
   * @throws InvalidStatusTransitionError if the App is not in 'uninstalled' status
   */
  reinstall(appId: string): void

  /**
   * Permanently delete an uninstalled App from the database.
   *
   * Only allowed when the App is in 'uninstalled' status. Removes the record
   * from SQLite and optionally purges the work directory.
   *
   * Built-in apps (spec.store.install_source === 'builtin') are protected:
   * the call rejects with `BuiltinAppProtectedError` unless the caller passes
   * `options.allowBuiltin = true`. That option is reserved for internal
   * callers (loader GC, full-space deletion) and must never be forwarded
   * from IPC / HTTP input.
   *
   * @throws AppNotFoundError if the App does not exist
   * @throws InvalidStatusTransitionError if the App is not in 'uninstalled' status
   * @throws BuiltinAppProtectedError if the App is built-in and allowBuiltin is not set
   */
  deleteApp(appId: string, options?: DeleteAppOptions): Promise<void>

  /**
   * Delete all Apps belonging to a space (for space deletion cleanup).
   *
   * Hard-deletes all app records and purges their work directories.
   * Called by space.service.ts when a space is being deleted.
   *
   * @param spaceId - The space ID whose apps should be deleted
   * @returns Number of apps deleted
   */
  deleteAppsInSpace(spaceId: string): Promise<number>

  /**
   * Garbage collect old uninstalled apps.
   *
   * Permanently deletes apps that have been in 'uninstalled' status for longer
   * than the retention period. Called during startup and periodically.
   *
   * @param retentionMs - Retention period in milliseconds (default: 30 days)
   * @returns Number of apps pruned
   */
  pruneUninstalledApps(retentionMs?: number): number

  // ── Status Management ──────────────────────────

  /**
   * Pause an App (user action).
   * Only valid from 'active' status.
   *
   * @throws AppNotFoundError if the App does not exist
   * @throws InvalidStatusTransitionError if current status is not 'active'
   */
  pause(appId: string): void

  /**
   * Resume an App (user action).
   * Valid from 'paused', 'error', or 'needs_login' status.
   *
   * @throws AppNotFoundError if the App does not exist
   * @throws InvalidStatusTransitionError if current status does not allow resume
   */
  resume(appId: string): void

  /**
   * Update App status (runtime action).
   * Used by apps/runtime to set error, needs_login, or waiting_user states.
   * Enforces the state machine -- throws on illegal transitions.
   *
   * @param extra - Optional metadata: errorMessage, pendingEscalationId
   * @throws AppNotFoundError if the App does not exist
   * @throws InvalidStatusTransitionError if the transition is not allowed
   */
  updateStatus(
    appId: string,
    status: AppStatus,
    extra?: { errorMessage?: string; pendingEscalationId?: string }
  ): void

  // ── Configuration ──────────────────────────────

  /**
   * Update user configuration for an App.
   * Replaces the entire userConfig object.
   */
  updateConfig(appId: string, config: Record<string, unknown>): void

  /**
   * Update the user's frequency override for a specific subscription.
   */
  updateFrequency(appId: string, subscriptionId: string, frequency: string): void

  /**
   * Update user overrides for an App (e.g. notificationLevel, model).
   * Merges the provided partial overrides into the existing overrides object.
   */
  updateOverrides(appId: string, overrides: Partial<InstalledApp['userOverrides']>): void

  /**
   * Update the upgrade strategy for an installed App.
   *
   * Persisted to the `installed_apps.upgrade_strategy` column.
   * Read by `upgrade.service.ts` on every check tick.
   *
   * @throws AppNotFoundError if the App does not exist
   */
  setUpgradeStrategy(appId: string, strategy: UpgradeStrategy): void

  /**
   * Update the App spec (JSON Merge Patch semantics).
   *
   * Provided fields overwrite existing values. Fields set to `null` are
   * removed from the spec. Omitted fields are preserved.
   *
   * The merged result is re-validated through the AppSpec Zod schema
   * before being persisted, so callers cannot produce invalid specs.
   *
   * @throws AppNotFoundError if the App does not exist
   * @throws AppSpecValidationError if the merged spec is invalid
   */
  updateSpec(appId: string, specPatch: Record<string, unknown>): void

  /**
   * Move an App to a different space (or to/from global scope).
   *
   * For skill apps: atomically removes the skill files from the current
   * filesystem location and writes them to the new location so Claude Code
   * auto-loads them from the correct path.
   *
   * For MCP apps: emits an MCP change notification for both the old and new
   * spaceId so affected sessions are invalidated.
   *
   * Constraints:
   * - App must not be in 'uninstalled' status.
   * - The target space must exist (unless newSpaceId is null = global).
   * - No other app with the same specId may be installed in the target scope.
   *
   * @param appId      - The ID of the app to move
   * @param newSpaceId - Target space ID, or null to move to global scope
   * @throws AppNotFoundError if the App does not exist
   * @throws SpaceNotFoundError if newSpaceId is non-null and space does not exist
   * @throws AppAlreadyInstalledError if target scope already has the same specId
   */
  moveToSpace(appId: string, newSpaceId: string | null): Promise<void>

  // ── Run Tracking ───────────────────────────────

  /**
   * Record the result of an App execution run.
   * Called by apps/runtime after each run completes.
   */
  updateLastRun(appId: string, outcome: RunOutcome, errorMessage?: string): void

  // ── Queries ────────────────────────────────────

  /**
   * Get a single installed App by ID.
   * Returns null if not found.
   */
  getApp(appId: string): InstalledApp | null

  /**
   * List installed Apps with optional filtering.
   * Supports filtering by spaceId, status, and App type.
   */
  listApps(filter?: AppListFilter): InstalledApp[]

  /**
   * List effective MCP apps for a space.
   * Returns global MCPs + space-scoped MCPs, with space-scoped overriding
   * global when they share the same specId.
   */
  listEffectiveMcpApps(spaceId: string): InstalledApp[]

  /**
   * List effective Skill apps for a space.
   * Returns global skills + space-scoped skills, with space-scoped overriding
   * global when they share the same specId.
   */
  listEffectiveSkillApps(spaceId: string): InstalledApp[]

  // ── Permissions ────────────────────────────────

  /** Grant a permission to an App. */
  grantPermission(appId: string, permission: string): void

  /** Revoke a previously granted permission. */
  revokePermission(appId: string, permission: string): void

  // ── File System ────────────────────────────────

  /**
   * Get the work directory path for an App.
   * Ensures the directory exists (auto-creates if missing).
   *
   * @returns Absolute path to `{space.path}/.halo/apps/{appId}/`
   * @throws AppNotFoundError if the App does not exist
   */
  getAppWorkDir(appId: string): string

  /**
   * Clear all memory for an App.
   *
   * Deletes `memory.md` and all files under `memory/` (run summaries and
   * compaction archives). The directory structure is preserved so the App
   * can start fresh on its next run.
   *
   * @returns Number of files removed
   * @throws AppNotFoundError if the App does not exist
   */
  clearAppMemory(appId: string): number

  // ── Events ─────────────────────────────────────

  /**
   * Register a callback for App status changes.
   * Returns an unsubscribe function.
   */
  onAppStatusChange(handler: StatusChangeHandler): Unsubscribe

  /**
   * Register a callback fired after a new install (including reinstall).
   * Returns an unsubscribe function.
   */
  onAppInstalled(handler: AppInstalledHandler): Unsubscribe

  /**
   * Register a callback fired after a soft-delete (uninstall).
   * Returns an unsubscribe function.
   */
  onAppUninstalled(handler: AppUninstalledHandler): Unsubscribe
}
