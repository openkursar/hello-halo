/**
 * Reading a joined office's detail tells federation someone is looking at it (it
 * may ask an office that refused this machine again). A team that lives only
 * here has nobody to ask, so its reads say nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))

import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { createTeamService } from '../../../../src/main/apps/team/service'

describe('reading an office detail', () => {
  let dbManager: DatabaseManager
  let store: TeamStore
  let onOfficeViewed: ReturnType<typeof vi.fn>
  let service: ReturnType<typeof createTeamService>

  const insertTeam = (id: string, hostNodeId: string | null) =>
    store.insertTeam({
      id, name: id, owningSpaceId: 'space', goal: '', leadAppId: null, memberSourcing: 'manual',
      collabMode: 'free', escalationRouting: 'user', status: 'idle', currentEpochId: null,
      createdAt: 1, updatedAt: 1, hostNodeId,
    })

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
    onOfficeViewed = vi.fn()
    const runtime = {
      blackboard: { readBoard: vi.fn(() => ({ tasks: [], findings: [], roster: [] })) },
      checks: { viewForTeam: () => [] },
      getObservableStatus: vi.fn(() => 'idle'),
      getMemberStatus: vi.fn(() => 'idle' as const),
      getMemberBusy: vi.fn(() => []),
    }
    service = createTeamService({
      store,
      appManager: { getApp: vi.fn(() => null) } as never,
      getRuntime: () => runtime as never,
      spaces: { spaceExists: () => true, createMemberSpace: ({ owningSpaceId }) => owningSpaceId },
      listArtifacts: vi.fn(async () => []),
      proposeMembersFromGoal: vi.fn(async () => []),
      onOfficeViewed,
    })
  })

  afterEach(() => dbManager.closeAll())

  it('tells federation about each read of a joined office', () => {
    insertTeam('office-joined', 'node-host')

    expect(service.getTeamDetail('office-joined')).not.toBeNull()
    service.getTeamDetail('office-joined')

    expect(onOfficeViewed.mock.calls).toEqual([['office-joined'], ['office-joined']])
  })

  it('says nothing for a team that lives only here, or one that does not exist', () => {
    insertTeam('team-local', null)

    expect(service.getTeamDetail('team-local')).not.toBeNull()
    expect(service.getTeamDetail('missing')).toBeNull()

    expect(onOfficeViewed).not.toHaveBeenCalled()
  })
})
