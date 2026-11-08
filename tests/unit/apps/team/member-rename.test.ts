/**
 * A renamed digital human is renamed in its teams: names derived from the app
 * name follow it (staying unique per team), names chosen for a team stay, only
 * the owner renames, and the former name keeps resolving so in-flight
 * addressing still lands.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))

import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { createTeamService, memberNameFollowsApp } from '../../../../src/main/apps/team/service'
import type { TeamServiceDeps } from '../../../../src/main/apps/team/service'
import type { TeamMember } from '../../../../src/shared/apps/team-types'

const APP = 'app-alice'

function team(id: string) {
  return {
    id, name: id, owningSpaceId: 'space', goal: 'ship', leadAppId: null,
    memberSourcing: 'manual' as const, collabMode: 'free' as const, escalationRouting: 'user' as const,
    status: 'idle' as const, currentEpochId: null, createdAt: 1, updatedAt: 1,
  }
}

function member(teamId: string, appId: string, memberName: string, extra: Partial<TeamMember> = {}): TeamMember {
  return { teamId, appId, memberName, role: '', isLead: false, aiProvisioned: false, addedAt: 1, ...extra }
}

describe('memberNameFollowsApp', () => {
  it('recognises names derived from the app name', () => {
    expect(memberNameFollowsApp('Alice', 'Alice')).toBe(true)
    expect(memberNameFollowsApp('Alice-2', 'Alice')).toBe(true)
    expect(memberNameFollowsApp('Alice·Bob', 'Alice')).toBe(true)
  })

  it('leaves names chosen for the team alone', () => {
    expect(memberNameFollowsApp('reviewer', 'Alice')).toBe(false)
    expect(memberNameFollowsApp('Alicette', 'Alice')).toBe(false)
    expect(memberNameFollowsApp('Alice-two', 'Alice')).toBe(false)
    expect(memberNameFollowsApp('anything', '  ')).toBe(false)
  })
})

describe('renaming a member', () => {
  let dbm: DatabaseManager
  let store: TeamStore
  let onMemberRenamed: ReturnType<typeof vi.fn>
  let onRosterMutated: ReturnType<typeof vi.fn>
  let service: ReturnType<typeof createTeamService>

  beforeEach(() => {
    dbm = createDatabaseManager(':memory:')
    const db = dbm.getAppDatabase()
    dbm.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
    store.insertTeam(team('t1'))
    store.insertTeam(team('t2'))
    onMemberRenamed = vi.fn()
    onRosterMutated = vi.fn()
    service = createTeamService({
      store,
      appManager: { getApp: () => null } as never,
      getRuntime: () => null,
      spaces: { spaceExists: () => true, createMemberSpace: () => 's', deleteMemberSpace: () => {} },
      listArtifacts: async () => [],
      proposeMembersFromGoal: async () => [],
      onMemberRenamed,
      onRosterMutated,
    } as TeamServiceDeps)
  })

  afterEach(() => dbm.closeAll())

  const nameIn = (teamId: string, appId = APP) => store.getMember(teamId, appId)?.memberName

  it('follows the new app name in every team it belongs to', () => {
    store.addMember(member('t1', APP, 'Alice'))
    store.addMember(member('t2', APP, 'Alice-2'))

    service.followAppRename(APP, 'Alice', 'Bea')

    expect(nameIn('t1')).toBe('Bea')
    expect(nameIn('t2')).toBe('Bea')
    expect(onMemberRenamed.mock.calls).toEqual([['t1', APP], ['t2', APP]])
    expect(onRosterMutated).toHaveBeenCalledWith('t1')
  })

  it('stays unique within a team by the join-time rule', () => {
    store.addMember(member('t1', APP, 'Alice'))
    store.addMember(member('t1', 'app-other', 'Bea'))

    service.followAppRename(APP, 'Alice', 'Bea')

    expect(nameIn('t1')).toBe('Bea-2')
    expect(nameIn('t1', 'app-other')).toBe('Bea')
  })

  it('keeps a name chosen for the team and someone else’s member', () => {
    store.addMember(member('t1', APP, 'reviewer'))
    store.addMember(member('t2', APP, 'Alice', { ownerNodeId: 'node-b', origin: 'remote' }))

    service.followAppRename(APP, 'Alice', 'Bea')

    expect(nameIn('t1')).toBe('reviewer')
    expect(nameIn('t2')).toBe('Alice')
    expect(onMemberRenamed).not.toHaveBeenCalled()
  })

  it('still resolves the former name, without letting a newcomer take it', () => {
    store.addMember(member('t1', APP, 'Alice'))
    service.followAppRename(APP, 'Alice', 'Bea')

    expect(store.getMemberByName('t1', 'Alice')?.appId).toBe(APP)
    expect(store.getMemberByName('t1', 'Bea')?.appId).toBe(APP)
  })

  it('can rename back to a former name', () => {
    store.addMember(member('t1', APP, 'Alice'))
    service.followAppRename(APP, 'Alice', 'Bea')
    service.followAppRename(APP, 'Bea', 'Alice')

    expect(nameIn('t1')).toBe('Alice')
    expect(store.getMemberByName('t1', 'Bea')?.appId).toBe(APP)
  })

  it('applies an owner’s rename sent from another computer, unique on this roster', () => {
    store.addMember(member('t1', 'app-remote', 'Carl', { ownerNodeId: 'node-b', origin: 'remote' }))
    store.addMember(member('t1', APP, 'Dana'))

    service.applyMemberRename('t1', 'app-remote', 'Dana')
    service.applyMemberRename('t1', 'missing', 'Eve')

    expect(nameIn('t1', 'app-remote')).toBe('Dana-2')
    expect(store.getMemberByName('t1', 'Carl')?.appId).toBe('app-remote')
    expect(onMemberRenamed).not.toHaveBeenCalled()
  })

  it('keeps the former name resolving when the authority’s roster renames a member', () => {
    const roster = (name: string) => ({
      hostNodeId: 'node-host',
      selfNodeId: 'node-self',
      snapshot: {
        team: { id: 't1', name: 't1', goal: 'ship', leadAppId: null, collabMode: 'free' as const, hostNodeId: 'node-host' },
        members: [{ appId: 'app-host', memberName: name, role: '', isLead: false, duty: null, ownerNodeId: 'node-host', memberIdentity: 'id' }],
        edges: [],
      },
    })
    store.materializeJoinedOffice(roster('Frank'))
    store.materializeJoinedOffice(roster('Gina'))

    expect(nameIn('t1', 'app-host')).toBe('Gina')
    expect(store.getMemberByName('t1', 'Frank')?.appId).toBe('app-host')
  })
})
