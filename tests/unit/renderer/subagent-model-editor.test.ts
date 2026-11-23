import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any, update: vi.fn(), create: vi.fn() }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (initial: any) => env.runner.state(initial), useRef: (initial: any) => env.runner.ref(initial), useId: () => 'editor', useEffect: () => {} }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (value: string) => value }) }))
vi.mock('../../../src/renderer/api', () => ({ api: { updateSubagentModel: env.update, createSubagentModel: env.create } }))
import { ProfileEditor } from '../../../src/renderer/components/subagent-models/ProfileEditor'
import { TargetPicker } from '../../../src/renderer/components/subagent-models/TargetPicker'
import { SUBAGENT_MODEL_DEFAULT_PURPOSES } from '../../../src/shared/subagent-models'
import type { SubagentModelProfile } from '../../../src/shared/types/subagent-models'

class Runner {
  values: any[] = []
  index = 0
  state(initial: any) { const index = this.index++; if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial; return [this.values[index], (value: any) => { this.values[index] = typeof value === 'function' ? value(this.values[index]) : value }] }
  ref(initial: any) { const index = this.index++; return this.values[index] ??= { current: initial } }
  draw(render: () => any) { this.index = 0; env.runner = this; return render() }
}
function nodes(tree: any): any[] { return !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }
const input = (tree: any, id: string) => nodes(tree).find(item => item.props?.id === id)
const submit = (tree: any) => tree.props.onSubmit({ preventDefault() {} })
const escape = (tree: any) => tree.props.onKeyDown({ key: 'Escape', stopPropagation() {}, preventDefault() {} })
const button = (tree: any, label: string) => nodes(tree).find(item => item.type === 'button' && item.props.children === label)
const picker = (tree: any) => nodes(tree).find(item => item.type === TargetPicker)
const role = (tree: any, name: string) => nodes(tree).find(item => item.props?.role === name)
const nextTarget = { kind: 'model', sourceId: 'source', modelId: 'next' } as const
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const profile: SubagentModelProfile = { id: 'custom-1', revision: 3, kind: 'custom', name: 'Reviewer', description: 'Review code', target: { kind: 'model', sourceId: 'source', modelId: 'm' } }
const config = { version: 2 as const, currentId: null, sources: [] }
const editor = (current: SubagentModelProfile | undefined, handlers: { onSaved?: any; onCancel?: any } = {}) => {
  const runner = new Runner()
  return () => runner.draw(() => ProfileEditor({ profile: current, config, onSaved: handlers.onSaved ?? vi.fn(), onCancel: handlers.onCancel ?? vi.fn(), onBusyChange: vi.fn() }))
}

