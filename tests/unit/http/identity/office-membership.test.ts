/**
 * Tests for the identity → office member appId mapping (read-side keystone).
 *
 * Backed by a real in-memory TeamStore singleton (initTeamStore) so the mapping
 * reads genuine persisted member rows (memberIdentity column). Proves an office
 * credential's identity resolves to exactly the member appIds it owns, and is
 * fail-closed (empty) for unknown identity / no store / no match.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { initTeamStore, shutdownTeamStore, getTeamStore } from '../../../../src/main/apps/team'
import { resolveOfficeMemberAppIds } from '../../../../src/main/http/identity/office-membership'
import type { Team, TeamMember } from '../../../../src/shared/apps/team-types'

const OFFICE = 'office-1'
const ID_A = 'id-alice'
const ID_B = 'id-bob'

function team(): Team {
  return {
    id: OFFICE,
    name: 'Office',
    owningSpaceId: 'space-1',
    goal: 'g',
    leadAppId: null,
    memberSourcing: 'manual',
    collabMode: 'structured',
    escalationRouting: 'user',
    status: 'idle',
    currentEpochId: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function member(appId: string, memberIdentity: string | null): TeamMember {
  return {
    teamId: OFFICE,
    appId,
    memberName: appId,
    role: 'r',
    isLead: false,
    aiProvisioned: false,
    addedAt: 1,
    memberIdentity,
  }
}

describe('resolveOfficeMemberAppIds', () => {
  let dbManager: DatabaseManager

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    initTeamStore({ db: dbManager })
    const store = getTeamStore()!
    store.insertTeam(team())
    store.addMember(member('app-a1', ID_A))
    store.addMember(member('app-a2', ID_A))
    store.addMember(member('app-b1', ID_B))
    store.addMember(member('app-local', null)) // local member, no portable identity
  })

  afterEach(() => {
    shutdownTeamStore()
    dbManager.closeAll()
  })

  it('maps an identity to ALL member appIds it owns in the office', () => {
    expect(resolveOfficeMemberAppIds(OFFICE, ID_A).sort()).toEqual(['app-a1', 'app-a2'])
  })

  it('maps a single-member identity to just that appId', () => {
    expect(resolveOfficeMemberAppIds(OFFICE, ID_B)).toEqual(['app-b1'])
  })

  it('returns [] for an identity that owns no member (fail-closed)', () => {
    expect(resolveOfficeMemberAppIds(OFFICE, 'id-unknown')).toEqual([])
  })

  it('never matches a local member with null memberIdentity', () => {
    // An empty/garbage identity must not accidentally collide with null rows.
    expect(resolveOfficeMemberAppIds(OFFICE, '')).toEqual([])
  })

  it('returns [] for an empty officeId or identity', () => {
    expect(resolveOfficeMemberAppIds('', ID_A)).toEqual([])
    expect(resolveOfficeMemberAppIds(OFFICE, '')).toEqual([])
  })

  it('does not leak members across offices', () => {
    const store = getTeamStore()!
    // Distinct name + space to satisfy the (owning_space_id, name) uniqueness.
    const other = { ...team(), id: 'office-2', name: 'Office Two', owningSpaceId: 'space-2' }
    store.insertTeam(other)
    store.addMember({ ...member('app-a1-elsewhere', ID_A), teamId: 'office-2' })
    // Alice owns a member in office-2, but the office-1 query must not see it.
    expect(resolveOfficeMemberAppIds(OFFICE, ID_A).sort()).toEqual(['app-a1', 'app-a2'])
  })
})
