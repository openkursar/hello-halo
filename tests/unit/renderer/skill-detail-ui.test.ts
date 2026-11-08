import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { useSkillInventory } from '../../../src/renderer/hooks/useSkillInventory'

const env = vi.hoisted(() => ({
  runner: null as any, api: {} as any, confirm: vi.fn(), navigate: vi.fn(), composer: vi.fn(), load: vi.fn(), inventory: vi.fn(),
  desktop: false, updates: [] as any[], updateStart: vi.fn(), updateFlow: vi.fn(), locale: 'en',
  t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values?.[key] ?? '')),
}))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useRef: (value: any) => env.runner.ref(value),
  useMemo: (fn: any, deps: unknown[]) => env.runner.memo(fn, deps),
  useCallback: (fn: any, deps: unknown[]) => env.runner.memo(() => fn, deps),
  useEffect: (fn: any, deps: unknown[]) => env.runner.effect(fn, deps),
}))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/api/transport', () => ({ isElectron: () => env.desktop }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: env.t }), getCurrentLanguage: () => env.locale }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: (select: any) => select({ currentSpace: { id: 'a' }, haloSpace: null, spaces: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Empty workspace' }] }) }))
vi.mock('../../../src/renderer/stores/apps-page.store', () => ({ useAppsPageStore: (select: any) => select({ availableUpdates: env.updates }) }))
vi.mock('../../../src/renderer/components/store/useStoreUpdateFlow', () => ({ useStoreUpdateFlow: env.updateFlow }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: { getState: () => ({ loadConversations: env.load }) } }))
vi.mock('../../../src/renderer/hooks/useConfirmDialog', () => ({ useConfirmDialog: () => ({ showConfirm: env.confirm, DialogComponent: null }) }))
vi.mock('../../../src/renderer/hooks/useSkillInventory', () => ({ useSkillInventory: env.inventory }))
vi.mock('../../../src/renderer/utils/conversation-navigation', () => ({ navigateToConversation: env.navigate, openSkillInComposer: env.composer }))
vi.mock('../../../src/renderer/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }))
vi.mock('../../../src/renderer/components/canvas/viewers/CodeMirrorEditor', () => ({ CodeMirrorEditor: () => null }))
vi.mock('../../../src/renderer/components/store/ShareCurrentAppDialog', () => ({ ShareCurrentAppDialog: () => null }))
vi.mock('../../../src/renderer/components/apps/CapabilityStoreDialog', () => ({ CapabilityStoreDialog: () => null }))
vi.mock('../../../src/renderer/components/apps/SkillInstallDialog', () => ({ SkillInstallDialog: () => null }))
import { SkillInfoCard } from '../../../src/renderer/components/apps/SkillInfoCard'
import { SkillCopyDialog } from '../../../src/renderer/components/apps/SkillCopyDialog'
import { ExistingSkillDialog } from '../../../src/renderer/components/apps/ExistingSkillDialog'
import { LegacySkillsDialog } from '../../../src/renderer/components/apps/LegacySkillsDialog'
import { AppSkillsSection } from '../../../src/renderer/components/apps/AppSkillsSection'
import { CodeMirrorEditor } from '../../../src/renderer/components/canvas/viewers/CodeMirrorEditor'
import { MarkdownRenderer } from '../../../src/renderer/components/chat/MarkdownRenderer'
import { ShareCurrentAppDialog } from '../../../src/renderer/components/store/ShareCurrentAppDialog'

function sameDeps(left: unknown[], right: unknown[]) { return left.length === right.length && left.every((value, index) => Object.is(value, right[index])) }
class Runner {
  values: any[] = []; index = 0
  effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>()
  pending = new Map<number, () => void>()
  state(initial: any) { const index = this.index++; if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial; return [this.values[index], (value: any) => { this.values[index] = typeof value === 'function' ? value(this.values[index]) : value }] }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  memo(fn: () => unknown, deps: unknown[]) {
    const index = this.index++
    if (!this.values[index] || !sameDeps(deps, this.values[index].deps)) this.values[index] = { deps, value: fn() }
    return this.values[index].value
  }
  effect(fn: () => void | (() => void), deps: unknown[]) {
    const index = this.index++; const previous = this.effects.get(index)
    if (previous && sameDeps(deps, previous.deps)) { this.pending.delete(index); return }
    this.pending.set(index, () => { previous?.cleanup?.(); this.effects.set(index, { deps, cleanup: fn() || undefined }) })
  }
  render<T>(fn: () => T) { this.index = 0; env.runner = this; return fn() }
  flush() { const effects = [...this.pending.values()]; this.pending.clear(); effects.forEach(fn => fn()) }
  unmount() { this.pending.clear(); this.effects.forEach(effect => effect.cleanup?.()); this.effects.clear() }
}
const runners: Runner[] = []
function setup(component: any, props: any) { const run = new Runner(); runners.push(run); return { run, props, render: () => run.render(() => component(props)) } }
function nodes(tree: any): any[] { return !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)] }
function text(tree: any): string { return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : Array.isArray(tree) ? tree.map(text).join('') : text(tree?.props?.children ?? '') }
function button(tree: any, label: string) { const node = nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label)); expect(node, label).toBeDefined(); return node }
function more(render: () => any, label: string) { button(render(), 'More').props.onClick(); return button(render(), label) }
function editor(tree: any) { return nodes(tree).find(node => node.type === CodeMirrorEditor) }
function instructions(tree: any) { return nodes(tree).find(node => node.type === MarkdownRenderer)?.props.content }
function alert(tree: any) { return text(nodes(tree).find(node => node.props.role === 'alert')) }
const settle = () => setImmediate()
function deferred() { let resolve!: (value: any) => void; const promise = new Promise(res => { resolve = res }); return { promise, resolve } }
function detail(id = 'copy-a') { return { copy: { id, name: 'review', displayName: id, description: 'Review code', scope: 'space', spaceId: 'a', path: `/a/${id}/SKILL.md`, owners: [], source: 'personal', enabled: true, editable: true, availability: 'available', isLink: false, revision: 'rev-1' }, content: 'Original', revision: 'rev-1', files: [], spec: {} } }
async function card(extra = {}) { const result = setup(SkillInfoCard, { skillRef: { spaceId: 'a', id: 'copy-a' }, onChanged: vi.fn(), onDeleted: vi.fn(), ...extra }); result.render(); result.run.flush(); await settle(); return result }
async function openSkillRow(render: () => any) {
  const row = nodes(render()).find(node => node.props.group && node.props.onOpen)
  const child = setup(row.type, row.props)
  button(child.render(), row.props.group.copies[0].displayName).props.onClick()
  child.render(); child.run.flush(); await settle()
  const tree = child.render()
  const content = nodes(tree)
  const link = button(tree, 'Open skill detail')
  expect(content.findIndex(node => node.type === MarkdownRenderer)).toBeLessThan(content.indexOf(link))
  link.props.onClick()
}
beforeEach(() => {
  vi.clearAllMocks()
  env.desktop = false; env.updates = []; env.locale = 'en'
  env.updateFlow.mockReturnValue({ busy: false, dialogs: null, start: env.updateStart })
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  for (const method of ['skillsList', 'skillsRead', 'skillsSave', 'skillsDelete', 'skillsMovePreview', 'skillsMove', 'skillsCopy', 'skillsSetEnabled', 'skillsOpenFolder', 'skillsDeleteLegacy', 'skillsRestoreLegacy', 'createConversation', 'sendMessage']) env.api[method] = vi.fn().mockResolvedValue({ success: true })
  env.api.skillsRead.mockResolvedValue({ success: true, data: detail() })
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [{ name: 'review', effectiveId: 'copy-a', copies: [detail().copy] }], warnings: [], truncated: false } })
  env.confirm.mockResolvedValue(true)
  env.inventory.mockReturnValue({ data: { groups: [], warnings: [], total: 0 }, loading: false, error: null, refresh: vi.fn() })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { runners.splice(0).forEach(run => run.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps failed save drafts and the edit-start revision after refreshing disk content', async () => {
  const { render, run, props } = await card()
  button(render(), 'Edit').props.onClick(); editor(render()).props.onChange('Unsaved draft')
  env.api.skillsRead.mockResolvedValue({ success: true, data: { ...detail(), content: 'External edit', revision: 'rev-2' } })
  more(render, 'Refresh').props.onClick(); render(); run.flush(); await settle()
  env.api.skillsSave.mockResolvedValue({ success: false, error: 'Concurrent edit' })
  button(render(), 'Save').props.onClick(); await settle()
  expect(env.api.skillsSave).toHaveBeenCalledWith({ ref: { spaceId: 'a', id: 'copy-a' }, content: 'Unsaved draft', revision: 'rev-1' })
  expect(editor(render()).props.content).toBe('Unsaved draft')
  expect(alert(render())).toContain('This skill was changed elsewhere. Your draft is kept; reload the file before saving again.')
  expect(alert(render())).not.toContain('Concurrent edit')
  expect(props.onDeleted).not.toHaveBeenCalled()
  button(render(), 'Save custom copy').props.onClick()
  expect(nodes(render()).find(node => node.type === SkillCopyDialog).props.content).toBe('Unsaved draft')
})

