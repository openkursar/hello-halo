/**
 * platform/store -- DatabaseManager Implementation
 *
 * Core implementation of the SQLite database manager.
 * Handles connection lifecycle, PRAGMA tuning, migration execution,
 * corruption recovery, and transaction helpers.
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, renameSync } from 'fs'
import { dirname } from 'path'
import type { DatabaseManager, Migration } from './types'
import { SchemaAheadError, snapshotBeforeMigration } from './schema-guard'

/** Internal meta-table for tracking migration versions per namespace. */
const MIGRATIONS_TABLE = '_migrations'

/** Suffix marking a pre-migration snapshot; also the pattern used to prune old ones. */
const BACKUP_SUFFIX = '.premigrate.bak'

/** How many pre-migration snapshots to keep before pruning the oldest. */
const MAX_BACKUPS = 2

/** SQL to create the migrations tracking table. */
const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    namespace  TEXT PRIMARY KEY,
    version    INTEGER NOT NULL DEFAULT 0,
    applied_at INTEGER NOT NULL
  )
`

interface ForeignKeyViolation {
  table: string
  rowid: bigint | null
  parent: string
  fkid: bigint
}

interface ForeignKeyColumn {
  id: number
  seq: number
  table: string
  from: string
  to: string | null
  on_update: string
  on_delete: string
  match: string
}

function quotedIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function foreignKeyValue(value: unknown): [string, string?] {
  if (value === null) return ['null']
  if (typeof value === 'bigint') return ['integer', value.toString()]
  if (typeof value === 'number') return ['real', String(value)]
  if (typeof value === 'string') return ['text', value]
  if (Buffer.isBuffer(value)) return ['blob', value.toString('base64')]
  throw new Error('[Store] Foreign-key verification encountered an unsupported SQLite value')
}

function* foreignKeyViolations(db: Database.Database) {
  const readers = new Map<string, { definition: unknown[]; columns: string[]; row: Database.Statement }>()
  const check = db.prepare('PRAGMA main.foreign_key_check').safeIntegers()
  for (const violation of check.iterate() as IterableIterator<ForeignKeyViolation>) {
    if (violation.rowid === null) {
      throw new Error(`[Store] Foreign-key verification cannot identify a violating row in "${violation.table}" without rowid`)
    }
    const constraint = JSON.stringify([violation.table, violation.fkid.toString()])
    let reader = readers.get(constraint)
    if (!reader) {
      const table = quotedIdentifier(violation.table)
      const columns = db.prepare('SELECT name, pk FROM pragma_table_info(?, ?)').all(violation.table, 'main') as Array<{ name: string; pk: number }>
      const names = new Set(columns.map(column => column.name.toLowerCase()))
      const rowid = ['_rowid_', 'rowid', 'oid'].find(name => !names.has(name))
      if (!rowid) throw new Error(`[Store] Foreign-key verification cannot address the row identity in "${violation.table}"`)
      const foreignKey = (db.prepare('SELECT * FROM pragma_foreign_key_list(?, ?)').all(violation.table, 'main') as ForeignKeyColumn[])
        .filter(column => BigInt(column.id) === violation.fkid).sort((a, b) => a.seq - b.seq)
      if (foreignKey.length === 0) throw new Error(`[Store] Foreign-key verification cannot resolve a constraint in "${violation.table}"`)
      const selected = [...columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name), ...foreignKey.map(column => column.from)]
      reader = {
        definition: foreignKey.map(column => [column.from, column.to, column.on_update, column.on_delete, column.match]),
        columns: selected,
        row: db.prepare(`SELECT ${selected.map(quotedIdentifier).join(', ')} FROM main.${table} WHERE ${rowid} = ?`).raw().safeIntegers(),
      }
      readers.set(constraint, reader)
    }
    const values = reader.row.get(violation.rowid) as unknown[] | undefined
    if (!values) throw new Error(`[Store] Foreign-key verification cannot read the violating row in "${violation.table}"`)
    yield {
      table: violation.table,
      parent: violation.parent,
      key: JSON.stringify([constraint, violation.rowid.toString(), violation.parent, reader.definition, reader.columns, values.map(foreignKeyValue)]),
    }
  }
}

/**
 * Apply performance and safety PRAGMAs to a newly opened database.
 *
 * These settings optimize for the Halo use case:
 * - WAL mode: concurrent reads, no reader blocking on writes
 * - NORMAL synchronous: good durability/performance balance with WAL
 * - Foreign keys: enforce referential integrity
 * - Busy timeout: wait for locks instead of failing immediately
 */
function applyPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
}

/**
 * Check if an error indicates actual database corruption vs. other I/O errors.
 * Only corruption errors should trigger the recovery path (rename + rebuild).
 * Other errors (permissions, disk full, etc.) should propagate.
 */
function isCorruptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const corruptionPatterns = [
    'SQLITE_CORRUPT',
    'SQLITE_NOTADB',
    'database disk image is malformed',
    'file is not a database',
    'file is encrypted or is not a database',
  ]
  return corruptionPatterns.some((p) => message.includes(p))
}

/**
 * Attempt to open a SQLite database with corruption recovery.
 *
 * If the initial open fails with a corruption-related error, the broken
 * database file is renamed to `{name}.corrupt.{timestamp}` and a fresh
 * database is created in its place. This ensures the application can always
 * start, even if data is lost.
 *
 * For in-memory databases (path === ':memory:'), no recovery is attempted.
 *
 * @param dbPath - Absolute path to the database file, or ':memory:'.
 * @returns An opened Database instance with PRAGMAs applied.
 */
function openDatabase(dbPath: string): Database.Database {
  // In-memory databases need no file handling
  if (dbPath === ':memory:') {
    const db = new Database(dbPath)
    applyPragmas(db)
    return db
  }

  // Ensure the parent directory exists
  const dir = dirname(dbPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  try {
    const db = new Database(dbPath)
    // Quick integrity check: try reading from sqlite_master
    db.prepare('SELECT count(*) FROM sqlite_master').get()
    applyPragmas(db)
    console.log(`[Store] Database opened: ${dbPath}`)
    return db
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[Store] Failed to open database ${dbPath}: ${message}`)

    // Only attempt corruption recovery for actual corruption errors.
    // Non-corruption errors (EACCES, ENOSPC, etc.) should propagate directly.
    if (!isCorruptionError(error)) {
      throw error
    }

    // Attempt corruption recovery
    if (existsSync(dbPath)) {
      const timestamp = Date.now()
      const corruptPath = `${dbPath}.corrupt.${timestamp}`
      try {
        renameSync(dbPath, corruptPath)
        console.warn(`[Store] Renamed corrupt database to: ${corruptPath}`)
      } catch (renameError) {
        console.error(`[Store] Failed to rename corrupt database:`, renameError)
        // If we cannot rename, try deleting WAL/SHM files that might be causing issues
      }

      // Also rename WAL and SHM files if they exist
      const walPath = `${dbPath}-wal`
      const shmPath = `${dbPath}-shm`
      try {
        if (existsSync(walPath)) renameSync(walPath, `${walPath}.corrupt.${timestamp}`)
        if (existsSync(shmPath)) renameSync(shmPath, `${shmPath}.corrupt.${timestamp}`)
      } catch {
        // Non-fatal: WAL/SHM cleanup failure
      }
    }

    // Try creating a fresh database
    try {
      const db = new Database(dbPath)
      applyPragmas(db)
      console.log(`[Store] Fresh database created at: ${dbPath}`)
      return db
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
      throw new Error(`[Store] Cannot create database at ${dbPath}: ${retryMessage}`)
    }
  }
}

