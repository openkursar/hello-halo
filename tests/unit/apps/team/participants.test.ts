import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { findWorkMember, getWorkMember, listWorkMembers, isWorkEdgeAllowed } from '../../../../src/main/apps/team/work-members'
import type { ParticipantExecution } from '../../../../src/main/apps/team/participants'
import type { TeamParticipant } from '../../../../src/shared/apps/team-types'
import { SELF_NODE_ID } from '../../../../src/shared/apps/team-types'
import { createWorkMembership, createWorkReachability } from '../../../../src/main/apps/runtime/team/membership'
import { createMessageBus } from '@hello-halo/agent-sdk/collaboration'

let manager: DatabaseManager
let store: TeamStore
beforeEach(() => {
  manager = createDatabaseManager(':memory:')
  const db = manager.getAppDatabase()
  manager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  store = new TeamStore(db)
  for (const id of ['team', 'other']) store.insertTeam({ id, name: id, owningSpaceId: 'space', goal: '', leadAppId: 'lead',
    memberSourcing: 'manual', collabMode: 'structured', escalationRouting: 'user', status: 'idle', currentEpochId: null, createdAt: 1, updatedAt: 1 })
  for (const id of ['work-a', 'work-b']) store.insertEpoch({ id, teamId: 'team', startedAt: 1, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' })
  store.insertEpoch({ id: 'other-work', teamId: 'other', startedAt: 1, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' })
  for (const appId of ['lead', 'researcher', 'tester']) store.addMember({ teamId: 'team', appId, memberName: appId,
    role: appId, isLead: appId === 'lead', aiProvisioned: false, addedAt: 1 })
  store.replaceEdgesForTeam('team', [{ teamId: 'team', fromAppId: 'lead', toAppId: 'researcher', sync: false },
    { teamId: 'team', fromAppId: 'lead', toAppId: 'tester', sync: false }])
})
afterEach(() => { manager.closeAll() })

function participant(overrides: Partial<TeamParticipant> = {}): TeamParticipant {
  return { teamId: 'team', epochId: 'work-a', appId: 'temporary', parentAppId: 'researcher', memberName: 'helper',
    role: 'Research', isLead: false, aiProvisioned: false, isTemporary: true, addedAt: 2, ownerNodeId: SELF_NODE_ID, origin: 'local', ...overrides }
}

const execution: ParticipantExecution = {
  sourceAppId: 'researcher', engineId: 'halo', modelSelection: { modelSourceId: 'private-source', modelId: 'private-model' },
  environment: { spaceId: 'space', spacePath: '/private/space', workDir: '/private/work', memoryDir: '/private/participant' },
  prompt: 'PRIVATE_ASSIGNMENT', permissions: { granted: ['Read'], denied: ['Bash'] },
}

describe('temporary work participants', () => {
  it('persists participants inside one work scope without changing standing membership or the people directory', () => {
    store.participants.insert(participant(), execution)
    expect(store.listMembersByTeam('team').map(member => member.appId)).toEqual(['lead', 'researcher', 'tester'])
    expect(store.listMembersByAppId('temporary')).toEqual([])
    expect(store.listDirectoryMemberships().some(member => member.appId === 'temporary')).toBe(false)
    expect(listWorkMembers(store, 'team', 'work-a').map(member => member.appId)).toContain('temporary')
    expect(listWorkMembers(store, 'team', 'work-b').map(member => member.appId)).not.toContain('temporary')
    expect(getWorkMember(store, 'team', 'work-b', 'temporary')).toBeNull()
    expect(getWorkMember(store, 'other', 'work-a', 'temporary')).toBeNull()
    expect(store.participants.getExecution('team', 'work-a', 'temporary')).toEqual(execution)
  })

  it('never exposes local execution configuration in public participant records', () => {
    store.participants.insert(participant(), execution)
    const records = JSON.stringify(store.participants.listByTeam('team'))
    expect(records).not.toContain('private-')
    expect(records).not.toContain('/private/')
    expect(records).not.toContain('PRIVATE_ASSIGNMENT')
    const second = new TeamStore(manager.getAppDatabase())
    expect(second.participants.getExecution('team', 'work-a', 'temporary')).toEqual(execution)
  })

  it('rejects cross-team placement and remote installation of local execution settings', () => {
    expect(() => store.participants.insert(participant({ teamId: 'other' }), execution)).toThrow(/scope/)
    expect(() => store.participants.insert(participant({ origin: 'remote', ownerNodeId: 'other-node' }), execution)).toThrow(/remote/)
    store.participants.insert(participant({ origin: 'remote', ownerNodeId: 'other-node' }))
    expect(store.participants.getExecution('team', 'work-a', 'temporary')).toBeNull()
    expect(() => store.participants.updateExecution('team', 'work-a', 'temporary', execution)).toThrow(/local participant/)
  })

  it('refuses participant identities that collide with a standing member or installed App', () => {
    expect(() => store.participants.applyReplica(participant({ appId: 'researcher', ownerNodeId: 'remote-node' }), 'self-node')).toThrow(/conflicts/)
    store.setParticipantIdentityLookup(id => id === 'installed-app')
    expect(() => store.participants.applyReplica(participant({ appId: 'installed-app', ownerNodeId: 'remote-node' }), 'self-node')).toThrow(/conflicts/)
    expect(() => store.participants.insert(participant({ appId: 'installed-app' }), execution)).toThrow(/conflicts/)
    expect(store.participants.list('team', 'work-a')).toEqual([])
  })

  it('allows the same display name in independent work and refuses ambiguous standing aliases', () => {
    store.participants.insert(participant())
    store.participants.insert(participant({ appId: 'second', epochId: 'work-b' }))
    expect(findWorkMember(store, 'team', 'work-a', 'helper')?.appId).toBe('temporary')
    expect(findWorkMember(store, 'team', 'work-b', 'helper')?.appId).toBe('second')
    store.addMember({ teamId: 'team', appId: 'standing-helper', memberName: 'helper', role: '', isLead: false, aiProvisioned: false, addedAt: 3 })
    expect(findWorkMember(store, 'team', 'work-a', 'helper')).toBeNull()
    expect(getWorkMember(store, 'team', 'work-a', 'temporary')?.appId).toBe('temporary')
  })

  it('inherits contact limits through nested delegation', () => {
    store.participants.insert(participant())
    store.participants.insert(participant({ appId: 'nested', memberName: 'nested', parentAppId: 'temporary' }))
    expect(isWorkEdgeAllowed(store, 'team', 'work-a', 'nested', 'researcher')).toBe(true)
    expect(isWorkEdgeAllowed(store, 'team', 'work-a', 'lead', 'nested')).toBe(true)
    expect(isWorkEdgeAllowed(store, 'team', 'work-a', 'nested', 'tester')).toBe(false)
    expect(isWorkEdgeAllowed(store, 'team', 'work-b', 'nested', 'researcher')).toBe(false)
    store.removeMember('team', 'researcher')
    expect(isWorkEdgeAllowed(store, 'team', 'work-a', 'lead', 'nested')).toBe(false)
  })

  it('routes through the shared bus only in the participant scope and accepts its stable handle', async () => {
    store.participants.insert(participant())
    const received: string[] = []
    const bus = createMessageBus({ store: createWorkMembership(store), hooks: {
      isBusy: () => false,
      wakeTarget: async request => { received.push(request.appId) },
    } })
    bus.assertCanContact('team', 'lead', 'temporary', 'structured', 'work-a')
    expect(() => bus.assertCanContact('team', 'tester', 'temporary', 'structured', 'work-a')).toThrow()
    await bus.send({ teamId: 'team', epochId: 'work-a', fromAppId: 'lead', to: 'temporary', message: 'Investigate.' })
    expect(received).toEqual(['temporary'])
    await expect(bus.send({ teamId: 'team', epochId: 'work-b', fromAppId: 'lead', to: 'temporary', message: 'Must not arrive.' })).rejects.toThrow()
    expect(received).toEqual(['temporary'])
    bus.resetEpoch('work-a')
  })

  it('routes a locally executable participant without consulting standing-member federation reachability', async () => {
    store.participants.insert(participant(), execution)
    const standing = vi.fn(() => false)
    const reachable = createWorkReachability(store, standing)
    expect(reachable('temporary', 'team')).toBe(true)
    expect(reachable('temporary', 'other')).toBe(false)
    expect(reachable('researcher', 'team')).toBe(false)
    expect(standing).toHaveBeenCalledTimes(1)
    const wake = vi.fn(async () => {})
    const bus = createMessageBus({ store: createWorkMembership(store), hooks: {
      isBusy: () => false, wakeTarget: wake, checkReachable: reachable,
    } })
    try {
      const result = await bus.send({ teamId: 'team', epochId: 'work-a', fromAppId: 'researcher', to: 'temporary', message: 'Start.' })
      expect(result).not.toMatchObject({ delivery: 'undelivered' })
      expect(wake).toHaveBeenCalledOnce()
    } finally { bus.resetEpoch('work-a') }
    store.participants.insert(participant({ appId: 'remote', memberName: 'remote-helper', origin: 'remote', ownerNodeId: 'remote-node' }))
    expect(reachable('remote', 'team')).toBe(false)
    expect(reachable('missing', 'team')).toBe(false)
  })

  it('projects active and waiting temporary work from its runtime cache alone', () => {
    store.applyParticipantStatuses('team', [
      { appId: 'first', epochId: 'work-a', status: 'working' },
      { appId: 'second', epochId: 'work-a', status: 'waiting_user' },
      { appId: 'third', epochId: 'work-b', status: 'waiting_user' },
    ])
    expect([...store.getParticipantWorkStates('team')]).toEqual([
      ['work-a', { active: true, waitingAppIds: ['second'] }],
      ['work-b', { active: false, waitingAppIds: ['third'] }],
    ])
    store.applyParticipantStatuses('team', [])
    expect(store.getParticipantWorkStates('team').size).toBe(0)
  })

  it('preserves participants with archived history and removes them with the owning team', () => {
    store.participants.insert(participant(), execution)
    store.endEpoch('work-a', 2, 'completed', 'Finished')
    expect(store.participants.get('team', 'work-a', 'temporary')).not.toBeNull()
    expect(store.participants.remove('team', 'work-b', 'temporary')).toBe(false)
    store.deleteTeam('team')
    expect(store.participants.listByTeam('team')).toEqual([])
  })
})
