/**
 * platform/store -- Type Definitions
 *
 * Public types for the SQLite persistence layer.
 * Consumed by all platform and apps modules.
 */

import type Database from 'better-sqlite3'

/**
 * A single schema migration step.
 *
 * Migrations are namespaced per module (e.g., "scheduler", "app_manager").
 * Each module maintains its own version sequence starting from 1.
 * The `up` function receives a raw better-sqlite3 Database instance and
 * should execute DDL/DML statements to bring the schema to this version.
 *
 * Migrations for a given namespace run inside a single transaction.
 * If any migration step throws, the entire batch is rolled back.
 */
export interface Migration {
  /** Sequential version number (1, 2, 3, ...). Must be unique within a namespace. */
  version: number
  /** Human-readable description of what this migration does. */
  description: string
  /** Rebuilds a referenced table: suspend FK actions for the atomic batch and reject new violations before commit. */
  foreignKeys?: 'rebuild'
  /** Execute the migration. Called with the database instance inside a transaction. */
  up(db: Database.Database): void
}

/**
 * Central database manager for the Halo application.
 *
 * Provides access to SQLite databases and handles schema migrations.
 * Each consuming module (scheduler, app manager, etc.) obtains a database
 * reference and registers its own migrations via a unique namespace.
 *
 * All methods are synchronous (better-sqlite3 is a synchronous API).
 * The only async operation is `initStore()` which creates the manager.
 */
export interface DatabaseManager {
  /**
   * Get the application-level database instance.
   *
   * Returns the shared SQLite database at `~/.halo/halo.db`.
   * The database is opened lazily on first call and cached for reuse.
   * WAL mode and performance PRAGMAs are applied automatically.
   *
   * @throws {Error} If the database cannot be opened after recovery attempts.
   */
  getAppDatabase(): Database.Database

  /**
   * Get a space-level database instance.
   *
   * V1: This method is defined for interface completeness but will throw
   * a "not implemented" error. Space-level databases ({space}/data.db) are
   * planned for V2 when space-scoped memory indexing is needed.
   *
   * @param spacePath - Absolute path to the space data directory.
   * @throws {Error} Always throws in V1 ("Space databases not implemented in V1").
   */
  getSpaceDatabase(spacePath: string): Database.Database

  /**
   * Run schema migrations for a specific module namespace.
   *
   * Each module (scheduler, app_manager, event_bus, etc.) calls this with
   * its own namespace and migration list. The method:
   *
   * 1. Creates the `_migrations` meta-table if it does not exist
   * 2. Reads the current version for the given namespace
   * 3. Filters to only unapplied migrations (version > current)
   * 4. Sorts by version ascending
   * 5. Runs all unapplied migrations in a single transaction
   * 6. Updates the namespace version in `_migrations`
   *
   * If any migration throws, the entire batch is rolled back and the
   * namespace stays at its previous version.
   * Pending referenced-table rebuilds cannot run inside an external transaction;
   * their batch temporarily disables FK actions and restores the original setting.
   *
   * @param db - The database to migrate (from getAppDatabase or getSpaceDatabase).
   * @param namespace - Unique identifier for the module (e.g., "scheduler").
   * @param migrations - Array of migration steps, in any order (sorted internally).
   */
  runMigrations(db: Database.Database, namespace: string, migrations: Migration[]): void

  /**
   * Execute a function inside a database transaction.
   *
   * Wraps better-sqlite3's transaction API for convenience.
   * If the function throws, the transaction is rolled back.
   * If it returns normally, the transaction is committed.
   *
   * @param db - The database to use.
   * @param fn - The function to execute within the transaction.
   * @returns The return value of `fn`.
   */
  transaction<T>(db: Database.Database, fn: () => T): T

  /**
   * Close all open database connections.
   *
   * Should be called during application shutdown (app.on('before-quit')).
   * After calling this, getAppDatabase() will open a fresh connection.
   */
  closeAll(): void
}