it('saves once with the exact revision and leaves edit mode only after success', async () => {
  const { render, props } = await card()
  button(render(), 'Edit').props.onClick(); editor(render()).props.onChange('Changed')
  const pending = deferred(); env.api.skillsSave.mockReturnValue(pending.promise)
  const save = button(render(), 'Save').props.onClick; save(); save(); await settle()
  expect(env.api.skillsSave).toHaveBeenCalledOnce(); expect(editor(render()).props.content).toBe('Changed')
  pending.resolve({ success: true, data: { ...detail(), content: 'Changed', revision: 'rev-2' } }); await settle()
  expect(editor(render())).toBeUndefined(); expect(props.onChanged).toHaveBeenCalledOnce()
})

it('uses one copy-specific delete confirmation and cancellation never calls delete', async () => {
  const { render, props } = await card()
  env.confirm.mockResolvedValueOnce(false)
  button(render(), 'Delete').props.onClick(); await settle()
  expect(env.api.skillsDelete).not.toHaveBeenCalled()
  expect(env.confirm).toHaveBeenCalledOnce()
  expect(env.confirm.mock.calls[0][0]).toMatchObject({ title: 'Delete this skill?', confirmLabel: 'Delete', variant: 'danger' })
  expect(env.confirm.mock.calls[0][0].message).toContain('copy-a')
  expect(env.confirm.mock.calls[0][0].message).toContain('Trash')
  expect(env.confirm.mock.calls[0][0].message).not.toContain('/a/copy-a/SKILL.md')
  button(render(), 'Delete').props.onClick(); await settle()
  expect(env.confirm).toHaveBeenCalledTimes(2)
  expect(env.api.skillsDelete).toHaveBeenCalledOnce()
  expect(env.api.skillsDelete).toHaveBeenCalledWith({ ref: { spaceId: 'a', id: 'copy-a' }, revision: 'rev-1' })
  expect(props.onDeleted).toHaveBeenCalledOnce()
})

it('rejects move preview conflicts before confirmation and mutation', async () => {
  const { render } = await card()
  env.api.skillsMovePreview.mockResolvedValue({ success: true, data: { conflict: 'Destination exists: /b/review/SKILL.md' } })
  button(render(), 'Change workspace').props.onClick()
  button(render(), 'Empty workspace').props.onClick(); await settle()
  expect(env.api.skillsMovePreview).toHaveBeenCalledWith({ ref: { spaceId: 'a', id: 'copy-a' }, spaceId: 'b' })
  expect(env.confirm).not.toHaveBeenCalled(); expect(env.api.skillsMove).not.toHaveBeenCalled()
  expect(alert(render())).toContain('A skill with this name already exists there. Choose another name or workspace.')
  expect(alert(render())).not.toContain('/b/review/SKILL.md')
})

it('uses a new conversation and composer without automatically sending', async () => {
  env.api.createConversation.mockResolvedValue({ success: true, data: { id: 'new-chat' } })
  const { render } = await card()
  more(render, 'Use in a new conversation').props.onClick(); await settle()
  expect(env.api.createConversation).toHaveBeenCalledWith('a')
  expect(env.load).toHaveBeenCalledWith('a'); expect(env.navigate).toHaveBeenCalledWith('a', 'new-chat')
  expect(env.composer).toHaveBeenCalledWith({ spaceId: 'a', name: 'review', description: 'Review code' })
  expect(env.api.sendMessage).not.toHaveBeenCalled()
})

