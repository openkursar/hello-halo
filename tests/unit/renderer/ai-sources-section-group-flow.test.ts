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
  confirmation: null as any,
  confirm: vi.fn(),
}))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useRef: (value: any) => env.runner.ref(value),
  useEffect: (effect: () => void | (() => void)) => { env.effects.push(effect) },
  useLayoutEffect: () => {},
  useId: () => 'source-editor',
}))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')) }),
  getCurrentLanguage: () => 'en',
}))
// Without an organization sign-in in this build, its store is never started.
vi.mock('../../../src/renderer/stores/org-sign-in.store', () => {
  const store = { state: null, readFailed: false, lastResult: null, start: () => {}, signIn: async () => 'cancelled', signOut: async () => {}, retry: async () => {} }
  return { useOrgSignInStore: Object.assign((select: (value: typeof store) => unknown) => select(store), { getState: () => store }) }
})
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/hooks/useOAuthLogin', () => ({ useOAuthLogin: () => ({ login: null, start: vi.fn(), cancel: vi.fn() }) }))
vi.mock('../../../src/renderer/components/settings/ProviderSelector', () => ({ ProviderSelector: () => null }))
vi.mock('../../../src/renderer/components/settings/OAuthAccountEditor', () => ({ OAuthAccountEditor: () => null }))
vi.mock('../../../src/renderer/components/settings/DelegatedLoginDialog', () => ({ DelegatedLoginDialog: () => null }))
vi.mock('../../../src/renderer/components/ai-config/OAuthRedirectLogin', () => ({ OAuthRedirectLogin: () => null }))
vi.mock('../../../src/renderer/components/icons/ProviderIconTile', () => ({ ProviderIconTile: () => null }))
vi.mock('../../../src/renderer/components/icons/BrandIcons', () => ({ getBrandIcon: () => null }))

import { AISourcesSection } from '../../../src/renderer/components/settings/AISourcesSection'
import { AISourceCard } from '../../../src/renderer/components/settings/AISourceCard'
import { OAuthAccountEditor } from '../../../src/renderer/components/settings/OAuthAccountEditor'

vi.mock('../../../src/renderer/hooks/useConfirmDialog', () => ({
  useConfirmDialog: () => ({
    showConfirm: (options: unknown) => { env.confirmation = options; return env.confirm(options) },
    DialogComponent: null,
  }),
}))
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
  return [tree, ...[tree.props?.children, tree.type === GroupCards && !tree.props.editingGroupId ? null : tree.props?.editor].flat(Infinity).flatMap(walk)]
}
function textOf(node: any): string {
  return [node?.props?.children].flat(Infinity).map(child => typeof child === 'string' ? child : child && typeof child === 'object' ? textOf(child) : '').join('')
}
const ofType = (tree: any, type: unknown) => walk(tree).find(node => node.type === type)
const buttons = (tree: any, label: string) => walk(tree).filter(node => node.type === 'button' && textOf(node) === label)
const regions = (tree: any) => walk(tree).filter(node => node.type === 'fieldset' && node.props['data-ai-source-editor'] !== undefined)
const headings = (tree: any) => regions(tree).map(node => node.props['aria-label'])
const cards = (tree: any) => walk(tree).filter(node => node.type === AISourceCard)

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
  cards(section.draw())[0].props.onToggle()
  cards(section.draw())[0].props.onEdit()
  return ofType(section.draw(), ProviderSelector)
}

