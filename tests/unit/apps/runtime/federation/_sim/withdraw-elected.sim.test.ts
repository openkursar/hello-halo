/**
 * Membership changes before and after the first host was lost and the
 * survivors elected an authority, over REAL FederationManagers with M2 (the
 * traffic cluster: real presence FSM and election).
 *
 * Whoever serves the office projects the change: a member taken out, or a
 * whole node leaving, converges on every surviving node — whether the first
 * host serves, a third node was elected, or the leaving node itself serves.
 * The elected authority speaks the frames the first host always spoke
 * (`member-removed`, `roster`), so a peer on an earlier build reads them too.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FederationStore } from '../../../../../../src/main/apps/federation/store'
import { DEFAULT_OFFICE_SCOPE } from '../../../../../../src/main/apps/federation/types'
import { AuthorityStore } from '../../../../../../src/main/apps/federation/authority-store'
import { buildTrafficCluster, SIM_OFFICE, type SimNode, type TrafficCluster } from './traffic-cluster'

let cluster: TrafficCluster | null = null
afterEach(() => {
  cluster?.dispose()
  cluster = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const ids = (node: SimNode) => node.team.listMembersByTeam(SIM_OFFICE).map((m) => m.appId).sort()
const ledger = (node: SimNode) => new FederationStore(node.dbm.getAppDatabase()).listNodesByOffice(SIM_OFFICE).map((n) => n.nodeId)
const rejoinRecord = (node: SimNode) =>
  new FederationStore(node.dbm.getAppDatabase()).listJoinedOfficeConnections().find((c) => c.officeId === SIM_OFFICE)

/** Host lost, a survivor other than `notWinner` elected; returns it and the bystander. */
function electThirdNode(c: TrafficCluster, notWinner: SimNode): { winner: SimNode; bystander: SimNode } {
  c.kill(c.host)
  const winner = c.electAfterHostLoss()
  expect(winner.id).not.toBe(notWinner.id)
  const bystander = c.joiners.find((j) => j.id !== winner.id && j.id !== notWinner.id)!
  return { winner, bystander }
}

describe('taking one digital human out, by who serves the office', () => {
  it('goes through while the first host serves it: every node drops the member', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(3, { secondMemberOf: 2 }))
    c.advance(5_000)
    const [j1, j2, j3] = c.joiners
    expect(ids(j2)).toContain('app-j2b')

    expect(j2.manager.withdrawMembers(SIM_OFFICE, ['app-j2b'])).toBe('sent')
    c.advance(5_000)

    for (const node of [c.host, j1, j2, j3]) expect(ids(node)).not.toContain('app-j2b')
    expect(ids(c.host)).toContain('app-j2')
  })

  it('goes through while a third node serves it after an election: every node drops the member', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(3, { secondMemberOf: 2 }))
    c.advance(5_000)
    const j2 = c.joiners[1]
    const { winner, bystander } = electThirdNode(c, j2)
    for (const node of [winner, j2, bystander]) expect(ids(node)).toContain('app-j2b')

    expect(j2.manager.withdrawMembers(SIM_OFFICE, ['app-j2b'])).toBe('sent')
    c.advance(5_000)

    for (const node of [winner, j2, bystander]) {
      expect(ids(node)).not.toContain('app-j2b')
      expect(ids(node)).toContain('app-j2')
    }
  })

  it('goes through while this node serves it after an election: every node drops the member', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(3, { secondMemberOf: 1 }))
    c.advance(5_000)
    const [j1] = c.joiners
    c.kill(c.host)
    const winner = c.electAfterHostLoss()
    expect(winner.id).toBe(j1.id)

    expect(j1.manager.withdrawMembers(SIM_OFFICE, ['app-j1b'])).toBe('sent')
    c.advance(5_000)

    for (const node of c.joiners) {
      expect(ids(node)).not.toContain('app-j1b')
      expect(ids(node)).toContain('app-j1')
    }
  })

  it('the elected authority speaks only the frames the first host speaks, so an earlier build reads them', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(3, { secondMemberOf: 2 }))
    c.advance(5_000)
    const j2 = c.joiners[1]
    const { winner, bystander } = electThirdNode(c, j2)
    c.capture.add(bystander.id)

    j2.manager.withdrawMembers(SIM_OFFICE, ['app-j2b'])
    c.advance(5_000)

    const frames = c.captured.get(bystander.id) ?? []
    const removed = frames.filter((f) => f.kind === 'member-removed')
    expect(removed).toHaveLength(1)
    expect(Object.keys(removed[0]).sort()).toEqual(['appId', 'fid', 'fromNode', 'kind', 'officeId', 'term'])
    expect(removed[0]).toMatchObject({ appId: 'app-j2b', fromNode: winner.id })
    const rosters = frames.filter((f) => f.kind === 'roster') as Array<Extract<(typeof frames)[number], { kind: 'roster' }>>
    expect(rosters.length).toBeGreaterThan(0)
    const last = rosters[rosters.length - 1]
    expect(last.snapshot.team.hostNodeId).toBe(winner.id)
    expect(last.snapshot.members.map((m) => m.appId)).not.toContain('app-j2b')
  })
})