it('refuses both Use actions when the actual workspace selects another copy', async () => {
  const { render } = await card({ skillRef: { spaceId: null, id: 'copy-a' } })
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [{ name: 'review', effectiveId: 'other', copies: [{ ...detail('other').copy, path: '/actual/other/SKILL.md' }] }], warnings: [], truncated: false } })
  button(render(), 'Use').props.onClick(); await settle()
  expect(env.api.skillsList).toHaveBeenLastCalledWith({ spaceId: 'a', q: 'review', limit: 100 })
  expect(env.composer).not.toHaveBeenCalled()
  more(render, 'Use in a new conversation').props.onClick(); await settle()
  expect(env.api.createConversation).not.toHaveBeenCalled()
  expect(alert(render())).toContain('different version of this skill')
})

it('deletes the resolved copy rather than the legacy app route and uses its latest revision', async () => {
  const { render } = await card({ skillRef: undefined, appId: 'old-install' })
  env.api.skillsRead.mockResolvedValue({ success: true, data: { ...detail(), revision: 'fresh-revision', copy: { ...detail().copy, isLink: true } } })
  button(render(), 'Delete').props.onClick(); await settle()
  expect(env.api.skillsRead).toHaveBeenLastCalledWith({ spaceId: 'a', id: 'copy-a' })
  expect(env.api.skillsDelete).toHaveBeenCalledWith({ ref: { spaceId: 'a', id: 'copy-a' }, revision: 'fresh-revision' })
  expect(env.confirm).toHaveBeenCalledOnce()
  expect(env.confirm.mock.calls[0][0].message).toContain('Only this skill’s link will move to the Trash. The original files will be kept.')
})

it('refreshes fallback copies before deleting even through an old app route', async () => {
  const { render } = await card({ skillRef: undefined, appId: 'old-install' })
  const global = { ...detail('global').copy, scope: 'global', spaceId: null, availability: 'overridden' }
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [{ name: 'review', copies: [detail().copy, global] }], warnings: [], truncated: false } })
  env.confirm.mockResolvedValue(false)
  button(render(), 'Delete').props.onClick(); await settle()
  expect(env.confirm.mock.calls[0][0].message).toContain('The global version will still be available in this workspace.')
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [{ name: 'review', copies: [detail().copy] }], warnings: [], truncated: false } })
  button(render(), 'Delete').props.onClick(); await settle()
  expect(env.confirm.mock.calls[1][0].message).not.toContain('The global version will still be available in this workspace.')
})

it('allows invalid instructions to be repaired without presenting engine internals', async () => {
  env.api.skillsRead.mockResolvedValue({ success: true, data: { ...detail(), copy: { ...detail().copy, availability: 'invalid', editable: true } } })
  const { render } = await card()
  expect(button(render(), 'Edit').props.disabled).toBe(false)
  expect(button(render(), 'Disable').props.disabled).toBe(false)
  expect(text(render())).toContain('This skill has invalid instructions.')
  expect(nodes(render()).some(node => node.type === 'button' && text(node) === 'Use')).toBe(false)
  expect(text(render())).not.toMatch(/Halo SDK availability|Engine support/)
})

it('keeps missing records actionable without exposing a filesystem exception', async () => {
  env.api.skillsRead.mockResolvedValue({ success: true, data: { ...detail(), content: '', files: [], revision: 'missing', copy: { ...detail().copy, availability: 'missing', editable: false } } })
  const { render } = await card()
  expect(text(render())).toContain('The skill file could not be found.')
  expect(button(render(), 'Disable').props.disabled).toBe(false)
  expect(button(render(), 'Delete').props.disabled).toBe(false)
  expect(button(render(), 'Edit').props.disabled).toBe(true)
  button(render(), 'Delete').props.onClick(); await settle()
  expect(env.confirm.mock.calls[0][0].message).toContain('Remove this entry from your library?')
  expect(env.api.skillsDelete).toHaveBeenCalledWith({ ref: { id: 'copy-a', spaceId: 'a' }, revision: 'missing' })
})

it.each(['personal', 'store', 'digital-human', 'builtin'])('prioritizes instructions without private paths or engine warnings for %s skills', async source => {
  env.api.skillsRead.mockResolvedValue({ success: true, data: { ...detail(), copy: { ...detail().copy, source } } })
  const { render } = await card()
  expect(instructions(render())).toBe('Original')
  expect(text(render())).toContain('Review code')
  expect(text(render())).not.toMatch(/Engine support|Halo SDK availability|private folders|Claude Code|Codex|dsh|\/a\/copy-a\/SKILL\.md/)
})

it('clears old digital-human selection and pagination on a workspace change', async () => {
  const group = { name: 'review', displayName: 'Review', copies: [detail().copy] }
  env.inventory.mockReturnValue({ data: { groups: [group], warnings: [], total: 100 }, refresh: vi.fn(), loading: false })
  const { render, props } = setup(AppSkillsSection, { appId: 'person-a', spaceId: 'a' })
  button(render(), 'Next').props.onClick()
  await openSkillRow(render)
  props.appId = 'person-b'; props.spaceId = 'b'
  expect(nodes(render()).some(node => node.type === SkillInfoCard)).toBe(false)
  render()
  expect(env.inventory).toHaveBeenLastCalledWith({ spaceId: 'b', q: '', offset: 0, limit: 50 })
})

it('resolves legacy appId through unified read without installed app data', async () => {
  await card({ skillRef: undefined, appId: 'old-install' })
  expect(env.api.skillsRead).toHaveBeenCalledWith({ spaceId: 'a', id: 'app:old-install' })
})

it('preserves custom-copy fields on failure and submits the draft without changing the original', async () => {
  const props = { skillRef: { spaceId: 'a', id: 'copy-a' }, name: 'review', content: 'Unsaved', spaceId: 'a', onClose: vi.fn(), onSaved: vi.fn() }
  const { render } = setup(SkillCopyDialog, props)
  nodes(render()).find(node => node.type === 'input').props.onChange({ target: { value: 'my-copy' } })
  nodes(render()).find(node => node.type === 'select').props.onChange({ target: { value: 'b' } })
  env.api.skillsCopy.mockResolvedValueOnce({ success: false, error: 'Offline' })
  await button(render(), 'Save custom copy').props.onClick()
  expect(props.onClose).not.toHaveBeenCalled(); expect(props.onSaved).not.toHaveBeenCalled()
  expect(nodes(render()).find(node => node.type === 'input').props.value).toBe('my-copy')
  expect(nodes(render()).find(node => node.type === 'select').props.value).toBe('b')
  await button(render(), 'Save custom copy').props.onClick()
  expect(env.api.skillsCopy).toHaveBeenLastCalledWith({ ref: props.skillRef, spaceId: 'b', name: 'my-copy', content: 'Unsaved' })
  expect(env.api.skillsSave).not.toHaveBeenCalled(); expect(props.onSaved).toHaveBeenCalledOnce()
})