beforeEach(() => {
  env.effects.length = 0
  env.confirmation = null
  env.confirm.mockReset().mockResolvedValue(true)
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
    buttons(section.draw(), 'Add AI Provider')[0].props.onClick({ currentTarget: null })
    const added = account('fresh')
    await ofType(section.draw(), ProviderSelector).props.onSave(added)

    expect(env.api.aiSourcesAddSource).toHaveBeenCalledWith(added)
    expect(env.api.aiSourcesSwitchSource).toHaveBeenCalledWith('fresh')
    expect(env.api.getConfig).not.toHaveBeenCalled()
  })

  it('changes nothing when the account could not be saved', async () => {
    env.api.aiSourcesUpdateSource.mockResolvedValue({ success: false, error: 'rejected' })
    const section = open(base({ currentGroupId: 'g1' }))
    await expect(startEditing(section).props.onSave(edited)).rejects.toThrow('Save failed')
    expect(ofType(section.draw(), ProviderSelector)).toBeDefined()

    expect(env.api.aiSourcesSwitchSource).not.toHaveBeenCalled()
    expect(env.api.getConfig).not.toHaveBeenCalled()
    expect(section.setConfig).not.toHaveBeenCalled()
    expect(env.api.setConfig).not.toHaveBeenCalled()
  })

  it('logs the failed stage and backend reason without account credentials', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const secret = 'fictional-save-secret'
    env.api.aiSourcesUpdateSource.mockResolvedValue({ success: false, error: `Storage denied for ${secret}` })
    const section = open(base())
    await expect(startEditing(section).props.onSave({ ...edited, apiKey: secret })).rejects.toThrow('Save failed')
    const diagnostic = warning.mock.calls.flat().join(' ')
    expect(diagnostic).toContain('stage=persist')
    expect(diagnostic).toContain('Storage denied')
    expect(diagnostic).not.toContain(secret)
  })

  it('keeps the draft open after a refused selection and retries the saved account instead of adding twice', async () => {
    env.api.aiSourcesSwitchSource.mockResolvedValueOnce({ success: false })
    const section = open(base())
    section.shown()
    buttons(section.draw(), 'Add AI Provider')[0].props.onClick({ currentTarget: null })
    const added = account('fresh')
    await expect(ofType(section.draw(), ProviderSelector).props.onSave(added)).rejects.toThrow('Save failed')
    expect(regions(section.draw())[0].props.disabled).toBe(false)
    expect(ofType(section.draw(), ProviderSelector)).toBeDefined()
    await ofType(section.draw(), ProviderSelector).props.onSave(added)
    expect(env.api.aiSourcesAddSource).toHaveBeenCalledTimes(1)
    expect(env.api.aiSourcesUpdateSource).toHaveBeenCalledWith(added.id, added)
    expect(ofType(section.draw(), ProviderSelector)).toBeUndefined()
  })

  it('keeps a settings-write refusal visible and closes only when the retry completes', async () => {
    env.api.setConfig.mockResolvedValueOnce({ success: false })
    const section = open(base())
    const editor = startEditing(section)
    await expect(editor.props.onSave(edited)).rejects.toThrow('Save failed')
    expect(ofType(section.draw(), ProviderSelector)).toBeDefined()
    await ofType(section.draw(), ProviderSelector).props.onSave(edited)
    expect(ofType(section.draw(), ProviderSelector)).toBeUndefined()
  })

  it('blocks dismissal and a second save while a write is pending, then restores the draft after failure', async () => {
    let resolveWrite!: (value: unknown) => void
    env.api.aiSourcesUpdateSource.mockReturnValueOnce(new Promise(resolve => { resolveWrite = resolve }))
    const section = open(base())
    const form = startEditing(section)
    const pending = form.props.onSave(edited)
    const rejection = expect(pending).rejects.toThrow('Save failed')
    expect(regions(section.draw())[0].props.disabled).toBe(true)
    ofType(section.draw(), ProviderSelector).props.onCancel()
    await ofType(section.draw(), ProviderSelector).props.onSave(edited)
    expect(env.api.aiSourcesUpdateSource).toHaveBeenCalledTimes(1)
    expect(ofType(section.draw(), ProviderSelector)).toBeDefined()
    resolveWrite({ success: false })
    await rejection
    expect(regions(section.draw())[0].props.disabled).toBe(false)
    ofType(section.draw(), ProviderSelector).props.onCancel()
    expect(ofType(section.draw(), ProviderSelector)).toBeUndefined()
  })

  it('closes the form once saved', async () => {
    const section = open(base({ currentGroupId: 'g1' }))
    await startEditing(section).props.onSave(edited)
    expect(ofType(section.draw(), ProviderSelector)).toBeUndefined()
    expect(headings(section.draw())).toEqual([])
  })
})