beforeEach(() => { env.update.mockReset(); env.create.mockReset() })
describe('model assignment editor', () => {
  it('shows the name, purpose and current model together and saves them with one Save', async () => {
    const saved = vi.fn()
    const draw = editor(profile, { onSaved: saved })
    const data = { revision: 4 }
    env.update.mockResolvedValue({ success: true, data })
    expect(button(draw(), 'Edit details')).toBeUndefined()
    expect(input(draw(), 'editor-name').props.value).toBe('Reviewer')
    expect(input(draw(), 'editor-purpose').props.value).toBe('Review code')
    expect(picker(draw()).props.value).toEqual(profile.target)
    input(draw(), 'editor-name').props.onChange({ target: { value: 'Backend reviewer' } })
    input(draw(), 'editor-purpose').props.onChange({ target: { value: 'Review backend changes' } })
    picker(draw()).props.onChange(nextTarget)
    expect(env.update).not.toHaveBeenCalled()
    submit(draw())
    submit(draw())
    await settle()
    expect(env.update).toHaveBeenCalledTimes(1)
    expect(env.update).toHaveBeenCalledWith({ id: profile.id, expectedRevision: 3, name: 'Backend reviewer', description: 'Review backend changes', target: nextTarget })
    expect(env.update.mock.calls[0][0]).not.toHaveProperty('reasoningEffort')
    expect(saved).toHaveBeenCalledWith(data)
  })

  it('keeps the shared default purpose when a tier only gets its first model', async () => {
    const builtin: SubagentModelProfile = { id: 'builtin:small', revision: 0, kind: 'builtin', slot: 'small', description: SUBAGENT_MODEL_DEFAULT_PURPOSES.small }
    const draw = editor(builtin)
    env.update.mockResolvedValue({ success: true, data: { revision: 1 } })
    expect(input(draw(), 'editor-name')).toBeUndefined()
    picker(draw()).props.onChange(nextTarget)
    submit(draw())
    await settle()
    expect(env.update).toHaveBeenCalledWith({ id: builtin.id, expectedRevision: 0, description: SUBAGENT_MODEL_DEFAULT_PURPOSES.small, target: nextTarget })
  })

  it('asks for a model before saving an unconfigured tier', async () => {
    const builtin: SubagentModelProfile = { id: 'builtin:large', revision: 0, kind: 'builtin', slot: 'large', description: SUBAGENT_MODEL_DEFAULT_PURPOSES.large }
    const cancel = vi.fn()
    const draw = editor(builtin, { onCancel: cancel })
    submit(draw())
    await settle()
    expect(env.update).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(role(draw(), 'alert').props.children).toBe('Choose an account and model or a group.')
  })

  it('edits purpose without exposing a legacy reasoning field or sending it back', async () => {
    const draw = editor({ ...profile, reasoningEffort: 'high' } as SubagentModelProfile)
    env.update.mockResolvedValue({ success: true, data: { revision: 4 } })
    expect(nodes(draw()).some(node => node.type === 'select')).toBe(false)
    input(draw(), 'editor-purpose').props.onChange({ target: { value: 'Review changes' } })
    submit(draw())
    await settle()
    expect(env.update).toHaveBeenCalledWith({ id: profile.id, expectedRevision: 3, name: 'Reviewer', description: 'Review changes', target: profile.target })
    expect(env.update.mock.calls[0][0]).not.toHaveProperty('reasoningEffort')
  })

  it('closes without writing when nothing changed', async () => {
    const cancel = vi.fn()
    const draw = editor(profile, { onCancel: cancel })
    picker(draw()).props.onChange(profile.target)
    submit(draw())
    await settle()
    expect(env.update).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('keeps the whole draft after a refused save', async () => {
    const saved = vi.fn()
    const draw = editor(profile, { onSaved: saved })
    env.update.mockResolvedValue({ success: false, code: 'unknown-model' })
    input(draw(), 'editor-purpose').props.onChange({ target: { value: 'Review changes' } })
    picker(draw()).props.onChange(nextTarget)
    submit(draw())
    await settle()
    expect(picker(draw()).props.value).toEqual(nextTarget)
    expect(input(draw(), 'editor-purpose').props.value).toBe('Review changes')
    expect(role(draw(), 'alert').props.children).toContain('Your changes are still here')
    expect(saved).not.toHaveBeenCalled()
  })

  it('keeps the captured revision after an external update and preserves failed input', async () => {
    env.update.mockResolvedValue({ success: false, code: 'revision-conflict' })
    const runner = new Runner()
    let current = profile
    const saved = vi.fn()
    const draw = () => runner.draw(() => ProfileEditor({ profile: current, config, onSaved: saved, onCancel: vi.fn(), onBusyChange: vi.fn() }))
    input(draw(), 'editor-name').props.onChange({ target: { value: 'My draft' } })
    current = { ...profile, revision: 4, name: 'Changed elsewhere' }
    submit(draw())
    await settle()
    expect(env.update).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 3, name: 'My draft' }))
    expect(input(draw(), 'editor-name').props.value).toBe('My draft')
    expect(role(draw(), 'alert').props.children).toContain('draft is safe')
    expect(saved).not.toHaveBeenCalled()
  })

  it('does not create an unbound draft or select the global model', async () => {
    const draw = editor(undefined)
    expect(button(draw(), 'Create')).toBeDefined()
    input(draw(), 'editor-name').props.onChange({ target: { value: 'New' } })
    submit(draw())
    await settle()
    expect(env.create).not.toHaveBeenCalled()
    expect(config.currentId).toBeNull()
  })

  it('closes an untouched editor on Escape', () => {
    const cancel = vi.fn()
    const draw = editor(profile, { onCancel: cancel })
    escape(draw())
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('keeps Escape from silently discarding a changed draft', () => {
    const cancel = vi.fn()
    const draw = editor(profile, { onCancel: cancel })
    input(draw(), 'editor-purpose').props.onChange({ target: { value: 'Unsaved purpose' } })
    escape(draw())
    expect(cancel).not.toHaveBeenCalled()
    expect(role(draw(), 'status').props.children).toContain('draft is still here')
    expect(role(draw(), 'alert')).toBeUndefined()
    expect(input(draw(), 'editor-purpose').props.value).toBe('Unsaved purpose')
  })
})