it('copies existing skills from an empty-install workspace using inventory identities', async () => {
  env.inventory.mockReturnValue({ data: { groups: [{ copies: [{ ...detail().copy, spaceId: 'b' }] }], total: 1 }, loading: false })
  const props = { spaceId: 'a', onClose: vi.fn(), onAdded: vi.fn() }
  const { render } = setup(ExistingSkillDialog, props)
  expect(nodes(render()).filter(node => node.type === 'option').map(node => node.props.value)).toContain('b')
  nodes(render()).find(node => node.type === 'select').props.onChange({ target: { value: 'b' } })
  await button(render(), 'Copy to this workspace').props.onClick()
  expect(env.api.skillsCopy).toHaveBeenCalledWith({ ref: { spaceId: 'b', id: 'copy-a' }, spaceId: 'a', name: 'review' })
  expect(props.onAdded).toHaveBeenCalledOnce()
})

it('keeps failed legacy recovery rows and removes only successfully processed content', async () => {
  const props = { skills: [{ appId: 'old', spaceId: 'a', name: 'Old', description: '' }], onClose: vi.fn(), onChanged: vi.fn() }
  const { render } = setup(LegacySkillsDialog, props)
  env.api.skillsRestoreLegacy.mockResolvedValueOnce({ success: false, error: 'Unavailable' })
  button(render(), 'Save as my skill').props.onClick(); await settle()
  expect(button(render(), 'Save as my skill')).toBeDefined(); expect(props.onChanged).not.toHaveBeenCalled()
  env.confirm.mockResolvedValueOnce(false); button(render(), 'Delete').props.onClick(); await settle()
  expect(env.api.skillsDeleteLegacy).not.toHaveBeenCalled()
  button(render(), 'Save as my skill').props.onClick(); await settle()
  expect(env.api.skillsRestoreLegacy).toHaveBeenLastCalledWith({ appId: 'old', spaceId: 'a' })
  expect(props.onChanged).toHaveBeenCalledOnce()
})

it('opens inventory-backed shared settings without fabricating installed apps', async () => {
  const group = { name: 'review', displayName: 'Review', description: '', effectiveId: 'copy-a', copies: [detail().copy] }
  env.inventory.mockReturnValue({ data: { groups: [group], warnings: [], total: 1 }, refresh: vi.fn(), loading: false })
  const { render } = setup(AppSkillsSection, { appId: 'person', spaceId: 'b' })
  await openSkillRow(render)
  expect(nodes(render()).find(node => node.type === SkillInfoCard).props).toMatchObject({ skillRef: { spaceId: 'b', id: 'copy-a' }, showUse: false, group })
  expect(env.inventory).toHaveBeenCalledWith({ spaceId: 'b', q: '', offset: 0, limit: 50 })
})

it('shows the prior empty state without a zero total when a workspace has no skills', () => {
  env.inventory.mockReturnValue({ data: { groups: [], warnings: [], total: 0 }, refresh: vi.fn(), loading: false })
  const { render } = setup(AppSkillsSection, { appId: 'person', spaceId: 'a' })
  const shown = text(render())
  expect(shown).toContain('No skills available in this workspace yet.')
  expect(shown).not.toContain('(0)')
  expect(shown).not.toContain('No matching skills.')
  expect(nodes(render()).some(node => node.type === 'button' && text(node).includes('Browse skill store'))).toBe(true)
})

it('keeps the known total when skills exist and reports an empty search separately', () => {
  const group = { name: 'review', displayName: 'Review', copies: [detail().copy] }
  env.inventory.mockReturnValue({ data: { groups: [group], warnings: [], total: 3 }, refresh: vi.fn(), loading: false })
  expect(text(setup(AppSkillsSection, { appId: 'person', spaceId: 'a' }).render())).toContain('(3)')
  env.inventory.mockReturnValue({ data: { groups: [], warnings: [], total: 0 }, refresh: vi.fn(), loading: false })
  const searched = setup(AppSkillsSection, { appId: 'person', spaceId: 'a' })
  searched.render()
  const input = nodes(searched.render()).find(node => node.type === 'input')
  input.props.onChange({ target: { value: 'nothing' } })
  const shown = text(searched.render())
  expect(shown).toContain('No matching skills.')
  expect(shown).not.toContain('No skills available in this workspace yet.')
})

it.each([
  { mcps: ['github', 'slack'], names: 'github, slack' },
  { mcps: [{ id: 'github' }, { id: 'slack', reason: 'Send updates' }], names: 'github, slack' },
  { mcps: ['github', { id: 'slack' }], names: 'github, slack' },
])('loads connection names from the expanded preview without another lookup: $mcps', async ({ mcps, names }) => {
  const group = { name: 'review', displayName: 'Review', copies: [detail().copy] }
  env.inventory.mockReturnValue({ data: { groups: [group], warnings: [], total: 1 }, refresh: vi.fn(), loading: false })
  env.api.skillsRead.mockResolvedValue({ success: true, data: { ...detail(), spec: { requires: { mcps } } } })
  const parent = setup(AppSkillsSection, { appId: 'person', spaceId: 'a' })
  const row = nodes(parent.render()).find(node => node.props.group && node.props.onOpen)
  const child = setup(row.type, row.props)
  child.render(); child.run.flush()
  expect(env.api.skillsRead).not.toHaveBeenCalled()
  expect(text(child.render())).not.toContain('Required connections')
  button(child.render(), 'copy-a').props.onClick()
  child.render(); child.run.flush(); await settle()
  const tree = child.render()
  expect(env.api.skillsRead).toHaveBeenCalledOnce()
  expect(env.api.skillsRead).toHaveBeenCalledWith({ spaceId: 'a', id: 'copy-a' })
  expect(text(tree)).toContain(`Required connections: ${names}`)
  expect(text(tree)).not.toMatch(/Required connections: 2|\[object Object\]/)
  expect(instructions(tree)).toBe('Original')
  expect(nodes(tree).findIndex(node => node.type === MarkdownRenderer)).toBeLessThan(nodes(tree).indexOf(button(tree, 'Open skill detail')))
  child.run.flush(); child.render()
  expect(env.api.skillsRead).toHaveBeenCalledOnce()
  expect(env.api.skillsList).not.toHaveBeenCalled()
})