describe('deleting an account that is in a group', () => {
  it('closes the confirmation before writing and reports a failed deletion at the account', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    env.api.aiSourcesDeleteSource.mockResolvedValue({ success: false })
    const section = open(base())
    section.shown()
    cards(section.draw())[0].props.onToggle()
    cards(section.draw())[0].props.onDelete()
    await new Promise(resolve => setTimeout(resolve, 0))
    const tree = section.draw()
    expect(env.confirmation).toEqual(expect.objectContaining({ title: 'Delete this account?', variant: 'danger' }))
    expect(cards(tree)[0].props.deleteError).toBe('Delete failed')
    expect(section.setConfig).not.toHaveBeenCalled()
  })

  it('says which groups it will leave', () => {
    const section = open(base())
    section.shown()
    cards(section.draw())[0].props.onToggle()
    cards(section.draw())[0].props.onDelete()
    const text = env.confirmation.message
    expect(text).toContain('It is also taken out of the load-balancing groups that use it: Daily.')
  })

  it('does not mention groups for an account no group uses', () => {
    const section = open(base({ groups: [{ ...group, members: [{ sourceId: 'backup', modelId: 'backup-m1' }] }] }))
    section.shown()
    cards(section.draw())[0].props.onToggle()
    cards(section.draw())[0].props.onDelete()
    expect(env.confirmation.message).not.toContain('load-balancing groups')
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

describe('inline editor ownership and save guards', () => {
  it('puts the editor only in its account card and replaces it when another account is edited', () => {
    const section = open(base())
    startEditing(section)
    let tree = section.draw()
    expect(cards(tree)[0].props.editor).toBeDefined()
    expect(cards(tree)[0].props.expanded).toBe(true)
    expect(cards(tree)[1].props.editor).toBeUndefined()
    expect(regions(tree)).toHaveLength(1)
    expect(regions(tree)[0].props.role).toBe('region')
    expect(ofType(tree, ProviderSelector).props.variant).toBe('inline')
    cards(tree)[1].props.onEdit()
    tree = section.draw()
    expect(cards(tree)[0].props.editor).toBeUndefined()
    expect(cards(tree)[1].props.editor).toBeDefined()
    expect(regions(tree)).toHaveLength(1)
    expect(env.api.aiSourcesUpdateSource).not.toHaveBeenCalled()
  })

  it('closes an editor whose account was removed elsewhere', () => {
    const section = open(base())
    startEditing(section)
    section.config.aiSources!.sources = [account('backup')]
    section.shown()
    expect(regions(section.draw())).toHaveLength(0)
  })

  it('waits for confirmation before deleting and blocks editing until the decision returns', async () => {
    let decide!: (confirmed: boolean) => void
    env.confirm.mockReturnValueOnce(new Promise<boolean>(resolve => { decide = resolve }))
    const section = open(base())
    cards(section.shown())[0].props.onDelete()
    cards(section.draw())[1].props.onEdit()
    expect(regions(section.draw())).toHaveLength(0)
    expect(env.api.aiSourcesDeleteSource).not.toHaveBeenCalled()
    decide(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(env.api.aiSourcesDeleteSource).toHaveBeenCalledWith('main')
  })

  it('closes an editor whose group was removed elsewhere', () => {
    const section = open(base())
    ofType(section.shown(), GroupCards).props.onEdit('g1')
    section.config.aiSources!.groups = []
    section.shown()
    expect(regions(section.draw())).toHaveLength(0)
  })

  it('does not delete an account when confirmation is cancelled', async () => {
    env.confirm.mockResolvedValueOnce(false)
    const section = open(base())
    cards(section.shown())[0].props.onDelete()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(env.api.aiSourcesDeleteSource).not.toHaveBeenCalled()
    cards(section.draw())[0].props.onEdit()
    expect(regions(section.draw())).toHaveLength(1)
  })

  it('keeps an OAuth editor at its account while saving and does not alter selection or setup flags', async () => {
    const section = open(base({ sources: [account('oauth', { authType: 'oauth', provider: 'chatgpt' })] }))
    cards(section.shown())[0].props.onEdit()
    const oauth = ofType(section.draw(), OAuthAccountEditor)
    oauth.props.onSavingChange(true)
    buttons(section.draw(), 'Add AI Provider')[0].props.onClick()
    ofType(section.draw(), GroupCards).props.onEdit('g1')
    oauth.props.onCancel()
    expect(ofType(section.draw(), OAuthAccountEditor)).toBeDefined()
    expect(regions(section.draw())).toHaveLength(1)
    expect(regions(section.draw())[0].props.disabled).toBe(true)
    oauth.props.onSavingChange(false)
    await oauth.props.onSaved()
    expect(regions(section.draw())).toHaveLength(0)
    expect(env.api.aiSourcesSwitchSource).not.toHaveBeenCalled()
    expect(env.api.setConfig).not.toHaveBeenCalled()
  })

  it('keeps a saving group at its own slot and saves without selecting it or clearing setup flags', () => {
    const section = open(base())
    ofType(section.shown(), GroupCards).props.onEdit('g1')
    const form = ofType(section.draw(), GroupEditor)
    expect(ofType(section.draw(), GroupCards).props.editingGroupId).toBe('g1')
    form.props.onSavingChange(true)
    cards(section.draw())[0].props.onEdit()
    form.props.onCancel()
    expect(ofType(section.draw(), GroupEditor)).toBeDefined()
    expect(regions(section.draw())).toHaveLength(1)
    form.props.onSavingChange(false)
    form.props.onSaved({ aiSources: base(), groupId: 'g1' })
    expect(regions(section.draw())).toHaveLength(0)
    expect(env.api.aiSourcesSwitchSource).not.toHaveBeenCalled()
    expect(env.api.setConfig).not.toHaveBeenCalled()
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
