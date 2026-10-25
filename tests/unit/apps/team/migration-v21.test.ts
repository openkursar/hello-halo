import { afterEach, describe, expect, it } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'

const managers: ReturnType<typeof createDatabaseManager>[] = []
afterEach(() => managers.splice(0).forEach(manager => manager.closeAll()))

describe('saved configuration migration', () => {
  it('keeps old rows intact and separates source names from ordinary team names', () => {
    const manager = createDatabaseManager(':memory:')
    managers.push(manager)
    const db = manager.getAppDatabase()
    manager.runMigrations(db, MIGRATION_NAMESPACE, migrations.filter(migration => migration.version <= 20))
    const insert = db.prepare(`INSERT INTO teams (id, name, owning_space_id, goal, created_at, updated_at, ephemeral) VALUES (?, 'Research', 'space', 'Research products', 1, 1, ?)`)
    insert.run('source', 1)
    manager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    expect(db.prepare('SELECT goal, ephemeral, saved_team_id FROM teams WHERE id = ?').get('source')).toEqual({ goal: 'Research products', ephemeral: 1, saved_team_id: null })
    insert.run('saved', 0)
    expect(() => insert.run('duplicate', 0)).toThrow(/UNIQUE/)
    db.prepare('UPDATE teams SET saved_team_id = ? WHERE id = ?').run('saved', 'source')
    db.prepare('DELETE FROM teams WHERE id = ?').run('saved')
    expect(db.prepare('SELECT saved_team_id FROM teams WHERE id = ?').get('source')).toEqual({ saved_team_id: null })
  })
})
