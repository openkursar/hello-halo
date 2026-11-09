import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { buildTeamSessionKey } from '../../../../src/shared/apps/team-types'

let manager: ReturnType<typeof createDatabaseManager>
let store: TeamStore
beforeEach(() => {
  manager = createDatabaseManager(':memory:')
  manager.runMigrations(manager.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
  store = new TeamStore(manager.getAppDatabase())
})
afterEach(() => manager.closeAll())

describe('retired collaboration state', () => {
  it('compacts a cancelled branch without reviving descendants or affecting its sibling', () => {
    store.requests.begin('source', 'root')
    store.requests.track('child-session', 'root/child')
    store.requests.track('grandchild-session', 'root/child/grandchild')
    store.requests.track('sibling-session', 'root/sibling')
    store.requests.cancel('root/child')
    expect(store.requests.cancelled('root/child/grandchild')).toBe(true)
    expect(store.requests.cancelled('root/sibling')).toBe(false)
    expect(manager.getAppDatabase().prepare('SELECT id FROM collaboration_requests ORDER BY id').all()).toEqual([
      { id: 'root' }, { id: 'root/child' }, { id: 'root/sibling' },
    ])
    expect(store.requests.assignment('child-session')?.requestId).toBe('root/child')
    store.requests.cancel('root')
    expect(manager.getAppDatabase().prepare('SELECT id FROM collaboration_requests').all()).toEqual([{ id: 'root' }])
    expect(store.requests.cancelled('root/sibling')).toBe(true)
  })

  it('removes deleted work heads and private payloads but keeps old request cancellation', () => {
    store.insertTeam({ id: 'team', name: 'Team', owningSpaceId: 'space', goal: '', leadAppId: 'lead', memberSourcing: 'manual',
      collabMode: 'free', escalationRouting: 'user', status: 'idle', currentEpochId: null, createdAt: 1, updatedAt: 1,
      ephemeral: true, coordinatorConversationId: 'source-chat' })
    store.addMember({ teamId: 'team', appId: 'lead', memberName: 'lead', role: '', isLead: true, aiProvisioned: false, addedAt: 1 })
    store.insertEpoch({ id: 'work', teamId: 'team', startedAt: 1, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' })
    const session = buildTeamSessionKey('lead', 'team', 'work')
    store.requests.begin('source-chat', 'source-request')
    store.requests.track(session, 'source-request/member')
    store.requests.begin('unrelated', 'other-request')
    store.sourceBindings.bind({ requestId: 'source-request', sourceKey: 'source-chat', scopeKey: 'im:channel', ownerKey: 'owner', payload: { private: 'source-message' } })
    store.recipientFences.rotate({ teamId: 'team', epochId: 'work', appId: 'lead' })
    store.deleteTeam('team')

    expect(store.requests.current('source-chat')).toBeNull()
    expect(store.requests.current(session)).toBeNull()
    expect(store.requests.cancelled('source-request/member')).toBe(true)
    expect(store.sourceBindings.get('source-request')).toMatchObject({ revoked: true, payload: {} })
    expect(store.requests.current('unrelated')).toBe('other-request')
    expect(store.requests.cancelled('other-request')).toBe(false)
    expect(manager.getAppDatabase().prepare('SELECT * FROM collaboration_recipient_fences').all()).toEqual([])
  })
})
