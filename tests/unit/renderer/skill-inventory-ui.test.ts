import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SkillCopy, SkillGroup, SkillInventory, SkillListQuery } from '../../../src/shared/types/skills'

const env = vi.hoisted(() => ({
  runner: null as any, list: vi.fn(), api: {} as any, confirm: vi.fn(), spaces: {} as any,
  desktop: true, updates: [] as any[], updateStart: vi.fn(), updateFlow: vi.fn(), locale: 'en',
  t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values?.[key] ?? '')),
}))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => env.runner.state(initial),
  useRef: (initial: any) => env.runner.ref(initial),
  useCallback: (fn: any, deps: unknown[]) => env.runner.memo(() => fn, deps),
  useMemo: (fn: any, deps: unknown[]) => env.runner.memo(fn, deps),
  useEffect: (fn: any, deps: unknown[]) => env.runner.effect(fn, deps),
}))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/api/transport', () => ({ isElectron: () => env.desktop }))
vi.mock('../../../src/renderer/hooks/useConfirmDialog', () => ({ useConfirmDialog: () => ({ showConfirm: env.confirm, DialogComponent: null }) }))
vi.mock('../../../src/renderer/stores/apps-page.store', () => ({ useAppsPageStore: (select: any) => select({ availableUpdates: env.updates }) }))
vi.mock('../../../src/renderer/components/store/useStoreUpdateFlow', () => ({ useStoreUpdateFlow: env.updateFlow }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: env.t }), getCurrentLanguage: () => env.locale }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: (select: any) => select(env.spaces) }))
vi.mock('../../../src/renderer/components/store/AppTypeIcon', () => ({ AppTypeIcon: () => null }))
import { useSkillInventory } from '../../../src/renderer/hooks/useSkillInventory'
import { useSkillActions } from '../../../src/renderer/hooks/useSkillActions'
import { SkillCardWall } from '../../../src/renderer/components/apps/SkillCardWall'
import { SkillCard } from '../../../src/renderer/components/apps/SkillCard'

