import { setImmediate } from 'node:timers/promises'
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SkillCopy, SkillGroup, SkillInventory } from '../../../src/shared/types/skills'

const env = vi.hoisted(() => ({
  runner: null as any,
  list: vi.fn(),
  preferences: { switcherCollapsed: false, switcherWidth: 220 },
  locale: 'en',
  t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values?.[key] ?? '')),
}))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => env.runner.state(initial),
  useRef: (initial: any) => env.runner.ref(initial),
  useCallback: (fn: any, deps: unknown[]) => env.runner.memo(() => fn, deps),
  useMemo: (fn: any, deps: unknown[]) => env.runner.memo(fn, deps),
  useEffect: (fn: any, deps: unknown[]) => env.runner.effect(fn, deps),
  useLayoutEffect: (fn: any, deps: unknown[]) => env.runner.effect(fn, deps),
  useId: () => 'switcher-tooltip',
}))
vi.mock('react-dom', () => ({ createPortal: (child: unknown) => child }))
vi.mock('../../../src/renderer/api', () => ({ api: { skillsList: env.list } }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: env.t }), getCurrentLanguage: () => env.locale }))
vi.mock('../../../src/renderer/stores/apps-page.store', () => ({
  useAppsPageStore: Object.assign((select: any) => select(env.preferences), {
    getState: () => env.preferences,
    setState: (patch: Partial<typeof env.preferences>) => Object.assign(env.preferences, patch),
  }),
}))
vi.mock('../../../src/renderer/components/store/AppTypeIcon', () => ({ AppTypeIcon: () => null }))
import { SkillDetailSwitcher } from '../../../src/renderer/components/apps/SkillDetailSwitcher'
import { DetailSwitcher } from '../../../src/renderer/components/apps/DetailSwitcher'

function sameDeps(left: unknown[], right: unknown[]) {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

class Runner {
  values: any[] = []
  index = 0
  effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>()
  pending = new Map<number, () => void>()

  state(initial: any) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial
    return [this.values[index], (update: any) => {
      this.values[index] = typeof update === 'function' ? update(this.values[index]) : update
    }]
  }

  ref(initial: any) {
    const index = this.index++
    this.values[index] ??= { current: initial }
    return this.values[index]
  }

  memo(fn: () => unknown, deps: unknown[]) {
    const index = this.index++
    if (!this.values[index] || !sameDeps(deps, this.values[index].deps)) {
      this.values[index] = { deps, value: fn() }
    }
    return this.values[index].value
  }

  effect(fn: () => (() => void) | void, deps: unknown[]) {
    const index = this.index++
    const previous = this.effects.get(index)
    if (previous && sameDeps(deps, previous.deps)) {
      this.pending.delete(index)
      return
    }
    this.pending.set(index, () => {
      previous?.cleanup?.()
      this.effects.set(index, { deps, cleanup: fn() || undefined })
    })
  }

  render<T>(fn: () => T) {
    this.index = 0
    env.runner = this
    return fn()
  }

  flush() {
    const effects = [...this.pending.values()]
    this.pending.clear()
    effects.forEach(fn => fn())
  }

  unmount() {
    this.pending.clear()
    this.effects.forEach(effect => effect.cleanup?.())
    this.effects.clear()
  }
}

const runners: Runner[] = []
function runner() {
  const value = new Runner()
  runners.push(value)
  return value
}
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  return Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
}
function text(tree: any): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  return Array.isArray(tree) ? tree.map(text).join('') : text(tree?.props?.children ?? '')
}
function button(tree: any, label: string) {
  const node = nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label))
  expect(node, label).toBeDefined()
  return node
}
function copy(name: string, extra: Partial<SkillCopy> = {}): SkillCopy {
  return {
    id: `${name}-copy`, name, displayName: `${name} title`, description: `${name} description`,
    path: `/private/skills/${name}/SKILL.md`, scope: 'global', spaceId: null,
    source: 'personal', owners: [], enabled: true, availability: 'available',
    revision: 'rev-1', editable: true, isLink: false, ...extra,
  }
}
function group(name: string, copies = [copy(name)]): SkillGroup {
  return { name, displayName: `${name} title`, description: `${name} description`, source: 'mine', copies, effectiveId: copies.at(-1)?.id, conflict: false }
}
function inventory(groups: SkillGroup[], total = groups.length): SkillInventory {
  return { groups, total, offset: 0, limit: 50, truncated: false, warnings: [], legacyRemoved: [] }
}
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function adapter() {
  const run = runner()
  const props = { spaceId: 'workspace-a' as string | null, selectedGroup: group('first'), onSelect: vi.fn(), revision: 0 }
  const render = () => run.render(() => SkillDetailSwitcher(props))
  const switcher = () => nodes(render()).find(node => node.type === DetailSwitcher)
  return { run, props, render, switcher }
}
const settle = () => setImmediate()

