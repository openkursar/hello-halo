/**
 * A member's new name, carried to the office as `member_profile.memberName`,
 * over REAL FederationManagers. Only the node that serves the office applies
 * it; every other node takes names from the roster, so all of them end on the
 * name the authority chose — even when this node's own uniqueness check would
 * choose differently, or an old rename is replayed after a later name.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildTrafficCluster, SIM_OFFICE, type SimNode, type TrafficCluster } from './traffic-cluster'

let cluster: TrafficCluster | null = null
afterEach(() => {
  cluster?.dispose()
  cluster = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const nameOf = (node: SimNode, appId: string) => node.team.getMember(SIM_OFFICE, appId)?.memberName

/** The owner renames its member and carries the name to the office, as bootstrap does. */
function ownerRenames(owner: SimNode, name: string): void {
  owner.team.renameMember(SIM_OFFICE, owner.appId, name)
  owner.manager.routeOfficeStateWrite(SIM_OFFICE, 'member_profile', {
    teamId: SIM_OFFICE, appId: owner.appId, duty: null, acceptsChecks: true, awaitingDecision: false, memberName: name,
  })
}

describe.each([
  ['only the serving node applies it', false, true],
  ['every node applies it (negative control)', true, false],
] as const)('a member rename when %s', (_label, namesEverywhere, converges) => {
  it('every node ends on the authority’s name when only the authority still holds a former name', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(3, { namesEverywhere }))
    c.advance(5_000)
    const [j1, j2, j3] = c.joiners
    // The host's member was once "Bea"; only the host still remembers that (a
    // joiner restarted since), so only the host counts the name as taken.
    c.host.team.renameMember(SIM_OFFICE, 'app-host', 'Bea')
    c.host.team.renameMember(SIM_OFFICE, 'app-host', 'Yan')

    ownerRenames(j2, 'Bea')
    c.advance(5_000)

    expect(nameOf(c.host, 'app-j2')).toBe('Bea-2')
    const names = [j1, j2, j3].map((n) => nameOf(n, 'app-j2'))
    if (converges) expect(names).toEqual(['Bea-2', 'Bea-2', 'Bea-2'])
    else expect(names).not.toEqual(['Bea-2', 'Bea-2', 'Bea-2'])
  })

  it('a replicated rename applied after a later roster does not take the name back', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(3, { namesEverywhere }))
    c.advance(5_000)
    const [, j2, j3] = c.joiners
    // j3's log entries arrive late (a later catch-up page); its rosters do not.
    c.defer(j3, ['blackboard-replicate', 'catchup-response'])
    ownerRenames(j2, 'Bea')
    c.advance(5_000)
    // Later the member's name changes without a rename entry (taken out and
    // brought back under a name chosen for the team).
    c.host.team.renameMember(SIM_OFFICE, 'app-j2', 'Analyst')
    c.host.manager.broadcastRosterFor(SIM_OFFICE)
    c.advance(1_000)
    expect(nameOf(j3, 'app-j2')).toBe('Analyst')

    c.release(j3)
    c.advance(5_000)

    expect(j3.officeState.some((r) => r.payload.memberName === 'Bea')).toBe(true)
    if (converges) expect(nameOf(j3, 'app-j2')).toBe('Analyst')
    else expect(nameOf(j3, 'app-j2')).not.toBe('Analyst')
  })
})
