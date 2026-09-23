/**
 * platform/store -- Protection against a build that is behind its own data.
 *
 * Migrations are forward-only, so an older build opening a database a newer
 * build already migrated finds nothing pending and proceeds happily against a
 * shape it does not know. That is silent data damage, not a startup failure.
 *
 * It stops being hypothetical as soon as two builds share one data directory
 * (a stable install and a preview install of the same product): whichever one
 * runs first decides the schema for both.
 */

import type Database from 'better-sqlite3'
import { readdirSync, statSync, unlinkSync } from 'fs'
import { basename, dirname, join } from 'path'

/**
 * The stored schema is newer than anything this build can migrate to.
 *
 * Carries the namespace and both versions so the shutdown path can tell the
 * user which install to reopen the data with, rather than showing a generic
 * database error.
 */
export class SchemaAheadError extends Error {
  readonly namespace: string
  readonly storedVersion: number
  readonly supportedVersion: number

  constructor(namespace: string, storedVersion: number, supportedVersion: number) {
    super(
      `[Store] Data for "${namespace}" is at schema v${storedVersion}, ` +
        `but this build only understands up to v${supportedVersion}. ` +
        'It was written by a newer version of the app.'
    )
    this.name = 'SchemaAheadError'
    this.namespace = namespace
    this.storedVersion = storedVersion
    this.supportedVersion = supportedVersion
  }
}

/** True when the error is this module's refusal to open newer data. */
export function isSchemaAheadError(error: unknown): error is SchemaAheadError {
  return error instanceof SchemaAheadError
}

/**
 * Snapshot a database file before the first migration of this run.
 *
 * `VACUUM INTO` is used rather than a file copy because it is a consistent
 * point-in-time image even with WAL content outstanding, and it is synchronous
 * — the migration path has no point at which it could await a copy.
 *
 * Failure is reported but not fatal: refusing to start because a *precaution*
 * could not be taken would turn a full disk into an unusable app.
 *
 * @returns The snapshot path, or null when no snapshot was taken.
 */
export function snapshotBeforeMigration(
  db: Database.Database,
  dbPath: string,
  backupSuffix: string,
  maxBackups: number
): string | null {
  const target = `${dbPath}.${Date.now()}${backupSuffix}`
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  } catch (error) {
    // VACUUM INTO refuses an existing target and fails on a full disk; both
    // leave the original untouched, which is the only property that matters.
    console.warn(`[Store] Pre-migration snapshot failed (continuing): ${String(error)}`)
    return null
  }
  console.log(`[Store] Pre-migration snapshot written: ${target}`)
  pruneBackups(dbPath, backupSuffix, maxBackups)
  return target
}

/**
 * Keep only the newest `maxBackups` snapshots for this database.
 *
 * Snapshots are full copies of a database that is routinely hundreds of MB, so
 * an unbounded set would quietly consume more disk than the app itself.
 */
function pruneBackups(dbPath: string, backupSuffix: string, maxBackups: number): void {
  const dir = dirname(dbPath)
  const prefix = `${basename(dbPath)}.`

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  const snapshots = entries
    .filter((name) => name.startsWith(prefix) && name.endsWith(backupSuffix))
    .map((name) => {
      const full = join(dir, name)
      try {
        return { full, mtime: statSync(full).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((entry): entry is { full: string; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime)

  for (const stale of snapshots.slice(maxBackups)) {
    try {
      unlinkSync(stale.full)
      console.log(`[Store] Pruned old snapshot: ${stale.full}`)
    } catch {
      // A snapshot we cannot delete is wasted disk, not a correctness problem.
    }
  }
}
