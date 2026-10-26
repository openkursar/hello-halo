/**
 * What the team store tells a person after asking to take one digital human out
 * of a joined team (`withdrawMember`), with only the API mocked.
 *
 *   - Done, including when the main process turned it into leaving the team
 *     (it was the last one): nothing to say; the `removed` event clears the view.
 *   - It had left already, or the team had: nothing to say either, the view
 *     reloads to show what is there now.
 *   - Refused: said once — an unreachable team, a team that cannot take one
 *     out on its own right now (saying what can be done instead, without
 *     naming any computer), a remote client.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ teamLeaveOffice: vi.fn(), teamGetDetail: vi.fn() }))

vi.mock('../../../src/renderer/api', () => ({
  api: new Proxy({}, {
    get: (_t, key) => (key === 'teamLeaveOffice' ? api.teamLeaveOffice : key === 'teamGetDetail' ? api.teamGetDetail : vi.fn()),
  }),
}))
vi.mock('../../../src/renderer/i18n', () => ({
  default: { t: (s: string, o?: Record<string, unknown>) => s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(o?.[k] ?? '')) },
}))
vi.mock('../../../src/renderer/services/request-update-check', () => ({ requestUpdateCheck: vi.fn() }))

const { useTeamStore } = await import('../../../src/renderer/stores/team.store')
const { useNotificationStore } = await import('../../../src/renderer/stores/notification.store')

const toasts = () => useNotificationStore.getState().toasts.map((t) => ({ title: t.title, body: t.body }))

function seed(memberIds: string[]) {
  const detail = {
    team: { id: 't', name: 'Office', hostNodeId: 'node-host' },
    members: memberIds.map((appId) => ({ appId, memberName: `name-${appId}`, origin: 'local', ownerNodeId: 'SELF' })),
    activities: [],
  }
  useTeamStore.setState({ teams: [{ id: 't', name: 'Office' }] as never, currentTeamId: 't', detail: detail as never, views: {}, error: null } as never)
}

beforeEach(() => {
  useNotificationStore.getState().clear()
  api.teamLeaveOffice.mockReset()
  api.teamGetDetail.mockReset()
  api.teamGetDetail.mockResolvedValue({ success: true, data: null })
})

describe('taking one out', () => {
  it('asks the main process for exactly that member', async () => {
    seed(['x', 'y'])
    api.teamLeaveOffice.mockResolvedValue({ success: true })

    expect(await useTeamStore.getState().withdrawMember('t', 'x')).toBe(true)

    expect(api.teamLeaveOffice).toHaveBeenCalledWith('t', ['x'])
    expect(toasts()).toEqual([])
  })

  it('says nothing when it became leaving the team, and the removal clears the view', async () => {
    seed(['x'])
    api.teamLeaveOffice.mockResolvedValue({ success: true })

    expect(await useTeamStore.getState().withdrawMember('t', 'x')).toBe(true)
    useTeamStore.getState().applyTeamUpdated({ teamId: 't', removed: true })

    const s = useTeamStore.getState()
    expect([s.currentTeamId, s.detail, s.teams.length, s.error]).toEqual([null, null, 0, null])
    expect(toasts()).toEqual([])
  })
})

describe('nothing left to take out', () => {
  it('says nothing when the member had left already, and reloads the team', async () => {
    seed(['x', 'y'])
    api.teamLeaveOffice.mockResolvedValue({ success: false, error: 'MEMBER_NOT_FOUND' })

    expect(await useTeamStore.getState().withdrawMember('t', 'x')).toBe(false)

    expect(toasts()).toEqual([])
    expect(api.teamGetDetail).toHaveBeenCalledWith('t')
  })

  it('says nothing when the team itself is gone', async () => {
    seed(['x'])
    api.teamLeaveOffice.mockResolvedValue({ success: false, error: 'NOT_JOINED' })

    await useTeamStore.getState().withdrawMember('t', 'x')

    expect(toasts()).toEqual([])
  })
})

describe('refused', () => {
  it('says one cannot be taken out right now and what can be done instead, naming no computer and not telling the person to wait', async () => {
    seed(['x', 'y'])
    api.teamLeaveOffice.mockResolvedValue({ success: false, error: 'ELECTED_AUTHORITY' })

    await useTeamStore.getState().withdrawMember('t', 'x')

    const [toast] = toasts()
    expect(toast.title).toBe('Could not remove name-x from the team')
    expect(toast.body).toMatch(/can’t take out one digital human on its own right now/)
    expect(toast.body).toMatch(/leave with all of your digital humans instead/)
    expect(toast.body).toMatch(/duties are kept/)
    expect(toast.body).not.toMatch(/computer/)
    expect(toast.body).not.toMatch(/later/i)
  })

  it('says the team cannot be reached right now', async () => {
    seed(['x', 'y'])
    api.teamLeaveOffice.mockResolvedValue({ success: false, error: 'OFFICE_UNREACHABLE' })

    await useTeamStore.getState().withdrawMember('t', 'x')

    expect(toasts()[0].body).toMatch(/can’t be reached right now/)
  })

  it('explains a remote client, whether or not it is the last member', async () => {
    seed(['x'])
    api.teamLeaveOffice.mockResolvedValue({ success: false, error: 'DESKTOP_ONLY' })

    await useTeamStore.getState().withdrawMember('t', 'x')

    expect(toasts()).toEqual([{
      title: 'Could not remove name-x from the team',
      body: 'Taking a digital human out of a team is only available in the desktop app.',
    }])
  })
})