it('opens a collapsed digital-human skill folder without reading or expanding its instructions', async () => {
  env.desktop = true
  const global = { ...detail('opaque-global').copy, scope: 'global', spaceId: null }
  const group = { name: 'review', effectiveId: global.id, copies: [detail().copy, global] }
  const changed = vi.fn(); const onOpen = vi.fn()
  env.inventory.mockReturnValue({ data: { groups: [group], total: 1 }, refresh: changed, loading: false })
  const parent = setup(AppSkillsSection, { appId: 'person', spaceId: 'a' })
  const row = nodes(parent.render()).find(node => node.props.group && node.props.onOpen)
  const { render, run } = setup(row.type, { ...row.props, onOpen })
  render(); run.flush()
  const pending = deferred(); env.api.skillsOpenFolder.mockReturnValueOnce(pending.promise)
  const stopPropagation = vi.fn()
  const openFolder = button(render(), 'Open skill folder').props.onClick
  openFolder({ stopPropagation }); openFolder({ stopPropagation })
  expect(stopPropagation).toHaveBeenCalledTimes(2)
  expect(button(render(), 'Open skill folder').props.disabled).toBe(true)
  expect(env.api.skillsOpenFolder).toHaveBeenCalledOnce()
  expect(env.api.skillsOpenFolder).toHaveBeenCalledWith({ spaceId: 'a', id: 'opaque-global' })
  pending.resolve({ success: true }); await settle()
  render(); run.flush()
  expect(button(render(), 'Open skill folder').props.disabled).toBe(false)
  expect(button(render(), 'opaque-global').props['aria-expanded']).toBe(false)
  expect(instructions(render())).toBeUndefined()
  expect(env.api.skillsRead).not.toHaveBeenCalled()
  expect(env.api.skillsList).not.toHaveBeenCalled()
  expect(onOpen).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
})

