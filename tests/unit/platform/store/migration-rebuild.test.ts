import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createDatabaseManager, type DatabaseManager, type Migration } from '../../../../src/main/platform/store'

const initial: Migration = {
  version: 1,
  description: 'Parent and dependent records',
  up(db) {
    db.exec(`
      CREATE TABLE parents (id TEXT PRIMARY KEY, label TEXT NOT NULL);
      CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id) ON DELETE CASCADE);
      INSERT INTO parents VALUES ('retained-parent', 'Original parent');
      INSERT INTO children VALUES ('retained-child', 'retained-parent');
    `)
  },
}

const rebuild: Migration = {
  version: 2,
  description: 'Rebuild the referenced parent',
  foreignKeys: 'rebuild',
  up(db) {
    db.exec(`
      CREATE TABLE parents_next (id TEXT PRIMARY KEY, label TEXT);
      INSERT INTO parents_next SELECT * FROM parents;
      DROP TABLE parents;
      ALTER TABLE parents_next RENAME TO parents;
    `)
  },
}

function snapshot(db: Database.Database) {
  return {
    parents: db.prepare('SELECT rowid, * FROM parents ORDER BY rowid').safeIntegers().all(),
    children: db.prepare('SELECT rowid, * FROM children ORDER BY rowid').safeIntegers().all(),
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name').all(),
    versions: db.prepare('SELECT * FROM _migrations ORDER BY namespace').all(),
  }
}

