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

const { useTeamStore, memberById } = await import('../../../src/renderer/stores/team.store')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function detail(boardEpochId: string | null, extra: Record<string, unknown> = {}) {
  return {
    team: { id: 't', name: 'Team' },
    members: [],
    edges: [],
    roster: [],
    tasks: [],
    findings: [],
    activities: [],
    boardEpochId,
    ...extra,
  }
}

function activity(id: string, epochId: string) {
  return { id, teamId: 't', epochId, kind: 'message', actorAppId: 'a', targetAppId: null, subject: id, body: null, refId: null, correlationId: null, status: null, createdAt: 1 }
}

describe('team board reloads', () => {
  beforeEach(() => {
    env.teamGetDetail.mockReset().mockResolvedValue({ success: true, data: detail('e1') })
    env.teamListEpochs.mockReset().mockResolvedValue({ success: true, data: [] })
    env.teamListConversations.mockReset().mockResolvedValue({ success: true, data: [] })
    useTeamStore.setState({ currentTeamId: 't', detail: detail('e1') as never })
  })

  it('a burst of team:updated events costs one fetch per surface plus one trailing rerun', async () => {
    const gate = deferred<unknown>()
    env.teamGetDetail.mockReturnValueOnce(gate.promise)
    for (let i = 0; i < 50; i++) useTeamStore.getState().applyTeamUpdated({ teamId: 't' })
    expect(env.teamGetDetail).toHaveBeenCalledTimes(1)
    gate.resolve({ success: true, data: detail('e1') })
    await useTeamStore.getState().loadDetail('t')
    expect(env.teamGetDetail).toHaveBeenCalledTimes(2)
    expect(env.teamListEpochs.mock.calls.length).toBeLessThanOrEqual(2)
    expect(env.teamListConversations.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('a caller awaiting a reload that joined an in-flight request sees a fetch started after its call', async () => {
    const first = deferred<unknown>()
    env.teamGetDetail
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ success: true, data: detail('e1', { tasks: [{ id: 'after' }] }) })
    void useTeamStore.getState().loadDetail('t')
    const awaited = useTeamStore.getState().loadDetail('t')
    first.resolve({ success: true, data: detail('e1') })
    await awaited
    expect(useTeamStore.getState().detail?.tasks.map((task) => task.id)).toEqual(['after'])
  })

  it('merges a board row of the shown epoch without any fetch', () => {
    useTeamStore.getState().applyTeamBlackboard({ teamId: 't', epochId: 'e1', kind: 'activity', activity: activity('a1', 'e1') as never })
    expect(useTeamStore.getState().detail?.activities?.map((a) => a.id)).toEqual(['a1'])
    expect(env.teamGetDetail).not.toHaveBeenCalled()
    expect(env.teamListConversations).not.toHaveBeenCalled()
  })

  it('merges a row of another epoch live, so that epoch’s task room updates without a fetch', () => {
    useTeamStore.getState().applyTeamBlackboard({ teamId: 't', epochId: 'e2', kind: 'activity', activity: activity('a2', 'e2') as never })
    expect(useTeamStore.getState().detail?.activities?.map((a) => a.id)).toEqual(['a2'])
    expect(env.teamGetDetail).not.toHaveBeenCalled()
  })

  it('merges into a canvas team view too, for any epoch', () => {
    useTeamStore.setState({ currentTeamId: null, detail: null, views: { t: { detail: detail('e1'), epochs: [], conversations: [], conversationsError: null, isLoadingDetail: false, isLoadingConversations: false, selectedConversationId: null, error: null } as never } })
    useTeamStore.getState().applyTeamBlackboard({ teamId: 't', epochId: 'e3', kind: 'activity', activity: activity('a3', 'e3') as never })
    expect(useTeamStore.getState().views.t.detail?.activities?.map((a) => a.id)).toEqual(['a3'])
    expect(env.teamGetDetail).not.toHaveBeenCalled()
    useTeamStore.setState({ views: {} })
  })

  it('a board that shows no epoch yet merges the row and asks which epoch to show', () => {
    useTeamStore.setState({ detail: detail(null) as never })
    useTeamStore.getState().applyTeamBlackboard({ teamId: 't', epochId: 'e2', kind: 'activity', activity: activity('a2', 'e2') as never })
    expect(useTeamStore.getState().detail?.activities?.map((a) => a.id)).toEqual(['a2'])
    expect(env.teamGetDetail).toHaveBeenCalledTimes(1)
  })

  it('refreshes the task list once for a burst of task rows', () => {
    for (let i = 0; i < 10; i++) {
      useTeamStore.getState().applyTeamBlackboard({
        teamId: 't', epochId: 'e1', kind: 'task',
        task: { id: `k${i}`, teamId: 't', epochId: 'e1', title: 'x', assigneeAppId: null, status: 'pending', resultRef: null, note: null, parentId: null, createdByAppId: 'a', createdAt: 0, updatedAt: 0 } as never,
      })
    }
    expect(useTeamStore.getState().detail?.tasks).toHaveLength(10)
    expect(env.teamListConversations).toHaveBeenCalledTimes(1)
  })

  it('reloads only what a team:updated says changed', async () => {
    useTeamStore.getState().applyTeamUpdated({ teamId: 't', changed: ['members'] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(env.teamGetDetail).toHaveBeenCalledTimes(1)
    expect(env.teamListEpochs).not.toHaveBeenCalled()
    expect(env.teamListConversations).not.toHaveBeenCalled()

    useTeamStore.getState().applyTeamUpdated({ teamId: 't', changed: ['conversations'] })
    expect(env.teamListConversations).toHaveBeenCalledTimes(1)
    expect(env.teamListEpochs).not.toHaveBeenCalled()
    expect(env.teamGetDetail).toHaveBeenCalledTimes(1)

    useTeamStore.getState().applyTeamUpdated({ teamId: 't', changed: ['status'] })
    expect(env.teamGetDetail).toHaveBeenCalledTimes(1)
    expect(env.teamListEpochs).not.toHaveBeenCalled()
  })

  it('indexes members once per detail', () => {
    const members = [{ appId: 'a', memberName: 'A' }, { appId: 'b', memberName: 'B' }]
    const d = detail('e1', { members }) as never
    expect(memberById(d, 'b')?.memberName).toBe('B')
    expect(memberById(d, 'z')).toBeUndefined()
    expect(memberById(null, 'a')).toBeUndefined()
  })
})
