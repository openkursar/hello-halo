/**
 * apps/manager -- SQLite Store
 *
 * Low-level CRUD operations for the installed_apps table.
 * This module handles serialization/deserialization between the InstalledApp
 * domain type and the flat SQLite row format.
 *
 * All methods are synchronous (better-sqlite3 is a synchronous API).
 * The store does not enforce business rules -- that is the service layer's job.
 */

import type Database from 'better-sqlite3'
import type { AppSpec } from '../spec'
import type { InstalledApp, AppStatus, RunOutcome, AppListFilter, UpgradeStrategy } from './types'

// ============================================
// SQLite Row Type (flat DB representation)
// ============================================

/** Shape of a row from the installed_apps table */
interface AppRow {
  id: string
  spec_id: string
  space_id: string | null
  spec_json: string
  status: string
  pending_escalation_id: string | null
  user_config_json: string
  user_overrides_json: string
  permissions_json: string
  installed_at: number
  last_run_at: number | null
  last_run_outcome: string | null
  error_message: string | null
  uninstalled_at: number | null
  upgrade_strategy: string
}

// ============================================
// Row <-> Domain Mapping
// ============================================

/**
 * Convert a database row to an InstalledApp domain object.
 */
function rowToInstalledApp(row: AppRow): InstalledApp {
  return {
    id: row.id,
    specId: row.spec_id,
    spaceId: row.space_id,  // null for global apps
    spec: JSON.parse(row.spec_json) as AppSpec,
    status: row.status as AppStatus,
    pendingEscalationId: row.pending_escalation_id ?? undefined,
    userConfig: JSON.parse(row.user_config_json) as Record<string, unknown>,
    userOverrides: JSON.parse(row.user_overrides_json) as InstalledApp['userOverrides'],
    permissions: JSON.parse(row.permissions_json) as InstalledApp['permissions'],
    installedAt: row.installed_at,
    lastRunAt: row.last_run_at ?? undefined,
    lastRunOutcome: (row.last_run_outcome as RunOutcome) ?? undefined,
    errorMessage: row.error_message ?? undefined,
    uninstalledAt: row.uninstalled_at ?? undefined,
    upgradeStrategy: (row.upgrade_strategy as UpgradeStrategy) ?? 'auto',
  }
}

// ============================================
// AppManagerStore
// ============================================

/**
 * Prepared-statement-based store for the installed_apps table.
 *
 * All statements are prepared once at construction time for performance.
 * The store is stateless beyond the prepared statements -- it does not cache
 * any data in memory.
 */
export class AppManagerStore {
  private readonly stmtInsert: Database.Statement
  private readonly stmtGetById: Database.Statement
  private readonly stmtDeleteById: Database.Statement
  private readonly stmtUpdateStatus: Database.Statement
  private readonly stmtUpdateConfig: Database.Statement
  private readonly stmtUpdateOverrides: Database.Statement
  private readonly stmtUpdatePermissions: Database.Statement
  private readonly stmtUpdateLastRun: Database.Statement
  private readonly stmtUpdateSpec: Database.Statement
  private readonly stmtUpdateSpaceId: Database.Statement
  private readonly stmtListAll: Database.Statement
  private readonly stmtGetBySpecAndSpace: Database.Statement
  private readonly stmtGetBySpecGlobal: Database.Statement
  private readonly stmtUpdateUninstalledAt: Database.Statement
  private readonly stmtUpdateUpgradeStrategy: Database.Statement

