import { describe, it, expect, vi, beforeEach } from 'vitest'

const env = vi.hoisted(() => ({
  appList: vi.fn(),
  teamList: vi.fn(),
}))

vi.mock('../../../src/renderer/api', () => ({
  api: new Proxy({ appList: env.appList, teamList: env.teamList }, {
    get: (target, key: string) => (key in target ? (target as Record<string, unknown>)[key] : vi.fn()),
  }),
}))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (s: string) => s } }))

const { useAppsStore } = await import('../../../src/renderer/stores/apps.store')
const { useTeamStore } = await import('../../../src/renderer/stores/team.store')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('list loading shared between surfaces', () => {
  beforeEach(() => {
    env.appList.mockReset()
    env.teamList.mockReset()
  })

  it('asks the backend once for concurrent app-list loads of the same space, and again once they settle', async () => {
    const gate = deferred<unknown>()
    env.appList.mockReturnValue(gate.promise)

    const loads = [useAppsStore.getState().loadApps('s1'), useAppsStore.getState().loadApps('s1'), useAppsStore.getState().loadApps('s1')]
    expect(env.appList).toHaveBeenCalledTimes(1)
    gate.resolve({ success: true, data: [] })
    await Promise.all(loads)

    env.appList.mockResolvedValue({ success: true, data: [] })
    await useAppsStore.getState().loadApps('s1')
    expect(env.appList).toHaveBeenCalledTimes(2)
  })

  it('keeps loads of different spaces apart', async () => {
    env.appList.mockResolvedValue({ success: true, data: [] })
    await Promise.all([useAppsStore.getState().loadApps('s1'), useAppsStore.getState().loadApps('s2')])
    expect(env.appList).toHaveBeenCalledTimes(2)
  })

  it('does the same for the team list', async () => {
    const gate = deferred<unknown>()
    env.teamList.mockReturnValue(gate.promise)

    const loads = [useTeamStore.getState().loadTeams(), useTeamStore.getState().loadTeams()]
    expect(env.teamList).toHaveBeenCalledTimes(1)
    gate.resolve({ success: true, data: [] })
    await Promise.all(loads)
  })
})
