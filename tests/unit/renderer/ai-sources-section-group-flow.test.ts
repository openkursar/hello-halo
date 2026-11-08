/**
 * Using the AI model settings while load-balancing groups exist: what editing,
 * adding and deleting an account does to the group chosen for new chats, what
 * happens after a group is saved, chosen or deleted, and how the model card
 * reaches a group's editor. The section's hooks run against a small state
 * holder, and its element tree is read for the controls a person would use.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  runner: null as any,
  effects: [] as Array<() => void | (() => void)>,
  api: {} as Record<string, any>,
}))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useRef: (value: any) => env.runner.ref(value),
  useEffect: (effect: () => void | (() => void)) => { env.effects.push(effect) },
}))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')) }),
  getCurrentLanguage: () => 'en',
}))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/hooks/useOAuthLogin', () => ({ useOAuthLogin: () => ({ login: null, start: vi.fn(), cancel: vi.fn() }) }))
vi.mock('../../../src/renderer/components/settings/ProviderSelector', () => ({ ProviderSelector: () => null }))
vi.mock('../../../src/renderer/components/settings/OAuthAccountEditor', () => ({ OAuthAccountEditor: () => null }))
vi.mock('../../../src/renderer/components/settings/DelegatedLoginDialog', () => ({ DelegatedLoginDialog: () => null }))
vi.mock('../../../src/renderer/components/ai-config/OAuthRedirectLogin', () => ({ OAuthRedirectLogin: () => null }))
vi.mock('../../../src/renderer/components/icons/ProviderIconTile', () => ({ ProviderIconTile: () => null }))
vi.mock('../../../src/renderer/components/icons/BrandIcons', () => ({ getBrandIcon: () => null }))

import { AISourcesSection } from '../../../src/renderer/components/settings/AISourcesSection'
import { ProviderSelector } from '../../../src/renderer/components/settings/ProviderSelector'
import { GroupCards } from '../../../src/renderer/components/ai-groups/GroupCards'
import { GroupCreateMenu } from '../../../src/renderer/components/ai-groups/GroupCreateMenu'
import { GroupEditor } from '../../../src/renderer/components/ai-groups/GroupEditor'
import { useGroupEditRequest } from '../../../src/renderer/stores/ai-group-ui.store'
import type { AIGroup, AISource, AISourcesConfig } from '../../../src/shared/types/ai-sources'
import type { HaloConfig } from '../../../src/renderer/types'

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

/** Every element of the tree as the section drew it; its parts are not run, so only the section's own state moves. */
function walk(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(walk)]
}
function textOf(node: any): string {
  return [node?.props?.children].flat(Infinity).map(child => typeof child === 'string' ? child : child && typeof child === 'object' ? textOf(child) : '').join('')
}
const ofType = (tree: any, type: unknown) => walk(tree).find(node => node.type === type)
const buttons = (tree: any, label: string) => walk(tree).filter(node => node.type === 'button' && textOf(node) === label)
const headings = (tree: any) => walk(tree).filter(node => node.type === 'h3').map(textOf)
const paragraphs = (tree: any) => walk(tree).filter(node => node.type === 'p').map(textOf)
/** The clickable heads of the account cards, in list order. */
const cardHeads = (tree: any) => walk(tree).filter(node => node.type === 'div' && typeof node.props?.className === 'string' && node.props.className.includes('cursor-pointer'))

