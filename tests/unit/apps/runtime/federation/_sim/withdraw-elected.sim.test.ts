/**
 * Taking one digital human out of an office, before and after its first host
 * was lost and the survivors elected an authority, over REAL FederationManagers
 * with M2 (the traffic cluster: real presence FSM and election).
 *
 * An elected authority applies a member-leave to its own copy only — it
 * projects no roster and no member-removed — so the rest of the office would
 * keep listing the member. Taking one out is therefore refused while any
 * elected authority serves, whether it is a third node or this one, and nothing
 * is half-applied anywhere. Before the first election it goes through.
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

const ids = (node: SimNode) => node.team.listMembersByTeam(SIM_OFFICE).map((m) => m.appId).sort()

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

  it('is refused while a third node serves it after an election, and every node keeps the member', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(3, { secondMemberOf: 2 }))
    c.advance(5_000)
    const [j1, j2, j3] = c.joiners
    c.kill(c.host)
    const winner = c.electAfterHostLoss()
    expect(winner.id).not.toBe(j2.id)
    const bystander = [j1, j3].find((j) => j.id !== winner.id)!

    expect(j2.manager.withdrawMembers(SIM_OFFICE, ['app-j2b'])).toBe('elected-authority')
    c.advance(60_000)

    for (const node of [winner, j2, bystander]) expect(ids(node)).toContain('app-j2b')
  })

  it('is refused while this node serves it after an election', () => {
    vi.useFakeTimers()
    const c = (cluster = buildTrafficCluster(3, { secondMemberOf: 1 }))
    c.advance(5_000)
    const [j1] = c.joiners
    c.kill(c.host)
    const winner = c.electAfterHostLoss()
    expect(winner.id).toBe(j1.id)

    expect(j1.manager.withdrawMembers(SIM_OFFICE, ['app-j1b'])).toBe('elected-authority')
    c.advance(5_000)

    for (const node of c.joiners) expect(ids(node)).toContain('app-j1b')
  })
})