beforeEach(() => {
  vi.clearAllMocks()
  env.list.mockReset()
  env.preferences = { switcherCollapsed: false, switcherWidth: 220 }
  env.locale = 'en'
  vi.stubGlobal('document', { body: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('window', { innerHeight: 900 })
})
afterEach(() => {
  runners.splice(0).forEach(value => value.unmount())
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('maps one stable command row to its effective copy without scanning other workspaces', async () => {
  const selected = group('review', [copy('review', { id: 'shadow' }), copy('review', { id: 'effective', displayName: 'Preferred title' })])
  const disabled = group('disabled', [copy('disabled', { enabled: false, availability: 'disabled' })])
  env.list.mockResolvedValue({ success: true, data: inventory([selected, disabled]) })
  const { run, props, render, switcher } = adapter()
  props.selectedGroup = selected
  render(); run.flush(); await settle()
  const component = switcher()
  expect(env.list).toHaveBeenCalledOnce()
  expect(env.list).toHaveBeenCalledWith({ spaceId: 'workspace-a', source: 'all', q: '', offset: 0, limit: 50 })
  expect(component.props.selectedId).toBe('review')
  expect(component.props.items).toMatchObject([
    { id: 'review', name: 'Preferred title', dimmed: false },
    { id: 'disabled', name: 'disabled title', dimmed: true },
  ])
  expect(JSON.stringify(component.props.items)).not.toContain('/private/')
  component.props.onSelect('disabled')
  expect(props.onSelect).toHaveBeenCalledWith(disabled)
  props.selectedGroup = disabled
  render(); run.flush(); await settle()
  expect(env.list).toHaveBeenCalledOnce()
})

it('fetches next and previous pages explicitly, resetting the page on backend search or scope changes', async () => {
  vi.useFakeTimers()
  env.list.mockResolvedValue({ success: true, data: inventory([group('first')], 120) })
  const { run, props, render, switcher } = adapter()
  render(); run.flush(); await settle()
  button(switcher().props.footer, 'Next').props.onClick()
  render(); run.flush(); await settle()
  expect(env.list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50, limit: 50 }))
  button(switcher().props.footer, 'Previous').props.onClick()
  render(); run.flush(); await settle()
  expect(env.list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }))
  button(switcher().props.footer, 'Next').props.onClick()
  render(); run.flush(); await settle()
  switcher().props.onQueryChange(' needle in description ')
  render(); run.flush()
  expect(switcher().props.loading).toBe(true)
  vi.advanceTimersByTime(300)
  render(); run.flush(); await settle()
  expect(env.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'needle in description', offset: 0 }))
  props.spaceId = null
  render(); run.flush(); await settle()
  expect(env.list).toHaveBeenLastCalledWith(expect.objectContaining({ spaceId: null, offset: 0 }))
  expect(env.list.mock.calls.every(([query]) => query.limit <= 100)).toBe(true)
})

it('refreshes after a detail mutation without an extra initial request and ignores an obsolete query result', async () => {
  vi.useFakeTimers()
  const first = deferred()
  env.list.mockReturnValueOnce(first.promise)
  const { run, props, render, switcher } = adapter()
  render(); run.flush()
  expect(env.list).toHaveBeenCalledOnce()
  env.list.mockResolvedValue({ success: true, data: inventory([group('new')]) })
  switcher().props.onQueryChange('new')
  render(); run.flush(); vi.advanceTimersByTime(300)
  render(); run.flush(); await settle()
  first.resolve({ success: true, data: inventory([group('obsolete')]) }); await settle()
  expect(switcher().props.items.map((item: any) => item.id)).toEqual(['new'])
  expect(switcher().props.selectedId).toBe('first')
  props.revision++
  render(); run.flush(); render(); run.flush(); await settle()
  expect(env.list).toHaveBeenCalledTimes(3)
})

it('retains healthy rows on refresh failure, displays a safe retry and keeps paging in the icon strip', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  env.list.mockResolvedValueOnce({ success: true, data: inventory([group('healthy')], 100) })
  const { run, props, render, switcher } = adapter()
  render(); run.flush(); await settle()
  env.list.mockRejectedValueOnce(new Error('ENOENT: /private/broken/SKILL.md'))
  props.revision++
  render(); run.flush(); render(); run.flush(); await settle()
  expect(switcher().props.items[0].id).toBe('healthy')
  expect(text(switcher().props.footer)).toContain('Could not refresh your skills. Please try again.')
  expect(text(switcher().props.footer)).not.toMatch(/ENOENT|\/private\//)
  env.preferences.switcherCollapsed = true
  const footer = switcher().props.footer
  expect(button(footer, 'Retry')).toBeDefined()
  expect(button(footer, 'Next').props.disabled).toBe(false)
  expect(button(footer, 'Previous').props.disabled).toBe(true)
  env.list.mockResolvedValue({ success: true, data: inventory([group('healthy')], 100) })
  button(footer, 'Retry').props.onClick()
  render(); run.flush(); await settle()
  expect(env.list).toHaveBeenCalledTimes(3)
})

