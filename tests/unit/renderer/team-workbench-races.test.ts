import { afterEach, expect, it, vi } from 'vitest'
const env = vi.hoisted(() => ({ runner: null as any, api: {} as Record<string, any>, live: { isGenerating: false, thoughts: [] }, entries: new Set<(data: any) => void>(), responses: new Set<(data: any) => void>(), histories: new Set<(data: any) => void>() }))
vi.mock('react', () => ({
  useState: (initial: any) => env.runner.state(initial), useRef: (initial: any) => env.runner.ref(initial),
  useMemo: (compute: any, deps: any[]) => env.runner.memo(compute, deps),
  useEffect: (effect: any, deps: any[]) => env.runner.effect(effect, deps),
}))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (s: string) => s } }))
vi.mock('../../../src/renderer/hooks/useRemoteSubscription', () => ({ useRemoteSubscription: () => {} }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: (select: any) => select({ getSession: () => env.live }) }))
vi.mock('../../../src/renderer/stores/team.store', async importOriginal => {
  const original = await importOriginal<typeof import('../../../src/renderer/stores/team.store')>()
  return { ...original, useTeamStore: Object.assign((select: any) => select(original.useTeamStore.getState()), original.useTeamStore) }
})
import { useTaskBoard } from '../../../src/renderer/components/team/workbench/useTaskBoard'
import { useTaskReports } from '../../../src/renderer/components/team/workbench/useTaskReports'
import { useTaskDecisions } from '../../../src/renderer/components/team/workbench/useTaskDecisions'
import { useExecutionState } from '../../../src/renderer/components/team/workbench/useExecutionState'
import { useTeamStore } from '../../../src/renderer/stores/team.store'
import { invalidateTeamSessionHistory, loadTeamSessionHistory, retainTeamSessionHistory } from '../../../src/renderer/components/team/session-history'

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
function listen(set: Set<any>) { return (callback: any) => { set.add(callback); return () => set.delete(callback) } }
function prepare() {
  env.api.onAppActivityEntry = listen(env.entries); env.api.onAppEscalationResolved = listen(env.responses); env.api.onTeamMemberHistory = listen(env.histories)
  env.api.teamChatMessages = vi.fn().mockResolvedValue({ success: true, data: [] })
}
afterEach(() => { runners.splice(0).forEach(runner => runner.close()); env.entries.clear(); env.responses.clear(); env.histories.clear(); env.live = { isGenerating: false, thoughts: [] }; vi.useRealTimers() })

