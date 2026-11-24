import { beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any, target: null as any, conversations: [] as any[], remembered: {} as any, board: {} as any, involved: vi.fn(), select: vi.fn(), remember: vi.fn(), openTeamTask: vi.fn() }))
vi.mock('react', () => ({
  useState: (initial: any) => env.runner.state(initial), useRef: (initial: any) => env.runner.ref(initial),
  useMemo: (compute: any) => compute(), useCallback: (callback: any) => callback,
  useEffect: (effect: any, deps: any[]) => env.runner.effect(effect, deps),
}))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/stores/team.store', () => ({
  TeamViewContext: { Provider: 'provider' },
  useTeamStore: { getState: () => ({ retainTeamView: () => () => {} }) },
  useTeamView: (select: any) => select({ detail, conversations: env.conversations }),
}))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: { getState: () => ({
  spaceStates: new Map([['space', { selectedTeamChat: env.target }]]), selectTeamConversation: env.select,
}) } }))
vi.mock('../../../src/renderer/stores/team-view-prefs.store', () => ({ useTeamViewPrefsStore: Object.assign(
  (select: any) => select({ memberByTask: { team: env.remembered } }),
  { getState: () => ({ rememberTaskMember: env.remember }) },
) }))
vi.mock('../../../src/renderer/components/team/workbench/TaskRoom', () => ({ TaskRoom: 'room' }))
vi.mock('../../../src/renderer/hooks/useCanvasLifecycle', () => ({ useCanvasActions: () => ({ openTeamTask: env.openTeamTask }) }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: (select: any) => select({ apps: [] }) }))
vi.mock('../../../src/renderer/components/team/workbench/useTaskBoard', () => ({ useTaskBoard: () => env.board }))
vi.mock('../../../src/renderer/components/team/workbench/members', () => ({
  detailForTask: (value: any) => value,
  ownedTaskMembers: (value: any) => value.roster,
  involvedOwnMember: (...args: any[]) => env.involved(...args),
}))
import { TeamConversationHost } from '../../../src/renderer/components/team/TeamConversationHost'