describe('referenced-table migration execution', () => {
  let manager: DatabaseManager
  let db: Database.Database

  beforeEach(() => {
    manager = createDatabaseManager(':memory:')
    db = manager.getAppDatabase()
    manager.runMigrations(db, 'parent-data', [initial])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (db.open) db.close()
    manager.closeAll()
  })

  for (const foreignKeys of [0, 1]) {
    it(`preserves dependent records and restores the original FK=${foreignKeys} after a successful rebuild`, () => {
      db.pragma(`foreign_keys = ${foreignKeys}`)
      const before = snapshot(db)
      manager.runMigrations(db, 'parent-data', [initial, rebuild])
      expect(db.prepare('SELECT rowid, * FROM parents').safeIntegers().all()).toEqual(before.parents)
      expect(db.prepare('SELECT rowid, * FROM children').safeIntegers().all()).toEqual(before.children)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('foreign_keys', { simple: true })).toBe(foreignKeys)
      expect(db.inTransaction).toBe(false)
      if (foreignKeys) expect(() => db.prepare('INSERT INTO children VALUES (?, ?)').run('forbidden', 'missing')).toThrow(/FOREIGN KEY/)
    })

    for (const failure of ['up', 'version-write']) {
      it(`rolls back the whole ${failure} failure and restores FK=${foreignKeys}`, () => {
        if (failure === 'version-write') db.exec(`CREATE TRIGGER refuse_version BEFORE UPDATE OF version ON _migrations BEGIN SELECT RAISE(ABORT, 'Version write refused'); END;`)
        db.pragma(`foreign_keys = ${foreignKeys}`)
        const before = snapshot(db)
        const migration: Migration = { ...rebuild, up(database) {
          rebuild.up(database)
          if (failure === 'up') database.exec('INSERT INTO absent_table VALUES (1)')
        } }
        expect(() => manager.runMigrations(db, 'parent-data', [initial, migration])).toThrow(failure === 'up' ? /absent_table/ : /Version write refused/)
        expect(snapshot(db)).toEqual(before)
        expect(db.pragma('foreign_keys', { simple: true })).toBe(foreignKeys)
        expect(db.inTransaction).toBe(false)
      })
    }
  }

  it('keeps an existing orphan for its owning module rather than blocking or silently deleting it', () => {
    db.pragma('foreign_keys = OFF')
    db.exec("INSERT INTO children VALUES ('legacy-orphan', 'old-missing-parent')")
    db.pragma('foreign_keys = ON')
    const children = db.prepare('SELECT * FROM children ORDER BY id').all()
    const violations = db.pragma('foreign_key_check')
    expect(violations).toHaveLength(1)
    manager.runMigrations(db, 'parent-data', [initial, rebuild])
    expect(db.prepare('SELECT * FROM children ORDER BY id').all()).toEqual(children)
    expect(db.pragma('foreign_key_check')).toEqual(violations)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('rejects a new broken reference and rolls back both schema and version', () => {
    const before = snapshot(db)
    const migration: Migration = { ...rebuild, up(database) {
      rebuild.up(database)
      database.exec("INSERT INTO children VALUES ('new-orphan', 'missing-parent')")
    } }
    expect(() => manager.runMigrations(db, 'parent-data', [initial, migration])).toThrow(/new violation in "children" referencing "parents"/)
    expect(snapshot(db)).toEqual(before)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  for (const change of ['identity', 'reference', 'definition']) {
    it(`does not mistake a changed ${change} for the existing violation just because the count and rowid match`, () => {
      db.pragma('foreign_keys = OFF')
      db.exec("INSERT INTO children (rowid, id, parent_id) VALUES (42, 'legacy-orphan', 'old-private-reference')")
      db.pragma('foreign_keys = ON')
      const before = snapshot(db)
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const migration: Migration = { ...rebuild, up(database) {
        rebuild.up(database)
        if (change === 'identity') database.exec("UPDATE children SET id = 'new-private-identity' WHERE rowid = 42")
        if (change === 'reference') database.exec("UPDATE children SET parent_id = 'new-private-reference' WHERE rowid = 42")
        if (change === 'definition') database.exec(`
          CREATE TABLE children_next (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id) ON DELETE SET NULL);
          INSERT INTO children_next (rowid, id, parent_id) SELECT rowid, id, parent_id FROM children;
          DROP TABLE children;
          ALTER TABLE children_next RENAME TO children;
        `)
      } }
      expect(() => manager.runMigrations(db, 'parent-data', [initial, migration])).toThrow(/new violation/)
      expect(snapshot(db)).toEqual(before)
      const messages = log.mock.calls.flat().join(' ')
      expect(messages).toContain('parent-data')
      expect(messages).toContain('Foreign-key verification')
      expect(messages).not.toMatch(/private-reference|private-identity/)
    })
  }

  it('keeps 64-bit violating row identities distinct without numeric rounding', () => {
    db.pragma('foreign_keys = OFF')
    db.exec(`CREATE TABLE wide_rows (parent_id TEXT REFERENCES parents(id)); INSERT INTO wide_rows (rowid, parent_id) VALUES (9007199254740992, 'missing');`)
    db.pragma('foreign_keys = ON')
    const migration: Migration = { ...rebuild, up(database) {
      rebuild.up(database)
      database.exec('UPDATE wide_rows SET rowid = 9007199254740993')
    } }
    expect(() => manager.runMigrations(db, 'parent-data', [initial, migration])).toThrow(/new violation in "wide_rows"/)
    expect(db.prepare('SELECT rowid FROM wide_rows').safeIntegers().pluck().get()).toBe(9007199254740992n)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('refuses an ambiguous existing WITHOUT ROWID violation before running the migration', () => {
    db.pragma('foreign_keys = OFF')
    db.exec("CREATE TABLE compact (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id)) WITHOUT ROWID; INSERT INTO compact VALUES ('old-orphan', 'missing')")
    db.pragma('foreign_keys = ON')
    const up = vi.fn(rebuild.up)
    const before = snapshot(db)
    expect(() => manager.runMigrations(db, 'parent-data', [initial, { ...rebuild, up }])).toThrow(/without rowid/)
    expect(up).not.toHaveBeenCalled()
    expect(snapshot(db)).toEqual(before)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('refuses an outer transaction without changing its state or data', () => {
    db.exec('BEGIN')
    const before = snapshot(db)
    expect(() => manager.runMigrations(db, 'parent-data', [initial, rebuild])).toThrow(/external transaction or savepoint/)
    expect(db.inTransaction).toBe(true)
    expect(snapshot(db)).toEqual(before)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.exec('ROLLBACK')
  })

  for (const foreignKeys of [0, 1]) {
    it(`refuses a fresh outer transaction before creating migration metadata with FK=${foreignKeys}`, () => {
      const fresh = createDatabaseManager(':memory:')
      const connection = fresh.getAppDatabase()
      try {
        connection.pragma(`foreign_keys = ${foreignKeys}`)
        connection.exec('BEGIN')
        const before = connection.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()
        expect(before).toEqual([])
        const up = vi.fn(initial.up)
        expect(() => fresh.runMigrations(connection, 'new-parent-data', [{ ...initial, foreignKeys: 'rebuild', up }])).toThrow(/external transaction or savepoint/)
        expect(up).not.toHaveBeenCalled()
        expect(connection.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()).toEqual(before)
        expect(connection.inTransaction).toBe(true)
        expect(connection.pragma('foreign_keys', { simple: true })).toBe(foreignKeys)
      } finally {
        if (connection.inTransaction) connection.exec('ROLLBACK')
        fresh.closeAll()
      }
    })
  }

  it('rejects an unknown execution marker rather than running a destructive ordinary rebuild', () => {
    const before = snapshot(db)
    const invalid = { ...rebuild, foreignKeys: 'rebuid' } as unknown as Migration
    expect(() => manager.runMigrations(db, 'parent-data', [initial, invalid])).toThrow(/Unsupported foreign-key migration mode.*parent-data.*version 2/)
    expect(snapshot(db)).toEqual(before)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('leaves ordinary migration FK enforcement in place without an integrity scan', () => {
    const prepare = vi.spyOn(db, 'prepare')
    const pragma = vi.spyOn(db, 'pragma')
    const before = snapshot(db)
    const invalid: Migration = { version: 2, description: 'Invalid ordinary write', up(database) { database.exec("INSERT INTO children VALUES ('ordinary-orphan', 'missing')") } }
    expect(() => manager.runMigrations(db, 'parent-data', [initial, invalid])).toThrow(/FOREIGN KEY/)
    expect(snapshot(db)).toEqual(before)
    expect(prepare.mock.calls.some(([sql]) => /foreign_key_check/i.test(sql))).toBe(false)
    expect(pragma.mock.calls.some(([sql]) => /foreign_keys/i.test(sql))).toBe(false)
  })

  it('does no FK scan or setting change when the marked version is already applied', () => {
    manager.runMigrations(db, 'parent-data', [initial, rebuild])
    db.exec('BEGIN')
    const prepare = vi.spyOn(db, 'prepare')
    const pragma = vi.spyOn(db, 'pragma')
    const before = snapshot(db)
    manager.runMigrations(db, 'parent-data', [initial, rebuild])
    expect(snapshot(db)).toEqual(before)
    expect(prepare.mock.calls.some(([sql]) => /foreign_key_check/i.test(sql))).toBe(false)
    expect(pragma).not.toHaveBeenCalled()
    expect(db.inTransaction).toBe(true)
    db.exec('ROLLBACK')
  })

  it('closes and evicts a connection whose FK restoration fails', () => {
    const nativePragma = db.pragma.bind(db)
    vi.spyOn(db, 'pragma').mockImplementation((source, options) => {
      if (source === 'foreign_keys = 1') throw new Error('Injected FK restoration failure')
      return nativePragma(source, options)
    })
    expect(() => manager.runMigrations(db, 'parent-data', [initial, rebuild])).toThrow(/restoration failed.*close succeeded/)
    expect(db.open).toBe(false)
    expect(() => db.exec("INSERT INTO parents VALUES ('unsafe-write', 'Forbidden')")).toThrow(/not open/)
    const next = manager.getAppDatabase()
    expect(next).not.toBe(db)
    expect(next.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('retains execution, restoration and close failures together and stops the batch', () => {
    const nativePragma = db.pragma.bind(db)
    vi.spyOn(db, 'pragma').mockImplementation((source, options) => {
      if (source === 'foreign_keys = 1') throw new Error('Injected FK restoration failure')
      return nativePragma(source, options)
    })
    const close = vi.spyOn(db, 'close').mockImplementation(() => { throw new Error('Injected close failure') })
    const later = vi.fn()
    const broken: Migration = { ...rebuild, up(database) { rebuild.up(database); throw new Error('Injected migration failure') } }
    let failure: unknown
    try { manager.runMigrations(db, 'parent-data', [initial, broken, { version: 3, description: 'Must not execute', up: later }]) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors.map(error => error.message)).toEqual(['Injected migration failure', 'Injected FK restoration failure', 'Injected close failure'])
    expect((failure as Error).message).toContain('close failed')
    expect(later).not.toHaveBeenCalled()
    expect(manager.getAppDatabase()).not.toBe(db)
    close.mockRestore()
  })
})
