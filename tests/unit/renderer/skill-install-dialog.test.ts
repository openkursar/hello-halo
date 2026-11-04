import { beforeEach, expect, it, vi } from 'vitest'
const env = vi.hoisted(() => ({ runner: null as any, api: {} as any, draft: undefined as any }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (value: any) => env.runner.state(value), useRef: (value: any) => env.runner.ref(value), useMemo: (compute: any) => compute(), useCallback: (fn: any) => fn, useEffect: () => {} }))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values?.[key] ?? '')) }) }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: (select: any) => select({ currentSpace: { id: 'space' }, spaces: [{ id: 'space', name: 'Space' }], haloSpace: null }) }))
vi.mock('../../../src/renderer/stores/capability-drafts', () => ({ getCapabilityDraft: () => env.draft, saveCapabilityDraft: vi.fn(), clearCapabilityDraft: vi.fn() }))
import { SkillInstallDialog } from '../../../src/renderer/components/apps/SkillInstallDialog'
class Runner {
  values: any[] = []; index = 0
  state(initial: any) { const index = this.index++; if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial; return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }] }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  render(props: any) { this.index = 0; env.runner = this; return SkillInstallDialog(props) }
}
function nodes(tree: any): any[] { return !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }
function button(tree: any, text: string) { return nodes(tree).find(node => node.type === 'button' && [node.props.children].flat().includes(text)) }
function setup() { const runner = new Runner(); const props = { onClose: vi.fn(), onInstalled: vi.fn() }; return { props, render: () => runner.render(props) } }
function copy(source = 'personal', spaceId: string | null = 'space') { return { id: 'copy', name: 'review', source, spaceId, editable: true, revision: 'rev', isLink: false } }
beforeEach(() => {
  env.draft = { form: { name: '中文', commandName: '', description: 'Review code', bodyContent: 'Instructions' }, mode: 'visual', mdContent: '', imported: null }
  env.api.appDeriveSkillCommandName = vi.fn().mockResolvedValue({ success: true, data: 'review' })
  env.api.skillsList = vi.fn().mockResolvedValue({ success: true, data: { groups: [], truncated: false, warnings: [] } })
  env.api.skillsImport = vi.fn().mockResolvedValue({ success: true, data: copy() })
  env.api.skillsRead = vi.fn().mockResolvedValue({ success: true, data: { copy: copy(), revision: 'read-rev' } })
})
it('awaits a localized command name, defaults to current space and returns the copy id', async () => {
  const { render, props } = setup()
  await button(render(), 'Install Skill').props.onClick()
  expect(env.api.appDeriveSkillCommandName).toHaveBeenCalledWith('中文')
  expect(env.api.skillsImport.mock.calls[0][0]).toMatchObject({ spaceId: 'space', spec: { name: 'review', display_name: '中文' }, requestId: expect.any(String) })
  expect(props.onInstalled).toHaveBeenCalledWith('copy')
})
it('requires explicit personal replacement and sends the exact ref and revision', async () => {
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [{ copies: [{ ...copy(), revision: '' }] }], truncated: false, warnings: [] } })
  const { render } = setup()
  await button(render(), 'Install Skill').props.onClick()
  expect(env.api.skillsImport).not.toHaveBeenCalled()
  expect(env.api.skillsRead).toHaveBeenCalledWith({ id: 'copy', spaceId: 'space' })
  await button(render(), 'Replace existing').props.onClick()
  expect(env.api.skillsImport.mock.calls[0][0].replace).toEqual({ ref: { id: 'copy', spaceId: 'space' }, revision: 'read-rev' })
})
it('keeps the replacement revision captured before confirmation and refuses an unreadable package', async () => {
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [{ copies: [{ ...copy(), revision: '' }] }], truncated: false, warnings: [] } })
  const { render } = setup()
  await button(render(), 'Install Skill').props.onClick()
  env.api.skillsRead.mockResolvedValue({ success: true, data: { copy: copy(), revision: 'changed-later' } })
  await button(render(), 'Replace existing').props.onClick()
  expect(env.api.skillsRead).toHaveBeenCalledOnce()
  expect(env.api.skillsImport.mock.calls[0][0].replace.revision).toBe('read-rev')

  env.api.skillsRead.mockResolvedValue({ success: false, error: 'Missing' })
  env.api.skillsImport.mockClear()
  const other = setup()
  await button(other.render(), 'Install Skill').props.onClick()
  expect(button(other.render(), 'Replace existing')).toBeUndefined()
  expect(env.api.skillsImport).not.toHaveBeenCalled()
})