function sameDeps(left: unknown[], right: unknown[]) { return left.length === right.length && left.every((value, index) => Object.is(value, right[index])) }
class Runner {
  values: any[] = []
  effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>()
  pending = new Map<number, () => void>()
  index = 0
  state(initial: any) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial
    return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }]
  }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  memo(fn: () => unknown, deps: unknown[]) {
    const index = this.index++
    if (!this.values[index] || !sameDeps(deps, this.values[index].deps)) this.values[index] = { deps, value: fn() }
    return this.values[index].value
  }
  effect(fn: () => (() => void) | void, deps: unknown[]) {
    const index = this.index++
    const previous = this.effects.get(index)
    if (previous && sameDeps(deps, previous.deps)) { this.pending.delete(index); return }
    this.pending.set(index, () => {
      previous?.cleanup?.()
      this.effects.set(index, { deps, cleanup: fn() || undefined })
    })
  }
  children = new Map<string, Runner>()
  render<T>(fn: () => T): T {
    this.index = 0; env.runner = this
    const tree = fn()
    const active = new Set<string>()
    const expand = (node: any, path: string): any => {
      if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${child?.key ?? index}`))
      if (!node || typeof node !== 'object' || !node.props) return node
      if (typeof node.type === 'function' && ['SkillScope', 'WorkspaceSkills'].includes(node.type.name)) {
        const key = `${path}:${node.type.name}`
        active.add(key)
        if (!this.children.has(key)) this.children.set(key, new Runner())
        return this.children.get(key)!.render(() => node.type(node.props))
      }
      return { ...node, props: { ...node.props, children: expand(node.props.children, `${path}/children`) } }
    }
    const result = expand(tree, 'root')
    for (const [key, child] of this.children) {
      if (!active.has(key)) { child.unmount(); this.children.delete(key) }
    }
    return result
  }
  flush() { const effects = [...this.pending.values()]; this.pending.clear(); effects.forEach(fn => fn()); this.children.forEach(child => child.flush()) }
  unmount() { this.pending.clear(); this.effects.forEach(effect => effect.cleanup?.()); this.effects.clear(); this.children.forEach(child => child.unmount()); this.children.clear() }
}
const runners: Runner[] = []
function runner() { const value = new Runner(); runners.push(value); return value }
function inventory(groups: SkillGroup[] = [], total = groups.length): SkillInventory {
  return { groups, total, offset: 0, limit: 50, truncated: false, warnings: [], legacyRemoved: [] }
}
function group(name: string, source: SkillGroup['source'] = 'mine'): SkillGroup {
  return { name, displayName: name, description: `${name} description`, source, copies: [], conflict: false }
}
function deferred() { let resolve!: (value: any) => void; const promise = new Promise(resolvePromise => { resolve = resolvePromise }); return { promise, resolve } }
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}
function text(tree: any): string { return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : Array.isArray(tree) ? tree.map(text).join('') : text(tree?.props?.children ?? '') }
function button(tree: any, label: string) { const node = nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label)); expect(node, label).toBeDefined(); return node }
function copy(): SkillCopy { return { id: 'copy-a', name: 'sample', displayName: 'Sample skill', description: 'A useful skill', scope: 'space' as const, spaceId: 'a', path: '/a/sample/SKILL.md', source: 'personal' as const, owners: [], enabled: true, availability: 'available' as const, editable: true, isLink: false, revision: 'rev-1' } }
function card(value: SkillGroup = { ...group('sample'), effectiveId: 'copy-a', copies: [copy()] }) {
  const run = runner(); const props = { group: value, spaceMap: { a: 'A' }, contextSpaceId: 'a', onOpen: vi.fn(), onChanged: vi.fn() }
  const render = () => run.render(() => SkillCard(props))
  render(); run.flush()
  return { run, props, render }
}
const settle = () => setImmediate()
beforeEach(() => {
  vi.clearAllMocks()
  env.list.mockReset()
  env.desktop = true; env.updates = []; env.locale = 'en'
  env.confirm.mockResolvedValue(true)
  env.updateFlow.mockReturnValue({ busy: false, dialogs: null, start: env.updateStart })
  env.api.skillsList = env.list
  for (const method of ['skillsRead', 'skillsSetEnabled', 'skillsDelete', 'skillsMovePreview', 'skillsMove', 'skillsOpenFolder']) env.api[method] = vi.fn().mockResolvedValue({ success: true })
  env.api.skillsRead.mockResolvedValue({ success: true, data: { copy: copy(), content: 'Instructions', revision: 'rev-2', files: [] } })
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  env.spaces = { currentSpace: { id: 'a', name: 'A' }, haloSpace: { id: 'halo', name: 'Halo', isTemp: true }, spaces: [{ id: 'a', name: 'A' }, { id: 'b', name: 'No installs' }] }
})
afterEach(() => { runners.splice(0).forEach(value => value.unmount()); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('requests only the query page, rejects late responses and hides old scope before effects', async () => {
  const first = deferred(); const second = deferred()
  env.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const run = runner()
  let query: SkillListQuery = { spaceId: 'a' }
  const render = () => run.render(() => useSkillInventory(query))
  render(); run.flush()
  query = { spaceId: 'b', offset: 50 }
  expect(render()).toMatchObject({ data: null, loading: true })
  run.flush()
  second.resolve({ success: true, data: inventory([group('new')]) }); await settle()
  first.resolve({ success: true, data: inventory([group('old')]) }); await settle()
  expect(render().data?.groups[0].name).toBe('new')
  expect(env.list).toHaveBeenCalledTimes(2)
  expect(env.list).toHaveBeenLastCalledWith({ spaceId: 'b', q: '', source: 'all', offset: 50, limit: 50 })
  query = { spaceId: null }
  expect(render().data).toBeNull()
})

it('retains same-query results on refresh failure and stops updates after unmount', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const data = inventory([group('kept')])
  env.list.mockResolvedValueOnce({ success: true, data }).mockRejectedValueOnce(new Error('Offline'))
  const run = runner(); const render = () => run.render(() => useSkillInventory({ spaceId: 'a' }))
  render(); run.flush(); await settle()
  render().refresh(); render(); run.flush(); await settle()
  expect(render()).toMatchObject({ data, error: 'Offline', loading: false })
  const late = deferred(); env.list.mockReturnValueOnce(late.promise)
  render().refresh(); render(); run.flush(); run.unmount()
  late.resolve({ success: true, data: inventory([group('late')]) }); await settle()
  expect(render().data).toEqual(data)
})

it('groups sources, offers every workspace, opens the exact group and resets pages on scope changes', async () => {
  const mine = group('personal'); const shared = group('shared', 'digital-human'); const builtin = group('builtin', 'builtin')
  env.list.mockResolvedValue({ success: true, data: inventory([mine, shared, builtin], 60) })
  const onOpen = vi.fn(); const onManualAdd = vi.fn()
  const props = { spaceMap: { a: 'A' }, onOpen, onManualAdd, onBrowseStore: vi.fn() }
  const run = runner(); const render = () => run.render(() => SkillCardWall(props))
  render(); run.flush(); await settle()
  let tree = render()
  expect(nodes(tree).filter(node => node.type === SkillCard).map(node => node.props.group)).toEqual([mine])
  expect(nodes(tree).filter(node => node.type === 'option').map(node => node.props.value)).toContain('b')
  nodes(tree).find(node => node.type === SkillCard)!.props.onOpen()
  expect(onOpen).toHaveBeenCalledWith(mine, 'a')
  nodes(tree).find(node => node.type === 'button' && node.props.children === 'Next')!.props.onClick()
  render(); run.flush(); await settle()
  expect(env.list).toHaveBeenLastCalledWith(expect.objectContaining({ spaceId: 'a', offset: 50 }))
  tree = render()
  nodes(tree).find(node => node.props?.['aria-label'] === 'Workspace')!.props.onChange({ target: { value: 'b' } })
  tree = render(); run.flush(); await settle()
  expect(env.list).toHaveBeenLastCalledWith(expect.objectContaining({ spaceId: 'b', offset: 0 }))
  tree = render()
  button(tree, 'Manual Add Skill').props.onClick()
  expect(onManualAdd).toHaveBeenCalledWith('b')
})

it('keeps All workspaces uninspected until each load action and passes the selected workspace ref', async () => {
  const globalCopy = { ...copy(), id: 'global', scope: 'global' as const, spaceId: null }
  const localCopy = { ...copy(), id: 'local-b', spaceId: 'b', enabled: false, availability: 'disabled' as const }
  const shared = { ...group('sample'), effectiveId: globalCopy.id, copies: [globalCopy, localCopy] }
  const globalOnly = { ...group('global-only'), effectiveId: 'only-global', copies: [{ ...globalCopy, id: 'only-global', name: 'global-only' }] }
  env.list.mockResolvedValue({ success: true, data: inventory([globalOnly, shared], 60) })
  const onOpen = vi.fn()
  const run = runner(); const render = () => run.render(() => SkillCardWall({ spaceMap: {}, onOpen, onManualAdd: vi.fn(), onBrowseStore: vi.fn() }))
  render(); run.flush(); await settle()
  expect(env.list.mock.calls.map(([query]) => query.spaceId)).toEqual(['a'])
  nodes(render()).find(node => node.props?.['aria-label'] === 'Workspace').props.onChange({ target: { value: 'all' } })
  let tree = render(); run.flush(); await settle()
  expect(env.list).toHaveBeenCalledOnce()
  expect(nodes(tree).filter(node => node.type === SkillCard)).toHaveLength(0)
  expect(text(tree)).toContain('Search applies only to loaded workspaces')
  const section = (name: string) => nodes(render()).find(node => node.type === 'section' && node.props['aria-label'] === name)
  expect(['Global', 'A', 'No installs', 'Halo'].every(name => section(name))).toBe(true)
  expect(text(section('No installs'))).toContain('Skills have not been loaded')
  button(section('No installs'), 'Load skills').props.onClick()
  render(); run.flush(); await settle()
  expect(env.list).toHaveBeenCalledTimes(2)
  expect(env.list).toHaveBeenLastCalledWith({ spaceId: 'b', q: '', source: 'all', offset: 0, limit: 50 })
  tree = render()
  const item = nodes(section('No installs')).find(node => node.type === SkillCard)
  expect(item.props.group.copies).toEqual([localCopy])
  expect(item.props.group.effectiveId).toBeUndefined()
  expect(item.props.contextSpaceId).toBe('b')
  item.props.onOpen()
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ copies: [localCopy] }), 'b')
  expect(nodes(tree).filter(node => node.type === SkillCard)).toHaveLength(1)
  expect(text(section('No installs'))).not.toContain('60 skills')
  button(section('No installs'), 'Next').props.onClick()
  render(); run.flush(); await settle()
  expect(env.list).toHaveBeenLastCalledWith(expect.objectContaining({ spaceId: 'b', offset: 50, limit: 50 }))
  button(section('Global'), 'Load skills').props.onClick()
  render(); run.flush(); await settle()
  expect(env.list.mock.calls.map(([query]) => query.spaceId)).toEqual(['a', 'b', 'b', null])
  expect(text(section('A'))).toContain('Skills have not been loaded')
  button(section('No installs'), 'Hide skills').props.onClick()
  render(); run.flush()
  expect(nodes(section('No installs')).some(node => node.type === SkillCard)).toBe(false)
  expect(env.list).toHaveBeenCalledTimes(4)
})

it('searches only explicitly loaded workspaces and keeps unloaded groups visible', async () => {
  vi.useFakeTimers()
  env.list.mockResolvedValue({ success: true, data: inventory() })
  const run = runner(); const render = () => run.render(() => SkillCardWall({ spaceMap: {}, onOpen: vi.fn(), onManualAdd: vi.fn(), onBrowseStore: vi.fn() }))
  render(); run.flush(); await settle()
  nodes(render()).find(node => node.props?.['aria-label'] === 'Workspace').props.onChange({ target: { value: 'all' } })
  render(); run.flush()
  const section = (name: string) => nodes(render()).find(node => node.type === 'section' && node.props['aria-label'] === name)
  button(section('No installs'), 'Load skills').props.onClick()
  render(); run.flush(); await settle()
  nodes(render()).find(node => node.type === 'input').props.onChange({ target: { value: 'missing' } })
  render(); run.flush(); vi.advanceTimersByTime(300)
  render(); run.flush(); await settle()
  expect(env.list.mock.calls.map(([query]) => query.spaceId)).toEqual(['a', 'b', 'b'])
  expect(env.list).toHaveBeenLastCalledWith(expect.objectContaining({ spaceId: 'b', q: 'missing' }))
  expect(text(section('A'))).toContain('Skills have not been loaded')
  expect(text(section('Global'))).toContain('Skills have not been loaded')
  expect(text(section('No installs'))).toContain('No workspace skills on this page.')
})

it('search exposes secondary sources', async () => {
  vi.useFakeTimers()
  env.list.mockResolvedValue({ success: true, data: inventory([group('hidden', 'builtin')]) })
  const run = runner(); const render = () => run.render(() => SkillCardWall({ spaceMap: {}, onOpen: vi.fn(), onManualAdd: vi.fn(), onBrowseStore: vi.fn() }))
  render(); run.flush(); await settle()
  expect(nodes(render()).filter(node => node.type === SkillCard)).toHaveLength(0)
  nodes(render()).find(node => node.type === 'input')!.props.onChange({ target: { value: 'hidden' } })
  render(); run.flush(); vi.advanceTimersByTime(300)
  render(); run.flush(); await settle()
  expect(nodes(render()).filter(node => node.type === SkillCard)).toHaveLength(1)
  expect(env.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'hidden' }))
})

it('shows failures rather than claiming an uninspected scope is empty', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  env.list.mockResolvedValue({ success: false, error: 'Location unavailable' })
  const run = runner()
  const render = () => run.render(() => SkillCardWall({ spaceMap: {}, onOpen: vi.fn(), onManualAdd: vi.fn(), onBrowseStore: vi.fn() }))
  render(); run.flush(); await settle()
  const tree = render()
  expect(nodes(tree).some(node => node.props.role === 'alert')).toBe(true)
  const texts = nodes(tree).flatMap(node => [node.props.children].flat())
  expect(texts).toContain('Could not refresh your skills. Please try again.')
  expect(texts).not.toContain('Location unavailable')
  expect(texts).not.toContain('No Skills installed yet')
  expect(texts).not.toContain('No matching Skills')
})

it('offers quick actions without paths or internal copy markers and keeps opening keyboard accessible', () => {
  const value = { ...group('sample'), effectiveId: 'copy-a', copies: [copy(), { ...copy(), id: 'disabled', enabled: false, availability: 'disabled' as const }] }
  const { render, props } = card(value)
  const tree = render()
  expect(button(tree, 'Disable').props.disabled).toBe(false)
  expect(button(tree, 'More')).toBeDefined()
  expect(text(tree)).toContain('Sample skill')
  expect(text(tree)).toContain('A useful skill')
  expect(text(tree)).not.toMatch(/\/a\/sample\/SKILL\.md|Disabled copy|Missing copy|Effective|Engine support|2 copies/i)
  tree.props.onClick(); expect(props.onOpen).toHaveBeenCalledOnce()
  const target = {}; const preventDefault = vi.fn()
  tree.props.onKeyDown({ target, currentTarget: target, key: 'Enter', preventDefault })
  tree.props.onKeyDown({ target, currentTarget: target, key: ' ', preventDefault })
  tree.props.onKeyDown({ target: {}, currentTarget: target, key: 'Enter', preventDefault })
  expect(props.onOpen).toHaveBeenCalledTimes(3)
  expect(preventDefault).toHaveBeenCalledTimes(2)
})

it('quick toggle changes only the effective copy without a confirmation when no fallback exists', async () => {
  const value = { ...group('sample'), effectiveId: 'copy-a', copies: [{ ...copy(), id: 'shadow' }, copy()] }
  env.list.mockResolvedValue({ success: true, data: inventory([value]) })
  const { render, props } = card(value)
  const toggle = button(render(), 'Disable').props.onClick
  toggle(); toggle(); await settle()
  expect(env.api.skillsRead).toHaveBeenCalledOnce()
  expect(env.api.skillsRead).toHaveBeenCalledWith({ spaceId: 'a', id: 'copy-a' })
  expect(env.api.skillsSetEnabled).toHaveBeenCalledOnce()
  expect(env.api.skillsSetEnabled).toHaveBeenCalledWith({ ref: { spaceId: 'a', id: 'copy-a' }, enabled: false })
  expect(env.confirm).not.toHaveBeenCalled()
  expect(props.onChanged).toHaveBeenCalledOnce()
  expect(props.onOpen).not.toHaveBeenCalled()
})

it('opens the exact folder and offers scope move and deletion through More', async () => {
  const { render, props } = card()
  button(render(), 'More').props.onClick()
  expect(button(render(), 'Move to workspace')).toBeDefined()
  expect(button(render(), 'Delete')).toBeDefined()
  button(render(), 'Open skill folder').props.onClick(); await settle()
  expect(env.api.skillsOpenFolder).toHaveBeenCalledOnce()
  expect(env.api.skillsOpenFolder).toHaveBeenCalledWith({ spaceId: 'a', id: 'copy-a' })
  expect(props.onOpen).not.toHaveBeenCalled()
  expect(props.onChanged).not.toHaveBeenCalled()
  const stopPropagation = vi.fn()
  nodes(render()).find(node => node.props.onClick && node.props.onKeyDown && node.props.role !== 'button').props.onClick({ stopPropagation })
  expect(stopPropagation).toHaveBeenCalledOnce()
})

it.each(['invalid', 'missing'] as const)('keeps %s card folder access separate from scope moves', async availability => {
  const { render, props } = card({ ...group('sample'), copies: [{ ...copy(), availability }] })
  button(render(), 'More').props.onClick()
  const folder = button(render(), 'Open skill folder')
  expect(folder.props.disabled).toBe(availability === 'missing')
  expect(button(render(), 'Move to workspace').props.disabled).toBe(true)
  expect(button(render(), 'Delete').props.disabled).toBe(false)
  if (availability === 'invalid') {
    folder.props.onClick(); await settle()
    expect(env.api.skillsOpenFolder).toHaveBeenCalledWith({ spaceId: 'a', id: 'copy-a' })
    expect(env.api.skillsOpenFolder).toHaveBeenCalledOnce()
  } else {
    expect(env.api.skillsOpenFolder).not.toHaveBeenCalled()
  }
  expect(env.api.skillsRead).not.toHaveBeenCalled()
  expect(env.list).not.toHaveBeenCalled()
  expect(props.onOpen).not.toHaveBeenCalled()
  expect(props.onChanged).not.toHaveBeenCalled()
})

it('moves through the scope menu only after preview and confirmation with the fresh revision', async () => {
  env.api.skillsMovePreview.mockResolvedValue({ success: true, data: { fromPath: '/a/sample', toPath: '/b/sample' } })
  const { render, props } = card()
  button(render(), 'More').props.onClick(); button(render(), 'Move to workspace').props.onClick()
  expect(button(render(), 'Global (all spaces)')).toBeDefined()
  expect(button(render(), 'Halo')).toBeDefined()
  button(render(), 'No installs').props.onClick(); await settle()
  expect(env.api.skillsMovePreview).toHaveBeenCalledOnce()
  expect(env.api.skillsMovePreview).toHaveBeenCalledWith({ ref: { spaceId: 'a', id: 'copy-a' }, spaceId: 'b' })
  expect(env.confirm).toHaveBeenCalledOnce()
  expect(env.confirm.mock.calls[0][0].message).toContain('No installs')
  expect(env.api.skillsMove).toHaveBeenCalledOnce()
  expect(env.api.skillsMove).toHaveBeenCalledWith({ ref: { spaceId: 'a', id: 'copy-a' }, spaceId: 'b', revision: 'rev-2' })
  expect(props.onChanged).toHaveBeenCalledOnce()
  expect(props.onOpen).not.toHaveBeenCalled()
})

it('cancels card deletion without mutation and trashes only that copy after one confirmation', async () => {
  env.list.mockResolvedValue({ success: true, data: inventory() })
  const { render, props } = card()
  env.confirm.mockResolvedValueOnce(false)
  button(render(), 'More').props.onClick(); button(render(), 'Delete').props.onClick(); await settle()
  expect(env.api.skillsDelete).not.toHaveBeenCalled()
  expect(props.onChanged).not.toHaveBeenCalled()
  button(render(), 'More').props.onClick(); button(render(), 'Delete').props.onClick(); await settle()
  expect(env.confirm).toHaveBeenCalledTimes(2)
  expect(env.confirm.mock.calls[1][0].message).toContain('Trash')
  expect(env.confirm.mock.calls[1][0].message).not.toContain('/a/sample/SKILL.md')
  expect(env.api.skillsDelete).toHaveBeenCalledOnce()
  expect(env.api.skillsDelete).toHaveBeenCalledWith({ ref: { spaceId: 'a', id: 'copy-a' }, revision: 'rev-2' })
  expect(props.onChanged).toHaveBeenCalledOnce()
})

it('keeps version and update available without opening the detail', () => {
  const update = { appId: 'installed', latestVersion: '2.0', entry: { slug: 'sample' } }
  env.updates = [update]
  const { render, props } = card({ ...group('sample'), effectiveId: 'copy-a', copies: [{ ...copy(), appId: 'installed', version: '1.0' }] })
  expect(text(render())).toContain('v1.0')
  const stopPropagation = vi.fn()
  button(render(), 'Update to v2.0').props.onClick({ stopPropagation })
  expect(stopPropagation).toHaveBeenCalledOnce()
  expect(env.updateFlow).toHaveBeenLastCalledWith(update.entry, update, undefined, props.onChanged)
  expect(env.updateStart).toHaveBeenCalledOnce()
  expect(props.onOpen).not.toHaveBeenCalled()
})

it('omits host folder operations for remote clients', () => {
  env.desktop = false
  const { render } = card()
  button(render(), 'More').props.onClick()
  expect(text(render())).not.toContain('Open skill folder')
  expect(button(render(), 'Move to workspace')).toBeDefined()
  expect(button(render(), 'Delete')).toBeDefined()
})

it('keeps healthy cards accessible when another skill warns without leaking its raw failure', async () => {
  const value = inventory([group('healthy')]); value.warnings = ['ENOENT: /private/broken/SKILL.md']
  env.list.mockResolvedValue({ success: true, data: value })
  const run = runner(); const onOpen = vi.fn()
  const render = () => run.render(() => SkillCardWall({ spaceMap: {}, onOpen, onManualAdd: vi.fn(), onBrowseStore: vi.fn() }))
  render(); run.flush(); await settle()
  expect(text(render())).toContain('Some skills could not be loaded. Your other skills are still available.')
  expect(text(render())).not.toMatch(/ENOENT|\/private\/broken/)
  nodes(render()).find(node => node.type === SkillCard).props.onOpen()
  expect(onOpen).toHaveBeenCalledWith(value.groups[0], 'a')
})

it('refreshes the selected wall scope after a card action without scanning other workspaces', async () => {
  env.list.mockResolvedValue({ success: true, data: inventory([group('sample')]) })
  const run = runner()
  const render = () => run.render(() => SkillCardWall({ spaceMap: {}, onOpen: vi.fn(), onManualAdd: vi.fn(), onBrowseStore: vi.fn() }))
  render(); render(); run.flush(); await settle()
  expect(env.list).toHaveBeenCalledOnce()
  const item = nodes(render()).find(node => node.type === SkillCard)
  expect(item.props.contextSpaceId).toBe('a')
  item.props.onChanged()
  render(); run.flush(); await settle()
  expect(env.list).toHaveBeenCalledTimes(2)
  expect(env.list.mock.calls.map(([query]) => query.spaceId)).toEqual(['a', 'a'])
})

it('removes menu listeners on Escape and unmount without reopening the card', () => {
  const { render, run, props } = card()
  button(render(), 'More').props.onClick(); render(); run.flush()
  const keydown = vi.mocked(document.addEventListener).mock.calls.find(([name]) => name === 'keydown')![1] as (event: any) => void
  const stopPropagation = vi.fn()
  keydown({ key: 'Escape', stopPropagation })
  render(); run.flush()
  expect(button(render(), 'More').props['aria-expanded']).toBe(false)
  expect(stopPropagation).toHaveBeenCalledOnce()
  expect(document.removeEventListener).toHaveBeenCalledWith('keydown', keydown)
  button(render(), 'More').props.onClick(); render(); run.flush(); run.unmount()
  expect(document.removeEventListener).toHaveBeenCalledTimes(4)
  expect(props.onOpen).not.toHaveBeenCalled()
})

it('does not apply action completion or errors to a card that has unmounted', async () => {
  const pending = deferred(); env.api.skillsDelete.mockReturnValueOnce(pending.promise)
  env.list.mockResolvedValue({ success: true, data: inventory() })
  const run = runner(); const changed = vi.fn(); const removed = vi.fn()
  const render = () => run.render(() => useSkillActions({ spaceId: 'a', id: 'copy-a' }, changed, removed))
  render(); run.flush()
  const action = render().remove(); await settle()
  expect(env.api.skillsDelete).toHaveBeenCalledOnce()
  run.unmount()
  pending.resolve({ success: false, error: 'ENOENT: /a/sample/SKILL.md' }); await action
  expect(changed).not.toHaveBeenCalled(); expect(removed).not.toHaveBeenCalled()
  expect(render().error).toBeNull()
})

it('does not let an old action close a new selection and releases the busy state', async () => {
  const pending = deferred(); env.api.skillsDelete.mockReturnValueOnce(pending.promise)
  env.list.mockResolvedValue({ success: true, data: inventory() })
  const run = runner(); const changed = vi.fn(); const removed = vi.fn()
  let ref = { spaceId: 'a', id: 'copy-a' }
  const render = () => run.render(() => useSkillActions(ref, changed, removed))
  render(); run.flush()
  const action = render().remove(); await settle()
  expect(env.api.skillsDelete).toHaveBeenCalledWith({ ref: { spaceId: 'a', id: 'copy-a' }, revision: 'rev-2' })
  ref = { spaceId: 'b', id: 'copy-b' }; render(); run.flush()
  pending.resolve({ success: true }); await action
  expect(changed).not.toHaveBeenCalled(); expect(removed).not.toHaveBeenCalled()
  expect(render()).toMatchObject({ busy: false, error: null })
})

it('does not leak an old action failure into another selected skill', async () => {
  const pending = deferred(); env.api.skillsOpenFolder.mockReturnValueOnce(pending.promise)
  const run = runner(); let ref = { spaceId: 'a', id: 'copy-a' }
  const render = () => run.render(() => useSkillActions(ref, vi.fn()))
  render(); run.flush(); const action = render().openFolder()
  ref = { spaceId: 'b', id: 'copy-b' }; render(); run.flush()
  pending.resolve({ success: false, error: 'ENOENT: /a/sample/SKILL.md' }); await action
  expect(render()).toMatchObject({ busy: false, error: null })
})
