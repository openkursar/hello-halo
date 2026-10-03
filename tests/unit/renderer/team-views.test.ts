import { describe, it, expect, vi, beforeEach } from 'vitest'

const env = vi.hoisted(() => ({
  teamGetDetail: vi.fn(),
  teamListEpochs: vi.fn(),
  teamListConversations: vi.fn(),
  teamOpenConversation: vi.fn(),
  teamSaveCollab: vi.fn(),
  teamList: vi.fn(),
}))

vi.mock('../../../src/renderer/api', () => ({
  api: new Proxy(
    {
      teamGetDetail: env.teamGetDetail,
      teamListEpochs: env.teamListEpochs,
      teamListConversations: env.teamListConversations,
      teamOpenConversation: env.teamOpenConversation,
      teamSaveCollab: env.teamSaveCollab,
      teamList: env.teamList,
    },
    { get: (target, key: string) => (key in target ? (target as Record<string, unknown>)[key] : vi.fn()) }
  ),
}))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (s: string) => s } }))

const { useTeamStore, teamViewOf, isRemoteMemberAppId } = await import('../../../src/renderer/stores/team.store')
const { useTeamViewPrefsStore } = await import('../../../src/renderer/stores/team-view-prefs.store')

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

  it('starting a task in a canvas tab leaves the Teams page selection and its remembered task alone', async () => {
    useTeamStore.getState().selectTeam('A')
    useTeamStore.setState({ selectedConversationId: 'a1' })
    useTeamViewPrefsStore.getState().setLastTask('A', 'a1')
    const release = useTeamStore.getState().retainTeamView('B')
    await flush()
    env.teamOpenConversation.mockResolvedValueOnce({ success: true, data: { epochId: 'b2' } })

    expect(await useTeamStore.getState().openConversation('B')).toBe('b2')
    expect(useTeamStore.getState().selectedConversationId).toBe('a1')
    expect(useTeamViewPrefsStore.getState().taskByTeam.A).toBe('a1')
    release()
  })

  it('starting a task on the Teams page selects it there', async () => {
    useTeamStore.getState().selectTeam('A')
    await flush()
    env.teamOpenConversation.mockResolvedValueOnce({ success: true, data: { epochId: 'a1' } })

    await useTeamStore.getState().openConversation('A')
    expect(useTeamStore.getState().selectedConversationId).toBe('a1')
  })

  it('keeping a collaboration shown in a canvas tab reselects its room there', async () => {
    env.teamListConversations.mockImplementation(async (id: string) => ({
      success: true,
      data: id === 'C' ? [{ epochId: 'room', kind: 'collab' }] : [],
    }))
    env.teamSaveCollab.mockResolvedValueOnce({ success: true })
    env.teamList.mockResolvedValue({ success: true, data: [] })
    useTeamStore.getState().selectTeam('A')
    const release = useTeamStore.getState().retainTeamView('C')
    await flush()
    useTeamStore.getState().selectViewConversation('C', null)
    env.teamGetDetail.mockClear()

    expect(await useTeamStore.getState().saveCollab('C')).toBe(true)
    expect(env.teamGetDetail).toHaveBeenCalledWith('C')
    expect(useTeamStore.getState().views.C.selectedConversationId).toBe('room')
    expect(useTeamStore.getState().selectedConversationId).not.toBe('room')
    release()
  })

  it('resolves a remote member from whichever surface shows its team', async () => {
    const remoteDetail = {
      ...detail('B'),
      members: [{ appId: 'm1', origin: 'remote', ownerNodeId: 'node-2' }],
    }
    env.teamGetDetail.mockImplementation(async (id: string) => ({ success: true, data: id === 'B' ? remoteDetail : detail(id) }))
    useTeamStore.getState().selectTeam('A')
    const release = useTeamStore.getState().retainTeamView('B')
    await flush()

    expect(isRemoteMemberAppId('B', 'm1')).toBe(true)
    expect(isRemoteMemberAppId('A', 'm1')).toBe(false)
    release()
  })
})
