/**
 * apps/manager -- Service Implementation
 *
 * Implements the AppManagerService interface with:
 * - State machine enforcement for status transitions
 * - Work directory creation on install
 * - Event notification on status changes
 * - Delegation to AppManagerStore for persistence
 *
 * This is the single implementation class. It is created by initAppManager()
 * in index.ts and returned as the AppManagerService interface.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from 'fs'
import { join } from 'path'
import { v4 as uuidv4 } from 'uuid'

import type { AppSpec } from '../spec'
import { validateAppSpec } from '../spec'
import type {
  AppManagerService,
  InstalledApp,
  AppStatus,
  RunOutcome,
  AppListFilter,
  StatusChangeHandler,
  AppInstalledHandler,
  AppUninstalledHandler,
  Unsubscribe,
  UninstallOptions,
  UpgradeStrategy,
  DeleteAppOptions,
} from './types'
import { AppManagerStore } from './store'
import {
  AppNotFoundError,
  AppAlreadyInstalledError,
  InvalidStatusTransitionError,
  SpaceNotFoundError,
  BuiltinAppProtectedError,
  McpCommandBlockedError,
} from './errors'
import { isMcpCommandBlocked } from '../../services/security-policy'
import { syncSkillToFilesystem, removeSkillFromFilesystem } from './skill-sync'
import { isBuiltinApp } from './types'

// ============================================
// MCP Apps Change Event
//
// Notifies subscribers (session-manager) when MCP app status changes,
// so active sessions can be invalidated and rebuilt with the new config.
//
// Pattern: same as onApiConfigChange in config.service.ts.
// Low-level module (apps/manager) exposes subscription API.
// High-level module (services/agent) subscribes without creating circular deps.
// ============================================

type McpChangeHandler = (spaceId: string | null) => void
const mcpChangeHandlers: McpChangeHandler[] = []

/**
 * Register a callback to be notified when MCP app configuration changes.
 * Called by session-manager to invalidate sessions when an MCP app is
 * installed, uninstalled, reinstalled, paused, resumed, its status changes
 * (e.g. active→error or error→active), or its spec is updated.
 *
 * @returns Unsubscribe function
 */
export function onMcpAppsChange(handler: McpChangeHandler): () => void {
  mcpChangeHandlers.push(handler)
  return () => {
    const idx = mcpChangeHandlers.indexOf(handler)
    if (idx >= 0) mcpChangeHandlers.splice(idx, 1)
  }
}

function emitMcpChange(spaceId: string | null): void {
  for (const handler of mcpChangeHandlers) {
    try {
      handler(spaceId)
    } catch (err) {
      console.error('[AppManager] mcpChange handler error:', err)
    }
  }
}

// ============================================
// State Machine
// ============================================

/**
 * Defines which status transitions are legal.
 *
 * Key: current status
 * Value: set of statuses that can be transitioned TO
 */
const VALID_TRANSITIONS: Record<AppStatus, ReadonlySet<AppStatus>> = {
  active: new Set<AppStatus>(['paused', 'error', 'needs_login', 'waiting_user', 'uninstalled']),
  paused: new Set<AppStatus>(['active', 'uninstalled']),
  error: new Set<AppStatus>(['active', 'paused', 'uninstalled']),
  needs_login: new Set<AppStatus>(['active', 'paused', 'uninstalled']),
  waiting_user: new Set<AppStatus>(['active', 'paused', 'error', 'uninstalled']),
  uninstalled: new Set<AppStatus>(['active']),
}

/**
 * Check if a status transition is legal according to the state machine.
 */
function isValidTransition(from: AppStatus, to: AppStatus): boolean {
  return VALID_TRANSITIONS[from]?.has(to) ?? false
}

// ============================================
// Service Implementation
// ============================================

/** Dependencies injected from the outside */
export interface AppManagerDeps {
  /** SQLite store for installed_apps CRUD */
  store: AppManagerStore

  /**
   * Resolve a space ID to its filesystem path for skill sync.
   * For halo-temp this returns the artifacts/ subdirectory (Claude SDK workDir).
   * Returns null if the space does not exist.
   */
  getSpacePath: (spaceId: string) => string | null