  constructor(private readonly db: Database.Database) {
    // ── INSERT ────────────────────────────────────
    this.stmtInsert = db.prepare(`
      INSERT INTO installed_apps (
        id, spec_id, space_id, spec_json, status,
        pending_escalation_id, user_config_json, user_overrides_json,
        permissions_json, installed_at, last_run_at, last_run_outcome, error_message,
        upgrade_strategy
      ) VALUES (
        @id, @spec_id, @space_id, @spec_json, @status,
        @pending_escalation_id, @user_config_json, @user_overrides_json,
        @permissions_json, @installed_at, @last_run_at, @last_run_outcome, @error_message,
        @upgrade_strategy
      )
    `)

    // ── SELECT ────────────────────────────────────
    this.stmtGetById = db.prepare(`
      SELECT * FROM installed_apps WHERE id = ?
    `)

    this.stmtGetBySpecAndSpace = db.prepare(`
      SELECT * FROM installed_apps WHERE spec_id = ? AND space_id = ?
    `)

    this.stmtGetBySpecGlobal = db.prepare(`
      SELECT * FROM installed_apps WHERE spec_id = ? AND space_id IS NULL
    `)

    this.stmtListAll = db.prepare(`
      SELECT * FROM installed_apps ORDER BY installed_at DESC
    `)

    // ── DELETE ────────────────────────────────────
    this.stmtDeleteById = db.prepare(`
      DELETE FROM installed_apps WHERE id = ?
    `)

    // ── UPDATE ────────────────────────────────────
    this.stmtUpdateStatus = db.prepare(`
      UPDATE installed_apps
      SET status = @status,
          pending_escalation_id = @pending_escalation_id,
          error_message = @error_message
      WHERE id = @id
    `)

    this.stmtUpdateConfig = db.prepare(`
      UPDATE installed_apps
      SET user_config_json = @user_config_json
      WHERE id = @id
    `)

    this.stmtUpdateOverrides = db.prepare(`
      UPDATE installed_apps
      SET user_overrides_json = @user_overrides_json
      WHERE id = @id
    `)

    this.stmtUpdatePermissions = db.prepare(`
      UPDATE installed_apps
      SET permissions_json = @permissions_json
      WHERE id = @id
    `)

    this.stmtUpdateLastRun = db.prepare(`
      UPDATE installed_apps
      SET last_run_at = @last_run_at,
          last_run_outcome = @last_run_outcome,
          error_message = @error_message
      WHERE id = @id
    `)

    this.stmtUpdateSpec = db.prepare(`
      UPDATE installed_apps
      SET spec_json = @spec_json,
          spec_id = @spec_id
      WHERE id = @id
    `)

    this.stmtUpdateSpaceId = db.prepare(`
      UPDATE installed_apps
      SET space_id = @space_id
      WHERE id = @id
    `)

    this.stmtUpdateUninstalledAt = db.prepare(`
      UPDATE installed_apps
      SET uninstalled_at = @uninstalled_at
      WHERE id = @id
    `)

    this.stmtUpdateUpgradeStrategy = db.prepare(`
      UPDATE installed_apps
      SET upgrade_strategy = @upgrade_strategy
      WHERE id = @id
    `)
  }

  // ── Create ─────────────────────────────────────

  /**
   * Insert a new installed App record.
   *
   * @throws If the UNIQUE(spec_id, space_id) constraint is violated.
   */
  insert(app: InstalledApp): void {
    this.stmtInsert.run({
      id: app.id,
      spec_id: app.specId,
      space_id: app.spaceId,
      spec_json: JSON.stringify(app.spec),
      status: app.status,
      pending_escalation_id: app.pendingEscalationId ?? null,
      user_config_json: JSON.stringify(app.userConfig),
      user_overrides_json: JSON.stringify(app.userOverrides),
      permissions_json: JSON.stringify(app.permissions),
      installed_at: app.installedAt,
      last_run_at: app.lastRunAt ?? null,
      last_run_outcome: app.lastRunOutcome ?? null,
      error_message: app.errorMessage ?? null,
      upgrade_strategy: app.upgradeStrategy ?? 'auto',
    })
  }

  /**
   * Update the upgrade strategy column for an App.
   * Caller is responsible for validating the strategy value.
   */
  updateUpgradeStrategy(appId: string, strategy: UpgradeStrategy): void {
    this.stmtUpdateUpgradeStrategy.run({
      id: appId,
      upgrade_strategy: strategy,
    })
  }

  // ── Read ───────────────────────────────────────

  /**
   * Get an installed App by its unique ID.
   * Returns null if not found.
   */
  getById(appId: string): InstalledApp | null {
    const row = this.stmtGetById.get(appId) as AppRow | undefined
    return row ? rowToInstalledApp(row) : null
  }

  /**
   * Check if an App with the given specId is already installed in the scope.
   * When spaceId is null, checks global scope (space_id IS NULL).
   * Returns the existing InstalledApp if found, null otherwise.
   */
  getBySpecAndSpace(specId: string, spaceId: string | null): InstalledApp | null {
    const row = spaceId === null
      ? this.stmtGetBySpecGlobal.get(specId) as AppRow | undefined
      : this.stmtGetBySpecAndSpace.get(specId, spaceId) as AppRow | undefined
    return row ? rowToInstalledApp(row) : null
  }

