/**
 * Unit tests for platform/store -- protection against a build behind its data.
 *
 * The scenario these cover is two installs of the same product (a stable one
 * and a preview one) deliberately sharing a data directory. The preview build
 * migrates the database; the stable build must then refuse it rather than
 * write through a schema it does not know.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { isSchemaAheadError, SchemaAheadError } from '../../../../src/main/platform/store/schema-guard'
import type { DatabaseManager, Migration } from '../../../../src/main/platform/store/types'

/** A build that knows migrations 1..n for one namespace. */
function migrationsUpTo(n: number): Migration[] {
  return Array.from({ length: n }, (_, i) => ({
    version: i + 1,
    description: `create t${i + 1}`,
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS t${i + 1} (id INTEGER PRIMARY KEY)`)
    },
  }))
}

describe('schema guard', () => {
  let dir: string
  let dbPath: string
  let manager: DatabaseManager

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'halo-store-'))
    dbPath = join(dir, 'halo.db')
    manager = createDatabaseManager(dbPath)
  })

  afterEach(() => {
    manager.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses data migrated by a newer build', () => {
    // The newer build migrates to v3.
    manager.runMigrations(manager.getAppDatabase(), 'demo', migrationsUpTo(3))
    manager.closeAll()

    // The older build only carries migrations up to v2.
    const older = createDatabaseManager(dbPath)
    try {
      expect(() => older.runMigrations(older.getAppDatabase(), 'demo', migrationsUpTo(2)))
        .toThrow(SchemaAheadError)
    } finally {
      older.closeAll()
    }
  })

  it('reports which namespace and versions disagree', () => {
    manager.runMigrations(manager.getAppDatabase(), 'demo', migrationsUpTo(5))
    manager.closeAll()

    const older = createDatabaseManager(dbPath)
    try {
      older.runMigrations(older.getAppDatabase(), 'demo', migrationsUpTo(2))
      expect.unreachable('expected the older build to refuse')
    } catch (error) {
      expect(isSchemaAheadError(error)).toBe(true)
      const schemaError = error as SchemaAheadError
      expect(schemaError.namespace).toBe('demo')
      expect(schemaError.storedVersion).toBe(5)
      expect(schemaError.supportedVersion).toBe(2)
    } finally {
      older.closeAll()
    }
  })

  it('allows a build that is exactly current', () => {
    manager.runMigrations(manager.getAppDatabase(), 'demo', migrationsUpTo(3))
    manager.closeAll()

    const same = createDatabaseManager(dbPath)
    try {
      expect(() => same.runMigrations(same.getAppDatabase(), 'demo', migrationsUpTo(3))).not.toThrow()
    } finally {
      same.closeAll()
    }
  })

  it('allows a newer build to keep migrating forward', () => {
    manager.runMigrations(manager.getAppDatabase(), 'demo', migrationsUpTo(2))
    manager.closeAll()

    const newer = createDatabaseManager(dbPath)
    try {
      expect(() => newer.runMigrations(newer.getAppDatabase(), 'demo', migrationsUpTo(4))).not.toThrow()
    } finally {
      newer.closeAll()
    }
  })

  it('leaves each namespace judged independently', () => {
    const db = manager.getAppDatabase()
    manager.runMigrations(db, 'alpha', migrationsUpTo(3))
    // A namespace this database has never seen starts at 0 and must not be
    // dragged into another namespace's verdict.
    expect(() => manager.runMigrations(db, 'beta', migrationsUpTo(1))).not.toThrow()
  })

  describe('pre-migration snapshot', () => {
    function snapshots(): string[] {
      return readdirSync(dir).filter((name) => name.endsWith('.premigrate.bak'))
    }

    it('does not snapshot a database being created', () => {
      manager.runMigrations(manager.getAppDatabase(), 'demo', migrationsUpTo(1))
      expect(snapshots()).toHaveLength(0)
    })

    it('snapshots before upgrading existing data', () => {
      manager.runMigrations(manager.getAppDatabase(), 'demo', migrationsUpTo(1))
      manager.closeAll()

      const upgrade = createDatabaseManager(dbPath)
      try {
        upgrade.runMigrations(upgrade.getAppDatabase(), 'demo', migrationsUpTo(2))
      } finally {
        upgrade.closeAll()
      }

      const taken = snapshots()
      expect(taken).toHaveLength(1)
      expect(existsSync(join(dir, taken[0]))).toBe(true)
    })

    it('takes one snapshot per run, not one per namespace', () => {
      const first = manager.getAppDatabase()
      manager.runMigrations(first, 'alpha', migrationsUpTo(1))
      manager.runMigrations(first, 'beta', migrationsUpTo(1))
      manager.closeAll()

      const upgrade = createDatabaseManager(dbPath)
      try {
        const db = upgrade.getAppDatabase()
        upgrade.runMigrations(db, 'alpha', migrationsUpTo(2))
        upgrade.runMigrations(db, 'beta', migrationsUpTo(2))
      } finally {
        upgrade.closeAll()
      }

      expect(snapshots()).toHaveLength(1)
    })

    it('keeps only the newest snapshots', async () => {
      manager.runMigrations(manager.getAppDatabase(), 'demo', migrationsUpTo(1))
      manager.closeAll()

      // Four successive upgrades; the retention bound is two.
      for (let version = 2; version <= 5; version++) {
        const upgrade = createDatabaseManager(dbPath)
        try {
          upgrade.runMigrations(upgrade.getAppDatabase(), 'demo', migrationsUpTo(version))
        } finally {
          upgrade.closeAll()
        }
        // Snapshot names carry a millisecond timestamp; without a gap two runs
        // in the same millisecond would collide on the same filename.
        await new Promise((resolve) => setTimeout(resolve, 5))
      }

      expect(snapshots().length).toBeLessThanOrEqual(2)
    })
  })
})