  /**
   * Resolve a space ID to its raw data path for app work directories.
   * Always returns space.path directly — never the artifacts/ subdirectory —
   * so that .halo/apps/{appId}/ is co-located with where the runtime writes memory.
   * Returns null if the space does not exist.
   */
  getAppDataPath: (spaceId: string) => string | null

  /**
   * Get the root directory for global app data (haloDir).
   * Global apps store work data at `{haloDir}/apps/{appId}/`.
   */
  getGlobalAppDir: () => string
}

/**
 * Create the AppManagerService implementation.
 *
 * @param deps - Injected dependencies
 * @returns A fully functional AppManagerService
 */
export function createAppManagerService(deps: AppManagerDeps): AppManagerService {
  const { store, getSpacePath, getAppDataPath, getGlobalAppDir } = deps

  // Status change event listeners
  const statusChangeHandlers: StatusChangeHandler[] = []
  // Install / uninstall event listeners (used by analytics subscribers).
  // Separate from status-change because the install path transitions from
  // undefined → active (no prior status) and therefore does not fire the
  // status-change listeners.
  const appInstalledHandlers: AppInstalledHandler[] = []
  const appUninstalledHandlers: AppUninstalledHandler[] = []

  /**
   * Notify all registered status change handlers.
   * Errors in handlers are caught and logged (do not propagate).
   */
  function notifyStatusChange(appId: string, oldStatus: AppStatus, newStatus: AppStatus): void {
    for (const handler of statusChangeHandlers) {
      try {
        handler(appId, oldStatus, newStatus)
      } catch (error) {
        console.error('[AppManager] Status change handler error:', error)
      }
    }
  }

  /** Fire app-installed handlers. Errors are isolated per subscriber. */
  function notifyInstalled(app: InstalledApp): void {
    for (const handler of appInstalledHandlers) {
      try {
        handler(app)
      } catch (error) {
        console.error('[AppManager] Install handler error:', error)
      }
    }
  }

  /** Fire app-uninstalled handlers. Errors are isolated per subscriber. */
  function notifyUninstalled(app: InstalledApp): void {
    for (const handler of appUninstalledHandlers) {
      try {
        handler(app)
      } catch (error) {
        console.error('[AppManager] Uninstall handler error:', error)
      }
    }
  }

  /**
   * Get an App or throw if not found.
   * Internal helper used by most methods.
   */
  function requireApp(appId: string): InstalledApp {
    const app = store.getById(appId)
    if (!app) {
      throw new AppNotFoundError(appId)
    }
    return app
  }

  /**
   * Resolve the work directory path for an App.
   * Space-scoped: {spacePath}/.halo/apps/{appId}/
   * Global: {haloDir}/apps/{appId}/
   */
  function resolveWorkDir(appId: string, spaceId: string | null): string {
    if (spaceId === null) {
      return join(getGlobalAppDir(), 'apps', appId)
    }
    const spacePath = getAppDataPath(spaceId)
    if (!spacePath) {
      throw new SpaceNotFoundError(spaceId)
    }
    return join(spacePath, '.halo', 'apps', appId)
  }

  /**
   * Ensure a directory exists, creating it recursively if needed.
   */
  function ensureDir(dirPath: string): void {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true })
    }
  }

  /**
   * Recursively delete all contents of a directory without removing the directory itself.
   * Returns the number of files removed.
   */
  function clearDirContents(dirPath: string): number {
    let removed = 0
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        removed += clearDirContents(fullPath)
        rmSync(fullPath, { recursive: true, force: true })
      } else {
        unlinkSync(fullPath)
        removed++
      }
    }
    return removed
  }

  /**
   * List effective apps of a given type for a space.
   * Merges global (spaceId=null) + space-scoped apps.
   * Space-scoped apps override global ones sharing the same specId.
   * Only returns active (non-uninstalled) apps.
   */
  function listEffectiveByType(type: 'mcp' | 'skill', spaceId: string): InstalledApp[] {
    // Get global apps of this type
    const globalApps = store.list({ spaceId: null, type }).filter(a => a.status !== 'uninstalled')
    // Get space-scoped apps of this type
    const spaceApps = store.list({ spaceId, type }).filter(a => a.status !== 'uninstalled')

    // Build effective set: space overrides global by specId
    const spaceSpecIds = new Set(spaceApps.map(a => a.specId))
    const effective: InstalledApp[] = [
      ...spaceApps,
      ...globalApps.filter(a => !spaceSpecIds.has(a.specId)),
    ]
    return effective
  }

  // ── Service Interface Implementation ─────────

  const service: AppManagerService = {
    // ── Installation ──────────────────────────

    async install(
      spaceId: string | null,
      spec: AppSpec,
      userConfig?: Record<string, unknown>
    ): Promise<string> {
      // For space-scoped installs, validate space exists
      if (spaceId !== null) {
        const spacePath = getSpacePath(spaceId)
        if (!spacePath) {
          throw new SpaceNotFoundError(spaceId)
        }
      }

      // Validate spec before any DB operations
      validateAppSpec(spec)

      // Security policy: reject MCP installs whose stdio command matches the
      // configured blacklist. The predicate short-circuits to false on
      // open-source builds (no policy → no blacklist → never blocked), so
      // this branch is free except in enterprise variants that opt in.
      if (spec.type === 'mcp') {
        const mcpCommand = spec.mcp_server?.command
        if (mcpCommand && isMcpCommandBlocked(mcpCommand)) {
          throw new McpCommandBlockedError(mcpCommand)
        }
      }

      // Check for duplicate installation
      const specId = spec.name // Use spec name as the canonical spec identifier
      const existing = store.getBySpecAndSpace(specId, spaceId)
      if (existing) {
        // If the existing record is uninstalled, reinstall it with the new spec
        if (existing.status === 'uninstalled') {
          // Update spec in case it changed
          store.updateSpec(existing.id, spec)
          // Update config if provided
          if (userConfig) {
            store.updateConfig(existing.id, userConfig)
          }
          // Reinstall (transitions from uninstalled -> active)
          service.reinstall(existing.id)
          console.log(
            `[AppManager] Reinstalled previously uninstalled app '${spec.name}' (${existing.id})`
          )
          // Re-emit install event: from analytics' perspective a reinstall is
          // a fresh install (the app re-enters the active population).
          const reinstalled = store.getById(existing.id)
          if (reinstalled) {
            notifyInstalled(reinstalled)
          }
          return existing.id
        }

        // Skills are content-only artifacts (prompt + files on disk) with no
        // runtime state; reinstalling the same skill should refresh content
        // rather than fail. Automation/MCP apps retain userConfig, memory,
        // schedule overrides and runtime sessions, so duplicates still throw
        // and the caller must explicitly uninstall before reinstalling.
        if (spec.type === 'skill') {
          store.updateSpec(existing.id, spec)
          if (userConfig) {
            store.updateConfig(existing.id, userConfig)
          }
          const refreshed = store.getById(existing.id)
          if (refreshed) {
            syncSkillToFilesystem(refreshed, getSpacePath)
          }
          console.log(
            `[AppManager] Overwrote existing skill '${spec.name}' (${existing.id})`
          )
          return existing.id
        }

        throw new AppAlreadyInstalledError(specId, spaceId)
      }

      // Generate unique ID
      const appId = uuidv4()

      // Build the InstalledApp record
      const app: InstalledApp = {
        id: appId,
        specId,
        spaceId,
        spec,
        status: 'active',
        userConfig: userConfig ?? {},
        userOverrides: {},
        permissions: {
          granted: [],
          denied: [],
        },
        installedAt: Date.now(),
        upgradeStrategy: 'auto',
      }

      // Persist to SQLite first (atomic: if this fails, no filesystem side effects).
      try {
        store.insert(app)
      } catch (dbError: unknown) {
        const sqliteCode = (dbError as { code?: string })?.code
        if (sqliteCode === 'SQLITE_CONSTRAINT_UNIQUE' || sqliteCode === 'SQLITE_CONSTRAINT') {
          throw new AppAlreadyInstalledError(specId, spaceId)
        }
        throw dbError
      }

      // Create work directories after the DB record is committed.
      const workDir = resolveWorkDir(appId, spaceId)
      const memoryDir = join(workDir, 'memory')

      try {
        ensureDir(workDir)
        ensureDir(memoryDir)
      } catch (dirError) {
        // Roll back the DB record to keep the install atomic
        try { store.delete(appId) } catch { /* best-effort rollback */ }
        throw dirError
      }

      const scope = spaceId ? `space ${spaceId}` : 'global'
      console.log(
        `[AppManager] Installed app '${spec.name}' (${appId}) in ${scope}`
      )

      // Sync skill file to filesystem for Claude Code auto-loading
      if (spec.type === 'skill') {
        syncSkillToFilesystem(app, getSpacePath)
      }

      // Notify session-manager to invalidate affected sessions
      if (spec.type === 'mcp') {
        emitMcpChange(spaceId)
      }

      // Fire install event for analytics / external subscribers.
      // Handlers run in try/catch so business flow is unaffected.
      notifyInstalled(app)

      return appId
    },

    async uninstall(appId: string, _options?: UninstallOptions): Promise<void> {
      const app = requireApp(appId)

      // Soft-delete: transition to 'uninstalled' status and record timestamp
      const oldStatus = app.status
      const newStatus: AppStatus = 'uninstalled'

      if (!isValidTransition(oldStatus, newStatus)) {
        throw new InvalidStatusTransitionError(appId, oldStatus, newStatus)
      }

      store.updateStatus(appId, newStatus, null, null)
      store.updateUninstalledAt(appId, Date.now())
      notifyStatusChange(appId, oldStatus, newStatus)

      // Remove skill file from filesystem on uninstall
      if (app.spec.type === 'skill') {
        removeSkillFromFilesystem(app, getSpacePath)
      }

      // Notify session-manager to invalidate affected sessions
      if (app.spec.type === 'mcp') {
        emitMcpChange(app.spaceId)
      }

      // Cascade-delete bundled skills when parent is uninstalled.
      // Bundled skills exist solely as dependencies of this app. Removing
      // them prevents stale DB records from blocking future reinstallation.
      const skills = app.spec.requires?.skills
      if (skills) {
        for (const dep of skills) {
          if (typeof dep === 'string' || !dep.bundled) continue

          const skillApp = store.getBySpecAndSpace(dep.id, app.spaceId)
          if (!skillApp) continue

          // Remove skill files from filesystem
          if (skillApp.spec.type === 'skill') {
            removeSkillFromFilesystem(skillApp, getSpacePath)
          }

          // Hard-delete the DB record so reinstall gets a clean slate
          store.delete(skillApp.id)

          console.log(
            `[AppManager] Cascade-deleted bundled skill "${dep.id}" (${skillApp.id})`
          )
        }
      }

      console.log(
        `[AppManager] Soft-deleted app ${appId} (was: ${oldStatus})`
      )

      // Fire uninstall event. `app` was captured by requireApp() before the
      // status transition so subscribers receive the original spec metadata.
      notifyUninstalled(app)
    },

    reinstall(appId: string): void {
      const app = requireApp(appId)
      const oldStatus = app.status
      const newStatus: AppStatus = 'active'

      if (oldStatus !== 'uninstalled') {
        throw new InvalidStatusTransitionError(appId, oldStatus, newStatus)
      }

      store.updateStatus(appId, newStatus, null, null)
      store.updateUninstalledAt(appId, null)
      notifyStatusChange(appId, oldStatus, newStatus)

      // Re-sync skill file to filesystem on reinstall
      if (app.spec.type === 'skill') {
        syncSkillToFilesystem(app, getSpacePath)
      }

      // Notify session-manager to invalidate affected sessions
      if (app.spec.type === 'mcp') {
        emitMcpChange(app.spaceId)
      }

      console.log(`[AppManager] Reinstalled app ${appId}`)
    },

    async deleteApp(appId: string, options?: DeleteAppOptions): Promise<void> {
      const app = requireApp(appId)

      // Built-in apps are bundled with the build itself and cannot be permanently
      // deleted by user-initiated paths — the loader would just re-create them on
      // next launch, silently reviving userConfig the user thought they erased.
      // Internal callers (loader GC, full-space deletion) may bypass via the
      // `allowBuiltin` option. IPC / HTTP layers must NOT forward that option.
      if (isBuiltinApp(app) && options?.allowBuiltin !== true) {
        throw new BuiltinAppProtectedError(appId, app.specId, 'deleteApp')
      }

      if (app.status !== 'uninstalled') {
        throw new InvalidStatusTransitionError(
          appId,
          app.status,
          'uninstalled' as AppStatus,
          'App must be uninstalled before permanent deletion'
        )
      }

      // Ensure skill file is removed from filesystem (idempotent)
      if (app.spec.type === 'skill') {
        removeSkillFromFilesystem(app, getSpacePath)
      }

      // Hard-delete the database record
      store.delete(appId)

      // Purge the work directory
      try {
        const workDir = resolveWorkDir(appId, app.spaceId)
        if (existsSync(workDir)) {
          rmSync(workDir, { recursive: true, force: true })
          console.log(`[AppManager] Purged work directory: ${workDir}`)
        }
      } catch (error) {
        console.error(`[AppManager] Failed to purge work directory for ${appId}:`, error)
      }

      console.log(`[AppManager] Permanently deleted app ${appId}`)
    },

    // ── Status Management ─────────────────────

    pause(appId: string): void {
      const app = requireApp(appId)
      const oldStatus = app.status
      const newStatus: AppStatus = 'paused'

      if (!isValidTransition(oldStatus, newStatus)) {
        throw new InvalidStatusTransitionError(appId, oldStatus, newStatus)
      }

      store.updateStatus(appId, newStatus, null, null)
      notifyStatusChange(appId, oldStatus, newStatus)

      // Skills live as .md files on disk that the SDK auto-loads.
      // Removing the file is the only way to prevent injection when paused.
      if (app.spec.type === 'skill') {
        removeSkillFromFilesystem(app, getSpacePath)
      }

      // MCP paused = no longer available in sessions
      if (app.spec.type === 'mcp') {
        emitMcpChange(app.spaceId)
      }

      console.log(`[AppManager] App ${appId}: ${oldStatus} -> ${newStatus}`)
    },

    resume(appId: string): void {
      const app = requireApp(appId)
      const oldStatus = app.status
      const newStatus: AppStatus = 'active'

      if (!isValidTransition(oldStatus, newStatus)) {
        throw new InvalidStatusTransitionError(appId, oldStatus, newStatus)
      }

      // Clear error-related fields on resume
      store.updateStatus(appId, newStatus, null, null)
      notifyStatusChange(appId, oldStatus, newStatus)

      // Restore the skill file so the SDK picks it up again.
      if (app.spec.type === 'skill') {
        syncSkillToFilesystem(app, getSpacePath)
      }

      // MCP resumed = available again in sessions
      if (app.spec.type === 'mcp') {
        emitMcpChange(app.spaceId)
      }

      console.log(`[AppManager] App ${appId}: ${oldStatus} -> ${newStatus}`)
    },

    updateStatus(
      appId: string,
      status: AppStatus,
      extra?: { errorMessage?: string; pendingEscalationId?: string }
    ): void {
      const app = requireApp(appId)
      const oldStatus = app.status

      if (oldStatus === status) {
        // No-op: already in the target status.
        // Still update extra fields if provided.
        store.updateStatus(
          appId,
          status,
          extra?.pendingEscalationId ?? app.pendingEscalationId ?? null,
          extra?.errorMessage ?? app.errorMessage ?? null
        )
        return
      }

      if (!isValidTransition(oldStatus, status)) {
        throw new InvalidStatusTransitionError(appId, oldStatus, status)
      }

      store.updateStatus(
        appId,
        status,
        extra?.pendingEscalationId ?? null,
        extra?.errorMessage ?? null
      )

      notifyStatusChange(appId, oldStatus, status)

      // MCP availability changed: invalidate affected sessions so they
      // rebuild with the correct tool set (e.g. active→error stops the
      // server; error/needs_login→active makes it available again).
      if (app.spec.type === 'mcp') {
        emitMcpChange(app.spaceId)
      }

      console.log(`[AppManager] App ${appId}: ${oldStatus} -> ${status}`)
    },

    // ── Configuration ─────────────────────────

    updateConfig(appId: string, config: Record<string, unknown>): void {
      requireApp(appId) // Throws if not found
      store.updateConfig(appId, config)
    },

    updateFrequency(appId: string, subscriptionId: string, frequency: string): void {
      const app = requireApp(appId)
      const overrides = { ...app.userOverrides }
      if (!overrides.frequency) {
        overrides.frequency = {}
      }
      overrides.frequency[subscriptionId] = frequency
      store.updateOverrides(appId, overrides)
    },

    updateOverrides(appId: string, partial: Partial<InstalledApp['userOverrides']>): void {
      const app = requireApp(appId)
      // JSON Merge Patch semantics: null or undefined removes the key.
      // This ensures both the IPC path (undefined via structured clone) and the
      // HTTP path (null via JSON serialization) correctly clear optional fields.
      const merged: Record<string, unknown> = { ...app.userOverrides }
      for (const [key, value] of Object.entries(partial as Record<string, unknown>)) {
        if (value == null) {
          delete merged[key]
        } else {
          merged[key] = value
        }
      }
      store.updateOverrides(appId, merged as InstalledApp['userOverrides'])
    },

    setUpgradeStrategy(appId: string, strategy: UpgradeStrategy): void {
      requireApp(appId) // Throws if not found
      if (strategy !== 'auto' && strategy !== 'notify' && strategy !== 'manual') {
        throw new Error(`Invalid upgrade strategy: ${strategy}`)
      }
      store.updateUpgradeStrategy(appId, strategy)
      console.log(`[AppManager] App ${appId}: upgradeStrategy -> ${strategy}`)
    },

    updateSpec(appId: string, specPatch: Record<string, unknown>): void {
      const app = requireApp(appId)

      // JSON Merge Patch: merge top-level fields, null = delete
      const currentSpec = app.spec as unknown as Record<string, unknown>
      const merged: Record<string, unknown> = { ...currentSpec }

      for (const [key, value] of Object.entries(specPatch)) {
        if (value === null) {
          delete merged[key]
        } else {
          merged[key] = value
        }
      }

      // Re-validate the merged spec through Zod
      const validatedSpec = validateAppSpec(merged)

      // Security policy: a spec update can change `mcp_server.command` (or
      // flip a non-MCP app into an MCP app). Re-run the blacklist check on
      // the merged result so a PATCH cannot bypass the install-time gate.
      if (validatedSpec.type === 'mcp') {
        const mcpCommand = validatedSpec.mcp_server?.command
        if (mcpCommand && isMcpCommandBlocked(mcpCommand)) {
          throw new McpCommandBlockedError(mcpCommand)
        }
      }

      // Persist
      store.updateSpec(appId, validatedSpec)

      // Re-sync skill file so Claude Code auto-loads the updated content.
      if (validatedSpec.type === 'skill') {
        const updatedApp = { ...app, spec: validatedSpec } as InstalledApp
        syncSkillToFilesystem(updatedApp, getSpacePath)
      }

      // MCP server definition may have changed (command/args/env/etc.):
      // invalidate affected sessions so they reconnect with the new config.
      if (validatedSpec.type === 'mcp') {
        emitMcpChange(app.spaceId)
      }

      console.log(`[AppManager] Updated spec for app ${appId}`)
    },

    async moveToSpace(appId: string, newSpaceId: string | null): Promise<void> {
      const app = requireApp(appId)

      // Cannot move an uninstalled app
      if (app.status === 'uninstalled') {
        throw new InvalidStatusTransitionError(
          appId,
          app.status,
          app.status,
          `App ${appId} is uninstalled and cannot be moved to a different space`
        )
      }

      // No-op: already in the target scope
      if (app.spaceId === newSpaceId) {
        return
      }

      // Validate that the target space exists (if non-global)
      if (newSpaceId !== null) {
        const spacePath = getSpacePath(newSpaceId)
        if (!spacePath) {
          throw new SpaceNotFoundError(newSpaceId)
        }
      }

      // Guard: reject if the same specId is already installed (and active) in the target scope.
      // Uninstalled records are ignored — moving an app to a scope with an uninstalled
      // record of the same specId would first require hard-deleting that record, but
      // that's an edge case we handle by failing gracefully rather than silently overwriting.
      const conflict = store.getBySpecAndSpace(app.specId, newSpaceId)
      if (conflict && conflict.status !== 'uninstalled') {
        throw new AppAlreadyInstalledError(app.specId, newSpaceId)
      }
      // If there's an uninstalled conflict, hard-delete it first to make room
      if (conflict && conflict.status === 'uninstalled') {
        store.delete(conflict.id)
        console.log(
          `[AppManager] Removed stale uninstalled record '${conflict.specId}' (${conflict.id}) to make room for move`
        )
      }

      const oldSpaceId = app.spaceId

      // For skill apps: remove from the old FS location before updating the DB.
      // If the DB update fails below, the skill file is already gone — this is
      // acceptable because the DB is authoritative; a re-sync can restore the file.
      // We do it in this order so the file never exists in two locations simultaneously.
      if (app.spec.type === 'skill') {
        removeSkillFromFilesystem(app, getSpacePath)
      }

      // Persist the new spaceId. The DB unique-index guards against races.
      store.updateSpaceId(appId, newSpaceId)

      // For skill apps: write files to the new location.
      // Build a synthetic InstalledApp with the updated spaceId for the sync call.
      if (app.spec.type === 'skill') {
        const movedApp: InstalledApp = { ...app, spaceId: newSpaceId }
        syncSkillToFilesystem(movedApp, getSpacePath)
      }

      // For MCP apps: notify both old and new scopes so session-manager
      // can invalidate the affected sessions on both sides.
      if (app.spec.type === 'mcp') {
        emitMcpChange(oldSpaceId)
        emitMcpChange(newSpaceId)
      }

      const fromScope = oldSpaceId === null ? 'global' : `space ${oldSpaceId}`
      const toScope   = newSpaceId === null ? 'global' : `space ${newSpaceId}`
      console.log(`[AppManager] Moved app ${appId} from ${fromScope} to ${toScope}`)
    },

    // ── Run Tracking ──────────────────────────

    updateLastRun(appId: string, outcome: RunOutcome, errorMessage?: string): void {
      requireApp(appId) // Throws if not found
      store.updateLastRun(appId, Date.now(), outcome, errorMessage ?? null)
    },

    // ── Queries ───────────────────────────────

    getApp(appId: string): InstalledApp | null {
      return store.getById(appId)
    },

    listApps(filter?: AppListFilter): InstalledApp[] {
      return store.list(filter)
    },

    listEffectiveMcpApps(spaceId: string): InstalledApp[] {
      return listEffectiveByType('mcp', spaceId)
    },

    listEffectiveSkillApps(spaceId: string): InstalledApp[] {
      return listEffectiveByType('skill', spaceId)
    },

    // ── Permissions ───────────────────────────

    grantPermission(appId: string, permission: string): void {
      const app = requireApp(appId)
      const permissions = { ...app.permissions }

      // Add to granted if not already there
      if (!permissions.granted.includes(permission)) {
        permissions.granted = [...permissions.granted, permission]
      }

      // Remove from denied if present
      permissions.denied = permissions.denied.filter(p => p !== permission)

      store.updatePermissions(appId, permissions)
    },

    revokePermission(appId: string, permission: string): void {
      const app = requireApp(appId)
      const permissions = { ...app.permissions }

      // Remove from granted
      permissions.granted = permissions.granted.filter(p => p !== permission)

      // Add to denied if not already there
      if (!permissions.denied.includes(permission)) {
        permissions.denied = [...permissions.denied, permission]
      }

      store.updatePermissions(appId, permissions)
    },

    // ── File System ───────────────────────────

    getAppWorkDir(appId: string): string {
      const app = requireApp(appId)
      const workDir = resolveWorkDir(appId, app.spaceId)

      // Auto-create if missing (contract: returned path always exists)
      ensureDir(workDir)

      // Also ensure the memory subdirectory exists
      ensureDir(join(workDir, 'memory'))

      return workDir
    },

    clearAppMemory(appId: string): number {
      const app = requireApp(appId)
      const workDir = resolveWorkDir(appId, app.spaceId)
      let removed = 0

      // Remove memory.md (active memory file)
      const memoryFile = join(workDir, 'memory.md')
      if (existsSync(memoryFile)) {
        unlinkSync(memoryFile)
        removed++
      }

      // Remove all files under memory/ recursively (run summaries + compaction archives)
      // Preserve the directory itself so the next run can write immediately.
      const memoryDir = join(workDir, 'memory')
      if (existsSync(memoryDir)) {
        removed += clearDirContents(memoryDir)
      }

      // Remove all files under runs/ (full session execution logs written by sessionWriter)
      // Preserve the directory itself.
      const runsDir = join(workDir, 'runs')
      if (existsSync(runsDir)) {
        removed += clearDirContents(runsDir)
      }

      console.log(`[AppManager] clearAppMemory: appId=${appId}, filesRemoved=${removed}`)
      return removed
    },

    // ── Events ────────────────────────────────

    onAppStatusChange(handler: StatusChangeHandler): Unsubscribe {
      statusChangeHandlers.push(handler)

      return () => {
        const index = statusChangeHandlers.indexOf(handler)
        if (index > -1) {
          statusChangeHandlers.splice(index, 1)
        }
      }
    },

    onAppInstalled(handler: AppInstalledHandler): Unsubscribe {
      appInstalledHandlers.push(handler)
      return () => {
        const index = appInstalledHandlers.indexOf(handler)
        if (index > -1) {
          appInstalledHandlers.splice(index, 1)
        }
      }
    },

    onAppUninstalled(handler: AppUninstalledHandler): Unsubscribe {
      appUninstalledHandlers.push(handler)
      return () => {
        const index = appUninstalledHandlers.indexOf(handler)
        if (index > -1) {
          appUninstalledHandlers.splice(index, 1)
        }
      }
    },

    // ── Space Cleanup ────────────────────────

    async deleteAppsInSpace(spaceId: string): Promise<number> {
      // Get all apps in this space (including uninstalled)
      const apps = store.list({ spaceId })
      let deleted = 0
      let builtinCount = 0

      for (const app of apps) {
        try {
          // Built-in apps in this space are deleted as part of the cascade — the
          // enclosing space no longer exists, so the BuiltinAppProtectedError
          // guard does not apply (it protects against accidental single-app
          // delete from the UI, not against legitimate space teardown). On the
          // next launch, the loader will re-install them in the spaceId declared
          // by the manifest, which is typically `halo-temp` — a different space
          // from the one being destroyed here. Worst case, userConfig for that
          // builtin in this destroyed space is lost, which is the expected
          // outcome of destroying a space.
          if (isBuiltinApp(app)) builtinCount++

          // Remove skill files from filesystem
          if (app.spec.type === 'skill') {
            removeSkillFromFilesystem(app, getSpacePath)
          }

          // Purge the work directory
          try {
            const workDir = resolveWorkDir(app.id, spaceId)
            if (existsSync(workDir)) {
              rmSync(workDir, { recursive: true, force: true })
            }
          } catch (dirErr) {
            console.warn(`[AppManager] Failed to purge work dir for ${app.id}:`, dirErr)
          }

          // Hard-delete the DB record
          store.delete(app.id)
          deleted++

          console.log(`[AppManager] Deleted app ${app.id} (${app.spec.name}) from space ${spaceId}`)
        } catch (err) {
          console.error(`[AppManager] Failed to delete app ${app.id}:`, err)
        }
      }

      if (deleted > 0) {
        const builtinNote = builtinCount > 0 ? ` (incl. ${builtinCount} built-in)` : ''
        console.log(`[AppManager] Deleted ${deleted} apps from space ${spaceId}${builtinNote}`)
      }

      return deleted
    },

    // ── Garbage Collection ───────────────────

    pruneUninstalledApps(retentionMs?: number): number {
      // Default retention: 30 days
      const retention = retentionMs ?? 30 * 24 * 60 * 60 * 1000
      const pruned = store.pruneUninstalledApps(retention)

      if (pruned > 0) {
        console.log(`[AppManager] Pruned ${pruned} stale uninstalled apps (retention: ${retention}ms)`)
      }

      return pruned
    },
  }

  return service
}
