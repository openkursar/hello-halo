/**
 * Using the group editor: what happens as someone fills it in and saves. The
 * editor is driven the way the repo's other interactive screens are tested — its
 * hooks run against a small state holder, and its element tree is read for the
 * controls a person would use.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  runner: null as any,
  create: vi.fn(),
  update: vi.fn(),
  picker: null as any,
}))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useMemo: (compute: any) => compute(),
  useRef: (value: any) => env.runner.ref(value),
  useCallback: (fn: any) => fn,
  useEffect: () => {},
}))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')) }),
  getCurrentLanguage: () => 'en',
}))
vi.mock('../../../src/renderer/api', () => ({ api: { aiGroupsCreate: env.create, aiGroupsUpdate: env.update } }))
vi.mock('../../../src/renderer/components/ui/Disclosure', () => ({ Disclosure: ({ children }: any) => children }))
vi.mock('../../../src/renderer/components/ai-groups/GroupModelPicker', () => ({
  GroupModelPicker: (props: unknown) => { env.picker = props; return null },
}))

import { GroupEditor } from '../../../src/renderer/components/ai-groups/GroupEditor'
import type { AIGroup, AISource, AISourcesConfig } from '../../../src/shared/types/ai-sources'

class ComponentRunner {
  values: any[] = []
  index = 0
  state(initial: any) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial
    return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }]
  }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  render(component: () => any) { this.index = 0; env.runner = this; return component() }
}

/** Flattens the element tree, running function components inline so extracted pieces are visible. */
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (typeof tree.type === 'function') return nodes(tree.type(tree.props))
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}
function textOf(node: any): string {
  return [node?.props?.children].flat(Infinity).map(child => typeof child === 'string' ? child : child && typeof child === 'object' ? textOf(child) : '').join('')
}
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && (textOf(node) === label || node.props['aria-label'] === label))
const buttons = (tree: any, action: 'Move up' | 'Move down' | 'Remove') => nodes(tree).filter(node => node.type === 'button' && node.props.title === action)
const alerts = (tree: any) => nodes(tree).filter(node => node.props?.role === 'alert').map(textOf)
const statuses = (tree: any) => nodes(tree).filter(node => node.props?.role === 'status').map(textOf)
const nameInput = (tree: any) => nodes(tree).find(node => node.type === 'input' && node.props.id === 'group-name')
const rows = (tree: any) => nodes(tree).filter(node => node.type === 'li' && node.props.draggable)
/** Lets the save in flight settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function account(id: string, extra: Partial<AISource> = {}): AISource {
  return {
    id, name: id, provider: 'custom', authType: 'api-key', apiUrl: 'https://example.invalid', apiKey: 'key',
    model: `${id}-m1`, availableModels: [{ id: `${id}-m1`, name: `${id} one` }, { id: `${id}-m2`, name: `${id} two` }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
  }
}
const stored: AIGroup = {
  id: 'g1', name: 'Daily', strategy: 'priority',
  members: [{ sourceId: 'main', modelId: 'main-m1' }, { sourceId: 'backup', modelId: 'backup-m2' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}
const sources = [account('main'), account('backup'), account('cli', { authType: 'delegated', apiKey: undefined })]
const config = (extra: Partial<AISourcesConfig> = {}): AISourcesConfig => ({ version: 2, currentId: 'main', sources, ...extra })

const onSaved = vi.fn()
const onCancel = vi.fn()
const onAddProvider = vi.fn()

function open(props: { aiSources?: AISourcesConfig; group?: AIGroup } = {}) {
  const runner = new ComponentRunner()
  const draw = () => runner.render(() => GroupEditor({ aiSources: config(), onSaved, onCancel, onAddProvider, ...props }))
  return { draw }
}
const submit = (tree: any) => nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault: () => {} })

beforeEach(() => {
  env.create.mockReset()
  env.update.mockReset()
  env.picker = null
  onSaved.mockReset()
  onCancel.mockReset()
  onAddProvider.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('building a group from the accounts already set up', () => {
  it('fills in each account\'s current model, the account in use first, and creates the group', async () => {
    env.create.mockResolvedValue({ success: true, data: { aiSources: config(), groupId: 'new' } })
    const { draw } = open({ aiSources: config({ currentId: 'backup' }) })
    button(draw(), 'Quick add from accounts').props.onClick()

    const filled = draw()
    expect(rows(filled)).toHaveLength(2)
    submit(filled)
    await settle()

    expect(env.create).toHaveBeenCalledWith({
      name: 'Model group',
      strategy: 'priority',
      members: [{ sourceId: 'backup', modelId: 'backup-m1' }, { sourceId: 'main', modelId: 'main-m1' }],
    })
    expect(onSaved).toHaveBeenCalledWith({ aiSources: config(), groupId: 'new' })
  })

  it('says which accounts it left out, and why', () => {
    const { draw } = open()
    button(draw(), 'Quick add from accounts').props.onClick()
    const notes = statuses(draw()).join(' ')
    expect(notes).toContain('Not added:')
    expect(notes).toContain('cli signs in through Claude Code, which groups cannot use')
  })

  it('says so when everything it would add is already there', () => {
    const { draw } = open({ group: { ...stored, members: [{ sourceId: 'main', modelId: 'main-m1' }, { sourceId: 'backup', modelId: 'backup-m1' }] }, aiSources: config({ sources: [account('main'), account('backup')] }) })
    button(draw(), 'Quick add from accounts').props.onClick()
    expect(statuses(draw()).join(' ')).toContain('Every account’s current model is already in the group.')
  })

  it('adds the models chosen in the panel after the ones already there, and closes the panel', () => {
    const { draw } = open({ group: stored })
    button(draw(), 'Add model').props.onClick()
    nodes(draw())
    expect(env.picker).not.toBeNull()
    expect([...env.picker.taken].sort()).toEqual(['backup\u0000backup-m2', 'main\u0000main-m1'])
    expect(env.picker.room).toBe(8)

    env.picker.onAdd([{ sourceId: 'main', modelId: 'main-m2' }])
    env.picker = null
    const after = draw()
    expect(rows(after)).toHaveLength(3)
    nodes(after)
    expect(env.picker).toBeNull()
  })
})

describe('putting the models in order', () => {
  async function savedOrder(act: (tree: any, draw: () => any) => void) {
    env.update.mockResolvedValue({ success: true, data: { aiSources: config(), groupId: 'g1' } })
    const { draw } = open({ group: { ...stored, members: [...stored.members, { sourceId: 'main', modelId: 'main-m2' }] } })
    act(draw(), draw)
    submit(draw())
    await settle()
    return env.update.mock.calls[0][1].members.map((member: any) => member.modelId)
  }

  it('moves a model down', async () => {
    expect(await savedOrder(tree => buttons(tree, 'Move down')[0].props.onClick())).toEqual(['backup-m2', 'main-m1', 'main-m2'])
  })

  it('moves a model up', async () => {
    expect(await savedOrder(tree => buttons(tree, 'Move up')[2].props.onClick())).toEqual(['main-m1', 'main-m2', 'backup-m2'])
  })

  it('moves a model by dragging it onto another', async () => {
    expect(await savedOrder((tree, draw) => {
      rows(tree)[0].props.onDragStart({ dataTransfer: {} })
      // Each event arrives after the screen has been redrawn from the one before.
      rows(draw())[2].props.onDragOver({ preventDefault: () => {} })
      rows(draw())[2].props.onDrop({ preventDefault: () => {} })
    })).toEqual(['backup-m2', 'main-m2', 'main-m1'])
  })

  it('removes a model', async () => {
    expect(await savedOrder(tree => buttons(tree, 'Remove')[1].props.onClick())).toEqual(['main-m1', 'main-m2'])
  })

  it('cannot move the first model up or the last one down', () => {
    const { draw } = open({ group: stored })
    const tree = draw()
    expect(buttons(tree, 'Move up')[0].props.disabled).toBe(true)
    expect(buttons(tree, 'Move down')[1].props.disabled).toBe(true)
    expect(buttons(tree, 'Move up')[1].props.disabled).toBe(false)
  })
})

describe('saving', () => {
  it('asks for a name before it asks the main process anything', async () => {
    const { draw } = open({ group: stored })
    nameInput(draw()).props.onChange({ target: { value: '   ' } })
    submit(draw())
    await settle()
    expect(env.update).not.toHaveBeenCalled()
    expect(alerts(draw())).toEqual(['Give the group a name.'])
  })

  it('asks for at least one model', async () => {
    const { draw } = open()
    submit(draw())
    await settle()
    expect(env.create).not.toHaveBeenCalled()
    expect(alerts(draw())).toEqual(['Add at least one model.'])
  })

  it('refuses a name another group uses', async () => {
    const { draw } = open({ aiSources: config({ groups: [{ ...stored, id: 'other', name: 'Work' }] }) })
    button(draw(), 'Quick add from accounts').props.onClick()
    nameInput(draw()).props.onChange({ target: { value: ' work ' } })
    submit(draw())
    await settle()
    expect(env.create).not.toHaveBeenCalled()
    expect(alerts(draw())).toEqual(['Another group already has this name.'])
  })

  it('clears the complaint as soon as the person changes something', () => {
    const { draw } = open()
    submit(draw())
    return settle().then(() => {
      expect(alerts(draw())).toHaveLength(1)
      nameInput(draw()).props.onChange({ target: { value: 'Daily' } })
      expect(alerts(draw())).toHaveLength(0)
    })
  })

  it('edits the stored group in place and hands back what the main process answered', async () => {
    const answer = { aiSources: config({ groups: [stored] }), groupId: 'g1' }
    env.update.mockResolvedValue({ success: true, data: answer })
    const { draw } = open({ group: stored, aiSources: config({ groups: [stored] }) })
    nameInput(draw()).props.onChange({ target: { value: 'Renamed' } })
    submit(draw())
    await settle()
    expect(env.update).toHaveBeenCalledWith('g1', { name: 'Renamed', strategy: 'priority', members: stored.members })
    expect(env.create).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalledWith(answer)
  })

  it('words a refusal from the main process, naming the model it is about', async () => {
    env.update.mockResolvedValue({ success: false, error: 'raw english', code: 'unknown-model', memberIndex: 1 })
    const { draw } = open({ group: stored })
    submit(draw())
    await settle()
    expect(alerts(draw())).toEqual(['backup / backup two is no longer offered by its account.'])
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('does not blame the person for a failure it cannot explain', async () => {
    env.update.mockRejectedValue(new Error('network down'))
    const { draw } = open({ group: stored })
    submit(draw())
    await settle()
    expect(alerts(draw())).toEqual(['The group could not be saved. Please try again.'])
  })

  it('does not save twice while the first save is still going', async () => {
    let finish: (value: unknown) => void = () => {}
    env.update.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const { draw } = open({ group: stored })
    submit(draw())
    submit(draw())
    await settle()
    expect(env.update).toHaveBeenCalledTimes(1)
    finish({ success: true, data: { aiSources: config(), groupId: 'g1' } })
    await settle()
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('goes back without saving', () => {
    const { draw } = open({ group: stored })
    button(draw(), 'Cancel').props.onClick()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(env.update).not.toHaveBeenCalled()
  })

  it('takes the chosen way of picking models', async () => {
    env.update.mockResolvedValue({ success: true, data: { aiSources: config(), groupId: 'g1' } })
    const { draw } = open({ group: stored })
    nodes(draw()).find(node => node.type === 'input' && node.props.value === 'spread').props.onChange()
    submit(draw())
    await settle()
    expect(env.update.mock.calls[0][1].strategy).toBe('spread')
  })
})

describe('with no account to build on', () => {
  it('sends the person to add one', () => {
    const { draw } = open({ aiSources: config({ sources: [], currentId: null }) })
    button(draw(), 'Add AI Provider').props.onClick()
    expect(onAddProvider).toHaveBeenCalledTimes(1)
  })
})
