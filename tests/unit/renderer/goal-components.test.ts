/**
 * The goal shelf above the composer and the goal editor tab.
 *
 * No DOM here: React's hooks are replaced by a small runner that also runs
 * effects whose dependencies changed, and the returned element tree is
 * searched for what the user would see.
 */

import { beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any, goal: undefined as any, ui: {} as any, conversations: [] as any[] }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (value: any) => env.runner.state(value), useRef: (value: any) => env.runner.ref(value), useEffect: (fn: any, deps: any) => env.runner.effect(fn, deps), useLayoutEffect: () => {}, useId: () => 'id' }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }), default: { t: (text: string) => text } }))
vi.mock('../../../src/renderer/stores/goal.store', () => ({
  useConversationGoal: () => env.goal,
  useGoalUnseenByModel: () => false,
  useGoalSupported: () => true,
  useGoalStore: { getState: () => ({ load: vi.fn(), byConversation: new Map() }) },
}))
vi.mock('../../../src/renderer/stores/goal-ui.store', () => ({ useGoalUiStore: Object.assign((select: any) => select(env.ui), { getState: () => env.ui }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: (select: any) => select({ spaceStates: new Map([['s', { conversations: env.conversations }]]) }) }))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({
  canvasLifecycle: { openGoal: vi.fn(), closeTab: vi.fn(), markTabSaved: vi.fn(), updateTabContent: vi.fn(), setRefreshHandler: () => () => {} },
}))
vi.mock('../../../src/renderer/components/goal/useClearGoal', () => ({ useClearGoal: () => ({ requestClear: vi.fn(), confirmDialog: null }) }))
vi.mock('../../../src/renderer/components/goal/goal-actions', () => ({ undoClearGoal: vi.fn(), saveGoal: vi.fn() }))
vi.mock('../../../src/renderer/components/goal/hooks', () => ({ useTimeAgo: () => 'just now', useConversationRunning: () => false }))

import { GoalShelf } from '../../../src/renderer/components/goal/GoalShelf'
import { GoalEditor } from '../../../src/renderer/components/goal'

class ComponentRunner {
  values: any[] = []; index = 0; pending: (() => void)[] = []
  state(initial: any) { const index = this.index++; if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial; return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }] }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  effect(fn: () => void, deps?: any[]) {
    const index = this.index++
    const previous = this.values[index]
    if (!deps || !previous || deps.some((d, i) => !Object.is(d, previous[i]))) this.pending.push(fn)
    this.values[index] = deps
  }
  /** Renders, runs the effects that fire, and renders again so their state updates show. */
  render(component: () => any) {
    const pass = () => { this.index = 0; this.pending = []; env.runner = this; return component() }
    pass(); const effects = this.pending; effects.forEach(fn => fn())
    return pass()
  }
}
/** Every element in the tree, without rendering child components. */
function nodes(tree: any): any[] { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }
const text = (tree: any) => nodes(tree).flatMap(node => [node.props?.children].flat(Infinity)).filter(c => typeof c === 'string')
const announcement = (tree: any) => nodes(tree).find(node => node.props?.['aria-live'] === 'polite')?.props.children

const goal = (patch: any = {}) => ({ objective: 'Ship the release', doneWhen: ['Tests pass'], status: 'active', updatedBy: 'user', updatedAt: '2026-09-26T10:00:00.000Z', ...patch })

beforeEach(() => {
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  env.goal = undefined
  env.ui = { undo: new Map(), dropUndo: vi.fn() }
  env.conversations = [{ id: 'c', title: 'Chat' }]
})

function shelf(onNewGoal = vi.fn()) {
  const runner = new ComponentRunner()
  return () => runner.render(() => GoalShelf({ spaceId: 's', conversationId: 'c', running: false, onNewGoal }))
}

it('shelf renders nothing without a goal', () => {
  env.goal = null
  const tree = shelf()()
  expect(nodes(tree).some(node => node.type === 'section')).toBe(false)
})

it('shelf shows an active goal with its criteria count and the actions on it', () => {
  env.goal = goal()
  const tree = shelf()()
  const strings = text(tree)
  expect(strings).toContain('Goal')
  expect(strings).toContain('Ship the release')
  expect(strings).toContain('1 criterion')
  expect(nodes(tree).some(node => node.props?.title === 'Edit goal')).toBe(true)
  expect(nodes(tree).some(node => node.props?.title === 'Clear goal')).toBe(true)
})

it('shelf offers a new goal once the goal is achieved', () => {
  env.goal = goal({ status: 'complete', updatedBy: 'agent' })
  const onNewGoal = vi.fn()
  const tree = shelf(onNewGoal)()
  expect(text(tree)).toContain('Goal achieved')
  nodes(tree).find(node => node.type === 'button' && node.props.title === 'New goal').props.onClick()
  expect(onNewGoal).toHaveBeenCalled()
})

it('shelf can reopen the goal tab for a finished or abandoned goal', async () => {
  const { canvasLifecycle } = await import('../../../src/renderer/services/canvas-lifecycle')
  for (const status of ['complete', 'abandoned']) {
    ;(canvasLifecycle.openGoal as any).mockClear()
    env.goal = goal({ status, updatedBy: 'agent' })
    const tree = shelf()()
    nodes(tree).find(node => node.type === 'button' && node.props.title === 'Edit goal').props.onClick()
    expect(canvasLifecycle.openGoal).toHaveBeenCalledWith('s', 'c')
  }
})