/**
 * Create a new DatabaseManager instance.
 *
 * @param appDbPath - Absolute path for the application-level database.
 *                    Pass ':memory:' for testing.
 */
export function createDatabaseManager(appDbPath: string): DatabaseManager {
  /**
   * Cache of open database connections, keyed by file path.
   * For the app-level database, the key is `appDbPath`.
   * For space-level databases (V2+), keys would be the space data.db paths.
   */
  const connections = new Map<string, Database.Database>()

  /**
   * Databases already snapshotted during this process run.
   *
   * Several namespaces migrate during one startup; one snapshot taken before
   * the first of them captures the pre-upgrade state for all, and avoids
   * writing a full copy of a multi-hundred-MB file once per module.
   */
  const snapshotted = new Set<string>()

  /**
   * Get or create a database connection for the given path.
   */
  function getOrOpen(dbPath: string): Database.Database {
    const existing = connections.get(dbPath)
    if (existing) {
      // Verify the connection is still usable
      try {
        existing.prepare('SELECT 1').get()
        return existing
      } catch {
        // Connection is broken, remove and reopen
        console.warn(`[Store] Stale connection detected for ${dbPath}, reopening...`)
        connections.delete(dbPath)
        try {
          existing.close()
        } catch {
          // Ignore close errors on stale connections
        }
      }
    }

    const db = openDatabase(dbPath)
    connections.set(dbPath, db)
    return db
  }

  /**
   * Ensure the migrations meta-table exists in the given database.
   * This is idempotent (CREATE TABLE IF NOT EXISTS).
   */
  function ensureMigrationsTable(db: Database.Database): void {
    db.exec(CREATE_MIGRATIONS_TABLE_SQL)
  }

  /**
   * Get the current schema version for a namespace.
   * Returns 0 if the namespace has never been migrated.
   */
  function getCurrentVersion(db: Database.Database, namespace: string): number {
    const row = db.prepare(
      `SELECT version FROM ${MIGRATIONS_TABLE} WHERE namespace = ?`
    ).get(namespace) as { version: number } | undefined

    return row?.version ?? 0
  }

  /**
   * Update (upsert) the schema version for a namespace.
   */
  function setVersion(db: Database.Database, namespace: string, version: number): void {
    db.prepare(`
      INSERT INTO ${MIGRATIONS_TABLE} (namespace, version, applied_at)
      VALUES (?, ?, ?)
      ON CONFLICT(namespace) DO UPDATE SET
        version = excluded.version,
        applied_at = excluded.applied_at
    `).run(namespace, version, Date.now())
  }

  // =========================================================================
  // DatabaseManager implementation
  // =========================================================================

  const manager: DatabaseManager = {
    getAppDatabase(): Database.Database {
      return getOrOpen(appDbPath)
    },

    getSpaceDatabase(_spacePath: string): Database.Database {
      throw new Error(
        '[Store] Space-level databases are not implemented in V1. ' +
        'This interface is reserved for V2+ when space-scoped memory indexing is needed.'
      )
    },

    runMigrations(db: Database.Database, namespace: string, migrations: Migration[]): void {
      if (!namespace || typeof namespace !== 'string') {
        throw new Error('[Store] Migration namespace must be a non-empty string')
      }

      if (!migrations || migrations.length === 0) {
        return // Nothing to migrate
      }

      // Validate migration list: no duplicate versions, all versions > 0
      const versionSet = new Set<number>()
      for (const m of migrations) {
        if (!Number.isInteger(m.version) || m.version < 1) {
          throw new Error(
            `[Store] Invalid migration version ${m.version} in namespace "${namespace}". ` +
            'Versions must be positive integers.'
          )
        }
        if (versionSet.has(m.version)) {
          throw new Error(
            `[Store] Duplicate migration version ${m.version} in namespace "${namespace}".`
          )
        }
        if (m.foreignKeys !== undefined && m.foreignKeys !== 'rebuild') {
          throw new Error(`[Store] Unsupported foreign-key migration mode in namespace "${namespace}" at version ${m.version}`)
        }
        versionSet.add(m.version)
      }

      // Sort migrations by version ascending
      const sorted = [...migrations].sort((a, b) => a.version - b.version)

      let transactionVersion: number | undefined
      if (db.inTransaction && sorted.some(migration => migration.foreignKeys === 'rebuild')) {
        const metadata = db.prepare('SELECT 1 FROM main.sqlite_schema WHERE type = ? AND name = ?').get('table', MIGRATIONS_TABLE)
        const storedVersion = metadata ? getCurrentVersion(db, namespace) : 0
        transactionVersion = storedVersion
        if (sorted.some(migration => migration.version > storedVersion && migration.foreignKeys === 'rebuild')) {
          const message = `[Store] Migration refused for namespace "${namespace}" at version ${storedVersion}: Referenced-table rebuild requires no external transaction or savepoint`
          console.error(message)
          throw new Error(message)
        }
      }

      // Ensure the migrations meta-table exists
      ensureMigrationsTable(db)

      // Get current version for this namespace
      const currentVersion = transactionVersion ?? getCurrentVersion(db, namespace)

      // The newest migration this build carries IS its statement of what it
      // understands, so this check cannot drift from the code the way a
      // separately-maintained "supported version" constant would.
      const supportedVersion = sorted[sorted.length - 1].version
      if (currentVersion > supportedVersion) {
        throw new SchemaAheadError(namespace, currentVersion, supportedVersion)
      }

      // Filter to only unapplied migrations
      const pending = sorted.filter(m => m.version > currentVersion)

      if (pending.length === 0) {
        return // Already up to date
      }

      // Verify no gaps in the migration sequence from current
      // (e.g., if current is 2 and we have [4, 5] but missing 3, that is an error)
      const expectedNextVersion = currentVersion + 1
      if (pending[0].version !== expectedNextVersion) {
        // Allow gaps: the module may have removed old migrations that were already applied.
        // Only warn, do not error -- this is a common pattern when cleaning up old migrations.
        console.warn(
          `[Store] Migration gap in namespace "${namespace}": ` +
          `current version is ${currentVersion}, ` +
          `next available migration is version ${pending[0].version}. ` +
          `Migrations ${expectedNextVersion} through ${pending[0].version - 1} are missing.`
        )
      }

      // Run all pending migrations in a single transaction
      const rebuilding = pending.some(migration => migration.foreignKeys === 'rebuild')
      let checked: { before: number; after: number } | undefined
      const runMigrationsBatch = db.transaction(() => {
        const baseline = rebuilding ? new Set<string>() : undefined
        if (baseline) {
          for (const violation of foreignKeyViolations(db)) baseline.add(violation.key)
        }
        for (const migration of pending) {
          console.log(
            `[Store] Running migration "${namespace}" v${migration.version}: ${migration.description}`
          )
          migration.up(db)
        }

        // Record the final version
        const finalVersion = pending[pending.length - 1].version
        setVersion(db, namespace, finalVersion)
        if (baseline) {
          let remaining = 0
          for (const violation of foreignKeyViolations(db)) {
            if (!baseline.has(violation.key)) {
              throw new Error(`[Store] Foreign-key verification found a new violation in "${violation.table}" referencing "${violation.parent}"`)
            }
            remaining++
          }
          checked = { before: baseline.size, after: remaining }
        }
      })

      try {
        // Snapshot before the schema changes shape, with the original FK setting.
        if (currentVersion > 0 && !db.memory && !snapshotted.has(db.name)) {
          snapshotted.add(db.name)
          snapshotBeforeMigration(db, db.name, BACKUP_SUFFIX, MAX_BACKUPS)
        }
        if (rebuilding) {
          const originalForeignKeys = db.pragma('foreign_keys', { simple: true })
          if (originalForeignKeys !== 0 && originalForeignKeys !== 1) throw new Error('[Store] Cannot read the foreign-key enforcement setting')
          let executionError: unknown
          try {
            db.pragma('foreign_keys = OFF')
            if (db.pragma('foreign_keys', { simple: true }) !== 0) throw new Error('[Store] Cannot suspend foreign-key actions for the referenced-table rebuild')
            runMigrationsBatch.immediate()
          } catch (error) {
            executionError = error
            throw error
          } finally {
            try {
              db.pragma(`foreign_keys = ${originalForeignKeys}`)
              if (db.pragma('foreign_keys', { simple: true }) !== originalForeignKeys) throw new Error('Foreign-key enforcement did not return to its original setting')
            } catch (restoreError) {
              const errors = executionError === undefined ? [restoreError] : [executionError, restoreError]
              for (const [path, connection] of connections) {
                if (connection === db) connections.delete(path)
              }
              let closeFailed = false
              try { if (db.open) db.close() } catch (closeError) { closeFailed = true; errors.push(closeError) }
              throw new AggregateError(errors, `[Store] Foreign-key restoration failed; connection removed from cache; close ${closeFailed ? 'failed' : 'succeeded'}`)
            }
          }
        } else {
          runMigrationsBatch()
        }
        console.log(
          `[Store] Migrations complete for "${namespace}": ` +
          `v${currentVersion} -> v${pending[pending.length - 1].version} ` +
          `(${pending.length} migration${pending.length === 1 ? '' : 's'} applied)` +
          (checked ? `; existing foreign-key violations: ${checked.before} -> ${checked.after}` : '')
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(
          `[Store] Migration failed for namespace "${namespace}" ` +
          `at version ${currentVersion}: ${message}`
        )
        throw error
      }
    },

    transaction<T>(db: Database.Database, fn: () => T): T {
      const runInTransaction = db.transaction(fn)
      return runInTransaction()
    },

    closeAll(): void {
      connections.forEach((db, dbPath) => {
        try {
          db.close()
          console.log(`[Store] Database closed: ${dbPath}`)
        } catch (error) {
          console.error(`[Store] Error closing database ${dbPath}:`, error)
        }
      })
      connections.clear()
    }
  }

  return manager
}
