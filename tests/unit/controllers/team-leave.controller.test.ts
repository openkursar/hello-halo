/**
 * Leaving a team hosted elsewhere, or taking one of this computer's digital
 * humans out of it (`leaveTeamOffice`).
 *
 * The controller decides which of the two a request is, keeps the duty of every
 * member it takes out so a rejoin gives it back, and never takes out more than
 * it was asked to: one member leaves alone while the others stay, the last one
 * leaving is leaving the team, and a member that is not this computer's is
 * never named. The federation manager is a stub; the team store is real, so a
 * kept duty is checked the way it is used — by the member rejoining.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { broadcastToAll, sendToRenderer, manager, storeRef } = vi.hoisted(() => ({
  broadcastToAll: vi.fn(),
  sendToRenderer: vi.fn(),
  manager: {
    withdrawMembers: vi.fn(),
    signalLeave: vi.fn(),
    leaveOffice: vi.fn(),
  },
  storeRef: { value: null as unknown },
}))

vi.mock('../../../src/main/http/websocket', () => ({ broadcastToAll }))
vi.mock('../../../src/main/foundation/window.service', () => ({ sendToRenderer }))
vi.mock('../../../src/main/apps/runtime/federation/manager', () => ({ getFederationManager: () => manager }))
vi.mock('../../../src/main/apps/team', () => ({ getTeamStore: () => storeRef.value }))
vi.mock('../../../src/main/apps/manager', () => ({ getAppManager: () => null }))
vi.mock('../../../src/main/http/identity/index', () => ({ getLocalIdentity: () => ({ id: 'node-self' }) }))
vi.mock('../../../src/main/http/auth/office-credential', () => ({
  issueOfficeCredential: vi.fn(),
  revokeOfficeCredential: vi.fn(),
  findReusableOfficeCredential: vi.fn(),
}))

import { createDatabaseManager } from '../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../src/main/platform/store/types'
import { TeamStore } from '../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../src/main/apps/team/migrations'
import { leaveTeamOffice } from '../../../src/main/controllers/team-invite.controller'

const OFFICE = 'office-joined'
const HOSTED = 'team-hosted-here'
const HOST = 'node-host'
const SELF = 'node-self'
const LEAD = 'app-host-lead'
const A = 'app-writer'
const B = 'app-tester'

let dbm: DatabaseManager
let store: TeamStore

function roster(members: Array<{ appId: string; owner: string; duty?: string | null }>) {
  return {
    hostNodeId: HOST,
    selfNodeId: SELF,
    snapshot: {
      team: { id: OFFICE, name: 'Release', goal: 'Ship', leadAppId: LEAD, collabMode: 'free' as const, hostNodeId: HOST },
      members: members.map((m) => ({
        appId: m.appId, memberName: m.appId, role: '', isLead: m.appId === LEAD, duty: m.duty ?? null,
        ownerNodeId: m.owner, memberIdentity: null, ownerDisplayName: null,
      })),
      edges: [],
    },
  }
}

/** The office drops these members, then admits them again with no duty. */
function rejoin(present: Array<{ appId: string; owner: string }>, returning: string[]) {
  store.materializeJoinedOffice(roster(present))
  store.materializeJoinedOffice(roster([...present, ...returning.map((appId) => ({ appId, owner: SELF }))]))
}

beforeEach(() => {
  dbm = createDatabaseManager(':memory:')
  const db = dbm.getAppDatabase()
  dbm.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  store = new TeamStore(db)
  storeRef.value = store
  for (const fn of Object.values(manager)) fn.mockReset()
  broadcastToAll.mockClear()
  sendToRenderer.mockClear()
})

afterEach(() => dbm.closeAll())

