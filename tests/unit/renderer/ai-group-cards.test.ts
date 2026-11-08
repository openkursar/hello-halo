/**
 * The groups in the provider list: the question asked before one is deleted and
 * what follows each answer, and how an opened card shows the models that are
 * resting and lets someone try one again. The cards' hooks run against a small
 * state holder, the way the repo's other interactive screens are tested.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  runner: null as any,
  effects: [] as Array<() => void | (() => void)>,
  confirm: vi.fn(),
  health: vi.fn(),
  release: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useCallback: (fn: any) => fn,
  useEffect: (effect: () => void | (() => void)) => { env.effects.push(effect) },
}))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')) }),
  getCurrentLanguage: () => 'en',
}))
vi.mock('../../../src/renderer/api', () => ({
  api: { aiGroupsHealth: env.health, aiGroupsReleaseRest: env.release, aiGroupsDelete: env.remove },
}))
vi.mock('../../../src/renderer/hooks/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ showConfirm: env.confirm, DialogComponent: null }),
}))

import { GroupCard } from '../../../src/renderer/components/ai-groups/GroupCard'
import { GroupCards } from '../../../src/renderer/components/ai-groups/GroupCards'
import { groupMemberKey } from '../../../src/shared/ai-groups'
import type { AIGroup, AISource, AISourcesConfig } from '../../../src/shared/types/ai-sources'
import type { GroupHealth } from '../../../src/shared/types/ai-groups-runtime'

class ComponentRunner {
  values: any[] = []
  index = 0
  state(initial: any) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial
    return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }]
  }
  render(component: () => any) { this.index = 0; env.runner = this; return component() }
}

function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (typeof tree.type === 'function') return nodes(tree.type(tree.props))
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}
function textOf(node: any): string {
  if (node && typeof node === 'object' && typeof node.type === 'function') return textOf(node.type(node.props))
  return [node?.props?.children].flat(Infinity).map(child => typeof child === 'string' ? child : child && typeof child === 'object' ? textOf(child) : '').join('')
}
const buttonWith = (tree: any, text: string) => nodes(tree).filter(node => node.type === 'button' && textOf(node) === text)
const textIn = (tree: any) => nodes(tree).map(node => [node?.props?.children].flat().filter(child => typeof child === 'string').join('')).join(' | ')
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function account(id: string): AISource {
  return {
    id, name: id, provider: 'custom', authType: 'api-key', apiUrl: 'https://example.invalid', apiKey: 'key',
    model: `${id}-m1`, availableModels: [{ id: `${id}-m1`, name: `${id} one` }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
const group: AIGroup = {
  id: 'g1', name: 'Daily', strategy: 'priority',
  members: [{ sourceId: 'main', modelId: 'main-m1' }, { sourceId: 'backup', modelId: 'backup-m1' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}
const sources = [account('main'), account('backup')]

beforeEach(() => {
  env.effects.length = 0
  env.confirm.mockReset()
  env.health.mockReset().mockResolvedValue({ success: false })
  env.release.mockReset().mockResolvedValue({ success: true, data: { released: 1 } })
  env.remove.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('deleting a group from the list', () => {
  const aiSources: AISourcesConfig = { version: 2, currentId: 'main', sources, groups: [group] }
  const onDeleted = vi.fn()
  const onError = vi.fn()
  const props = { aiSources, chosenGroupId: null, expandedGroupId: null, onToggle: vi.fn(), onChoose: vi.fn(), onEdit: vi.fn(), onDeleted, onError }

  async function deleteGroup() {
    const tree = GroupCards(props) as any
    const cards = [tree.props.children].flat(Infinity).filter((child: any) => child?.type === GroupCard)
    expect(cards).toHaveLength(1)
    cards[0].props.onDelete()
    await settle()
  }

  beforeEach(() => {
    onDeleted.mockReset()
    onError.mockReset()
  })

  it('shows a card for each group and nothing else', () => {
    const tree = GroupCards({ ...props, aiSources: { ...aiSources, groups: [group, { ...group, id: 'g2', name: 'Other' }] } }) as any
    expect([tree.props.children].flat(Infinity).filter((child: any) => child?.type === GroupCard)).toHaveLength(2)
  })

  it('asks first, saying what stays and what the group\'s chats will use instead', async () => {
    env.confirm.mockResolvedValue(false)
    await deleteGroup()
    expect(env.confirm).toHaveBeenCalledTimes(1)
    expect(env.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Delete this group?',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'danger',
      message: 'The accounts in it stay as they are. Chats and digital humans that use “Daily” will use your default model instead.',
    }))
  })

  it('leaves the group alone when the answer is no', async () => {
    env.confirm.mockResolvedValue(false)
    await deleteGroup()
    expect(env.remove).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('deletes it on a yes and hands on the settings as they are afterwards', async () => {
    env.confirm.mockResolvedValue(true)
    const after: AISourcesConfig = { ...aiSources, groups: [] }
    env.remove.mockResolvedValue({ success: true, data: { aiSources: after } })
    await deleteGroup()
    expect(env.remove).toHaveBeenCalledWith('g1')
    expect(onDeleted).toHaveBeenCalledWith(after, 'g1')
    expect(onError).not.toHaveBeenCalled()
  })

  it('says why when the group could not be deleted', async () => {
    env.confirm.mockResolvedValue(true)
    env.remove.mockResolvedValue({ success: false, error: 'This group no longer exists', code: 'not-found' })
    await deleteGroup()
    expect(onError).toHaveBeenCalledWith('This group no longer exists')
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('still says something when the refusal carries no reason', async () => {
    env.confirm.mockResolvedValue(true)
    env.remove.mockResolvedValue({ success: false })
    await deleteGroup()
    expect(onError).toHaveBeenCalledWith('The group could not be deleted. Please try again.')
  })

  it('does not leave a request that failed to go through unanswered', async () => {
    env.confirm.mockResolvedValue(true)
    env.remove.mockRejectedValue(new Error('offline'))
    await deleteGroup()
    expect(onError).toHaveBeenCalledWith('The group could not be deleted. Please try again.')
    expect(onDeleted).not.toHaveBeenCalled()
  })
})

describe('how an opened card shows its models', () => {
  const props = { group, sources, chosen: false, expanded: true, onToggle: vi.fn(), onChoose: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }
  const mainKey = groupMemberKey(group.members[0])

  const resting = (): GroupHealth => ({
    groupId: 'g1',
    members: [
      // A little over four and a half minutes, so it reads "5 minutes" however long the test takes.
      { sourceId: 'main', modelId: 'main-m1', state: 'resting', reason: 'rate', until: Date.now() + 270_000 },
      { sourceId: 'backup', modelId: 'backup-m1', state: 'ready' },
    ],
  })

  /** A card on screen: drawing, and the effects React runs once it is on screen. */
  function mount(overrides: Partial<typeof props> = {}) {
    const runner = new ComponentRunner()
    const draw = () => {
      env.effects.length = 0
      return runner.render(() => GroupCard({ ...props, ...overrides }))
    }
    const commit = () => env.effects.splice(0).map(effect => effect())
    return { draw, commit }
  }

  it('asks nothing of the router while the card is closed', () => {
    const { draw, commit } = mount({ expanded: false })
    draw()
    commit()
    expect(env.health).not.toHaveBeenCalled()
  })

  it('reads how the models stand when the card opens', () => {
    const { draw, commit } = mount()
    draw()
    commit()
    expect(env.health).toHaveBeenCalledWith('g1')
  })

  it('says why a model is resting and when it will be tried again, and says nothing of one that is ready', async () => {
    env.health.mockResolvedValue({ success: true, data: resting() })
    const { draw, commit } = mount()
    draw()
    commit()
    await settle()
    const tree = draw()
    expect(textIn(tree)).toContain('Too many requests · trying again in 5 minutes')
    expect(textIn(tree).match(/Too many requests/g)).toHaveLength(1)
    expect(buttonWith(tree, 'Try again now')).toHaveLength(1)
  })

  it('shows no standing, and no error, while the router cannot say', async () => {
    env.health.mockResolvedValue({ success: false, error: 'not found' })
    const { draw, commit } = mount()
    draw()
    commit()
    await settle()
    const tree = draw()
    expect(textIn(tree)).not.toContain('trying again')
    expect(buttonWith(tree, 'Try again now')).toHaveLength(0)
  })

  it('copes with a read that fails outright', async () => {
    env.health.mockRejectedValue(new Error('offline'))
    const { draw, commit } = mount()
    draw()
    commit()
    await settle()
    expect(buttonWith(draw(), 'Try again now')).toHaveLength(0)
  })

  it('ignores an answer that arrives after the card was closed', async () => {
    let answer: (value: unknown) => void = () => {}
    env.health.mockReturnValue(new Promise(resolve => { answer = resolve }))
    const { draw, commit } = mount()
    draw()
    const [cleanup] = commit() as Array<() => void>
    cleanup()
    answer({ success: true, data: resting() })
    await settle()
    expect(buttonWith(draw(), 'Try again now')).toHaveLength(0)
  })

  it('lets someone try a resting model again now, then reads how the models stand again', async () => {
    env.health.mockResolvedValue({ success: true, data: resting() })
    const { draw, commit } = mount()
    draw()
    commit()
    await settle()

    env.health.mockResolvedValue({ success: true, data: { groupId: 'g1', members: [{ sourceId: 'main', modelId: 'main-m1', state: 'half-open' }] } })
    buttonWith(draw(), 'Try again now')[0].props.onClick()
    await settle()
    expect(env.release).toHaveBeenCalledWith('g1', mainKey)

    draw()
    commit()
    await settle()
    expect(env.health).toHaveBeenCalledTimes(2)
    const tree = draw()
    expect(textIn(tree)).toContain('Checking again')
    expect(buttonWith(tree, 'Try again now')).toHaveLength(0)
  })

  it('reads again even when the release could not be sent, so the card does not show a stale rest', async () => {
    env.health.mockResolvedValue({ success: true, data: resting() })
    env.release.mockRejectedValue(new Error('offline'))
    const { draw, commit } = mount()
    draw()
    commit()
    await settle()

    buttonWith(draw(), 'Try again now')[0].props.onClick()
    await settle()
    draw()
    commit()
    expect(env.health).toHaveBeenCalledTimes(2)
  })
})
