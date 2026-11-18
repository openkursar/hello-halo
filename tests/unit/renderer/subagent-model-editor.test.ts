import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any, update: vi.fn(), create: vi.fn() }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (initial: any) => env.runner.state(initial), useRef: (initial: any) => env.runner.ref(initial), useId: () => 'editor', useEffect: () => {} }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (value: string) => value }) }))
vi.mock('../../../src/renderer/api', () => ({ api: { updateSubagentModel: env.update, createSubagentModel: env.create } }))
vi.mock('../../../src/shared/subagent-models', () => ({ getSubagentModelTargetEfforts: () => ['low', 'high'], MODEL_SELECTION_LIMITS: { nameCodePoints: 80, descriptionCodePoints: 1000 }, validSubagentModelText: (value: string, maximum: number) => [...value].length <= maximum }))
import { ProfileEditor } from '../../../src/renderer/components/subagent-models/ProfileEditor'
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
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const profile: SubagentModelProfile = { id: 'custom-1', revision: 3, kind: 'custom', name: 'Reviewer', description: 'Review code', target: { kind: 'model', sourceId: 'source', modelId: 'm' } }
const config = { version: 2 as const, currentId: null, sources: [] }

beforeEach(() => { env.update.mockReset(); env.create.mockReset() })
describe('model assignment editor drafts', () => {
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
    draw().props.onKeyDown({ key: 'Escape', stopPropagation() {}, preventDefault() {} })
    expect(cancel).not.toHaveBeenCalled()
    expect(nodes(draw()).find(item => item.props?.role === 'status').props.children).toContain('draft is still here')
    expect(nodes(draw()).some(item => item.props?.role === 'alert')).toBe(false)
  })
})
