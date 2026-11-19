import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any, update: vi.fn(), create: vi.fn() }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (initial: any) => env.runner.state(initial), useRef: (initial: any) => env.runner.ref(initial), useId: () => 'editor', useEffect: () => {} }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (value: string) => value }) }))
vi.mock('../../../src/renderer/api', () => ({ api: { updateSubagentModel: env.update, createSubagentModel: env.create } }))
import { ProfileEditor } from '../../../src/renderer/components/subagent-models/ProfileEditor'
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
const button = (tree: any, label: string) => nodes(tree).find(item => item.type === 'button' && item.props.children === label)
const picker = (tree: any) => nodes(tree).find(item => item.props?.immediate === true)
const nextTarget = { kind: 'model', sourceId: 'source', modelId: 'next' } as const
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const profile: SubagentModelProfile = { id: 'custom-1', revision: 3, kind: 'custom', name: 'Reviewer', description: 'Review code', target: { kind: 'model', sourceId: 'source', modelId: 'm' } }
const config = { version: 2 as const, currentId: null, sources: [] }

beforeEach(() => { env.update.mockReset(); env.create.mockReset() })
describe('model assignment editor drafts', () => {
  it('applies just the model on selection with no save button or work to confirm twice', async () => {
    const runner = new Runner()
    const saved = vi.fn()
    const draw = () => runner.draw(() => ProfileEditor({ profile, config, onSaved: saved, onCancel: vi.fn(), onBusyChange: vi.fn() }))
    const data = { revision: 4 }
    env.update.mockResolvedValue({ success: true, data })
    expect(button(draw(), 'Save')).toBeUndefined()
    expect(input(draw(), 'editor-effort')).toBeUndefined()
    picker(draw()).props.onChange(nextTarget)
    picker(draw()).props.onChange(nextTarget)
    await settle()
    expect(env.update).toHaveBeenCalledTimes(1)
    expect(env.update).toHaveBeenCalledWith({ id: profile.id, expectedRevision: 3, name: 'Reviewer', description: 'Review code', target: nextTarget })
    expect(env.update.mock.calls[0][0]).not.toHaveProperty('reasoningEffort')
    expect(saved).toHaveBeenCalledWith(data)
  })

  it('preserves the builtin default purpose when selecting its first target', async () => {
    const runner = new Runner()
    const builtin: SubagentModelProfile = { id: 'builtin:small', revision: 0, kind: 'builtin', slot: 'small', description: SUBAGENT_MODEL_DEFAULT_PURPOSES.small }
    const draw = () => runner.draw(() => ProfileEditor({ profile: builtin, config, onSaved: vi.fn(), onCancel: vi.fn(), onBusyChange: vi.fn() }))
    env.update.mockResolvedValue({ success: true, data: { revision: 1 } })
    picker(draw()).props.onChange(nextTarget)
    await settle()
    expect(env.update).toHaveBeenCalledWith({ id: builtin.id, expectedRevision: 0, description: SUBAGENT_MODEL_DEFAULT_PURPOSES.small, target: nextTarget })
  })

  it('edits purpose without exposing a legacy reasoning field or sending it back', async () => {
    const runner = new Runner()
    const legacyProfile = { ...profile, reasoningEffort: 'high' }
    const draw = () => runner.draw(() => ProfileEditor({ profile: legacyProfile, config, onSaved: vi.fn(), onCancel: vi.fn(), onBusyChange: vi.fn() }))
    env.update.mockResolvedValue({ success: true, data: { revision: 4 } })
    button(draw(), 'Edit details').props.onClick()
    expect(nodes(draw()).some(node => node.type === 'select')).toBe(false)
    input(draw(), 'editor-purpose').props.onChange({ target: { value: 'Review changes' } })
    submit(draw())
    await settle()
    expect(env.update).toHaveBeenCalledWith({ id: profile.id, expectedRevision: 3, name: 'Reviewer', description: 'Review changes', target: profile.target })
    expect(env.update.mock.calls[0][0]).not.toHaveProperty('reasoningEffort')
  })

  it('keeps the previous model and picker open after a refused change', async () => {
    const runner = new Runner()
    const saved = vi.fn()
    const draw = () => runner.draw(() => ProfileEditor({ profile, config, onSaved: saved, onCancel: vi.fn(), onBusyChange: vi.fn() }))
    env.update.mockResolvedValue({ success: false, code: 'unknown-model' })
    picker(draw()).props.onChange(nextTarget)
    await settle()
    expect(picker(draw()).props.value).toEqual(profile.target)
    expect(nodes(draw()).find(item => item.props?.role === 'alert').props.children).toContain('previous selection was kept')
    expect(saved).not.toHaveBeenCalled()
  })
  it('keeps the captured revision after an external update and preserves failed input', async () => {
    env.update.mockResolvedValue({ success: false, code: 'revision-conflict' })
    const runner = new Runner()
    let current = profile
    const saved = vi.fn()
    const draw = () => runner.draw(() => ProfileEditor({ profile: current, config, onSaved: saved, onCancel: vi.fn(), onBusyChange: vi.fn() }))
    button(draw(), 'Edit details').props.onClick()
    input(draw(), 'editor-name').props.onChange({ target: { value: 'My draft' } })
    current = { ...profile, revision: 4, name: 'Changed elsewhere' }
    submit(draw())
    await settle()
    expect(env.update).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 3, name: 'My draft' }))
    expect(input(draw(), 'editor-name').props.value).toBe('My draft')
    expect(nodes(draw()).find(item => item.props?.role === 'alert').props.children).toContain('draft is safe')
    expect(saved).not.toHaveBeenCalled()
  })
  it('does not create an unbound draft or select the global model', async () => {
    const runner = new Runner()
    const draw = () => runner.draw(() => ProfileEditor({ config, onSaved: vi.fn(), onCancel: vi.fn(), onBusyChange: vi.fn() }))
    input(draw(), 'editor-name').props.onChange({ target: { value: 'New' } })
    submit(draw())
    await settle()
    expect(env.create).not.toHaveBeenCalled()
    expect(config.currentId).toBeNull()
  })
  it('keeps Escape from silently discarding a draft', () => {
    const runner = new Runner()
    const cancel = vi.fn()
    const draw = () => runner.draw(() => ProfileEditor({ profile, config, onSaved: vi.fn(), onCancel: cancel, onBusyChange: vi.fn() }))
    button(draw(), 'Edit details').props.onClick()
    draw().props.onKeyDown({ key: 'Escape', stopPropagation() {}, preventDefault() {} })
    expect(cancel).not.toHaveBeenCalled()
    expect(nodes(draw()).find(item => item.props?.role === 'status').props.children).toContain('draft is still here')
    expect(nodes(draw()).some(item => item.props?.role === 'alert')).toBe(false)
  })
})