describe('taking one digital human out of a joined team', () => {
  beforeEach(() => {
    store.materializeJoinedOffice(roster([
      { appId: LEAD, owner: HOST },
      { appId: A, owner: SELF, duty: 'You write it.' },
      { appId: B, owner: SELF, duty: 'You test it.' },
    ]))
  })

  it('takes out only that member, keeps the others, and keeps its duty for a rejoin', async () => {
    manager.withdrawMembers.mockReturnValue('sent')

    const result = await leaveTeamOffice(OFFICE, [B])

    expect(result).toEqual({ success: true })
    expect(manager.withdrawMembers).toHaveBeenCalledWith(OFFICE, [B])
    expect(manager.signalLeave).not.toHaveBeenCalled()
    expect(manager.leaveOffice).not.toHaveBeenCalled()
    expect(store.getTeamById(OFFICE)).not.toBeNull()
    expect(sendToRenderer).not.toHaveBeenCalled()

    rejoin([{ appId: LEAD, owner: HOST }, { appId: A, owner: SELF }], [B])
    expect(store.getMember(OFFICE, B)?.duty).toBe('You test it.')
  })

  it('keeps nothing and says so when the team cannot be reached', async () => {
    manager.withdrawMembers.mockReturnValue('authority-offline')

    const result = await leaveTeamOffice(OFFICE, [B])

    expect(result).toEqual({ success: false, error: 'OFFICE_UNREACHABLE' })
    rejoin([{ appId: LEAD, owner: HOST }, { appId: A, owner: SELF }], [B])
    expect(store.getMember(OFFICE, B)?.duty).toBeNull()
  })

  it('keeps nothing and says why while an elected authority serves the team', async () => {
    manager.withdrawMembers.mockReturnValue('elected-authority')

    const result = await leaveTeamOffice(OFFICE, [B])

    expect(result).toEqual({ success: false, error: 'ELECTED_AUTHORITY' })
    expect(store.getTeamById(OFFICE)).not.toBeNull()
    rejoin([{ appId: LEAD, owner: HOST }, { appId: A, owner: SELF }], [B])
    expect(store.getMember(OFFICE, B)?.duty).toBeNull()
  })

  it('leaves the team when the others are already on their way out', async () => {
    manager.withdrawMembers.mockReturnValue('last-members')

    const result = await leaveTeamOffice(OFFICE, [B])

    expect(result).toEqual({ success: true })
    expect(manager.signalLeave).toHaveBeenCalledWith(OFFICE)
    expect(manager.leaveOffice).toHaveBeenCalledWith(OFFICE)
    expect(store.getTeamById(OFFICE)).toBeNull()
    expect(sendToRenderer).toHaveBeenCalledWith('team:updated', { teamId: OFFICE, removed: true })
    // Both duties kept: A's row was still here.
    store.materializeJoinedOffice(roster([{ appId: LEAD, owner: HOST }, { appId: A, owner: SELF }, { appId: B, owner: SELF }]))
    expect(store.getMember(OFFICE, A)?.duty).toBe('You write it.')
    expect(store.getMember(OFFICE, B)?.duty).toBe('You test it.')
  })

  it('gives back nothing the owner cleared after a removal that never came', async () => {
    manager.withdrawMembers.mockReturnValue('sent') // the office never applies it
    await leaveTeamOffice(OFFICE, [B])
    // B is still in the team; the owner clears its duty on purpose, then leaves.
    store.updateMemberFields(OFFICE, B, { duty: null })
    await leaveTeamOffice(OFFICE)

    const result = store.materializeJoinedOffice(roster([{ appId: LEAD, owner: HOST }, { appId: A, owner: SELF }, { appId: B, owner: SELF }]))

    expect(store.getMember(OFFICE, B)?.duty).toBeNull()
    expect(result.dutiesRestored).toEqual([A])
  })

  it('never names a member that is not this computer’s', async () => {
    const result = await leaveTeamOffice(OFFICE, [LEAD])

    expect(result).toEqual({ success: false, error: 'MEMBER_NOT_FOUND' })
    expect(manager.withdrawMembers).not.toHaveBeenCalled()
    expect(manager.signalLeave).not.toHaveBeenCalled()
  })
})

