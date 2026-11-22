import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeamUpdatedEvent } from '../../../src/shared/apps/team-types'

const env = vi.hoisted(() => ({ runner: null as any, api: {} as Record<string, any>, pinned: {} as Record<string, string[]>, hidden: {} as Record<string, Record<string, { waiting: boolean }>>, reconcile: vi.fn(), listeners: new Set<(event: TeamUpdatedEvent) => void>() }))
vi.mock('react', () => ({
  useState: (initial: any) => env.runner.state(initial),
  useRef: (initial: any) => env.runner.ref(initial),
  useMemo: (compute: any, deps: any[]) => env.runner.memo(compute, deps),
  useEffect: (effect: any, deps: any[]) => env.runner.effect(effect, deps),
}))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/stores/team-chat-pins.store', () => ({
  teamTaskKey: (team: string, epoch: string) => `team:${team}:${epoch}`,
  useTeamChatPinsStore: Object.assign((select: any) => select({ pinned: env.pinned }), { getState: () => ({ pinned: env.pinned }) }),
}))
vi.mock('../../../src/renderer/stores/team-chat-hidden.store', () => ({
  useTeamChatHiddenStore: Object.assign((select: any) => select({ hidden: env.hidden, reconcile: env.reconcile }), { getState: () => ({ hidden: env.hidden }) }),
}))
import { buildTeamRows, teamAvatarFaces, useTeamConversationRows, type NativeTeamTask } from '../../../src/renderer/hooks/useTeamConversationRows'

