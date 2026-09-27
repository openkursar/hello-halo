import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { migrations, MIGRATION_NAMESPACE } from '../../../../src/main/apps/team/migrations'
import { reconcileCoordinatorIdentity } from '../../../../src/main/apps/team/coordinator-identity'
import { provisionLeadSpec } from '../../../../src/main/apps/team/lead'
import type { AppManagerService, InstalledApp } from '../../../../src/main/apps/manager'
import type { Team } from '../../../../src/shared/apps/team-types'

describe('dedicated coordinator identity', () => {
  let db: DatabaseManager
  let store: TeamStore
  const team: Team = {
    id: 'team', name: 'Research', goal: 'Check evidence', owningSpaceId: 'space', leadAppId: 'lead',
    memberSourcing: 'manual', collabMode: 'structured', escalationRouting: 'user', status: 'idle',
    currentEpochId: null, createdAt: 1, updatedAt: 1, hostNodeId: null,
  }
  beforeEach(() => {
    db = createDatabaseManager(':memory:')
    const database = db.getAppDatabase()
    db.runMigrations(database, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(database)
    store.insertTeam(team)
  })
  afterEach(() => db.closeAll())

  function member(aiProvisioned: boolean) {
    store.addMember({ teamId: team.id, appId: 'lead', memberName: 'Lead', role: 'Coordinator', isLead: true, aiProvisioned, addedAt: 1 })
  }
  function manager(custom = false) {
    const spec = provisionLeadSpec({ teamName: team.name, goal: team.goal, owningSpaceId: team.owningSpaceId }).spec
    if (custom) spec.system_prompt += '\nMy own responsibilities.'
    return { getApp: () => ({ id: 'lead', spec }) as InstalledApp } as unknown as AppManagerService
  }

  it('recovers only an exact historical system coordinator and is idempotent', () => {
    member(true)
    expect(reconcileCoordinatorIdentity(store, manager())).toBe(1)
    expect(store.getMember('team', 'lead')?.isSystemCoordinator).toBe(true)
    expect(reconcileCoordinatorIdentity(store, manager())).toBe(0)
  })

  it('keeps promoted user people visible even when they use the lead template', () => {
    member(false)
    expect(reconcileCoordinatorIdentity(store, manager())).toBe(0)
    expect(store.getMember('team', 'lead')?.isSystemCoordinator).toBe(false)
  })

  it('does not infer coordinator identity from a custom AI-provisioned leader', () => {
    member(true)
    expect(reconcileCoordinatorIdentity(store, manager(true))).toBe(0)
    expect(store.getMember('team', 'lead')?.isSystemCoordinator).toBe(false)
  })
})
