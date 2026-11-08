/**
 * What a person sees of a load-balancing group, as markup: the card in the
 * provider list, the model card in the dropdown, the editor and its add-model
 * panel. Behaviour is covered where it lives (the pure model, the editor flows);
 * this pins the words and states a screen must show.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const translate = (text: string, values?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } }),
  getCurrentLanguage: () => 'en',
}))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))

import { GroupCard } from '../../../src/renderer/components/ai-groups/GroupCard'
import { GroupEditor } from '../../../src/renderer/components/ai-groups/GroupEditor'
import { GroupModelCard } from '../../../src/renderer/components/ai-groups/GroupModelCard'
import { GroupModelPicker } from '../../../src/renderer/components/ai-groups/GroupModelPicker'
import { GroupRouteStatus } from '../../../src/renderer/components/ai-groups/GroupRouteStatus'
import type { AIGroup, AISource, AISourcesConfig } from '../../../src/shared/types/ai-sources'
import type { GroupRouteInfo } from '../../../src/shared/types/ai-groups-runtime'

function render<P extends object>(component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(createElement(component, props))
}

function account(id: string, extra: Partial<AISource> = {}): AISource {
  return {
    id, name: id, provider: 'custom', authType: 'api-key', apiUrl: 'https://example.invalid', apiKey: 'key',
    model: `${id}-m1`, availableModels: [{ id: `${id}-m1`, name: `${id} model one` }, { id: `${id}-m2`, name: `${id} model two` }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
  }
}

const group = (extra: Partial<AIGroup> = {}): AIGroup => ({
  id: 'g1', name: 'Daily', strategy: 'priority',
  members: [{ sourceId: 'main', modelId: 'main-m1' }, { sourceId: 'backup', modelId: 'backup-m2' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
})

const sources = [account('main'), account('backup')]
const config = (extra: Partial<AISourcesConfig> = {}): AISourcesConfig => ({ version: 2, currentId: 'main', sources, ...extra })

const route = (state: GroupRouteInfo['state'], withMember = true): GroupRouteInfo => ({
  groupId: 'g1', sessionKey: 'c1', state, at: 1,
  ...(withMember ? { member: { key: 'k', sourceId: 'backup', modelId: 'backup-m2', label: { account: 'backup', model: 'backup model two' } } } : {}),
})

describe('the group card in the provider list', () => {
  const props = { group: group(), sources, chosen: false, expanded: false, onToggle: vi.fn(), onChoose: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }

  it('reads like a provider: a name, an Auto mark, and how many accounts and models', () => {
    const html = render(GroupCard, props)
    expect(html).toContain('Daily')
    expect(html).toContain('>Auto<')
    expect(html).toContain('2 accounts')
    expect(html).toContain('2 models')
  })

  it('counts an account once however many of its models are in the group', () => {
    const html = render(GroupCard, { ...props, group: group({ members: [{ sourceId: 'main', modelId: 'main-m1' }, { sourceId: 'main', modelId: 'main-m2' }] }) })
    expect(html).toContain('1 accounts')
    expect(html).toContain('2 models')
  })

  it('shows nothing about the models until it is opened', () => {
    const html = render(GroupCard, props)
    expect(html).not.toContain('in the order they are used')
    expect(html).not.toContain('Delete')
  })

  it('marks the group chosen for new chats the way an account is marked', () => {
    expect(render(GroupCard, { ...props, chosen: true })).toContain('aria-checked="true"')
    expect(render(GroupCard, props)).toContain('aria-checked="false"')
  })

  it('opens to the models in the order they are used, each with its account', () => {
    const html = render(GroupCard, { ...props, expanded: true })
    expect(html).toContain('Models, in the order they are used')
    expect(html.indexOf('main model one')).toBeGreaterThan(-1)
    expect(html.indexOf('main model one')).toBeLessThan(html.indexOf('backup model two'))
    expect(html).toContain('>Edit<')
    expect(html).toContain('>Delete<')
  })

  it('says a lone model has no backup yet', () => {
    const html = render(GroupCard, { ...props, expanded: true, group: group({ members: [{ sourceId: 'main', modelId: 'main-m1' }] }) })
    expect(html).toContain('No backup yet')
  })

  it('flags a model whose account is signed out', () => {
    const html = render(GroupCard, { ...props, expanded: true, sources: [account('main', { apiKey: '' }), account('backup')] })
    expect(html).toContain('Not signed in')
  })
})

describe('where the conversation is, in the dropdown', () => {
  const base = { group: group(), sources, route: null as GroupRouteInfo | null, live: false, onSwitch: vi.fn(), onEdit: vi.fn() }

  it('names the group with its Auto mark and how it chooses', () => {
    const html = render(GroupModelCard, base)
    expect(html).toContain('Daily')
    expect(html).toContain('>Auto<')
    expect(html).toContain('2 models · Use in order')
    expect(render(GroupModelCard, { ...base, group: group({ strategy: 'spread' }) })).toContain('Spread across accounts')
  })

  it('does not name a model before the router has served the conversation', () => {
    const html = render(GroupModelCard, base)
    expect(html).toContain('Picked automatically when you send')
    expect(html).not.toContain('In use for this chat')
  })

  it('shows the account and model that are serving, not just the vendor', () => {
    const html = render(GroupModelCard, { ...base, route: route('serving') })
    expect(html).toContain('In use for this chat')
    expect(html).toContain('backup model two')
    expect(html).toContain('>backup<')
  })

  it('shows the model being tried while Halo switches, and only while a reply is awaited', () => {
    const live = render(GroupModelCard, { ...base, route: route('switching'), live: true })
    expect(live).toContain('Trying another model')
    expect(live).toContain('backup model two')
    const stale = render(GroupModelCard, { ...base, route: route('switching'), live: false })
    expect(stale).not.toContain('Trying another model')
    expect(stale).toContain('Picked automatically when you send')
  })

  it('warns when no model is available', () => {
    const html = render(GroupModelCard, { ...base, route: route('exhausted', false) })
    expect(html).toContain('No model is available right now')
    expect(html).toContain('text-halo-warning')
  })

  it('states what the group promises: the smallest context window, images only if all see them', () => {
    const small = [
      account('main', { availableModels: [{ id: 'main-m1', name: 'big', supportsVision: true, capabilities: { contextWindow: 1_000_000 } } as never] }),
      account('backup', { availableModels: [{ id: 'backup-m2', name: 'small', supportsVision: false, capabilities: { contextWindow: 128_000 } } as never] }),
    ]
    const html = render(GroupModelCard, { ...base, sources: small })
    expect(html).toContain('128K')
    expect(html).toContain('Not supported')
  })

  it('leaves out the limits of a lone model that the catalog does not state, as for any account', () => {
    const html = render(GroupModelCard, { ...base, group: group({ members: [{ sourceId: 'main', modelId: 'main-m1' }] }) })
    expect(html).not.toContain('Context window')
    expect(html).not.toContain('Image input')
  })

  it('says image input is not confirmed for a group of several models when nothing is known, never that it is supported', () => {
    const html = render(GroupModelCard, base)
    expect(html).toContain('Image input')
    expect(html).toContain('Not confirmed')
    expect(html).not.toContain('Supported')
    expect(html).not.toContain('Context window')
  })

  it('says when the context size is not known for every model of a mixed group', () => {
    const mixed = [
      account('main', { availableModels: [{ id: 'main-m1', name: 'big', supportsVision: true, capabilities: { contextWindow: 200_000 } } as never] }),
      account('backup'),
    ]
    const html = render(GroupModelCard, { ...base, sources: mixed })
    expect(html).toContain('200K')
    expect(html).toContain('not confirmed for every model')
  })

  it('offers the way to the group\'s settings and carries the shared controls below', () => {
    const html = render(GroupModelCard, { ...base, children: createElement('div', { id: 'shared-controls' }) })
    expect(html).toContain('Edit this group')
    expect(html).toContain('id="shared-controls"')
  })
})

describe('the route line on its own', () => {
  it('is a live region, so a change is announced without anything entering the chat', () => {
    const html = render(GroupRouteStatus, { route: route('serving'), live: false })
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
  })
})

describe('the group editor', () => {
  const props = { aiSources: config(), onSaved: vi.fn(), onCancel: vi.fn(), onAddProvider: vi.fn() }

  it('says in a sentence what it is for and what it uses', () => {
    const html = render(GroupEditor, props)
    expect(html).toContain('Combine several accounts and models. When quota runs out or a service fails, Halo automatically tries another model.')
    expect(html).toContain('Halo only uses the models you add.')
    expect(html).toContain('How it works')
  })

  it('starts a new group with a free name and no models, and creates rather than saves', () => {
    const html = render(GroupEditor, props)
    expect(html).toContain('value="Model group"')
    expect(html).toContain('No models yet')
    expect(html).toContain('>Create<')
    expect(html).toContain('Quick add from accounts')
    expect(html).toContain('Add model')
    expect(html.indexOf('Add model')).toBeLessThan(html.indexOf('Quick add from accounts'))
    expect(html).toContain('Adds the currently selected model from each account.')
    expect(html).not.toContain('lucide-sparkles')
  })

  it('numbers a new name apart from the ones in use', () => {
    const html = render(GroupEditor, { ...props, aiSources: config({ groups: [group({ name: 'Model group' })] }) })
    expect(html).toContain('value="Model group 2"')
  })

  it('keeps the choice of how Halo picks out of sight until asked', () => {
    const html = render(GroupEditor, props)
    expect(html).toContain('More settings')
    expect(html).not.toContain('Spread across accounts')
  })

  it('edits a stored group: its models in order, a note on who is affected, and a Save button', () => {
    const html = render(GroupEditor, { ...props, group: group(), aiSources: config({ groups: [group()] }) })
    expect(html).toContain('value="Daily"')
    expect(html.indexOf('main model one')).toBeLessThan(html.indexOf('backup model two'))
    expect(html).toContain('Changes apply to every chat and digital human that uses this group')
    expect(html).toContain('>Save<')
    expect(html).toContain('Models higher in the list are used first.')
  })

  it('suggests another model when the group has only one', () => {
    const html = render(GroupEditor, { ...props, group: group({ members: [{ sourceId: 'main', modelId: 'main-m1' }] }) })
    expect(html).toContain('Add another model so Halo can switch when this one is unavailable.')
  })

  it('warns, before saving, about what a mixed group gives up', () => {
    const mixed = [
      account('main', { availableModels: [{ id: 'main-m1', name: 'big', supportsVision: true, capabilities: { contextWindow: 1_000_000 } } as never] }),
      account('backup', { availableModels: [{ id: 'backup-m2', name: 'small', supportsVision: false, capabilities: { contextWindow: 128_000 } } as never] }),
    ]
    const html = render(GroupEditor, { ...props, group: group(), aiSources: config({ sources: mixed, groups: [group()] }) })
    expect(html).toContain('limited to 128K because of backup / small')
    expect(html).toContain('Image input is off for this group because backup / small cannot read images')
  })

  it('points someone with no account to adding one, instead of an empty form', () => {
    const html = render(GroupEditor, { ...props, aiSources: config({ sources: [], currentId: null }) })
    expect(html).toContain('Add an AI provider first.')
    expect(html).toContain('Add AI Provider')
    expect(html).not.toContain('id="group-name"')
    expect(html).toContain('disabled')
  })

  it('treats accounts that cannot serve as no accounts at all', () => {
    const html = render(GroupEditor, { ...props, aiSources: config({ sources: [account('cli', { authType: 'delegated', apiKey: undefined }), account('out', { apiKey: '' })] }) })
    expect(html).toContain('Add an AI provider first.')
  })
})

describe('the add-model panel', () => {
  const props = { sources: [account('main'), account('cli', { authType: 'delegated', apiKey: undefined }), account('backup')], taken: new Set<string>(), room: 10, onAdd: vi.fn(), onClose: vi.fn() }

  it('lists accounts that can join first and says why the others cannot', () => {
    const html = render(GroupModelPicker, props)
    expect(html.indexOf('>main<')).toBeLessThan(html.indexOf('>cli<'))
    expect(html.indexOf('>backup<')).toBeLessThan(html.indexOf('>cli<'))
    expect(html).toContain('Signs in through Claude Code, which groups cannot use')
  })

  it('keeps each account closed until opened, so a long list stays short', () => {
    const html = render(GroupModelPicker, props)
    expect(html).not.toContain('main model one')
    expect(html).toContain('aria-expanded="false"')
  })

  it('opens the only account by itself', () => {
    const html = render(GroupModelPicker, { ...props, sources: [account('main')] })
    expect(html).toContain('main model one')
    expect(html).toContain('main model two')
  })

  it('shows a model already in the group as added and not choosable again', () => {
    const html = render(GroupModelPicker, { ...props, sources: [account('main')], taken: new Set(['main\u0000main-m1']) })
    expect(html).toContain('>Added<')
    expect(html).toMatch(/checked=""[^>]*disabled=""|disabled=""[^>]*checked=""/)
  })

  it('has nothing to add yet, and says so by leaving the button off', () => {
    const html = render(GroupModelPicker, { ...props, sources: [account('main')] })
    expect(html).toMatch(/disabled=""[^>]*>Add</)
  })
})