class HookRunner<T> {
  slots: any[] = []; index = 0; dirty = true; effects: (() => void)[] = []; result!: T
  constructor(private hook: () => T) {}
  state(initial: any) { const index = this.index++; this.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [this.slots[index].value, (update: any) => { const value = typeof update === 'function' ? update(this.slots[index].value) : update; if (!Object.is(value, this.slots[index].value)) { this.slots[index].value = value; this.dirty = true } }] }
  ref(initial: any) { const index = this.index++; return this.slots[index] ??= { current: initial } }
  changed(index: number, deps: any[]) { return !this.slots[index] || deps.some((item, i) => !Object.is(item, this.slots[index].deps[i])) }
  memo(compute: any, deps: any[]) { const index = this.index++; if (this.changed(index, deps)) this.slots[index] = { deps, value: compute() }; return this.slots[index].value }
  effect(effect: any, deps: any[]) { const index = this.index++; if (this.changed(index, deps)) { const previous = this.slots[index]; this.slots[index] = { deps }; this.effects.push(() => { previous?.cleanup?.(); this.slots[index].cleanup = effect() }) } }
  render() { let count = 0; do { if (++count > 30) throw new Error('Render loop'); this.dirty = false; this.index = 0; env.runner = this; this.result = this.hook(); this.effects.splice(0).forEach(effect => effect()) } while (this.dirty); return this.result }
  async settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); if (this.dirty) this.render() } return this.result }
  close() { this.slots.forEach(slot => slot?.cleanup?.()) }
}
const runners: HookRunner<any>[] = []
function mount<T>(hook: () => T) { const runner = new HookRunner(hook); runners.push(runner); runner.render(); return runner }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function task(epochId: string, teamId = 't', spaceId = 's'): NativeTeamTask {
  return { epochId, teamId, spaceId, teamName: `Team ${teamId}`, kind: 'native', label: epochId, readonly: false, startedAt: 1, lastActivityAt: 1 }
}
const page = (items: NativeTeamTask[], nextCursor: string | null = null) => ({ success: true, data: { items, nextCursor } })
const emit = () => env.listeners.forEach(listener => listener({ teamId: 't', changed: ['epochs'] }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  env.pinned = {}
  env.hidden = {}
  env.reconcile = vi.fn()
  env.api.teamList = vi.fn().mockResolvedValue({ success: true, data: [] })
  env.api.teamListNativeTasks = vi.fn().mockResolvedValue(page([]))
  env.api.onTeamUpdated = vi.fn((listener: (event: TeamUpdatedEvent) => void) => { env.listeners.add(listener); return () => env.listeners.delete(listener) })
  for (const name of ['teamChatMessages', 'teamListConversations', 'teamListEpochs', 'teamGetDetail']) env.api[name] = vi.fn()
})
afterEach(() => {
  runners.splice(0).forEach(runner => runner.close())
  env.listeners.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('team conversation metadata', () => {
  it('preserves avatar members on status updates and refreshes them once for a membership burst', async () => {
    const members = [{ appId: 'lead', memberName: 'Lead', isLead: true }]
    env.api.teamList.mockResolvedValue({ success: true, data: [{ id: 't', name: 'Crew', roster: members }] })
    const runner = mount(() => useTeamConversationRows('s')); await runner.settle()
    env.listeners.forEach(listener => listener({ teamId: 't', team: { id: 't', name: 'Renamed', owningSpaceId: 's' } as any, changed: ['status'] }))
    await runner.settle()
    expect(runner.result.teams[0].roster).toEqual(members)
    const updated = [...members, { appId: 'writer', memberName: 'Writer', isLead: false }]
    env.api.teamList.mockResolvedValue({ success: true, data: [{ id: 't', name: 'Renamed', roster: updated }] })
    for (let i = 0; i < 10; i++) env.listeners.forEach(listener => listener({ teamId: 't', changed: ['members'] }))
    await vi.advanceTimersByTimeAsync(250); await runner.settle()
    expect(env.api.teamList).toHaveBeenCalledTimes(2)
    expect(runner.result.teams[0].roster).toEqual(updated)
    expect(env.api.teamGetDetail).not.toHaveBeenCalled()
  })
  it('resolves persisted pins beyond the first page in batches of 100 and keeps them on refresh', async () => {
    const pins = Array.from({ length: 205 }, (_, i) => task(`old-${i}`))
    env.pinned.s = pins.map(item => `team:t:${item.epochId}`)
    let recent = task('newest')
    env.api.teamListNativeTasks.mockImplementation(async (options: { epochIds?: string[] }) => options.epochIds
      ? page(pins.filter(item => options.epochIds!.includes(item.epochId)))
      : page([recent], 'older'))
    const runner = mount(() => useTeamConversationRows('s')); await runner.settle()
    expect(env.api.teamListNativeTasks.mock.calls.map(([options]: any) => options.limit)).toEqual([50, 100, 100, 100])
    expect(env.api.teamListNativeTasks.mock.calls.slice(1).map(([options]: any) => options.epochIds.length)).toEqual([100, 100, 5])
    expect(env.api.teamListNativeTasks.mock.calls.slice(1).flatMap(([options]: any) => options.epochIds)).toEqual(pins.map(item => item.epochId))
    expect(runner.result.tasks).toHaveLength(206)
    recent = task('newer')
    runner.result.refresh(); await vi.advanceTimersByTimeAsync(250); await runner.settle()
    expect(runner.result.tasks.map(item => item.epochId)).toEqual([...pins.map(item => item.epochId), 'newer'])
    const grouped = buildTeamRows(runner.result.tasks, [], runner.result.pins, () => true)
    expect(grouped.pinned).toHaveLength(205)
    expect(grouped.rows.filter(row => row.type === 'team-item').map(row => row.key)).toEqual(['team:t:newer'])
    expect(env.api.teamListNativeTasks).toHaveBeenCalledTimes(8)
  })

  it('retains newest tasks when loading more than 500 records and merges overlapping pages by identity', async () => {
    env.api.teamListNativeTasks.mockImplementation(async ({ cursor, limit }: { cursor?: string; limit: number }) => {
      const start = Number(cursor ?? 0)
      return page(Array.from({ length: limit }, (_, i) => task(`e-${start + i}`)), start < 539 ? String(start + 49) : null)
    })
    const runner = mount(() => useTeamConversationRows('s')); await runner.settle()
    for (let i = 0; i < 11; i++) { runner.result.loadMore(); await runner.settle() }
    expect(runner.result.tasks.map(item => item.epochId)).toEqual(Array.from({ length: 589 }, (_, i) => `e-${i}`))
    expect(runner.result.cursor).toBeNull()
    expect(env.api.teamListNativeTasks.mock.calls.map(([options]: any) => options)).toEqual(Array.from({ length: 12 }, (_, i) => ({ spaceId: 's', limit: 50, scope: 'mine', ...(i ? { cursor: String(i * 49) } : {}) })))
    runner.result.loadMore()
    expect(env.api.teamListNativeTasks).toHaveBeenCalledTimes(12)
  })

  it('coalesces event bursts at 250ms and performs only one trailing refresh during an in-flight page', async () => {
    const pending = deferred<ReturnType<typeof page>>()
    env.api.teamListNativeTasks.mockReturnValueOnce(pending.promise)
    const runner = mount(() => useTeamConversationRows('s'))
    for (let i = 0; i < 20; i++) emit()
    await vi.advanceTimersByTimeAsync(249)
    expect(env.api.teamListNativeTasks).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(env.api.teamListNativeTasks).toHaveBeenCalledTimes(1)
    pending.resolve(page([task('initial')])); await runner.settle()
    await vi.advanceTimersByTimeAsync(249)
    expect(env.api.teamListNativeTasks).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); await runner.settle()
    expect(env.api.teamListNativeTasks).toHaveBeenCalledTimes(2)
    for (let i = 0; i < 20; i++) emit()
    await vi.advanceTimersByTimeAsync(249)
    expect(env.api.teamListNativeTasks).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1); await runner.settle()
    expect(env.api.teamListNativeTasks).toHaveBeenCalledTimes(3)
    expect(env.api.teamList).toHaveBeenCalledTimes(1)
    for (const name of ['teamChatMessages', 'teamListConversations', 'teamListEpochs', 'teamGetDetail']) expect(env.api[name]).not.toHaveBeenCalled()
  })

  it.each(['page', 'pins'])('ignores late %s and summary responses after switching spaces', async stage => {
    const stale = deferred<ReturnType<typeof page>>()
    const summary = deferred<any>()
    env.pinned.a = ['team:t:old']
    env.api.teamList.mockImplementation((space: string) => space === 'a' ? summary.promise : Promise.resolve({ success: true, data: [{ id: 'b-team', name: 'B' }] }))
    env.api.teamListNativeTasks.mockImplementation((options: { spaceId: string; epochIds?: string[] }) => {
      if (options.spaceId === 'b') return Promise.resolve(page([task('b-task', 'b-team', 'b')]))
      return stage === 'page' || options.epochIds ? stale.promise : Promise.resolve(page([task('a-task', 't', 'a')]))
    })
    let space = 'a'
    const runner = mount(() => useTeamConversationRows(space)); await runner.settle()
    emit()
    space = 'b'; runner.render(); await runner.settle()
    expect(env.listeners.size).toBe(1)
    stale.resolve(page([task('old', 't', 'a')], 'stale-cursor'))
    summary.resolve({ success: true, data: [{ id: 'a-team', name: 'A' }] })
    await runner.settle(); await vi.advanceTimersByTimeAsync(1000); await runner.settle()
    expect(runner.result.tasks.map(item => item.epochId)).toEqual(['b-task'])
    expect(runner.result.teams.map(team => team.id)).toEqual(['b-team'])
    expect(runner.result).toMatchObject({ cursor: null, error: false, loading: false, pins: [] })
    expect(env.api.teamListNativeTasks.mock.calls.filter(([options]: any) => options.spaceId === 'b')).toHaveLength(1)
    expect(env.api.teamListNativeTasks.mock.calls.filter(([options]: any) => options.spaceId === 'a')).toHaveLength(stage === 'page' ? 1 : 2)
  })

  it('keeps a summary failure after task success and reloads summaries on retry', async () => {
    const pending = deferred<ReturnType<typeof page>>()
    env.api.teamList.mockResolvedValueOnce({ success: false, error: 'Unavailable' }).mockResolvedValueOnce({ success: true, data: [{ id: 't', name: 'Recovered' }] })
    env.api.teamListNativeTasks.mockReturnValueOnce(pending.promise)
    const runner = mount(() => useTeamConversationRows('s')); await runner.settle()
    expect(runner.result.error).toBe(true)
    pending.resolve(page([task('ready')])); await runner.settle()
    expect(runner.result.tasks).toHaveLength(1)
    expect(runner.result.error).toBe(true)
    runner.result.refresh(); await runner.settle()
    expect(env.api.teamList).toHaveBeenCalledTimes(2)
    expect(runner.result.teams[0].name).toBe('Recovered')
    await vi.advanceTimersByTimeAsync(250); await runner.settle()
    expect(env.api.teamListNativeTasks).toHaveBeenCalledTimes(2)
    expect(runner.result.error).toBe(false)
  })

  it('does not let a successful summary hide a task failure', async () => {
    const summary = deferred<any>()
    env.api.teamList.mockReturnValueOnce(summary.promise)
    env.api.teamListNativeTasks.mockResolvedValueOnce({ success: false, error: 'Task failure' })
    const runner = mount(() => useTeamConversationRows('s')); await runner.settle()
    expect(runner.result.error).toBe(true)
    summary.resolve({ success: true, data: [] }); await runner.settle()
    expect(runner.result.error).toBe(true)
    runner.result.refresh(); await vi.advanceTimersByTimeAsync(250); await runner.settle()
    expect(runner.result.error).toBe(false)
    expect(env.api.teamList).toHaveBeenCalledTimes(1)
  })

  it('deduplicates a pin returned by both exact lookup and the visible page', async () => {
    env.pinned.s = ['team:t:e']
    env.api.teamListNativeTasks.mockImplementation(async ({ epochIds }: { epochIds?: string[] }) => page([{ ...task('e'), label: epochIds ? 'Older snapshot' : 'Newest snapshot' }]))
    const runner = mount(() => useTeamConversationRows('s')); await runner.settle()
    expect(runner.result.tasks).toHaveLength(1)
    expect(runner.result.tasks[0].label).toBe('Newest snapshot')
    const grouped = buildTeamRows(runner.result.tasks, [], runner.result.pins, () => true)
    expect(grouped.pinned.map(row => row.key)).toEqual(['team:t:e'])
    expect(grouped.rows.map(row => row.key)).toEqual(['team:t'])
  })

  it('clears visible state and pending event refreshes when disabled, then reloads on re-enable', async () => {
    env.api.teamListNativeTasks.mockResolvedValue(page([task('e')], 'next'))
    let enabled = true
    const runner = mount(() => useTeamConversationRows('s', enabled)); await runner.settle()
    emit(); enabled = false; runner.render()
    expect(runner.result).toMatchObject({ tasks: [], teams: [], loading: false, error: false, cursor: null })
    expect(env.listeners.size).toBe(0)
    runner.result.refresh(); runner.result.loadMore()
    await vi.advanceTimersByTimeAsync(1000)
    expect(env.api.teamListNativeTasks).toHaveBeenCalledTimes(1)
    enabled = true; runner.render(); await runner.settle()
    expect(runner.result.tasks).toHaveLength(1)
    expect(env.api.teamListNativeTasks).toHaveBeenCalledTimes(2)
    expect(env.listeners.size).toBe(1)
  })
})

