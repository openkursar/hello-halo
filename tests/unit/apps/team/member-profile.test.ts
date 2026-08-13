/**
 * Unit tests for a member's per-team profile: the duty its owner writes, and the
 * capabilities the owner lends to teammates.
 *
 * The rules under test: a duty belongs to one team and to its owner alone; the
 * policy that guards a machine never leaves it, while the single bit other
 * machines need does; and a roster projection from the office authority must not
 * undo an edit the owner just made on their own row.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { SELF_NODE_ID } from '../../../../src/shared/apps/team-types'

const TEAM = 'office-1'
const MINE = 'app-mine'
const THEIRS = 'app-theirs'

function makeStore(): TeamStore {
  const dbm = createDatabaseManager(':memory:')
  const db = dbm.getAppDatabase()
  dbm.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  const store = new TeamStore(db)
  store.insertTeam({
    id: TEAM, name: 'Delivery', owningSpaceId: 'space', goal: 'ship', leadAppId: null,
    memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user',
    status: 'idle', currentEpochId: null, createdAt: 1, updatedAt: 1,
  })
  return store
}

describe('member duty and delegated capabilities', () => {
  let store: TeamStore

  beforeEach(() => {
    store = makeStore()
    store.addMember({
      teamId: TEAM, appId: MINE, memberName: 'coder', role: '',
      isLead: false, aiProvisioned: false, addedAt: 1,
    })
  })

  it('defaults to no duty and no restriction, so an untouched team is unchanged', () => {
    const member = store.listMembersByTeam(TEAM)[0]
    expect(member.duty).toBeNull()
    expect(member.delegatedPolicy).toBeNull()
    expect(member.acceptsChecks).toBe(true)
  })

  it('keeps a duty scoped to one team', () => {
    store.insertTeam({
      id: 'office-2', name: 'Support', owningSpaceId: 'space', goal: 'help', leadAppId: null,
      memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user',
      status: 'idle', currentEpochId: null, createdAt: 1, updatedAt: 1,
    })
    store.addMember({
      teamId: 'office-2', appId: MINE, memberName: 'coder', role: '',
      isLead: false, aiProvisioned: false, addedAt: 1,
    })

    store.updateMemberFields(TEAM, MINE, { duty: 'You do the coding here.' })

    expect(store.listMembersByTeam(TEAM)[0].duty).toBe('You do the coding here.')
    expect(store.listMembersByTeam('office-2')[0].duty).toBeNull()
  })

  it('stores the delegated policy and leaves untouched fields alone', () => {
    store.updateMemberFields(TEAM, MINE, { duty: 'Write code.' })
    store.updateMemberFields(TEAM, MINE, {
      delegatedPolicyJson: JSON.stringify({ allowedTools: ['Read'], allowChecks: false }),
      acceptsChecks: false,
    })

    const member = store.listMembersByTeam(TEAM)[0]
    expect(member.duty).toBe('Write code.')
    expect(member.delegatedPolicy).toEqual({ allowedTools: ['Read'], allowChecks: false })
    expect(member.acceptsChecks).toBe(false)
  })

  it('treats an unreadable policy as no restriction rather than a lockout', () => {
    store.updateMemberFields(TEAM, MINE, { delegatedPolicyJson: 'not json' })
    expect(store.listMembersByTeam(TEAM)[0].delegatedPolicy).toBeNull()
  })

  describe('when the office authority projects its roster', () => {
    const HOST = 'node-host'
    const SELF = 'node-self'

    function snapshot(duty: string | null) {
      return {
        hostNodeId: HOST,
        selfNodeId: SELF,
        snapshot: {
          team: { id: TEAM, name: 'Delivery', goal: 'ship', leadAppId: null, collabMode: 'free' as const },
          members: [
            { appId: MINE, memberName: 'coder', role: '', duty, ownerNodeId: SELF, memberIdentity: null },
            {
              appId: THEIRS, memberName: 'tester', role: '', duty: 'You run the tests.',
              acceptsChecks: false, ownerNodeId: HOST, memberIdentity: 'id-host',
            },
          ],
          edges: [],
        },
      }
    }

    it('adopts a teammate’s duty and their accepts-checks answer', () => {
      store.materializeJoinedOffice(snapshot(null))

      const theirs = store.listMembersByTeam(TEAM).find(m => m.appId === THEIRS)!
      expect(theirs.duty).toBe('You run the tests.')
      expect(theirs.acceptsChecks).toBe(false)
      expect(theirs.origin).toBe('remote')
    })

    it('keeps my own member’s duty when the projection is behind my edit', () => {
      store.materializeJoinedOffice(snapshot(null))
      store.updateMemberFields(TEAM, MINE, { duty: 'You do the coding.' })

      // A snapshot taken before the edit reached the authority arrives late.
      store.materializeJoinedOffice(snapshot(null))

      const mine = store.listMembersByTeam(TEAM).find(m => m.appId === MINE)!
      expect(mine.duty).toBe('You do the coding.')
      expect(mine.ownerNodeId).toBe(SELF_NODE_ID)
    })

    it('never lets a projection reach the policy guarding my own machine', () => {
      store.materializeJoinedOffice(snapshot(null))
      store.updateMemberFields(TEAM, MINE, {
        delegatedPolicyJson: JSON.stringify({ allowedTools: ['Read'] }),
        acceptsChecks: false,
      })

      store.materializeJoinedOffice(snapshot('something the host thinks'))

      const mine = store.listMembersByTeam(TEAM).find(m => m.appId === MINE)!
      expect(mine.delegatedPolicy).toEqual({ allowedTools: ['Read'] })
      expect(mine.acceptsChecks).toBe(false)
    })
  })
})
