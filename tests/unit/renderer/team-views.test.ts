import { describe, it, expect, vi, beforeEach } from 'vitest'

const env = vi.hoisted(() => ({
  teamGetDetail: vi.fn(),
  teamListEpochs: vi.fn(),
  teamListConversations: vi.fn(),
}))

vi.mock('../../../src/renderer/api', () => ({
  api: new Proxy(
    { teamGetDetail: env.teamGetDetail, teamListEpochs: env.teamListEpochs, teamListConversations: env.teamListConversations },
    { get: (target, key: string) => (key in target ? (target as Record<string, unknown>)[key] : vi.fn()) }
  ),
}))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (s: string) => s } }))

const { useTeamStore, teamViewOf } = await import('../../../src/renderer/stores/team.store')

const detail = (id: string) => ({ team: { id, name: id }, members: [], edges: [], roster: [], tasks: [], findings: [], activities: [], boardEpochId: 'e' })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('two surfaces on two teams', () => {
  beforeEach(() => {
    env.teamGetDetail.mockReset().mockImplementation(async (id: string) => ({ success: true, data: detail(id) }))
    env.teamListEpochs.mockReset().mockResolvedValue({ success: true, data: [] })
    env.teamListConversations.mockReset().mockImplementation(async (id: string) => ({
      success: true,
      data: id === 'B' ? [{ epochId: 'b1' }, { epochId: 'b2' }] : [{ epochId: 'a1' }],
    }))
    useTeamStore.setState({ currentTeamId: null, detail: null, conversations: [], views: {} })
  })

  it('the Teams page on A and a canvas tab on B each show their own team, with no selection tug of war', async () => {
    useTeamStore.getState().selectTeam('A')
    const release = useTeamStore.getState().retainTeamView('B')
    await flush()

    const s = useTeamStore.getState()
    expect(s.currentTeamId).toBe('A')
    expect(s.detail?.team.id).toBe('A')
    expect(s.views.B.detail?.team.id).toBe('B')
    expect(s.views.B.conversations).toHaveLength(2)
    expect(s.conversations).toHaveLength(1)

    // Components read the team of the surface they are in.
    expect(teamViewOf(s, null).detail?.team.id).toBe('A')
    expect(teamViewOf(s, 'B').detail?.team.id).toBe('B')
    expect(teamViewOf(s, 'B').conversations).toHaveLength(2)

    // An update of B refreshes B's view only.
    env.teamListConversations.mockClear()
    useTeamStore.getState().applyTeamUpdated({ teamId: 'B', changed: ['conversations'] })
    await flush()
    expect(env.teamListConversations).toHaveBeenCalledWith('B')
    expect(env.teamListConversations).not.toHaveBeenCalledWith('A')

    expect(useTeamStore.getState().currentTeamId).toBe('A')
    release()
    expect(useTeamStore.getState().views).toEqual({})
  })

  it('a view is shared by its holders and dropped after the last one leaves', async () => {
    const r1 = useTeamStore.getState().retainTeamView('B')
    const r2 = useTeamStore.getState().retainTeamView('B')
    await flush()
    expect(env.teamGetDetail).toHaveBeenCalledTimes(1)
    r1()
    expect(useTeamStore.getState().views.B).toBeDefined()
    r2()
    expect(useTeamStore.getState().views.B).toBeUndefined()
  })

  it('selecting a task in a view leaves the Teams page selection alone', async () => {
    useTeamStore.getState().selectTeam('A')
    const release = useTeamStore.getState().retainTeamView('B')
    await flush()
    useTeamStore.getState().selectViewConversation('B', 'b2')
    expect(useTeamStore.getState().views.B.selectedConversationId).toBe('b2')
    expect(useTeamStore.getState().selectedConversationId).not.toBe('b2')
    release()
  })
})