describe('buildTeamRows', () => {
  it('shows every member up to four, then four faces with the last veiled by a count, lead first and shared across grouped and pinned rows', () => {
    const roster = [
      { appId: 'writer', memberName: 'Writer', isLead: false },
      { appId: 'lead', memberName: 'Lead', isLead: true },
      { appId: 'analyst', memberName: 'Analyst', isLead: false },
      { appId: 'researcher', memberName: 'Researcher', isLead: false },
      { appId: 'reviewer', memberName: 'Reviewer', isLead: false },
    ]
    const teams = [{ id: 't', name: 'Crew', roster }]
    const result = buildTeamRows([task('pin'), task('chat')], teams, ['team:t:pin'], () => true)
    for (const row of [...result.rows, ...result.pinned]) {
      if (row.type === 'team-item') expect(row.avatar).toEqual({ names: ['Lead', 'Writer', 'Analyst', 'Researcher'], overflow: 2 })
    }
    expect(roster.map(member => member.appId)).toEqual(['writer', 'lead', 'analyst', 'researcher', 'reviewer'])
  })
  it.each([
    [1, { names: ['Lead'], overflow: 0 }],
    [2, { names: ['Lead', 'M1'], overflow: 0 }],
    [4, { names: ['Lead', 'M1', 'M2', 'M3'], overflow: 0 }],
    [5, { names: ['Lead', 'M1', 'M2', 'M3'], overflow: 2 }],
    [120, { names: ['Lead', 'M1', 'M2', 'M3'], overflow: 117 }],
  ])('sizes the overflow for a team of %i members', (total, expected) => {
    const roster = Array.from({ length: total }, (_, index) => ({ appId: `m${index}`, memberName: index === 0 ? 'Lead' : `M${index}`, isLead: index === 0 }))
    expect(teamAvatarFaces(roster)).toEqual(expected)
  })
  it('keeps stable group and task keys, empty teams, and pinned tasks outside collapsed groups', () => {
    const tasks = [task('b1', 'b'), task('a1', 'a'), task('a2', 'a'), task('orphan', 'c')]
    const teams = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'empty', name: 'Empty' }]
    const pins = ['team:a:a1', 'team:b:b1', 'team:a:a1']
    const grouped = buildTeamRows(tasks, teams, pins, id => id !== 'b')
    expect(grouped.rows.map(row => row.key)).toEqual(['team:a', 'team:a:a2', 'team:b', 'team:empty', 'team:c', 'team:c:orphan'])
    expect(grouped.pinned.map(row => row.key)).toEqual(['team:a:a1', 'team:b:b1'])
    expect(grouped.pinned.every(row => row.type === 'team-item' && row.starred && row.standalone)).toBe(true)
    expect(grouped.rows.filter(row => row.type === 'team-header').map(({ avatar, ...row }) => { expect(avatar).toEqual({ names: [], overflow: 0 }); return row })).toEqual([
      { type: 'team-header', key: 'team:a', teamId: 'a', name: 'Alpha', collapsed: false },
      { type: 'team-header', key: 'team:b', teamId: 'b', name: 'Beta', collapsed: true },
      { type: 'team-header', key: 'team:empty', teamId: 'empty', name: 'Empty', collapsed: false },
      { type: 'team-header', key: 'team:c', teamId: 'c', name: 'Team c', collapsed: false },
    ])
    expect(buildTeamRows(tasks.map(item => ({ ...item })), teams, pins, id => id !== 'b')).toEqual(grouped)
    const keys = [...grouped.rows, ...grouped.pinned].map(row => row.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(buildTeamRows(tasks, teams, pins, () => false).rows.every(row => row.type === 'team-header')).toBe(true)
  })
  it('skips removed tasks but keeps the empty group header', () => {
    const result = buildTeamRows([task('a'), task('b')], [{ id: 't', name: 'Crew' }], [], () => true, { 'team:t:a': { waiting: false } })
    expect(result.rows.map(row => row.key)).toEqual(['team:t', 'team:t:b'])
    expect(buildTeamRows([task('a')], [{ id: 't', name: 'Crew' }], [], () => true, { 'team:t:a': { waiting: false } }).rows.map(row => row.key)).toEqual(['team:t'])
  })
  it('hands the visible tasks waiting state to the hidden store', async () => {
    env.api.teamListNativeTasks.mockResolvedValue(page([{ ...task('a'), waitingForMe: true }, task('b')]))
    const runner = mount(() => useTeamConversationRows('s')); await runner.settle()
    expect(env.reconcile).toHaveBeenLastCalledWith('s', new Map([['team:t:a', true], ['team:t:b', false]]))
  })
})