it.each(['response', 'rejection'])('shows a folder %s failure on a collapsed row and permits retry without a preview read', async failure => {
  env.desktop = true
  const group = { name: 'review', copies: [{ ...detail().copy, availability: 'invalid' }] }
  env.inventory.mockReturnValue({ data: { groups: [group], total: 1 }, refresh: vi.fn(), loading: false })
  const parent = setup(AppSkillsSection, { appId: 'person', spaceId: 'a' })
  const row = nodes(parent.render()).find(node => node.props.group && node.props.onOpen)
  const { render, run } = setup(row.type, row.props)
  render(); run.flush()
  const reason = 'EACCES: permission denied /private/review/SKILL.md'
  if (failure === 'response') env.api.skillsOpenFolder.mockResolvedValueOnce({ success: false, error: reason })
  else env.api.skillsOpenFolder.mockRejectedValueOnce(new Error(reason))
  expect(button(render(), 'Open skill folder').props.disabled).toBe(false)
  button(render(), 'Open skill folder').props.onClick({ stopPropagation: vi.fn() }); await settle()
  expect(alert(render())).toBe('Halo cannot access this skill folder. Check its permissions and try again.')
  expect(text(render())).not.toMatch(/EACCES|\/private\//)
  expect(button(render(), 'copy-a').props['aria-expanded']).toBe(false)
  expect(console.warn).toHaveBeenCalledOnce()
  button(render(), 'Open skill folder').props.onClick({ stopPropagation: vi.fn() }); await settle()
  expect(alert(render())).toBe('')
  expect(env.api.skillsOpenFolder).toHaveBeenCalledTimes(2)
  expect(env.api.skillsRead).not.toHaveBeenCalled()
  expect(env.api.skillsList).not.toHaveBeenCalled()
})

it('keeps a missing digital-human skill folder disabled without preloading its body', () => {
  env.desktop = true
  const group = { name: 'review', copies: [{ ...detail().copy, availability: 'missing' }] }
  env.inventory.mockReturnValue({ data: { groups: [group], total: 1 }, refresh: vi.fn(), loading: false })
  const parent = setup(AppSkillsSection, { appId: 'person', spaceId: 'a' })
  const row = nodes(parent.render()).find(node => node.props.group && node.props.onOpen)
  const { render, run } = setup(row.type, row.props)
  render(); run.flush()
  expect(button(render(), 'Open skill folder').props.disabled).toBe(true)
  expect(button(render(), 'copy-a').props['aria-expanded']).toBe(false)
  expect(env.api.skillsOpenFolder).not.toHaveBeenCalled()
  expect(env.api.skillsRead).not.toHaveBeenCalled()
})

it('hides the host folder action in the remote renderer branch while preserving row expansion', async () => {
  const group = { name: 'review', copies: [detail().copy] }
  env.inventory.mockReturnValue({ data: { groups: [group], total: 1 }, refresh: vi.fn(), loading: false })
  const parent = setup(AppSkillsSection, { appId: 'person', spaceId: 'a' })
  const row = nodes(parent.render()).find(node => node.props.group && node.props.onOpen)
  const { render, run } = setup(row.type, row.props)
  render(); run.flush()
  expect(nodes(render()).some(node => node.props['aria-label'] === 'Open skill folder')).toBe(false)
  expect(env.api.skillsRead).not.toHaveBeenCalled()
  button(render(), 'copy-a').props.onClick()
  render(); run.flush(); await settle()
  expect(button(render(), 'copy-a').props['aria-expanded']).toBe(true)
  expect(instructions(render())).toBe('Original')
  expect(button(render(), 'Open skill detail')).toBeDefined()
  expect(env.api.skillsRead).toHaveBeenCalledOnce()
  expect(env.api.skillsOpenFolder).not.toHaveBeenCalled()
  expect(env.api.skillsList).not.toHaveBeenCalled()
})

it('uses the paged inventory total including global skills without a count request or a fake loading zero', async () => {
  const actual = await vi.importActual<{ useSkillInventory: typeof useSkillInventory }>('../../../src/renderer/hooks/useSkillInventory')
  env.inventory.mockImplementation(actual.useSkillInventory)
  const first = deferred(); env.api.skillsList.mockReturnValueOnce(first.promise)
  const local = { name: 'review', copies: [detail().copy] }
  const global = { name: 'global', copies: [{ ...detail('global').copy, scope: 'global', spaceId: null }] }
  const data = { groups: [local, global], total: 73, offset: 0, limit: 50, warnings: [], truncated: false, legacyRemoved: [] }
  const { render, run } = setup(AppSkillsSection, { appId: 'person', spaceId: 'a' })
  const heading = () => text(nodes(render()).find(node => node.type === 'h3'))
  expect(heading()).toBe('Skills')
  run.flush()
  expect(heading()).toBe('Skills')
  first.resolve({ success: true, data }); await settle()
  expect(heading()).toBe('Skills(73)')
  expect(env.api.skillsList).toHaveBeenCalledOnce()
  expect(env.api.skillsList).toHaveBeenCalledWith({ spaceId: 'a', q: '', source: 'all', offset: 0, limit: 50 })
  const filtered = deferred(); env.api.skillsList.mockReturnValueOnce(filtered.promise)
  nodes(render()).find(node => node.type === 'input').props.onChange({ target: { value: 'global' } })
  expect(heading()).toBe('Skills')
  run.flush()
  filtered.resolve({ success: true, data: { ...data, groups: [global], total: 1 } }); await settle()
  expect(heading()).toBe('Skills(1)')
  expect(env.api.skillsList).toHaveBeenCalledTimes(2)
  expect(env.api.skillsList).toHaveBeenLastCalledWith({ spaceId: 'a', q: 'global', source: 'all', offset: 0, limit: 50 })
  expect(env.api.skillsRead).not.toHaveBeenCalled()
})

it('clears the previous total immediately on a workspace change and ignores its late refresh', async () => {
  const actual = await vi.importActual<{ useSkillInventory: typeof useSkillInventory }>('../../../src/renderer/hooks/useSkillInventory')
  env.inventory.mockImplementation(actual.useSkillInventory)
  const data = { groups: [], total: 73, offset: 0, limit: 50, warnings: [], truncated: false, legacyRemoved: [] }
  env.api.skillsList.mockResolvedValueOnce({ success: true, data })
  const { render, run, props } = setup(AppSkillsSection, { appId: 'person-a', spaceId: 'a' })
  const heading = () => text(nodes(render()).find(node => node.type === 'h3'))
  render(); run.flush(); await settle()
  expect(heading()).toBe('Skills(73)')
  const old = deferred(); env.api.skillsList.mockReturnValueOnce(old.promise)
  button(render(), 'Refresh').props.onClick()
  render(); run.flush()
  expect(heading()).toBe('Skills(73)')
  const current = deferred(); env.api.skillsList.mockReturnValueOnce(current.promise)
  props.appId = 'person-b'; props.spaceId = 'b'
  expect(heading()).toBe('Skills')
  render(); run.flush()
  old.resolve({ success: true, data: { ...data, total: 99 } }); await settle()
  expect(heading()).toBe('Skills')
  current.resolve({ success: true, data: { ...data, total: 5 } }); await settle()
  expect(heading()).toBe('Skills(5)')
  expect(env.api.skillsList.mock.calls.map(([query]: any[]) => query.spaceId)).toEqual(['a', 'a', 'b'])
  expect(env.api.skillsList).toHaveBeenLastCalledWith({ spaceId: 'b', q: '', source: 'all', offset: 0, limit: 50 })
  expect(env.api.skillsRead).not.toHaveBeenCalled()
})

it('does not expose the previous copy after a new detail request fails', async () => {
  const { render, run, props } = await card()
  props.skillRef = { spaceId: 'b', id: 'copy-b' }
  env.api.skillsRead.mockResolvedValue({ success: false, error: 'Unavailable' })
  render(); run.flush(); render(); run.flush(); await settle()
  expect(instructions(render())).toBeUndefined()
  expect(text(render())).not.toContain('copy-a')
  expect(alert(render())).toContain('Could not open this skill. Please try again.')
  expect(nodes(render()).some(node => node.type === 'button' && text(node) === 'Use')).toBe(false)
})

it('does not let a save response from the previous selection overwrite the current detail', async () => {
  const { render, run, props } = await card()
  button(render(), 'Edit').props.onClick(); editor(render()).props.onChange('Old draft')
  const pending = deferred(); env.api.skillsSave.mockReturnValue(pending.promise)
  button(render(), 'Save').props.onClick(); await settle()
  props.skillRef = { spaceId: 'b', id: 'copy-b' }
  env.api.skillsRead.mockResolvedValue({ success: true, data: { ...detail('copy-b'), content: 'Current instructions', copy: { ...detail('copy-b').copy, spaceId: 'b' } } })
  render(); run.flush(); render(); run.flush(); await settle()
  pending.resolve({ success: true, data: { ...detail(), content: 'Old draft' } }); await settle()
  expect(instructions(render())).toBe('Current instructions')
  expect(text(render())).toContain('copy-b')
  expect(text(render())).not.toContain('copy-a')
  expect(props.onChanged).not.toHaveBeenCalled()
  expect(props.onDeleted).not.toHaveBeenCalled()
})

it('keeps primary actions and author, version and scope visible while secondary actions stay in More', async () => {
  env.api.skillsRead.mockResolvedValue({ success: true, data: { ...detail(), spec: { author: 'Skill author', version: '1.2' } } })
  const { render } = await card()
  expect(text(render())).toContain('Skill author')
  expect(text(render())).toContain('v1.2')
  expect(text(button(render(), 'Change workspace'))).toContain('Alpha')
  expect(button(render(), 'Use').props.disabled).toBe(false)
  expect(button(render(), 'Disable').props.disabled).toBe(false)
  expect(button(render(), 'Share')).toBeDefined()
  expect(text(render())).not.toContain('Use in a new conversation')
  expect(text(render())).not.toContain('Save custom copy')
  button(render(), 'More').props.onClick()
  expect(button(render(), 'Use in a new conversation')).toBeDefined()
  expect(button(render(), 'Save custom copy')).toBeDefined()
  expect(button(render(), 'Refresh')).toBeDefined()
})

it('shares the current detail and keeps version update connected to its installation', async () => {
  const current = { ...detail(), copy: { ...detail().copy, appId: 'installed' }, spec: { author: 'Author', version: '1.0' } }
  const update = { appId: 'installed', latestVersion: '2.0', entry: { slug: 'review' } }
  env.updates = [update]
  env.api.skillsRead.mockResolvedValue({ success: true, data: current })
  const { render, run } = await card()
  button(render(), 'Share').props.onClick()
  expect(nodes(render()).find(node => node.type === ShareCurrentAppDialog).props).toMatchObject({ appId: 'installed', skillRef: { spaceId: 'a', id: 'copy-a' }, specOverride: current.spec })
  button(render(), 'Update to v2.0').props.onClick()
  expect(env.updateFlow).toHaveBeenLastCalledWith(update.entry, update, undefined, expect.any(Function))
  expect(env.updateStart).toHaveBeenCalledOnce()
  const reads = env.api.skillsRead.mock.calls.length
  env.updateFlow.mock.calls.at(-1)[3]()
  render(); run.flush(); await settle()
  expect(env.api.skillsRead.mock.calls.length).toBeGreaterThan(reads)
})

it('leaves other versions collapsed and targets the selected version for editing', async () => {
  const current = detail()
  const global = { ...detail('global'), content: 'Global instructions', revision: 'global-revision', copy: { ...detail('global').copy, scope: 'global', spaceId: null, availability: 'overridden' } }
  const group = { name: 'review', copies: [current.copy, global.copy], effectiveId: current.copy.id }
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [group], warnings: [], truncated: false } })
  const { render, run } = await card({ group })
  const versions = nodes(render()).find(node => node.type === 'details' && text(node).includes('Other versions'))
  expect(versions).toBeDefined(); expect(versions.props.open).not.toBe(true)
  expect(text(versions)).not.toContain('/a/')
  env.api.skillsRead.mockResolvedValue({ success: true, data: global })
  nodes(versions).find(node => node.type === 'button' && !node.props.disabled).props.onClick()
  render(); run.flush(); await settle()
  expect(env.api.skillsRead).toHaveBeenLastCalledWith({ spaceId: 'a', id: 'global' })
  expect(instructions(render())).toBe('Global instructions')
  button(render(), 'Edit').props.onClick(); editor(render()).props.onChange('Revised global instructions')
  env.api.skillsSave.mockResolvedValue({ success: true, data: { ...global, content: 'Revised global instructions' } })
  button(render(), 'Save').props.onClick(); await settle()
  expect(env.api.skillsSave).toHaveBeenCalledWith({ ref: { spaceId: 'a', id: 'global' }, revision: 'global-revision', content: 'Revised global instructions' })
})

