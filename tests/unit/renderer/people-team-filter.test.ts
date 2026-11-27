import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ teamList: vi.fn(), teamDissolve: vi.fn(), teamLeaveOffice: vi.fn() }))
vi.mock('../../../src/renderer/api', () => ({ api }))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (s: string) => s } }))
vi.mock('../../../src/renderer/services/request-update-check', () => ({ requestUpdateCheck: vi.fn() }))

import { usePeopleViewStore } from '../../../src/renderer/stores/people-view.store'
import { useTeamStore } from '../../../src/renderer/stores/team.store'

describe('the persisted People team filter', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    usePeopleViewStore.getState().setFilters({ team: 'selected', query: 'report', space: 'project', tag: 'research', page: 3 })
  })

  it.each(['dissolve', 'leave', 'removed event', 'directory load'])('drops only the missing team and resets the page on %s', async action => {
    const store = useTeamStore.getState()
    if (action === 'dissolve') {
      api.teamDissolve.mockResolvedValue({ success: true })
      await store.dissolveTeam('selected')
    } else if (action === 'leave') {
      api.teamLeaveOffice.mockResolvedValue({ success: true })
      await store.leaveOffice('selected')
    } else if (action === 'removed event') {
      store.applyTeamUpdated({ teamId: 'selected', removed: true })
    } else {
      api.teamList.mockResolvedValue({ success: true, data: [{ id: 'another' }] })
      await store.loadTeams()
    }
    expect(usePeopleViewStore.getState()).toMatchObject({ team: '', query: 'report', space: 'project', tag: 'research', page: 1 })
  })

  it('does not clear a team selected after a list request started', async () => {
    let finish!: (result: unknown) => void
    api.teamList.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const pending = useTeamStore.getState().loadTeams()
    usePeopleViewStore.getState().setFilters({ team: 'new-team' })
    finish({ success: true, data: [] })
    await pending
    expect(usePeopleViewStore.getState().team).toBe('new-team')
  })

  it('keeps the filter for a different removal, an existing team, a partial list or a failed read', async () => {
    const store = useTeamStore.getState()
    store.applyTeamUpdated({ teamId: 'another', removed: true })
    api.teamList.mockResolvedValueOnce({ success: true, data: [{ id: 'selected' }] })
      .mockResolvedValueOnce({ success: true, data: [] }).mockResolvedValueOnce({ success: false })
    await store.loadTeams()
    await store.loadTeams('another-workspace')
    await store.loadTeams()
    expect(usePeopleViewStore.getState()).toMatchObject({ team: 'selected', page: 3 })
  })
})
