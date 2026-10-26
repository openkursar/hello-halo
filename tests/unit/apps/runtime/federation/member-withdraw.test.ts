/**
 * Taking some of this computer's digital humans out of a team hosted elsewhere,
 * against a host that speaks only the frames earlier builds already exchange.
 *
 * The host here is a scripted socket, not this build's manager (_scripted-host):
 * it grants the join, projects the roster it is told to, and records every frame
 * the joiner sends. Whatever this computer does must reach such a host as frames
 * it already understands — a `member-leave` naming only the member taken out, a
 * `member_profile` write for a duty given back — and no join-request this node
 * sends again, for any reason, may bring back a member that left.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JoinRequest } from '../../../../../src/main/apps/runtime/federation/types'
import {
  SCRIPTED_HOST as HOST,
  SCRIPTED_LEAD as LEAD,
  SCRIPTED_OFFICE as OFFICE,
  SCRIPTED_SELF as SELF,
  snap,
  startScriptedHostOffice,
  waitFor,
} from './_scripted-host'

const A = 'app-writer'
const B = 'app-tester'
const C = 'app-reviewer'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0)) await close()
})

async function harness(brought: string[]) {
  const h = await startScriptedHostOffice(brought)
  cleanup.push(() => h.close())
  return h
}

const ids = (members: Array<{ appId: string }>) => members.map((m) => m.appId).sort()
const joinIds = (h: Awaited<ReturnType<typeof harness>>, n: number) => ids((h.sent('join-request')[n] as JoinRequest).bringMembers)

describe('taking one digital human out of a team hosted on an earlier build', () => {
  it('names only that member, in the frame an earlier host already acts on', async () => {
    const h = await harness([A, B, C])

    expect(h.manager.withdrawMembers(OFFICE, [B])).toBe('sent')

    await waitFor(() => h.sent('member-leave').length === 1)
    // Exactly the shape every build on this protocol version handles: a host
    // removes the members named and keeps this computer in the office while
    // it still has others there.
    expect(h.sent('member-leave')[0]).toEqual({ kind: 'member-leave', officeId: OFFICE, fromNode: SELF, appIds: [B] })
    expect(h.record()?.bringAppIds.sort()).toEqual([A, C].sort())
  })

  it('is not reported as a kick when the host takes the member out', async () => {
    const h = await harness([A, B, C])
    h.manager.withdrawMembers(OFFICE, [B])

    h.removeOnHost([B])

    await waitFor(() => h.teamStore.getMember(OFFICE, B) === null)
    expect(h.removed).toEqual([{ appId: B, ownMember: false }])
    expect(ids(h.teamStore.listMembersByTeam(OFFICE))).toEqual([A, C, LEAD].sort())
  })

  it('leaves the row until the roster drops it, so a roster sent before the host acted keeps it', async () => {
    const h = await harness([A, B, C])
    h.manager.withdrawMembers(OFFICE, [B])
    h.sendRoster() // projected before the host processed the leave
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.teamStore.getMember(OFFICE, B)).not.toBeNull()

    h.host.members = h.host.members.filter((m) => m.appId !== B)
    h.sendRoster()

    await waitFor(() => h.teamStore.getMember(OFFICE, B) === null)
  })

  it('is not undone by the join a reconnect sends again', async () => {
    const h = await harness([A, B, C])
    h.manager.withdrawMembers(OFFICE, [B])
    await waitFor(() => h.sent('member-leave').length === 1)

    h.dropConnection()

    await waitFor(() => h.sent('join-request').length === 2, 5000)
    expect(joinIds(h, 1)).toEqual([A, C].sort())
  })

  it('is not undone by the join this node re-sends when the host asks it to rejoin', async () => {
    const h = await harness([A, B, C])
    h.manager.withdrawMembers(OFFICE, [B])
    await waitFor(() => h.sent('member-leave').length === 1)

    // What the host's coordinator sends when it confirmed this node offline
    // while its socket stayed up (a laptop asleep with the TCP session alive).
    h.send({ kind: 'rejoin-request', officeId: OFFICE })

    await waitFor(() => h.sent('join-request').length === 2)
    expect(joinIds(h, 1)).toEqual([A, C].sort())
  })

  it('is not undone by the join this node re-sends when a host it judged offline is heard again', async () => {
    const h = await harness([A, B, C])
    // The joiner tracks its upstream; with M2 on this row lands on the first roster.
    h.federationStore.upsertNode({
      nodeId: HOST, officeId: OFFICE, identity: HOST, displayName: 'Host',
      joinedAt: 0, lastSeen: Date.now(), status: 'online', advertisedUrl: null,
    })
    h.manager.withdrawMembers(OFFICE, [B])
    await waitFor(() => h.sent('member-leave').length === 1)

    // The host is silent for 20 s on this node's monotonic clock (its machine
    // slept with the TCP session surviving), then its heartbeat arrives.
    const coordinator = h.manager.getOffice(OFFICE)!.coordinator
    coordinator.sweepPresence()
    const realNow = performance.now.bind(performance)
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + 20_000)
    coordinator.sweepPresence()
    expect(h.federationStore.getNode(OFFICE, HOST)?.status).toBe('offline')
    h.send({ kind: 'heartbeat', officeId: OFFICE, fromNode: HOST, ts: Date.now() })

    await waitFor(() => h.sent('join-request').length === 2)
    expect(joinIds(h, 1)).toEqual([A, C].sort())
  })

  it('is refused, with nothing sent, while the team’s host is confirmed offline', async () => {
    const h = await harness([A, B, C])
    h.federationStore.upsertNode({
      nodeId: HOST, officeId: OFFICE, identity: HOST, displayName: 'Host',
      joinedAt: 0, lastSeen: 0, status: 'offline', advertisedUrl: null,
    })

    expect(h.manager.withdrawMembers(OFFICE, [B])).toBe('authority-offline')

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.sent('member-leave')).toEqual([])
    expect(h.record()?.bringAppIds.sort()).toEqual([A, B, C].sort())
  })
})

describe('taking out a second one before the office answered the first', () => {
  it('counts the first as gone: taking out the last of them is leaving, and nothing is sent for it', async () => {
    const h = await harness([A, B])
    expect(h.manager.withdrawMembers(OFFICE, [A])).toBe('sent')
    // The office has not answered yet: A's row is still here.
    expect(h.teamStore.getMember(OFFICE, A)).not.toBeNull()

    expect(h.manager.withdrawMembers(OFFICE, [B])).toBe('last-members')

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.sent('member-leave').map((f) => f.appIds)).toEqual([[A]])
    // A stays out of the record a restart re-joins from.
    expect(h.record()?.bringAppIds).toEqual([B])
  })

  it('keeps the first out of the record when another one is taken out', async () => {
    const h = await harness([A, B, C])
    h.manager.withdrawMembers(OFFICE, [A])

    expect(h.manager.withdrawMembers(OFFICE, [B])).toBe('sent')

    expect(h.record()?.bringAppIds).toEqual([C])
    h.removeOnHost([A, B])
    await waitFor(() => h.teamStore.getMember(OFFICE, A) === null && h.teamStore.getMember(OFFICE, B) === null)
    // Neither is reported as a kick: this node took both out.
    expect(h.removed).toEqual([{ appId: A, ownMember: false }, { appId: B, ownMember: false }])
  })
})

describe('a member the host removed', () => {
  it('is not brought back by the join a reconnect sends again', async () => {
    const h = await harness([A, B, C])

    h.removeOnHost([B])
    await waitFor(() => h.removed.length === 1)
    expect(h.removed[0]).toEqual({ appId: B, ownMember: true })

    h.dropConnection()

    await waitFor(() => h.sent('join-request').length === 2, 5000)
    expect(joinIds(h, 1)).toEqual([A, C].sort())
  })

  it('is not brought back by the join this node re-sends when the host asks it to rejoin', async () => {
    const h = await harness([A, B, C])
    h.removeOnHost([B])
    await waitFor(() => h.removed.length === 1 && h.teamStore.getMember(OFFICE, B) === null)

    h.send({ kind: 'rejoin-request', officeId: OFFICE })

    await waitFor(() => h.sent('join-request').length === 2)
    expect(joinIds(h, 1)).toEqual([A, C].sort())
  })
})

describe('leaving a team hosted on an earlier build', () => {
  it('takes out every member the team has as this computer’s, not only the ones the re-join record lists', async () => {
    const h = await harness([A, B, C])
    // A record narrowed by an earlier re-join that brought only some members.
    h.federationStore.upsertJoinedOfficeConnection({ ...h.record()!, bringAppIds: [A, B] })

    h.manager.signalLeave(OFFICE)

    await waitFor(() => h.sent('member-leave').length === 1)
    expect(h.sent('member-leave')[0].appIds.sort()).toEqual([A, B, C].sort())
  })

  it('names a member taken out earlier whose removal has not come back', async () => {
    const h = await harness([A, B, C])
    h.manager.withdrawMembers(OFFICE, [B]) // the host never applies it

    h.manager.signalLeave(OFFICE)

    await waitFor(() => h.sent('member-leave').length === 2)
    expect(h.sent('member-leave')[1].appIds.sort()).toEqual([A, B, C].sort())
  })
})

describe('joining the same team again', () => {
  it('gives a returning member its kept duty and tells the host with the profile write it already applies', async () => {
    const h = await harness([A, C])
    // B was taken out earlier; its duty stayed on this computer.
    h.teamStore.retainMemberDuties(OFFICE, [{ appId: B, duty: 'You test every build.' }])

    // The host admits B with no duty: the join request carries none.
    h.host.members = [...h.host.members, snap(B, SELF)]
    await h.join([B])

    await waitFor(() => h.sent('blackboard-write').length === 1)
    expect(h.teamStore.getMember(OFFICE, B)?.duty).toBe('You test every build.')
    expect(h.sent('blackboard-write')[0]).toMatchObject({
      kind: 'blackboard-write',
      officeId: OFFICE,
      fromNode: SELF,
      op: 'member_profile',
      payload: { teamId: OFFICE, appId: B, duty: 'You test every build.' },
    })
  })

  it('keeps the members already there in the re-join record', async () => {
    const h = await harness([A, C])

    h.host.members = [...h.host.members, snap(B, SELF)]
    await h.join([B])

    await waitFor(() => h.teamStore.getMember(OFFICE, B) !== null)
    expect(h.record()?.bringAppIds.sort()).toEqual([A, B, C].sort())
  })

  it('brings back the duty written last, when a removal never arrived and the owner kept editing', async () => {
    const h = await harness([A, B, C])
    h.manager.withdrawMembers(OFFICE, [B]) // the host never applies it
    h.teamStore.retainMemberDuties(OFFICE, [{ appId: B, duty: 'D1' }])
    h.sendRoster()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.teamStore.getMember(OFFICE, B)).not.toBeNull() // still in the team
    // The owner keeps using B and writes a newer duty.
    h.teamStore.updateMemberFields(OFFICE, B, { duty: 'D2' })
    // Later the host removes B, and B is invited back.
    h.removeOnHost([B])
    await waitFor(() => h.teamStore.getMember(OFFICE, B) === null)
    h.host.members = [...h.host.members, snap(B, SELF)]
    await h.join([B])

    await waitFor(() => h.teamStore.getMember(OFFICE, B) !== null)
    expect(h.teamStore.getMember(OFFICE, B)?.duty).toBe('D2')
  })

  it('a roster still listing a member that left neither gives its duty back nor uses it up', async () => {
    const h = await harness([A, B, C])
    h.manager.withdrawMembers(OFFICE, [B])
    h.teamStore.retainMemberDuties(OFFICE, [{ appId: B, duty: 'D1' }])
    h.removeOnHost([B])
    await waitFor(() => h.teamStore.getMember(OFFICE, B) === null)

    // A roster that is behind lists B again, then the current one does not.
    h.host.members = [...h.host.members, snap(B, SELF)]
    h.sendRoster()
    await waitFor(() => h.teamStore.getMember(OFFICE, B) !== null)
    expect(h.teamStore.getMember(OFFICE, B)?.duty).toBeNull()
    h.host.members = h.host.members.filter((m) => m.appId !== B)
    h.sendRoster()
    await waitFor(() => h.teamStore.getMember(OFFICE, B) === null)
    expect(h.sent('blackboard-write')).toEqual([])

    // B is invited back for real: its duty is still there to give back.
    h.host.members = [...h.host.members, snap(B, SELF)]
    await h.join([B])
    await waitFor(() => h.teamStore.getMember(OFFICE, B)?.duty === 'D1')
  })
})
