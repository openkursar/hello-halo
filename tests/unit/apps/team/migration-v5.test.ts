/**
 * Unit tests for apps/team migration v5: adds owner_node_id/origin/member_identity
 * to team_members without breaking the existing v1..v4 migration chain.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { SELF_NODE_ID } from '../../../../src/shared/apps/team-types'
import type { Team, TeamMember } from '../../../../src/main/apps/team/types'

function makeTeam(overrides?: Partial<Team>): Team {
  const now = Date.now()
  return {
    id: 'team-1',
    name: 'Research Team',
    owningSpaceId: 'space-a',
    goal: 'Build a competitor brief',
    leadAppId: null,
    memberSourcing: 'manual',
    collabMode: 'structured',
    escalationRouting: 'user',
    status: 'idle',
    currentEpochId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeMember(overrides?: Partial<TeamMember>): TeamMember {
  return {
    teamId: 'team-1',
    appId: 'app-1',
    memberName: 'researcher',
    role: 'Research',
    isLead: false,
    aiProvisioned: false,
    addedAt: Date.now(),
    ...overrides,
  }
}

describe('apps/team migration v5 (team_members federation fields)', () => {
  let dbManager: DatabaseManager
  let store: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    // Applies the full set on a fresh db; this slice asserts the v5 step's effect.
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
    store.insertTeam(makeTeam())
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  it('reaches at least version 5 in the app_team namespace', () => {
    const db = dbManager.getAppDatabase()
    const row = db
      .prepare('SELECT version FROM _migrations WHERE namespace = ?')
      .get(MIGRATION_NAMESPACE) as { version: number }
    expect(row.version).toBeGreaterThanOrEqual(5)
  })

  it('adds the three federation columns to team_members', () => {
    const db = dbManager.getAppDatabase()
    const cols = (db.prepare('PRAGMA table_info(team_members)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('owner_node_id')
    expect(cols).toContain('origin')
    expect(cols).toContain('member_identity')
  })

  it('applies v5 cleanly on a db already at v4 (regression: AC-9)', () => {
    const m2 = createDatabaseManager(':memory:')
    const db = m2.getAppDatabase()
    m2.runMigrations(db, MIGRATION_NAMESPACE, migrations.filter(m => m.version <= 4))
    expect(
      (db.prepare('SELECT version FROM _migrations WHERE namespace = ?').get(MIGRATION_NAMESPACE) as { version: number }).version
    ).toBe(4)

    const upToV5 = migrations.filter(m => m.version <= 5)
    expect(() => m2.runMigrations(db, MIGRATION_NAMESPACE, upToV5)).not.toThrow()
    expect(
      (db.prepare('SELECT version FROM _migrations WHERE namespace = ?').get(MIGRATION_NAMESPACE) as { version: number }).version
    ).toBe(5)
    m2.closeAll()
  })

  it('defaults a member without federation fields to SELF / local / null', () => {
    store.addMember(makeMember())
    const back = store.listMembersByTeam('team-1')[0]
    expect(back.ownerNodeId).toBe(SELF_NODE_ID)
    expect(back.ownerNodeId).toBe('SELF')
    expect(back.origin).toBe('local')
    expect(back.memberIdentity).toBeNull()
  })

  it('round-trips a member with explicit federation fields', () => {
    store.addMember(
      makeMember({
        appId: 'app-remote',
        memberName: 'bob',
        ownerNodeId: 'node-bob',
        origin: 'remote',
        memberIdentity: 'identity-bob',
      })
    )
    const back = store.getMemberByName('team-1', 'bob')!
    expect(back.ownerNodeId).toBe('node-bob')
    expect(back.origin).toBe('remote')
    expect(back.memberIdentity).toBe('identity-bob')
  })
})