const detail = { team: { id: 'team', name: 'Crew', leadAppId: 'remote-lead' }, roster: [{ appId: 'owned' }, { appId: 'remote-lead', sameMachine: false }] }
class Runner {
  slots: any[] = []; index = 0; effects: (() => void)[] = []; dirty = false; result: any
  state(initial: any) { const i = this.index++; this.slots[i] ??= { value: initial }; return [this.slots[i].value, (value: any) => { this.slots[i].value = value; this.dirty = true }] }
  ref(initial: any) { const i = this.index++; return this.slots[i] ??= { current: initial } }
  effect(effect: any, deps: any[]) { const i = this.index++; const old = this.slots[i]; if (!old || deps.some((dep, n) => !Object.is(dep, old.deps[n]))) { const slot = { deps, cleanup: undefined as any }; this.slots[i] = slot; this.effects.push(() => { old?.cleanup?.(); slot.cleanup = effect() }) } }
  render(target = env.target, flush = true) {
    do {
      this.index = 0; this.dirty = false; env.runner = this
      const host = TeamConversationHost({ spaceId: 'space', target }) as any
      const view = host.props.children.type(host.props.children.props)
      this.result = view.type(view.props)
    } while (this.dirty)
    if (flush) this.flush()
    return this.room()
  }
  room() { return this.result.props.children.find((child: any) => child?.type === 'room') }
  flush() { this.effects.splice(0).forEach(effect => effect()) }
  close() { this.slots.forEach(slot => slot?.cleanup?.()) }
}
beforeEach(() => {
  env.target = { teamId: 'team', epochId: null, teamName: 'Crew', appId: 'remote-lead' }
  env.conversations = []; env.remembered = {}; env.board = {}; env.involved.mockReset(); env.remember.mockReset(); env.openTeamTask.mockReset()
  env.select.mockReset().mockImplementation((_space, next) => { env.target = next })
})
it('defaults to the real lead even when another member is owned', () => {
  env.target = { teamId: 'team', epochId: null, teamName: 'Crew' }
  const runner = new Runner()
  const room = runner.render()
  expect(room.props.selectedAppId).toBe('remote-lead')
  expect(room.props.homepageConversation).toBe(true)
  expect(env.target.appId).toBe('remote-lead')
  runner.close()
})
it('does not replace a newer selection from a stale metadata effect', () => {
  const runner = new Runner()
  const old = { ...env.target, teamName: 'Old name' }
  env.target = old; runner.render(old, false)
  env.target = { ...old, epochId: 'other' }
  runner.flush()
  expect(env.select).not.toHaveBeenCalled()
  runner.close()
})
it('promotes the first send without remounting the room, but remounts a different task', () => {
  const runner = new Runner(); const draft = runner.render()
  env.conversations = [{ epochId: 'created', label: 'First', kind: 'native' }, { epochId: 'other', kind: 'native' }]
  draft.props.onCreated('created')
  expect(env.target.epochId).toBe('created')
  expect(runner.render().key).toBe(draft.key)
  env.target = { ...env.target, epochId: 'other' }
  expect(runner.render().key).not.toBe(draft.key)
  runner.close()
})
it('does not replace another selected task when the first send finishes', () => {
  const runner = new Runner(); const draft = runner.render()
  env.target = { ...env.target, epochId: 'other' }
  draft.props.onCreated('created')
  expect(env.target.epochId).toBe('other')
  expect(env.select).not.toHaveBeenCalled()
  runner.close()
})
it('does not promote a reopened draft after the first-send host unmounts', () => {
  const runner = new Runner(); const draft = runner.render(); runner.close()
  env.target = { ...env.target }
  draft.props.onCreated('created')
  expect(env.select).not.toHaveBeenCalled()
})
it('does not promote after switching members away and back during creation', () => {
  const runner = new Runner(); const draft = runner.render()
  env.target = { ...env.target, appId: 'owned' }; runner.render()
  env.target = { ...env.target, appId: 'remote-lead' }; runner.render()
  draft.props.onCreated('created')
  expect(env.select).not.toHaveBeenCalled()
  runner.close()
})
it('requires an explicit choice when a remembered member is missing', () => {
  env.conversations = [{ epochId: 'task', kind: 'native' }]
  env.remembered = { task: 'removed' }
  env.target = { teamId: 'team', epochId: 'task', teamName: 'Crew' }
  const runner = new Runner()
  expect(runner.render().props.selectedAppId).toBeNull()
  runner.close()
})
it('opens someone else\'s task on my digital human that took part', () => {
  env.conversations = [{ epochId: 'task', kind: 'native', createdByMe: false, involvedMe: true }]
  env.board = { board: { tasks: [] }, activities: [{ actorAppId: 'owned' }] }
  env.involved.mockReturnValue('owned')
  env.target = { teamId: 'team', epochId: 'task', teamName: 'Crew' }
  const runner = new Runner()
  expect(runner.render().props.selectedAppId).toBe('owned')
  expect(env.involved).toHaveBeenCalledWith(detail.roster, env.board.activities, [])
  runner.close()
})
it('waits for the board before choosing a participant', () => {
  env.conversations = [{ epochId: 'task', kind: 'native', createdByMe: false, involvedMe: true }]
  env.target = { teamId: 'team', epochId: 'task', teamName: 'Crew' }
  const runner = new Runner()
  try { runner.render() } catch { /* the loading view has no room */ }
  expect(runner.result.props.className).toContain('items-center')
  runner.close()
})
it('opens team progress in the canvas instead of a drawer, once per linked record', () => {
  env.conversations = [{ epochId: 'task', kind: 'native' }]
  env.target = { teamId: 'team', epochId: 'task', teamName: 'Crew', appId: 'owned', entryId: 'activity-1' }
  const runner = new Runner()
  const room = runner.render()
  const scope = { spaceId: 'space', teamId: 'team', epochId: 'task' }
  expect(env.openTeamTask).toHaveBeenCalledWith(scope, 'Team progress', { reveal: { activityId: 'activity-1' } })
  runner.render()
  expect(env.openTeamTask).toHaveBeenCalledTimes(1)
  room.props.onActivity()
  expect(env.openTeamTask).toHaveBeenLastCalledWith(scope, 'Team progress', {})
  room.props.onExecution('owned')
  expect(env.openTeamTask).toHaveBeenLastCalledWith(scope, 'Team progress', { reveal: { memberAppId: 'owned' } })
  runner.close()
})