it('toggles directly unless disabling would reveal a global fallback', async () => {
  const { render, props } = await card()
  button(render(), 'Disable').props.onClick(); await settle()
  expect(env.confirm).not.toHaveBeenCalled()
  expect(env.api.skillsSetEnabled).toHaveBeenCalledWith({ ref: { spaceId: 'a', id: 'copy-a' }, enabled: false })
  expect(props.onChanged).toHaveBeenCalledOnce()
  env.api.skillsSetEnabled.mockClear(); props.onChanged.mockClear()
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [{ name: 'review', copies: [detail().copy, { ...detail('global').copy, scope: 'global', spaceId: null, availability: 'overridden' }] }], warnings: [], truncated: false } })
  env.confirm.mockResolvedValueOnce(false)
  button(render(), 'Disable').props.onClick(); await settle()
  expect(env.confirm).toHaveBeenCalledOnce()
  expect(env.confirm.mock.calls[0][0].message).toBe('The global version will still be available in this workspace.')
  expect(env.api.skillsSetEnabled).not.toHaveBeenCalled()
  expect(props.onChanged).not.toHaveBeenCalled()
  button(render(), 'Disable').props.onClick(); await settle()
  expect(env.api.skillsSetEnabled).toHaveBeenCalledOnce()
})

it('uses the current enabled state instead of toggling a stale detail snapshot', async () => {
  const { render } = await card()
  env.api.skillsRead.mockResolvedValue({ success: true, data: { ...detail(), copy: { ...detail().copy, enabled: false, availability: 'disabled' } } })
  button(render(), 'Disable').props.onClick(); await settle()
  expect(env.api.skillsSetEnabled).toHaveBeenCalledWith({ ref: { spaceId: 'a', id: 'copy-a' }, enabled: true })
  expect(env.confirm).not.toHaveBeenCalled()
})

it('cancels save without losing the draft and never submits supporting file bytes', async () => {
  const files = [{ path: 'SKILL.md', binary: false, size: 10 }, { path: 'assets/image.png', binary: true, size: 4096 }]
  const originalFiles = structuredClone(files)
  const current = { ...detail(), files }
  env.api.skillsRead.mockResolvedValue({ success: true, data: current })
  const { render, props } = await card()
  button(render(), 'Edit').props.onClick(); editor(render()).props.onChange('Revised instructions')
  env.confirm.mockResolvedValueOnce(false)
  button(render(), 'Save').props.onClick(); await settle()
  expect(env.api.skillsSave).not.toHaveBeenCalled()
  expect(editor(render()).props.content).toBe('Revised instructions')
  expect(props.onChanged).not.toHaveBeenCalled()
  env.api.skillsSave.mockResolvedValue({ success: true, data: { ...current, content: 'Revised instructions' } })
  button(render(), 'Save').props.onClick(); await settle()
  expect(env.confirm).toHaveBeenCalledTimes(2)
  expect(env.api.skillsSave).toHaveBeenCalledWith({ ref: { spaceId: 'a', id: 'copy-a' }, content: 'Revised instructions', revision: 'rev-1' })
  expect(current.files).toEqual(originalFiles)
  expect(instructions(render())).toBe('Revised instructions')
  expect(text(render())).toContain('assets/image.png')
})

it('keeps current skill viewing and Use available despite another skill warning', async () => {
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [{ name: 'review', effectiveId: 'copy-a', copies: [detail().copy] }], warnings: ['ENOENT: /private/unrelated/SKILL.md'], truncated: false } })
  const { render } = await card()
  expect(instructions(render())).toBe('Original')
  expect(alert(render())).toBe('')
  expect(text(render())).not.toMatch(/ENOENT|\/private\/unrelated/)
  button(render(), 'Use').props.onClick(); await settle()
  expect(env.composer).toHaveBeenCalledWith({ spaceId: 'a', name: 'review', description: 'Review code' })
  expect(env.api.sendMessage).not.toHaveBeenCalled()
  expect(env.api.createConversation).not.toHaveBeenCalled()
})