  /**
   * List all installed Apps, optionally filtered.
   *
   * Filtering is done in-memory after fetching all rows. For the expected
   * scale (tens to low hundreds of installed Apps), this is perfectly adequate
   * and simpler than dynamic SQL construction.
   */
  list(filter?: AppListFilter): InstalledApp[] {
    const rows = this.stmtListAll.all() as AppRow[]
    let apps = rows.map(rowToInstalledApp)

    if (filter) {
      if (filter.spaceId !== undefined) {
        if (filter.spaceId === null) {
          // Explicitly filter to global-only apps
          apps = apps.filter(a => a.spaceId === null)
        } else {
          const spaceId = filter.spaceId
          apps = apps.filter(a => a.spaceId === spaceId)
        }
      }
      if (filter.status) {
        const status = filter.status
        apps = apps.filter(a => a.status === status)
      }
      if (filter.type) {
        const type = filter.type
        apps = apps.filter(a => a.spec.type === type)
      }
    }

    return apps
  }

  // ── Update ─────────────────────────────────────

  /**
   * Update the status and related fields of an installed App.
   */
  updateStatus(
    appId: string,
    status: AppStatus,
    pendingEscalationId: string | null,
    errorMessage: string | null
  ): void {
    this.stmtUpdateStatus.run({
      id: appId,
      status,
      pending_escalation_id: pendingEscalationId,
      error_message: errorMessage,
    })
  }

  /**
   * Update the user configuration JSON for an App.
   */
  updateConfig(appId: string, config: Record<string, unknown>): void {
    this.stmtUpdateConfig.run({
      id: appId,
      user_config_json: JSON.stringify(config),
    })
  }

  /**
   * Update the user overrides JSON for an App.
   */
  updateOverrides(appId: string, overrides: InstalledApp['userOverrides']): void {
    this.stmtUpdateOverrides.run({
      id: appId,
      user_overrides_json: JSON.stringify(overrides),
    })
  }

  /**
   * Update the permissions JSON for an App.
   */
  updatePermissions(appId: string, permissions: InstalledApp['permissions']): void {
    this.stmtUpdatePermissions.run({
      id: appId,
      permissions_json: JSON.stringify(permissions),
    })
  }

  /**
   * Update the App spec and spec_id for an installed App.
   */
  updateSpec(appId: string, spec: AppSpec): void {
    this.stmtUpdateSpec.run({
      id: appId,
      spec_json: JSON.stringify(spec),
      spec_id: spec.name,
    })
  }

  /**
   * Update the space_id for an installed App.
   * Pass null for global scope.
   *
   * Callers must verify no UNIQUE(spec_id, space_id) collision exists before
   * calling this — the DB constraint will throw if it does.
   */
  updateSpaceId(appId: string, spaceId: string | null): void {
    this.stmtUpdateSpaceId.run({
      id: appId,
      space_id: spaceId,
    })
  }

  /**
   * Record the result of a run execution.
   */
  updateLastRun(
    appId: string,
    lastRunAt: number,
    outcome: RunOutcome,
    errorMessage: string | null
  ): void {
    this.stmtUpdateLastRun.run({
      id: appId,
      last_run_at: lastRunAt,
      last_run_outcome: outcome,
      error_message: errorMessage,
    })
  }

  /**
   * Update the uninstalled_at timestamp for an App.
   * Pass a timestamp (ms) for soft-delete, or null to clear (reinstall).
   */
  updateUninstalledAt(appId: string, ts: number | null): void {
    this.stmtUpdateUninstalledAt.run({
      id: appId,
      uninstalled_at: ts,
    })
  }

  // ── Delete ─────────────────────────────────────

  /**
   * Delete an installed App record by ID.
   * Returns true if a row was actually deleted, false if it did not exist.
   */
  delete(appId: string): boolean {
    const result = this.stmtDeleteById.run(appId)
    return result.changes > 0
  }

  /**
   * Delete all apps that have been uninstalled for longer than the given retention period.
   * Returns the number of records deleted.
   *
   * @param retentionMs - Retention period in milliseconds (e.g., 30 days)
   */
  pruneUninstalledApps(retentionMs: number): number {
    const cutoff = Date.now() - retentionMs
    const stmt = this.db.prepare(`
      DELETE FROM installed_apps
      WHERE status = 'uninstalled' AND uninstalled_at IS NOT NULL AND uninstalled_at < ?
    `)
    const result = stmt.run(cutoff)
    return result.changes
  }
}