it('replays invalidation during an in-flight history request before resolving all readers', async () => {
  prepare()
  const old = deferred<any>(); const fresh = deferred<any>()
  env.api.teamChatMessages.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  const release = retainTeamSessionHistory('a', 's', 't', 'e')
  const first = loadTeamSessionHistory('a', 's', 't', 'e'); const second = loadTeamSessionHistory('a', 's', 't', 'e')
  await Promise.resolve()
  invalidateTeamSessionHistory('a', 's', 't', 'e'); invalidateTeamSessionHistory('a', 's', 't', 'e')
  const third = loadTeamSessionHistory('a', 's', 't', 'e')
  old.resolve({ success: true, data: [{ id: 'old', seq: 1 }] })
  for (let i = 0; i < 4; i++) await Promise.resolve()
  expect(env.api.teamChatMessages).toHaveBeenCalledTimes(2)
  fresh.resolve({ success: true, data: [{ id: 'old', seq: 1 }, { id: 'final', seq: 2 }] })
  for (const result of await Promise.all([first, second, third])) expect(result.data).toHaveLength(2)
  release()
})
it('live execution start and end win over an older snapshot, including a late response', async () => {
  prepare(); vi.useFakeTimers(); vi.setSystemTime(1000)
  const old = deferred<any>()
  env.api.appChatSessionState = vi.fn().mockReturnValueOnce(old.promise)
  const runner = mount(() => useExecutionState('t', 'e', 'a', false))
  vi.setSystemTime(1001); env.live = { isGenerating: true, thoughts: [] }; runner.render()
  old.resolve({ success: true, data: { isActive: false, thoughts: [] } }); await runner.settle()
  expect(runner.result.active).toBe(true)
  vi.setSystemTime(1002); env.live = { isGenerating: false, thoughts: [] }; runner.render()
  expect(runner.result.active).toBe(false)
})
it('a closed decision stays closed after a delayed initial page and ignores foreign responses', async () => {
  prepare(); const page = deferred<any>(); env.api.appGetActivity = vi.fn().mockReturnValue(page.promise)
  const runner = mount(() => useTaskDecisions('t', 'e', ['a']))
  const entry = { id: 'd', appId: 'a', type: 'escalation', content: { summary: 'Confirm', teamContext: { teamId: 't', epochId: 'e' } } }
  for (const listener of env.entries) listener({ entry: { ...entry, content: { ...entry.content, resolution: { reason: 'task_closed', ts: 10 } } } })
  runner.render()
  for (const listener of env.responses) listener({ appId: 'a', teamId: 'other', epochId: 'e', entryId: 'd', response: { choice: 'Wrong', ts: 11 } })
  page.resolve({ success: true, data: [entry] }); await runner.settle()
  expect(runner.result.entries[0].content.resolution?.reason).toBe('task_closed')
  expect(runner.result.entries[0].userResponse).toBeUndefined()
})
it('retains task A live records when a later detail response contains task B', async () => {
  prepare()
  let detail: any = { team: { id: 't' }, activities: [], tasks: [], findings: [] }
  env.api.teamEpochBoard = vi.fn().mockResolvedValue({ success: true, data: { epoch: { id: 'a' }, activities: [], tasks: [], findings: [], members: [] } })
  const snapshot = deferred<any>()
  env.api.teamEpochBoard.mockReturnValueOnce(snapshot.promise)
  const runner = mount(() => useTaskBoard(detail, 'a')); await runner.settle()
  detail = { ...detail, activities: [{ id: 'a1', epochId: 'a' }], tasks: [{ id: 'task-a', epochId: 'a', updatedAt: 2, status: 'done' }], findings: [{ id: 'output-a', epochId: 'a' }] }; runner.render()
  detail = { ...detail, activities: [{ id: 'b1', epochId: 'b' }], tasks: [{ id: 'task-b', epochId: 'b' }], findings: [] }; runner.render()
  snapshot.resolve({ success: true, data: { epoch: { id: 'a' }, activities: [], tasks: [{ id: 'task-a', epochId: 'a', updatedAt: 1, status: 'pending' }], findings: [], members: [] } }); await runner.settle()
  expect(runner.result.activities.map(row => row.id)).toEqual(['a1'])
  expect(runner.result.board?.tasks[0].status).toBe('done')
  expect(runner.result.board?.findings[0].id).toBe('output-a')
})
it('a successful team update with the activity drawer mounted stays within three IPCs', async () => {
  prepare()
  const detail: any = { team: { id: 't', name: 'Team' }, members: [], roster: [{ appId: 'a', memberName: 'A', spaceId: 's' }], activities: [], tasks: [], findings: [] }
  env.api.teamEpochBoard = vi.fn().mockResolvedValue({ success: true, data: { epoch: { id: 'e' }, activities: [], tasks: [], findings: [], members: [] } })
  env.api.teamGetDetail = vi.fn().mockResolvedValue({ success: true, data: detail })
  env.api.teamListEpochs = vi.fn().mockResolvedValue({ success: true, data: [] })
  env.api.teamListConversations = vi.fn().mockResolvedValue({ success: true, data: [{ epochId: 'e', lastActivityAt: 999 }] })
  useTeamStore.setState({ currentTeamId: 't', detail })
  const runner = mount(() => { const current = useTeamStore.getState().detail!; return { board: useTaskBoard(current, 'e'), reports: useTaskReports('t', 'e', current.roster, 0) } })
  await runner.settle()
  expect(env.api.teamEpochBoard).toHaveBeenCalledTimes(1)
  expect(env.api.teamChatMessages).toHaveBeenCalledTimes(1)
  expect(runner.result.board.board).not.toBeNull()
  env.api.teamEpochBoard.mockClear(); env.api.teamChatMessages.mockClear()
  useTeamStore.getState().applyTeamUpdated({ teamId: 't' }); await runner.settle(); runner.render(); await runner.settle()
  expect(env.api.teamGetDetail).toHaveBeenCalledTimes(1)
  expect(env.api.teamListEpochs).toHaveBeenCalledTimes(1)
  expect(env.api.teamListConversations).toHaveBeenCalledTimes(1)
  expect(env.api.teamEpochBoard).not.toHaveBeenCalled()
  expect(env.api.teamChatMessages).not.toHaveBeenCalled()
})

it('live stop is not hidden by an earlier active snapshot', async () => {
  prepare(); vi.useFakeTimers(); vi.setSystemTime(2000)
  env.api.appChatSessionState = vi.fn().mockResolvedValue({ success: true, data: { isActive: true, thoughts: [] } })
  const runner = mount(() => useExecutionState('t', 'e', 'a', false)); await runner.settle()
  expect(runner.result.active).toBe(true)
  vi.setSystemTime(2001); env.live = { isGenerating: true, thoughts: [] }; runner.render()
  vi.setSystemTime(2002); env.live = { isGenerating: false, thoughts: [] }; runner.render()
  expect(runner.result.active).toBe(false)
})
it('accepts a detail without optional activities without a render loop', async () => {
  prepare()
  const detail: any = { team: { id: 't' }, tasks: [], findings: [] }
  env.api.teamEpochBoard = vi.fn().mockResolvedValue({ success: true, data: { epoch: { id: 'e' }, tasks: [], findings: [], members: [] } })
  const runner = mount(() => useTaskBoard(detail, 'e')); await runner.settle()
  expect(runner.result.activities).toEqual([])
  expect(env.api.teamEpochBoard).toHaveBeenCalledTimes(1)
})