describe('leaving a joined team', () => {
  it('taking out the last of this computer’s members is leaving the team', async () => {
    store.materializeJoinedOffice(roster([{ appId: LEAD, owner: HOST }, { appId: A, owner: SELF, duty: 'You write it.' }]))

    const result = await leaveTeamOffice(OFFICE, [A])

    expect(result).toEqual({ success: true })
    expect(manager.withdrawMembers).not.toHaveBeenCalled()
    expect(manager.signalLeave).toHaveBeenCalledWith(OFFICE)
    expect(manager.leaveOffice).toHaveBeenCalledWith(OFFICE)
    expect(store.getTeamById(OFFICE)).toBeNull()
  })

  it('keeps every member’s duty, and gives each one back when it rejoins', async () => {
    store.materializeJoinedOffice(roster([
      { appId: LEAD, owner: HOST },
      { appId: A, owner: SELF, duty: 'You write it.' },
      { appId: B, owner: SELF, duty: 'You test it.' },
    ]))

    await leaveTeamOffice(OFFICE)
    expect(store.getTeamById(OFFICE)).toBeNull()

    store.materializeJoinedOffice(roster([{ appId: LEAD, owner: HOST }, { appId: A, owner: SELF }, { appId: B, owner: SELF }]))
    expect(store.getMember(OFFICE, A)?.duty).toBe('You write it.')
    expect(store.getMember(OFFICE, B)?.duty).toBe('You test it.')
  })
})

describe('a team this computer hosts', () => {
  beforeEach(() => {
    const now = Date.now()
    store.insertTeam({
      id: HOSTED, name: 'Mine', owningSpaceId: 'space', goal: 'Own work', leadAppId: null,
      memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user', status: 'idle',
      currentEpochId: null, createdAt: now, updatedAt: now,
    })
    store.addMember({ teamId: HOSTED, appId: A, memberName: 'writer', role: '', isLead: false, aiProvisioned: false, addedAt: now })
    store.updateMemberFields(HOSTED, A, { duty: 'You write it.' })
  })

  it('has no member to take out — removing one is the host’s own action', async () => {
    const result = await leaveTeamOffice(HOSTED, [A])

    expect(result).toEqual({ success: false, error: 'NOT_JOINED' })
    expect(store.getMember(HOSTED, A)).not.toBeNull()
    expect(manager.withdrawMembers).not.toHaveBeenCalled()
  })

  it('cannot be left either: its host dissolves it, and a leave would delete it without telling anyone who joined', async () => {
    const result = await leaveTeamOffice(HOSTED)

    expect(result).toEqual({ success: false, error: 'NOT_JOINED' })
    expect(store.getTeamById(HOSTED)).not.toBeNull()
    expect(store.getMember(HOSTED, A)?.duty).toBe('You write it.')
    // Still hosted: nothing stopped, nothing announced.
    expect(manager.signalLeave).not.toHaveBeenCalled()
    expect(manager.leaveOffice).not.toHaveBeenCalled()
    expect(sendToRenderer).not.toHaveBeenCalled()
    expect(broadcastToAll).not.toHaveBeenCalled()
  })
})

describe('a team that is not here', () => {
  it('is not left: nothing is torn down for an id this computer has no team for', async () => {
    const result = await leaveTeamOffice('office-unknown')

    expect(result).toEqual({ success: false, error: 'NOT_JOINED' })
    expect(manager.signalLeave).not.toHaveBeenCalled()
    expect(manager.leaveOffice).not.toHaveBeenCalled()
    expect(sendToRenderer).not.toHaveBeenCalled()
    expect(broadcastToAll).not.toHaveBeenCalled()
  })

  it('has no member to take out either: nothing is sent for it', async () => {
    const result = await leaveTeamOffice('office-unknown', [A])

    expect(result).toEqual({ success: false, error: 'NOT_JOINED' })
    expect(manager.withdrawMembers).not.toHaveBeenCalled()
    expect(manager.signalLeave).not.toHaveBeenCalled()
    expect(manager.leaveOffice).not.toHaveBeenCalled()
    expect(sendToRenderer).not.toHaveBeenCalled()
    expect(broadcastToAll).not.toHaveBeenCalled()
  })
})
