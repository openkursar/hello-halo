/**
 * Unit tests for apps/team migration v20: unique coordinator_conversation_id.
 *
 * Pre-v20 a createCollab race could bind two teams to one conversation. The
 * migration must keep exactly the row the read query already returns
 * (created_at DESC, id ASC), null the losers, and leave a partial unique
 * index that rejects a second binding forever after.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'

const managers: DatabaseManager[] = []

function dbAtVersion(version: number) {
  const manager = createDatabaseManager(':memory:')
  managers.push(manager)
  const db = manager.getAppDatabase()
  manager.runMigrations(db, MIGRATION_NAMESPACE, migrations.filter(m => m.version <= version))
  return { manager, db }
}

function insertTeamRow(
  db: ReturnType<DatabaseManager['getAppDatabase']>,
  id: string,
  createdAt: number,
  conversationId: string | null
): void {
  db.prepare(
    `INSERT INTO teams (id, name, owning_space_id, goal, created_at, updated_at, ephemeral, coordinator_conversation_id)
       VALUES (?, ?, 'space-a', 'goal', ?, ?, 1, ?)`
  ).run(id, `Team ${id}`, createdAt, createdAt, conversationId)
}

function bindingOf(db: ReturnType<DatabaseManager['getAppDatabase']>, id: string): string | null {
  return (db.prepare('SELECT coordinator_conversation_id AS c FROM teams WHERE id = ?').get(id) as { c: string | null }).c
}

afterEach(() => {
  while (managers.length > 0) managers.pop()!.closeAll()
})

describe('apps/team migration v20 (unique collaboration binding per conversation)', () => {
  it('applies cleanly on a db already at v19', () => {
    const { manager, db } = dbAtVersion(19)
    expect(() => manager.runMigrations(db, MIGRATION_NAMESPACE, migrations.filter(m => m.version <= 20))).not.toThrow()
    const row = db.prepare('SELECT version FROM _migrations WHERE namespace = ?').get(MIGRATION_NAMESPACE) as { version: number }
    expect(row.version).toBe(20)
  })

  it('dedups duplicate bindings, keeping the row the read query prefers', () => {
    const { manager, db } = dbAtVersion(19)
    // Two teams bound to conv-1 (newest wins), a created_at tie on conv-2
    // (lowest id wins), and an untouched single binding on conv-3.
    insertTeamRow(db, 'team-old', 1000, 'conv-1')
    insertTeamRow(db, 'team-new', 2000, 'conv-1')
    insertTeamRow(db, 'team-b', 3000, 'conv-2')
    insertTeamRow(db, 'team-a', 3000, 'conv-2')
    insertTeamRow(db, 'team-solo', 4000, 'conv-3')
    insertTeamRow(db, 'team-none', 5000, null)

    manager.runMigrations(db, MIGRATION_NAMESPACE, migrations.filter(m => m.version <= 20))

    expect(bindingOf(db, 'team-new')).toBe('conv-1')
    expect(bindingOf(db, 'team-old')).toBeNull()
    expect(bindingOf(db, 'team-a')).toBe('conv-2')
    expect(bindingOf(db, 'team-b')).toBeNull()
    expect(bindingOf(db, 'team-solo')).toBe('conv-3')
    expect(bindingOf(db, 'team-none')).toBeNull()
  })

  it('the rebuilt index rejects a second binding but allows many NULLs', () => {
    const { db } = dbAtVersion(20)
    insertTeamRow(db, 'team-1', 1000, 'conv-1')
    expect(() => insertTeamRow(db, 'team-2', 2000, 'conv-1')).toThrow(/UNIQUE constraint failed/)
    expect(() => insertTeamRow(db, 'team-3', 3000, null)).not.toThrow()
    expect(() => insertTeamRow(db, 'team-4', 4000, null)).not.toThrow()
  })
})