function account(id: string, extra: Partial<AISource> = {}): AISource {
  return {
    id, name: id, provider: 'custom', authType: 'api-key', apiUrl: 'https://example.invalid', apiKey: 'key',
    model: `${id}-m1`, availableModels: [{ id: `${id}-m1`, name: `${id} one` }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
  }
}
const group: AIGroup = {
  id: 'g1', name: 'Daily', strategy: 'priority',
  members: [{ sourceId: 'main', modelId: 'main-m1' }, { sourceId: 'backup', modelId: 'backup-m1' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}
const base = (extra: Partial<AISourcesConfig> = {}): AISourcesConfig =>
  ({ version: 2, currentId: 'main', sources: [account('main'), account('backup')], groups: [group], ...extra })

const cleanups: Array<() => void> = []

function open(aiSources: AISourcesConfig) {
  const config = { aiSources } as unknown as HaloConfig
  const setConfig = vi.fn()
  const runner = new ComponentRunner()
  const draw = () => {
    env.effects.length = 0
    return runner.render(() => AISourcesSection({ config, setConfig }))
  }
  /** The effects React runs once the section is on screen. */
  const commit = () => {
    for (const cleanup of env.effects.splice(0).map(effect => effect())) if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  const shown = () => { const tree = draw(); commit(); return tree }
  return { draw, commit, shown, setConfig, config }
}

function startEditing(section: ReturnType<typeof open>) {
  section.shown()
  cardHeads(section.draw())[0].props.onClick()
  buttons(section.draw(), 'Edit')[0].props.onClick()
  return ofType(section.draw(), ProviderSelector)
}

beforeEach(() => {
  env.effects.length = 0
  env.api.authGetProviders = vi.fn().mockResolvedValue({ success: true, data: [] })
  env.api.aiSourcesUpdateSource = vi.fn().mockResolvedValue({ success: true })
  env.api.aiSourcesAddSource = vi.fn().mockResolvedValue({ success: true })
  env.api.aiSourcesSwitchSource = vi.fn().mockResolvedValue({ success: true, data: { version: 2, currentId: 'switched', sources: [] } })
  env.api.aiSourcesDeleteSource = vi.fn().mockResolvedValue({ success: true, data: { version: 2, currentId: null, sources: [] } })
  env.api.getConfig = vi.fn().mockResolvedValue({ success: true, data: { marker: 'snapshot', aiSources: base({ currentGroupId: 'g1' }) } })
  env.api.setConfig = vi.fn().mockResolvedValue({ success: true })
  env.api.isRemoteMode = () => false
  useGroupEditRequest.setState({ groupId: null })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('saving an account while a group is chosen for new chats', () => {
  const edited = account('main', { model: 'main-m2' })

  it('leaves the group chosen when an existing account is edited, and brings in the settings as they are now', async () => {
    const section = open(base({ currentGroupId: 'g1' }))
    await startEditing(section).props.onSave(edited)

    expect(env.api.aiSourcesUpdateSource).toHaveBeenCalledWith('main', edited)
    expect(env.api.aiSourcesSwitchSource).not.toHaveBeenCalled()
    expect(env.api.getConfig).toHaveBeenCalledWith({ snapshot: true })
    expect(section.setConfig).toHaveBeenCalledWith({ marker: 'snapshot', aiSources: base({ currentGroupId: 'g1' }), isFirstLaunch: false, modelConfigSkipped: false })
    expect(env.api.setConfig).toHaveBeenCalledWith({ isFirstLaunch: false, modelConfigSkipped: false })
  })

  it('makes an edited account the one in use when no group is chosen, as it always did', async () => {
    const section = open(base())
    await startEditing(section).props.onSave(edited)

    expect(env.api.aiSourcesUpdateSource).toHaveBeenCalledWith('main', edited)
    expect(env.api.aiSourcesSwitchSource).toHaveBeenCalledWith('main')
    expect(env.api.getConfig).not.toHaveBeenCalled()
    expect(section.setConfig).toHaveBeenCalledWith(expect.objectContaining({ aiSources: { version: 2, currentId: 'switched', sources: [] }, isFirstLaunch: false }))
  })

  it('moves the choice to an account that is added, even while a group is chosen', async () => {
    const section = open(base({ currentGroupId: 'g1' }))
    section.shown()
    buttons(section.draw(), 'Add AI Provider')[0].props.onClick()
    const added = account('fresh')
    await ofType(section.draw(), ProviderSelector).props.onSave(added)

    expect(env.api.aiSourcesAddSource).toHaveBeenCalledWith(added)
    expect(env.api.aiSourcesSwitchSource).toHaveBeenCalledWith('fresh')
    expect(env.api.getConfig).not.toHaveBeenCalled()
  })

  it('changes nothing when the account could not be saved', async () => {
    env.api.aiSourcesUpdateSource.mockResolvedValue({ success: false, error: 'rejected' })
    const section = open(base({ currentGroupId: 'g1' }))
    await startEditing(section).props.onSave(edited)

    expect(env.api.aiSourcesSwitchSource).not.toHaveBeenCalled()
    expect(env.api.getConfig).not.toHaveBeenCalled()
    expect(section.setConfig).not.toHaveBeenCalled()
    expect(env.api.setConfig).not.toHaveBeenCalled()
  })

  it('closes the form once saved', async () => {
    const section = open(base({ currentGroupId: 'g1' }))
    await startEditing(section).props.onSave(edited)
    expect(ofType(section.draw(), ProviderSelector)).toBeUndefined()
    expect(headings(section.draw())).toEqual([])
  })
})

describe('deleting an account that is in a group', () => {
  it('says which groups it will leave', () => {
    const section = open(base())
    section.shown()
    cardHeads(section.draw())[0].props.onClick()
    buttons(section.draw(), 'Delete')[0].props.onClick()
    const text = paragraphs(section.draw()).join(' ')
    expect(text).toContain('It is also taken out of the load-balancing groups that use it: Daily.')
  })

  it('does not mention groups for an account no group uses', () => {
    const section = open(base({ groups: [{ ...group, members: [{ sourceId: 'backup', modelId: 'backup-m1' }] }] }))
    section.shown()
    cardHeads(section.draw())[0].props.onClick()
    buttons(section.draw(), 'Delete')[0].props.onClick()
    expect(paragraphs(section.draw()).join(' ')).not.toContain('load-balancing groups')
  })
})

describe('what happens to a group in the list', () => {
  it('is chosen for new chats like an account is', async () => {
    const section = open(base())
    const cards = ofType(section.shown(), GroupCards)
    await cards.props.onChoose('g1')
    expect(env.api.aiSourcesSwitchSource).toHaveBeenCalledWith('g1')
    expect(section.setConfig).toHaveBeenCalledWith(expect.objectContaining({ aiSources: { version: 2, currentId: 'switched', sources: [] } }))
  })

  it('opens and closes by its header, one at a time', () => {
    const section = open(base({ groups: [group, { ...group, id: 'g2', name: 'Other' }] }))
    section.shown()
    ofType(section.draw(), GroupCards).props.onToggle('g1')
    expect(ofType(section.draw(), GroupCards).props.expandedGroupId).toBe('g1')
    ofType(section.draw(), GroupCards).props.onToggle('g2')
    expect(ofType(section.draw(), GroupCards).props.expandedGroupId).toBe('g2')
    ofType(section.draw(), GroupCards).props.onToggle('g2')
    expect(ofType(section.draw(), GroupCards).props.expandedGroupId).toBeNull()
  })

  it('takes the settings it is given back when deleted, and its card is no longer open', () => {
    const section = open(base())
    section.shown()
    ofType(section.draw(), GroupCards).props.onToggle('g1')
    const after = base({ groups: [] })
    ofType(section.draw(), GroupCards).props.onDeleted(after, 'g1')
    expect(section.setConfig).toHaveBeenCalledWith({ aiSources: after })
    expect(ofType(section.draw(), GroupCards).props.expandedGroupId).toBeNull()
  })

  it('keeps another group\'s card open when a different one is deleted', () => {
    const section = open(base({ groups: [group, { ...group, id: 'g2', name: 'Other' }] }))
    section.shown()
    ofType(section.draw(), GroupCards).props.onToggle('g2')
    ofType(section.draw(), GroupCards).props.onDeleted(base({ groups: [{ ...group, id: 'g2', name: 'Other' }] }), 'g1')
    expect(ofType(section.draw(), GroupCards).props.expandedGroupId).toBe('g2')
  })

  it('shows what went wrong when a group cannot be deleted', () => {
    const section = open(base())
    section.shown()
    ofType(section.draw(), GroupCards).props.onError('The group could not be deleted. Please try again.')
    expect(walk(section.draw()).filter(node => node.props?.role === 'alert').map(textOf)).toEqual(['The group could not be deleted. Please try again.'])
  })
})

describe('making and editing a group', () => {
  it('opens an empty editor from the quiet menu, and returns to the list when cancelled', () => {
    const section = open(base())
    section.shown()
    ofType(section.draw(), GroupCreateMenu).props.onCreate()
    const tree = section.draw()
    expect(headings(tree)).toEqual(['Create Load-Balancing Group'])
    expect(ofType(tree, GroupEditor).props.group).toBeUndefined()

    ofType(tree, GroupEditor).props.onCancel()
    expect(ofType(section.draw(), GroupEditor)).toBeUndefined()
    expect(ofType(section.draw(), GroupCards)).toBeDefined()
  })

  it('opens the group\'s own editor from its card', () => {
    const section = open(base())
    section.shown()
    ofType(section.draw(), GroupCards).props.onEdit('g1')
    const tree = section.draw()
    expect(headings(tree)).toEqual(['Edit Load-Balancing Group'])
    expect(ofType(tree, GroupEditor).props.group).toEqual(group)
  })

  it('shows the saved group opened in the list, with the settings it came back with', () => {
    const section = open(base())
    section.shown()
    ofType(section.draw(), GroupCreateMenu).props.onCreate()
    const saved = base({ groups: [group, { ...group, id: 'g2', name: 'Weekend' }] })
    ofType(section.draw(), GroupEditor).props.onSaved({ aiSources: saved, groupId: 'g2' })

    expect(section.setConfig).toHaveBeenCalledWith({ aiSources: saved })
    const tree = section.draw()
    expect(ofType(tree, GroupEditor)).toBeUndefined()
    expect(ofType(tree, GroupCards).props.expandedGroupId).toBe('g2')
  })

  it('sends someone with no account on to adding one', () => {
    const section = open(base({ sources: [], currentId: null, groups: [] }))
    section.shown()
    ofType(section.draw(), GroupCreateMenu).props.onCreate()
    ofType(section.draw(), GroupEditor).props.onAddProvider()
    const tree = section.draw()
    expect(ofType(tree, GroupEditor)).toBeUndefined()
    expect(headings(tree)).toEqual(['Add AI Provider'])
    expect(ofType(tree, ProviderSelector)).toBeDefined()
  })
})

describe('the model card asking for a group\'s editor', () => {
  it('finds the request waiting when settings opens, opens that group and clears the request', () => {
    useGroupEditRequest.getState().request('g1')
    const section = open(base())
    section.shown()
    const tree = section.draw()
    expect(headings(tree)).toEqual(['Edit Load-Balancing Group'])
    expect(ofType(tree, GroupEditor).props.group).toEqual(group)
    expect(useGroupEditRequest.getState().groupId).toBeNull()
  })

  it('drops a request for a group that no longer exists', () => {
    useGroupEditRequest.getState().request('gone')
    const section = open(base())
    section.shown()
    expect(ofType(section.draw(), GroupEditor)).toBeUndefined()
    expect(ofType(section.draw(), GroupCards)).toBeDefined()
    expect(useGroupEditRequest.getState().groupId).toBeNull()
  })

  it('picks up a request that arrives while settings is already open', () => {
    const section = open(base())
    section.shown()
    expect(ofType(section.draw(), GroupEditor)).toBeUndefined()

    useGroupEditRequest.getState().request('g1')
    expect(headings(section.draw())).toEqual(['Edit Load-Balancing Group'])
    expect(useGroupEditRequest.getState().groupId).toBeNull()
  })

  it('stops listening once settings closes', () => {
    const section = open(base())
    section.shown()
    for (const cleanup of cleanups.splice(0)) cleanup()
    useGroupEditRequest.getState().request('g1')
    expect(ofType(section.draw(), GroupEditor)).toBeUndefined()
    expect(useGroupEditRequest.getState().groupId).toBe('g1')
  })
})
