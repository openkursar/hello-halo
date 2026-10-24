/**
 * Taking this computer's digital humans out of a joined team one after the
 * other, faster than the office answers: the real controller over the real
 * federation manager, joined to a scripted host (_scripted-host).
 *
 * Taking out the last one still in the team is leaving it, even while the rows
 * of those taken out a moment earlier are still shown: the computer must not
 * stay behind in the office with none of its members, nor report its own
 * request as the host's doing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const ref = vi.hoisted(() => ({ store: null as unknown, sendToRenderer: vi.fn() }))

vi.mock('../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../src/main/foundation/window.service', () => ({ sendToRenderer: ref.sendToRenderer }))
vi.mock('../../../src/main/apps/team', () => ({ getTeamStore: () => ref.store }))
vi.mock('../../../src/main/apps/manager', () => ({ getAppManager: () => null }))
vi.mock('../../../src/main/http/identity/index', () => ({ getLocalIdentity: () => ({ id: 'node-self' }) }))
vi.mock('../../../src/main/http/auth/office-credential', () => ({
  issueOfficeCredential: vi.fn(),
  revokeOfficeCredential: vi.fn(),
  findReusableOfficeCredential: vi.fn(),
}))

import { setFederationManager } from '../../../src/main/apps/runtime/federation/manager'
import { leaveTeamOffice } from '../../../src/main/controllers/team-invite.controller'
import {
  SCRIPTED_OFFICE as OFFICE,
  startScriptedHostOffice,
  waitFor,
} from '../apps/runtime/federation/_scripted-host'

const A = 'app-writer'
const B = 'app-tester'
const C = 'app-reviewer'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  setFederationManager(null)
  ref.sendToRenderer.mockClear()
  for (const close of cleanup.splice(0)) await close()
})

async function harness(brought: string[]) {
  const h = await startScriptedHostOffice(brought, { duty: (appId) => `duty of ${appId}` })
  cleanup.push(() => h.close())
  ref.store = h.teamStore
  setFederationManager(h.manager)
  return h
}

describe('taking one out, then another, before the office answered the first', () => {
  it('the last one still in the team takes this computer out with it', async () => {
    const h = await harness([A, B])

    expect(await leaveTeamOffice(OFFICE, [A])).toEqual({ success: true })
    expect(h.teamStore.getMember(OFFICE, A)).not.toBeNull() // no answer yet
    expect(await leaveTeamOffice(OFFICE, [B])).toEqual({ success: true })

    await waitFor(() => h.sent('member-leave').length === 2)
    const [first, second] = h.sent('member-leave').map((f) => [...f.appIds].sort())
    expect(first).toEqual([A])
    // A again too: its removal may never have arrived.
    expect(second).toEqual([A, B].sort())
    expect(h.manager.listJoinedOffices()).not.toContain(OFFICE)
    expect(h.teamStore.getTeamById(OFFICE)).toBeNull()
    expect(h.record()).toBeUndefined()
    expect(ref.sendToRenderer).toHaveBeenCalledWith('team:updated', { teamId: OFFICE, removed: true })
    // Nothing was reported as the host's doing.
    expect(h.removed).toEqual([])

    // The host asking it to rejoin reaches nobody: no member-less node comes back.
    h.send({ kind: 'rejoin-request', officeId: OFFICE })
    await new Promise((r) => setTimeout(r, 100))
    expect(h.sent('join-request')).toHaveLength(1)
  })

  it('with one more still in the team, only the second is taken out and the first stays out of the record', async () => {
    const h = await harness([A, B, C])

    await leaveTeamOffice(OFFICE, [A])
    expect(await leaveTeamOffice(OFFICE, [B])).toEqual({ success: true })

    await waitFor(() => h.sent('member-leave').length === 2)
    expect(h.sent('member-leave').map((f) => f.appIds)).toEqual([[A], [B]])
    expect(h.record()?.bringAppIds).toEqual([C])
    expect(h.manager.listJoinedOffices()).toContain(OFFICE)
  })
})
