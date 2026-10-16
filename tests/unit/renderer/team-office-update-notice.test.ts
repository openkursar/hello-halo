/**
 * The sticky "needs an update" / "waiting on X to update" notice for an office
 * says it clears by itself once everyone matches. Main reports that moment as
 * the office being 'resumed' (admitted again after the refusal), and the notice
 * must go then — not linger over a team that works again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/renderer/api', () => ({
  api: new Proxy({}, { get: () => vi.fn() }),
}))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (s: string) => s } }))
vi.mock('../../../src/renderer/services/request-update-check', () => ({ requestUpdateCheck: vi.fn() }))

const { useTeamStore } = await import('../../../src/renderer/stores/team.store')
const { useNotificationStore } = await import('../../../src/renderer/stores/notification.store')

const noticeIds = () => useNotificationStore.getState().toasts.map((t) => t.id)

describe('office update notice', () => {
  beforeEach(() => {
    useNotificationStore.getState().clear()
    useTeamStore.setState({ teams: [{ id: 't', name: 'Office' }] as never, officeLiveness: new Map() })
  })

  it.each([
    ['this machine is behind', { direction: 'self' as const }],
    ['a teammate is behind', { direction: 'peer' as const, peerName: 'Alice' }],
  ])('is retired when the office is admitted again (%s)', (_label, versionMismatch) => {
    useTeamStore.getState().applyTeamOfficeStatus({ teamId: 't', kind: 'update-required', versionMismatch })
    expect(noticeIds()).toEqual(['team-update-required-t'])

    useTeamStore.getState().applyTeamOfficeStatus({ teamId: 't', kind: 'resumed' })

    expect(noticeIds()).toEqual([])
  })

  it('stays for another office, and a resume with nothing to retire shows nothing', () => {
    useTeamStore.getState().applyTeamOfficeStatus({ teamId: 't', kind: 'update-required', versionMismatch: { direction: 'peer', peerName: null } })

    useTeamStore.getState().applyTeamOfficeStatus({ teamId: 'other', kind: 'resumed' })

    expect(noticeIds()).toEqual(['team-update-required-t'])
  })
})