it('shelf offers undo right after a clear', () => {
  env.goal = null
  env.ui.undo.set('c', { previous: { objective: 'Ship the release' }, id: 1 })
  const strings = text(shelf()())
  expect(strings).toContain('Goal cleared.')
  expect(strings).toContain('Undo')
})

it('shelf announces a live change by Halo, but not a goal already there on open', () => {
  env.goal = goal()
  const render = shelf()
  expect(announcement(render())).toBe('')

  env.goal = goal({ objective: 'Ship and tag the release', updatedBy: 'agent', updatedAt: '2026-09-26T10:05:00.000Z' })
  expect(announcement(render())).toBe('Goal updated by Halo')

  env.goal = goal({ status: 'complete', updatedBy: 'agent', updatedAt: '2026-09-26T10:09:00.000Z' })
  expect(announcement(render())).toBe('Goal achieved')
})

it('shelf announces the first goal Halo sets', () => {
  env.goal = null
  const render = shelf()
  render()
  env.goal = goal({ updatedBy: 'agent' })
  expect(announcement(render())).toBe('Goal set by Halo')
})

function editor() {
  const runner = new ComponentRunner()
  const tab = { id: 'tab', type: 'goal', title: 'Goal', goal: { spaceId: 's', conversationId: 'c' } } as any
  return () => runner.render(() => { const outer = GoalEditor({ tab }); return outer.type(outer.props) })
}
const banner = (tree: any) => nodes(tree).find(node => node.props?.role === 'alert')

it('editor asks what to keep when the goal changes under unsaved edits', () => {
  env.goal = goal()
  const render = editor()
  let tree = render()
  expect(banner(tree)).toBeUndefined()

  nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: 'My own wording' } })
  render()
  env.goal = goal({ objective: 'Halo wording', updatedBy: 'agent', updatedAt: '2026-09-26T10:05:00.000Z' })
  tree = render()

  expect(text(banner(tree))).toContain('Halo updated this goal while you were editing.')
  expect(nodes(tree).find(node => node.type === 'textarea').props.value).toBe('My own wording')
})

it('editor follows a change silently while it has no edits', () => {
  env.goal = goal()
  const render = editor()
  render()
  env.goal = goal({ objective: 'Halo wording', updatedBy: 'agent', updatedAt: '2026-09-26T10:05:00.000Z' })
  const tree = render()

  expect(banner(tree)).toBeUndefined()
  expect(nodes(tree).find(node => node.type === 'textarea').props.value).toBe('Halo wording')
})

it('editor keeps the actions in the footer, never the header', () => {
  env.goal = goal()
  const tree = editor()()
  const footer = nodes(tree).find(node => node.type === 'footer')
  const header = nodes(tree).find(node => node.type === 'header')
  expect(text(footer)).toContain('Save goal')
  expect(text(footer)).toContain('Clear goal')
  expect(nodes(header).some(node => node.type === 'button')).toBe(false)
})

it('footer keeps clear and cancel usable until a save is in flight', async () => {
  env.goal = goal()
  const { saveGoal } = await import('../../../src/renderer/components/goal/goal-actions')
  let release!: (ok: boolean) => void
  const inFlight = new Promise<boolean>((resolve) => { release = resolve })
  ;(saveGoal as any).mockReturnValueOnce(inFlight)
  const button = (tree: any, label: string) =>
    nodes(tree).find(node => node.type === 'button' && [node.props?.children].flat(Infinity).includes(label))

  const render = editor()
  let tree = render()
  nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: 'My own wording' } })
  tree = render()
  expect(button(tree, 'Clear goal').props.disabled).toBeFalsy()
  expect(button(tree, 'Cancel').props.disabled).toBeFalsy()

  button(tree, 'Save goal').props.onClick()
  tree = render()
  expect(button(tree, 'Clear goal').props.disabled).toBe(true)
  expect(button(tree, 'Cancel').props.disabled).toBe(true)

  release(true)
  await inFlight
  await Promise.resolve()
  await Promise.resolve()
  tree = render()
  expect(button(tree, 'Clear goal').props.disabled).toBeFalsy()
})

it('editor ignores Esc while an input method is composing', async () => {
  const { canvasLifecycle } = await import('../../../src/renderer/services/canvas-lifecycle')
  env.goal = goal()
  const tree = editor()()
  const onKeyDown = nodes(tree).find(node => node.type === 'div' && node.props.onKeyDown).props.onKeyDown
  const press = (key: string, isComposing: boolean) => onKeyDown({ key, metaKey: key === 's', ctrlKey: false, defaultPrevented: false, target: {}, currentTarget: { contains: () => true }, nativeEvent: { isComposing }, preventDefault: vi.fn(), stopPropagation: vi.fn() })

  press('Escape', true)
  expect(canvasLifecycle.closeTab).not.toHaveBeenCalled()
  press('Escape', false)
  expect(canvasLifecycle.closeTab).toHaveBeenCalledWith('tab')
})