it('keeps controlled description results visible and preserves the search field below the old local threshold', () => {
  const run = runner()
  const onQueryChange = vi.fn()
  const props = {
    title: 'Skills', searchPlaceholder: 'Search skills', selectedId: 'one', onSelect: vi.fn(),
    items: [{ id: 'one', name: 'Unrelated name', description: 'Matching description', icon: null }],
    controlledQuery: 'description', onQueryChange,
  }
  const render = () => run.render(() => DetailSwitcher(props))
  let tree = render()
  expect(button(tree, 'Unrelated name')).toBeDefined()
  const input = nodes(tree).find(node => node.type === 'input')
  expect(input.props.value).toBe('description')
  input.props.onChange({ target: { value: 'changed' } })
  expect(onQueryChange).toHaveBeenCalledWith('changed')
  props.items = []
  tree = render()
  expect(nodes(tree).find(node => node.type === 'input')).toBeDefined()
  expect(text(tree)).not.toContain('No matching results found')
})

it('leaves default local search and folded unfiltered rows unchanged for existing callers', () => {
  const run = runner()
  const props = {
    title: 'People', searchPlaceholder: 'Search people', selectedId: '0', onSelect: vi.fn(),
    items: Array.from({ length: 8 }, (_, index) => ({ id: String(index), name: `Person ${index}`, icon: null })),
  }
  const render = () => run.render(() => DetailSwitcher(props))
  const input = nodes(render()).find(node => node.type === 'input')
  input.props.onChange({ target: { value: 'Person 2' } })
  expect(nodes(render()).filter(node => node.type === 'button' && node.props['aria-current'] !== undefined)).toHaveLength(1)
  button(render(), 'Collapse').props.onClick()
  expect(env.preferences.switcherCollapsed).toBe(true)
  expect(nodes(render()).filter(node => node.type === 'button' && node.props['aria-current'] !== undefined)).toHaveLength(8)
  button(render(), 'Expand').props.onClick()
  expect(env.preferences.switcherCollapsed).toBe(false)
  expect(nodes(render()).find(node => node.type === 'input').props.value).toBe('Person 2')
  props.items = props.items.slice(0, 2)
  expect(nodes(render()).find(node => node.type === 'input')).toBeUndefined()
})

it('reuses width persistence, drag cleanup, hover cards and loading in both layouts', () => {
  vi.useFakeTimers()
  const run = runner()
  const props = {
    title: 'Skills', searchPlaceholder: 'Search skills', selectedId: 'first', onSelect: vi.fn(),
    items: [{ id: 'first', name: 'First', description: 'The first skill', icon: null }],
    loading: true, footer: createElement('span', null, 'Page controls'),
  }
  const render = () => run.render(() => DetailSwitcher(props))
  let tree = render(); run.flush()
  const containerRef = (tree as unknown as { ref: { current: unknown } }).ref
  containerRef.current = { getBoundingClientRect: () => ({ left: 20 }) }
  expect(tree.props.style.width).toBe(220)
  const drag = nodes(tree).find(node => node.props.title === 'Drag to resize width')
  drag.props.onMouseDown({ preventDefault: vi.fn() })
  render(); run.flush()
  const listener = (name: string) => vi.mocked(document.addEventListener).mock.calls.find(([event]) => event === name)![1] as (event: any) => void
  const move = listener('mousemove')
  const release = listener('mouseup')
  move({ clientX: 300 })
  expect(render().props.style.width).toBe(280)
  expect(env.preferences.switcherWidth).toBe(220)
  release({})
  render(); run.flush()
  expect(env.preferences.switcherWidth).toBe(280)
  expect(document.removeEventListener).toHaveBeenCalledWith('mousemove', move)
  button(render(), 'First').props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ top: 10, height: 20, right: 280 }) } })
  vi.advanceTimersByTime(300)
  tree = render()
  expect(text(nodes(tree).find(node => node.props.role === 'tooltip'))).toContain('The first skill')
  expect(nodes(tree).some(node => node.props['aria-busy'] === true)).toBe(true)
  expect(nodes(tree).some(node => node.props.role === 'status')).toBe(false)
  button(tree, 'Collapse').props.onClick()
  tree = render(); run.flush()
  expect(text(tree)).toContain('Page controls')
  button(tree, 'First').props.onClick()
  expect(props.onSelect).toHaveBeenCalledWith('first')
  props.items = []
  tree = render()
  expect(nodes(tree).some(node => node.props.role === 'status')).toBe(true)
  button(tree, 'Expand').props.onClick()
  expect(nodes(render()).some(node => node.props.role === 'status')).toBe(true)
})