it('does not offer replacement of maintained copies and cancellation writes nothing', async () => {
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [{ copies: [copy('store')] }], truncated: false, warnings: [] } })
  const { render } = setup()
  await button(render(), 'Install Skill').props.onClick()
  expect(button(render(), 'Replace existing')).toBeUndefined()
  button(render(), 'Cancel').props.onClick()
  expect(env.api.skillsImport).not.toHaveBeenCalled()
  expect(button(render(), 'Install Skill').props.disabled).toBe(false)
})
it('save-as updates command metadata and preserves resources', async () => {
  env.api.skillsList.mockResolvedValueOnce({ success: true, data: { groups: [{ copies: [copy()] }], truncated: false, warnings: [] } })
  const { render } = setup()
  await button(render(), 'Install Skill').props.onClick()
  nodes(render()).find(node => node.props?.['aria-label'] === 'New skill command name').props.onChange({ target: { value: 'review-copy' } })
  await button(render(), 'Save as new skill').props.onClick()
  expect(env.api.skillsImport.mock.calls[0][0].spec).toMatchObject({ name: 'review-copy', skill_content: expect.stringContaining('name: review-copy') })
})
it('ignores a global namesake when installing in a space', async () => {
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [{ copies: [copy('personal', null)] }], truncated: false, warnings: [] } })
  const { render } = setup(); await button(render(), 'Install Skill').props.onClick()
  expect(env.api.skillsImport).toHaveBeenCalledOnce()
})
it('blocks double submission and retries an uncertain failure with the same request id', async () => {
  env.api.skillsImport.mockResolvedValueOnce({ success: false, error: 'Offline' })
  const { render, props } = setup(); const submit = button(render(), 'Install Skill').props.onClick
  await Promise.all([submit(), submit()])
  expect(env.api.skillsImport).toHaveBeenCalledOnce()
  expect(props.onClose).not.toHaveBeenCalled()
  await button(render(), 'Install Skill').props.onClick()
  expect(env.api.skillsImport.mock.calls[1][0].requestId).toBe(env.api.skillsImport.mock.calls[0][0].requestId)
  expect(env.api.skillsList).toHaveBeenCalledOnce()
})
it('imports binary resources and completes plain Markdown metadata without dropping the body', async () => {
  env.draft.mode = 'import'
  env.draft.imported = { sourceType: 'md', label: 'notes.md', parsed: { name: '', description: '', skillFiles: { 'SKILL.md': '# Original body' }, skillAssets: { 'image.png': { encoding: 'base64', content: 'AA==' } } } }
  const { render } = setup()
  nodes(render()).find(node => node.props?.['aria-label'] === 'Skill command name').props.onChange({ target: { value: 'notes' } })
  nodes(render()).find(node => node.props?.['aria-label'] === 'Description').props.onChange({ target: { value: 'My notes' } })
  await button(render(), 'Install Skill').props.onClick()
  const spec = env.api.skillsImport.mock.calls[0][0].spec
  expect(spec.skill_assets).toEqual({ 'image.png': { encoding: 'base64', content: 'AA==' } })
  expect(spec.skill_files['SKILL.md']).toContain('description: My notes')
  expect(spec.skill_files['SKILL.md']).toContain('# Original body')
})
it.each(['', '  '])('fills a plain Markdown description fallback without changing the source: %s', description => {
  env.draft.mode = 'import'
  const source = { 'SKILL.md': '# Original body\r\n\r\n  Preserve spacing.  \r\n' }
  env.draft.imported = { sourceType: 'md', label: 'notes.md', parsed: { name: 'notes', description, skillFiles: source } }
  const { render } = setup()
  return button(render(), 'Install Skill').props.onClick().then(() => {
    const spec = env.api.skillsImport.mock.calls[0][0].spec
    expect(spec.description).toBe('Skill: notes')
    expect(spec.skill_files['SKILL.md']).toContain('description: "Skill: notes"')
    expect(spec.skill_files['SKILL.md']).toContain(source['SKILL.md'])
    expect(spec.skill_files).not.toBe(source)
    expect(source).toEqual({ 'SKILL.md': '# Original body\r\n\r\n  Preserve spacing.  \r\n' })
    expect(env.draft.imported.parsed.description).toBe(description)
  })
})

it('allows an unrelated inventory warning without weakening truncation protection', async () => {
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [], truncated: false, warnings: ['Another skill needs attention'] } })
  const allowed = setup()
  await button(allowed.render(), 'Install Skill').props.onClick()
  expect(env.api.skillsImport).toHaveBeenCalledOnce()
  expect(allowed.props.onInstalled).toHaveBeenCalledWith('copy')

  env.api.skillsImport.mockClear()
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [], truncated: true, warnings: [] } })
  const blocked = setup()
  await button(blocked.render(), 'Install Skill').props.onClick()
  expect(env.api.skillsImport).not.toHaveBeenCalled()
  expect(blocked.props.onClose).not.toHaveBeenCalled()
  expect(button(blocked.render(), 'Install Skill').props.disabled).toBe(false)
  expect(nodes(blocked.render()).some(node => node.props.children === 'Skill inspection is incomplete. Refresh the library and try again.')).toBe(true)
})

it('does not offer replacement from a truncated conflict inspection', async () => {
  env.api.skillsList.mockResolvedValue({ success: true, data: { groups: [{ copies: [copy()] }], truncated: true, warnings: [] } })
  const { render } = setup()
  await button(render(), 'Install Skill').props.onClick()
  expect(env.api.skillsRead).not.toHaveBeenCalled()
  expect(env.api.skillsImport).not.toHaveBeenCalled()
  expect(button(render(), 'Replace existing')).toBeUndefined()
})

it('fails closed when scope inspection fails and leaves the draft editable', async () => {
  env.api.skillsList.mockResolvedValue({ success: false, error: 'Unavailable' })
  const { render, props } = setup(); await button(render(), 'Install Skill').props.onClick()
  expect(env.api.skillsImport).not.toHaveBeenCalled()
  expect(props.onClose).not.toHaveBeenCalled()
  expect(button(render(), 'Install Skill').props.disabled).toBe(false)
})