it.each(['ENOENT: /private/review/SKILL.md', 'EACCES: permission denied /private/review/SKILL.md'])('presents a recoverable local error instead of %s', async failure => {
  env.api.skillsRead.mockResolvedValue({ success: false, error: failure })
  const { render } = await card()
  expect(alert(render())).toContain(failure.startsWith('ENOENT') ? 'The skill file could not be found.' : 'Halo cannot access this skill folder.')
  expect(alert(render())).not.toContain('/private/')
  expect(alert(render())).not.toMatch(/ENOENT|EACCES/)
  expect(button(render(), 'Retry')).toBeDefined()
  expect(instructions(render())).toBeUndefined()
})

it('moves only after confirming the selected scope and the fresh read revision', async () => {
  const { render, props } = await card()
  env.api.skillsRead.mockResolvedValue({ success: true, data: { ...detail(), revision: 'latest-revision' } })
  env.api.skillsMovePreview.mockResolvedValue({ success: true, data: { fromPath: '/a/review', toPath: '/b/review' } })
  env.confirm.mockResolvedValueOnce(false)
  button(render(), 'Change workspace').props.onClick(); button(render(), 'Empty workspace').props.onClick(); await settle()
  expect(env.api.skillsMove).not.toHaveBeenCalled()
  button(render(), 'Change workspace').props.onClick(); button(render(), 'Empty workspace').props.onClick(); await settle()
  expect(env.api.skillsMove).toHaveBeenCalledOnce()
  expect(env.api.skillsMove).toHaveBeenCalledWith({ ref: { spaceId: 'a', id: 'copy-a' }, spaceId: 'b', revision: 'latest-revision' })
  expect(props.onChanged).toHaveBeenCalledOnce()
  expect(props.onDeleted).toHaveBeenCalledOnce()
})

it.each([true, false])('ignores an obsolete detail read after a newer selection (success: %s)', async success => {
  const old = deferred(); env.api.skillsRead.mockReturnValueOnce(old.promise)
  const { render, run, props } = await card()
  props.skillRef = { spaceId: 'b', id: 'copy-b' }
  const current = { ...detail('copy-b'), content: 'New selection', copy: { ...detail('copy-b').copy, spaceId: 'b' } }
  env.api.skillsRead.mockResolvedValue({ success: true, data: current })
  render(); run.flush(); render(); run.flush(); await settle()
  old.resolve(success ? { success: true, data: { ...detail(), content: 'Obsolete instructions' } } : { success: false, error: 'ENOENT: /a/copy-a/SKILL.md' }); await settle()
  expect(instructions(render())).toBe('New selection')
  expect(alert(render())).toBe('')
  expect(text(render())).not.toContain('copy-a')
})

it('does not publish a save callback after the detail unmounts', async () => {
  const { render, run, props } = await card()
  button(render(), 'Edit').props.onClick(); editor(render()).props.onChange('Pending draft')
  const pending = deferred(); env.api.skillsSave.mockReturnValueOnce(pending.promise)
  button(render(), 'Save').props.onClick(); await settle(); run.unmount()
  pending.resolve({ success: true, data: detail() }); await settle()
  expect(props.onChanged).not.toHaveBeenCalled()
  expect(props.onDeleted).not.toHaveBeenCalled()
})

it('matches the command identity rather than another skill with the same display name', async () => {
  const current = detail(); current.copy.displayName = 'Shared title'
  const other = { ...detail('other').copy, name: 'review-other', displayName: 'Shared title' }
  env.api.skillsRead.mockResolvedValue({ success: true, data: current })
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [
    { name: 'review-other', displayName: 'Shared title', effectiveId: 'other', copies: [other] },
    { name: 'review', displayName: 'Shared title', effectiveId: 'copy-a', copies: [current.copy] },
  ], warnings: [], truncated: false } })
  const { render } = await card()
  button(render(), 'Use').props.onClick(); await settle()
  expect(env.composer).toHaveBeenCalledOnce()
  expect(env.composer).toHaveBeenCalledWith({ spaceId: 'a', name: 'review', description: 'Review code' })
  expect(env.api.sendMessage).not.toHaveBeenCalled()
})

it.each([false, true])('ignores a stale Use check after switching details (new conversation: %s)', async newConversation => {
  const { render, run, props } = await card()
  const pending = deferred(); env.api.skillsList.mockReturnValueOnce(pending.promise)
  env.api.createConversation.mockResolvedValue({ success: true, data: { id: 'obsolete-chat' } })
  if (newConversation) more(render, 'Use in a new conversation').props.onClick()
  else button(render(), 'Use').props.onClick()
  props.skillRef = { spaceId: 'b', id: 'copy-b' }
  env.api.skillsRead.mockResolvedValue({ success: true, data: { ...detail('copy-b'), content: 'Current instructions', copy: { ...detail('copy-b').copy, spaceId: 'b' } } })
  render(); run.flush(); render(); run.flush(); await settle()
  pending.resolve({ success: true, data: { groups: [{ name: 'review', effectiveId: 'copy-a', copies: [detail().copy] }], warnings: [], truncated: false } }); await settle()
  expect(instructions(render())).toBe('Current instructions')
  expect(env.api.createConversation).not.toHaveBeenCalled()
  expect(env.navigate).not.toHaveBeenCalled()
  expect(env.composer).not.toHaveBeenCalled()
  expect(env.api.sendMessage).not.toHaveBeenCalled()
})

it('does not open a composer after unmounting during a Use check', async () => {
  const { render, run } = await card()
  const pending = deferred(); env.api.skillsList.mockReturnValueOnce(pending.promise)
  button(render(), 'Use').props.onClick(); run.unmount()
  pending.resolve({ success: true, data: { groups: [{ name: 'review', effectiveId: 'copy-a', copies: [detail().copy] }], warnings: [], truncated: false } }); await settle()
  expect(env.composer).not.toHaveBeenCalled()
  expect(env.api.sendMessage).not.toHaveBeenCalled()
})