describe('a whole node leaving after an election', () => {
  it('a joiner leaving a third-node authority: the others drop its members and its ledger row', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(3))
    c.advance(5_000)
    const j2 = c.joiners[1]
    const { winner, bystander } = electThirdNode(c, j2)

    j2.manager.signalLeave(SIM_OFFICE)
    j2.manager.leaveOffice(SIM_OFFICE)
    c.advance(5_000)

    for (const node of [winner, bystander]) {
      expect(ids(node)).not.toContain('app-j2')
      expect(ledger(node)).not.toContain(j2.id)
    }
  })

  it('the elected authority itself leaving: the others drop its members and its ledger row', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(3))
    c.advance(5_000)
    c.kill(c.host)
    const winner = c.electAfterHostLoss()
    const others = c.joiners.filter((j) => j.id !== winner.id)

    winner.manager.signalLeave(SIM_OFFICE)
    winner.manager.leaveOffice(SIM_OFFICE)
    c.advance(1_000)

    for (const node of others) {
      expect(ids(node)).not.toContain(winner.appId)
      expect(ledger(node)).not.toContain(winner.id)
    }
  })
})

describe('governance frames from a node that does not serve the office', () => {
  it('a member-removed from a peer other than the believed authority changes nothing', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(2))
    c.advance(5_000)
    const [j1, j2] = c.joiners
    expect(rejoinRecord(j1)?.bringAppIds).toEqual(['app-j1'])

    j1.manager.deliverInbound(
      SIM_OFFICE,
      { kind: 'member-removed', officeId: SIM_OFFICE, fromNode: j2.id, term: 0, appId: 'app-j1', fid: 'f-1' } as never,
      j2.id
    )
    c.advance(1_000)

    expect(rejoinRecord(j1)?.bringAppIds).toEqual(['app-j1'])
  })
})

describe('office-shared writes made on the elected authority', () => {
  it('a periodic check and a member profile written there reach every other node', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(3))
    c.advance(5_000)
    c.kill(c.host)
    const winner = c.electAfterHostLoss()
    const others = c.joiners.filter((j) => j.id !== winner.id)
    expect(winner.manager.servesOffice(SIM_OFFICE)).toBe(true)
    for (const node of others) expect(node.manager.servesOffice(SIM_OFFICE)).toBe(false)

    winner.manager.routeOfficeStateWrite(SIM_OFFICE, 'check_upsert', { id: 'check-1', teamId: SIM_OFFICE })
    winner.manager.routeOfficeStateWrite(SIM_OFFICE, 'member_profile', { teamId: SIM_OFFICE, appId: winner.appId, duty: 'd' })
    c.advance(5_000)

    for (const node of others) {
      expect(node.officeState.map((r) => r.op)).toEqual(expect.arrayContaining(['check_upsert', 'member_profile']))
    }
  })
})

describe('governance frames from a newly elected authority this node has not heard announced', () => {
  function electWhileJ2MissesTheNews(c: TrafficCluster): { winner: SimNode; j2: SimNode } {
    const j2 = c.joiners[1]
    c.defer(j2, ['authority-announce', 'blackboard-replicate', 'roster', 'member-status'])
    const { winner } = electThirdNode(c, j2)
    expect(new AuthorityStore(j2.dbm.getAppDatabase()).getAuthorityState(SIM_OFFICE)?.authorityNodeId).not.toBe(winner.id)
    return { winner, j2 }
  }

  it('a member-removed at a newer term is taken: the member leaves this node’s bring set', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(3, { secondMemberOf: 2 }))
    c.advance(5_000)
    const { winner, j2 } = electWhileJ2MissesTheNews(c)
    expect(rejoinRecord(j2)?.bringAppIds).toContain('app-j2b')

    winner.team.removeMember(SIM_OFFICE, 'app-j2b')
    winner.manager.projectMemberRemoved(SIM_OFFICE, 'app-j2b')
    c.advance(1_000)

    expect(rejoinRecord(j2)?.bringAppIds).not.toContain('app-j2b')
  })

  it('an office-dissolved at a newer term is taken: this node leaves the office', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(3))
    c.advance(5_000)
    const { winner, j2 } = electWhileJ2MissesTheNews(c)

    winner.manager.projectOfficeDissolved(SIM_OFFICE)
    c.advance(1_000)

    expect(j2.manager.listJoinedOffices()).not.toContain(SIM_OFFICE)
    expect(rejoinRecord(j2)).toBeUndefined()
  })
})

describe('a first host that is no longer the authority', () => {
  it('projects nothing once another node holds the office', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(2))
    c.advance(5_000)
    const [j1] = c.joiners
    expect(c.host.manager.servesOffice(SIM_OFFICE)).toBe(true)
    // It came back after an election elsewhere and stepped down.
    const authority = c.host.manager.getOfficeAuthority(SIM_OFFICE)!
    authority.termState.setAuthority(j1.id, authority.getTerm() + 1)
    c.capture.add(j1.id)

    c.host.manager.broadcastRosterFor(SIM_OFFICE)
    c.host.manager.projectMemberRemoved(SIM_OFFICE, 'app-j1')
    c.advance(5_000)

    expect(c.host.manager.servesOffice(SIM_OFFICE)).toBe(false)
    const kinds = (c.captured.get(j1.id) ?? []).map((f) => f.kind)
    expect(kinds).not.toContain('roster')
    expect(kinds).not.toContain('member-status')
    expect(kinds).not.toContain('member-removed')
  })
})

describe('governance frames before this node knows who serves the office', () => {
  /** j1 as right after its grant, before a roster named the authority. */
  function authorityNotYetKnown(c: TrafficCluster): SimNode {
    const [j1] = c.joiners
    const db = j1.dbm.getAppDatabase()
    db.prepare('DELETE FROM office_authority WHERE office_id = ?').run(SIM_OFFICE)
    db.prepare('UPDATE teams SET host_node_id = NULL WHERE id = ?').run(SIM_OFFICE)
    return j1
  }

  it('a removal from the host is taken: the member leaves the bring set', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(2, { secondMemberOf: 1 }))
    c.advance(5_000)
    const j1 = authorityNotYetKnown(c)

    c.host.team.removeMember(SIM_OFFICE, 'app-j1b')
    c.host.manager.projectMemberRemoved(SIM_OFFICE, 'app-j1b')

    expect(rejoinRecord(j1)?.bringAppIds).toEqual(['app-j1'])
  })

  it('a dissolve from the host is taken: the node leaves the office', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(2))
    c.advance(5_000)
    const j1 = authorityNotYetKnown(c)

    c.host.manager.projectOfficeDissolved(SIM_OFFICE)

    expect(j1.manager.listJoinedOffices()).not.toContain(SIM_OFFICE)
  })
})

describe('a first host that stepped down', () => {
  function stepDown(c: TrafficCluster, to: SimNode): void {
    const authority = c.host.manager.getOfficeAuthority(SIM_OFFICE)!
    authority.termState.setAuthority(to.id, authority.getTerm() + 1)
  }

  it('still revokes the invites it issued when its owner dissolves the team', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(2))
    c.advance(5_000)
    const store = new FederationStore(c.host.dbm.getAppDatabase())
    store.insertCredential({ jti: 'invite-1', officeId: SIM_OFFICE, identity: 'invitee', scope: DEFAULT_OFFICE_SCOPE, exp: null, issuedAt: Date.now(), revoked: false })
    stepDown(c, c.joiners[0])

    c.host.manager.projectOfficeDissolved(SIM_OFFICE)

    expect(store.getCredential('invite-1')?.revoked).toBe(true)
  })

  it('sends its owner’s writes to the authority instead of dropping them', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(2))
    c.advance(5_000)
    const [j1] = c.joiners
    stepDown(c, j1)
    c.capture.add(j1.id)

    c.host.manager.routeOfficeStateWrite(SIM_OFFICE, 'member_profile', { teamId: SIM_OFFICE, appId: 'app-host', duty: 'd' })

    const writes = (c.captured.get(j1.id) ?? []).filter((f) => f.kind === 'blackboard-write')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ op: 'member_profile', fromNode: c.host.id })
  })
})
