import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any, target: {} as any, app: {} as any, mobile: false, chat: {} as any, api: {} as any }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => env.runner.state(initial),
  useRef: (initial: any) => env.runner.ref(initial),
  useEffect: () => {},
}))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: (select?: any) => select ? select(env.app) : env.app }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: (select: any) => select({ apps: [{ id: 'person', userOverrides: {} }] }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: Object.assign((select: any) => select(env.chat), { getState: () => env.chat }) }))
vi.mock('../../../src/renderer/hooks/useActiveModelTarget', () => ({ useActiveModelTarget: () => env.target }))
vi.mock('../../../src/renderer/hooks/useIsMobile', () => ({ useIsMobile: () => env.mobile }))
vi.mock('../../../src/renderer/utils/people-navigation', () => ({ openPersonModelSettings: vi.fn() }))
vi.mock('../../../src/renderer/services/home-telemetry', () => ({ trackHome: vi.fn() }))
vi.mock('../../../src/renderer/components/ai-config/ThinkingLevelControl', () => ({ ThinkingLevelControl: () => null }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
const fresh = vi.hoisted(() => vi.fn())
vi.mock('../../../src/renderer/hooks/useFreshModelCatalogs', () => ({ useFreshModelCatalogs: fresh }))

import { ModelSelector, ModelSelectSheet } from '../../../src/renderer/components/ai-config/ModelSelector'
import * as listParts from '../../../src/renderer/components/ai-config/model-list-parts'
import { AppModelSelector } from '../../../src/renderer/components/apps/AppModelSelector'
import { openPersonModelSettings } from '../../../src/renderer/utils/people-navigation'

class Runner {
  values: any[] = []
  index = 0
  state(initial: any) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial
    return [this.values[index], (value: any) => { this.values[index] = typeof value === 'function' ? value(this.values[index]) : value }]
  }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  render(component: () => any) { this.index = 0; env.runner = this; return component() }
}
/** The shared list parts hold no state, so they render inline like plain markup. */
const PARTS = new Set<unknown>(Object.values(listParts))
const expand = (tree: any): any => tree && typeof tree === 'object' && PARTS.has(tree.type) ? expand(tree.type(tree.props)) : tree
const nodes = (tree: any): any[] => { tree = expand(tree); return !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(nodes) : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }
const text = (tree: any): string => { tree = expand(tree); return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : !tree || typeof tree !== 'object' ? ''
  : Array.isArray(tree) ? tree.map(text).join(' ') : [tree.props?.children].flat(Infinity).map(text).join(' ') }
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && text(node).includes(label))
const source = { id: 'b', name: 'Global account B', model: 'b-model', provider: 'custom', availableModels: [{ id: 'b-model', name: 'Global model B', supportsVision: true, capabilities: { contextWindow: 1000000 } }] }

beforeEach(() => {
  env.app = { config: { aiSources: { version: 2, currentId: 'b', sources: [source] } }, navigate: vi.fn(), setConfig: vi.fn() }
  env.target = { kind: 'conversation', conversationId: 'c', conversation: { id: 'c', modelSourceId: 'removed', modelId: 'old-model' } }
  env.chat = { currentSpaceId: 's', setConversationModel: vi.fn().mockResolvedValue(undefined) }
  Object.assign(env.api, { aiSourcesSwitchSource: vi.fn().mockResolvedValue({ success: true, data: env.app.config.aiSources }), aiSourcesSetModel: vi.fn().mockResolvedValue({ success: true, data: env.app.config.aiSources }) })
  env.mobile = false
  vi.mocked(openPersonModelSettings).mockClear()
})

function selector() {
  const runner = new Runner()
  const render = () => runner.render(() => { const outer = ModelSelector(); return (outer.type as any)(outer.props) })
  return { runner, render }
}

function child(tree: any, name: string) {
  const element = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === name)
  return new Runner().render(() => element.type(element.props))
}

/** The checked model row of a rendered ModelList. */
const checkedRow = (list: any) => nodes(list).find(node => node.type === 'button' && nodes(node).some(child => child.type?.displayName === 'Check'))

describe('model selector for a conversation whose pinned account was removed', () => {
  it.each([false, true])('shows the global account and model the conversation now runs on (mobile=%s)', mobile => {
    env.mobile = mobile
    const { render } = selector()
    let tree = render()
    expect(nodes(tree).find(node => node.type === 'button')?.props['aria-label']).toBe('Global model B')
    nodes(tree).find(node => node.type === 'button').props.onClick()
    tree = render()
    if (mobile) {
      const sheet = child(tree, 'ModelSelectSheet')
      expect(text(sheet)).toContain('Global model B')
      expect(text(checkedRow(child(sheet, 'ModelList')))).toContain('Global model B')
    } else {
      const card = child(tree, 'CurrentModelCard')
      expect(text(card)).toContain('Global model B')
      expect(text(card)).toContain('Global account B')
      expect(text(card)).toContain('Context window')
    }
    expect(text(tree)).not.toContain('Account removed')
    expect(text(tree)).not.toContain('old-model')
    expect(env.chat.setConversationModel).not.toHaveBeenCalled()
  })

  it('checks the global model in the list and pins a chosen model to the conversation', async () => {
    const { render } = selector()
    nodes(render()).find(node => node.type === 'button').props.onClick()
    button(child(render(), 'CurrentModelCard'), 'Global model B').props.onClick()
    const list = child(render(), 'ModelList')
    expect(text(checkedRow(list))).toContain('Global model B')
    await button(list, 'Global model B').props.onClick()
    expect(env.chat.setConversationModel).toHaveBeenCalledWith('s', 'c', 'b', 'b-model')
  })

  it('offers configuration after the last source is removed', () => {
    env.app.config.aiSources = { version: 2, currentId: null, sources: [] }
    const { render } = selector()
    nodes(render()).find(node => node.type === 'button').props.onClick()
    const card = child(render(), 'CurrentModelCard')
    expect(text(card)).toContain('No AI sources configured')
    button(card, 'Configure AI Source').props.onClick()
    expect(env.app.navigate).toHaveBeenCalledWith('settings')
    const sheet = new Runner().render(() => ModelSelectSheet({ onClose: vi.fn() }))
    expect(text(child(sheet, 'ModelList'))).toContain('Configure AI Source')
  })

  it('shows a digital human the global model it now runs on and directs changes to its settings', () => {
    env.target = { kind: 'digital-human', appId: 'person', appName: 'Person', modelSourceId: 'removed', modelId: 'old-model' }
    const { render } = selector()
    nodes(render()).find(node => node.type === 'button').props.onClick()
    const tree = render()
    expect(text(tree)).toContain('Global model B')
    expect(text(tree)).not.toContain('Account removed')
    button(tree, 'Change in its settings').props.onClick()
    expect(openPersonModelSettings).toHaveBeenCalledWith('person')
  })
})

describe('current-model card with per-model settings', () => {
  it('shows the user\'s per-model settings over the catalog, and ignores a malformed one', () => {
    env.target = { kind: 'conversation', conversationId: 'c', conversation: { id: 'c' } }
    env.app.config.aiSources.sources = [{ ...source, modelOverrides: { 'b-model': { contextWindow: 870000, vision: false } } }]
    const { render } = selector()
    nodes(render()).find(node => node.type === 'button').props.onClick()
    let card = text(child(render(), 'CurrentModelCard'))
    expect(card).toContain('870K')
    expect(card).toContain('Not supported')
    env.app.config.aiSources.sources = [{ ...source, modelOverrides: { 'b-model': { contextWindow: -1 } } }]
    card = text(child(render(), 'CurrentModelCard'))
    expect(card).toContain('1M')
    expect(card).toContain('Supported')
  })
})

describe('vendor presentation and withdrawn models in the pickers', () => {
  const vendor = {
    id: 't', name: 'Vendor account', model: 'glm', provider: 'vendor-oauth', authType: 'oauth',
    availableModels: [
      { id: 'glm', name: 'GLM-5.2', badge: { label: 'Night offer', detail: 'Cheaper 23:00-08:00' }, costMultiplier: 0.5, regularCostMultiplier: 0.79 },
      { id: 'hy', name: 'Hy3', costMultiplier: 0 },
      { id: 'custom:maas', name: 'maas-model', group: 'enterprise' }
    ],
    withdrawnModels: [{ id: 'kimi-old', name: 'Kimi-K3 (old)', at: '2026-10-21T10:00:00.000Z' }]
  }

  beforeEach(() => {
    env.app.config.aiSources = { version: 2, currentId: 't', sources: [vendor] }
    env.target = { kind: 'conversation', conversationId: 'c', conversation: { id: 'c' } }
  })

  function openList() {
    const { render } = selector()
    nodes(render()).find(node => node.type === 'button').props.onClick()
    button(child(render(), 'CurrentModelCard'), 'GLM-5.2').props.onClick()
    return child(render(), 'ModelList')
  }

  it('lists the vendor badge and multiplier on each row and the enterprise models under their own heading', () => {
    const list = openList()
    const glm = button(list, 'GLM-5.2')
    expect(text(glm)).toContain('Night offer')
    expect(text(glm)).toContain('0.79x')
    expect(text(glm)).toContain('0.5x')
    expect(text(button(list, 'Hy3'))).toContain('0x')
    const all = text(list)
    expect(all.indexOf('Enterprise models')).toBeGreaterThan(all.indexOf('Hy3'))
    expect(all.indexOf('maas-model')).toBeGreaterThan(all.indexOf('Enterprise models'))
  })

  it('shows the offer and the cost of the current model on its card', () => {
    const { render } = selector()
    nodes(render()).find(node => node.type === 'button').props.onClick()
    const card = text(child(render(), 'CurrentModelCard'))
    expect(card).toContain('Night offer')
    expect(card).toContain('Credits per use')
    expect(card).toContain('Cheaper 23:00-08:00')
  })

  it('says a pinned model is no longer offered, under its last known name', () => {
    env.target = { kind: 'conversation', conversationId: 'c', conversation: { id: 'c', modelSourceId: 't', modelId: 'kimi-old' } }
    const { render } = selector()
    nodes(render()).find(node => node.type === 'button').props.onClick()
    const card = text(child(render(), 'CurrentModelCard'))
    expect(card).toContain('Kimi-K3 (old)')
    expect(card).toContain('{{model}} is no longer offered by {{account}}. Choose another model.')
    button(child(render(), 'CurrentModelCard'), 'Kimi-K3 (old)').props.onClick()
    expect(text(child(render(), 'ModelList'))).toContain('{{model}} is no longer offered by {{account}}. Choose another model.')
  })

  it('asks to pick a re-issued model again rather than calling it gone', () => {
    env.app.config.aiSources.sources = [{ ...vendor, withdrawnModels: [{ id: 'kimi-old', name: 'GLM-5.2', at: '2026-10-21T10:00:00.000Z' }] }]
    env.target = { kind: 'conversation', conversationId: 'c', conversation: { id: 'c', modelSourceId: 't', modelId: 'kimi-old' } }
    const { render } = selector()
    nodes(render()).find(node => node.type === 'button').props.onClick()
    const card = text(child(render(), 'CurrentModelCard'))
    expect(card).toContain('{{account}} updated {{model}}. Choose it again to use the current version.')
    expect(card).not.toContain('Choose another model.')
  })

  it('asks main for fresh lists as soon as the current-model card opens', () => {
    const { render } = selector()
    nodes(render()).find(node => node.type === 'button').props.onClick()
    fresh.mockClear()
    child(render(), 'CurrentModelCard')
    expect(fresh).toHaveBeenCalledWith(true)
  })

  it('shows the cost and the offer of the current model at the top of the phone sheet', () => {
    env.mobile = true
    const { render } = selector()
    nodes(render()).find(node => node.type === 'button').props.onClick()
    const sheet = text(child(render(), 'ModelSelectSheet'))
    expect(sheet).toContain('Credits per use')
    expect(sheet).toContain('0.5x')
    expect(sheet).toContain('Cheaper 23:00-08:00')
  })

  it('does not tell a digital human with its own model that the account model was replaced', () => {
    const replaced = { ...vendor, modelReplacement: { from: 'kimi-old', fromName: 'Kimi-K3 (old)', to: 'glm', at: new Date().toISOString() } }
    env.app.config.aiSources.sources = [replaced]
    const note = '{{from}} is no longer offered, so this account now uses {{to}}.'
    const popover = () => {
      const { render } = selector()
      nodes(render()).find(node => node.type === 'button').props.onClick()
      return text(render())
    }

    env.target = { kind: 'digital-human', appId: 'person', appName: 'Person', modelSourceId: 't', modelId: 'glm' }
    expect(popover()).not.toContain(note)
    const settings = text(new Runner().render(() => AppModelSelector({ modelSourceId: 't', modelId: 'glm', onChange: vi.fn() })))
    expect(settings).not.toContain(note)

    env.target = { kind: 'digital-human', appId: 'person', appName: 'Person' }
    expect(popover()).toContain(note)
  })

  it('mentions a replaced account model for a week, then stops', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-22T00:00:00.000Z'))
      env.app.config.aiSources.sources = [{ ...vendor, modelReplacement: { from: 'kimi-old', fromName: 'Kimi-K3 (old)', to: 'glm', at: '2026-10-21T10:00:00.000Z' } }]
      const { render } = selector()
      nodes(render()).find(node => node.type === 'button').props.onClick()
      expect(text(child(render(), 'CurrentModelCard'))).toContain('{{from}} is no longer offered, so this account now uses {{to}}.')
      vi.setSystemTime(new Date('2026-10-29T00:00:00.000Z'))
      expect(text(child(render(), 'CurrentModelCard'))).not.toContain('{{from}} is no longer offered')
    } finally {
      vi.useRealTimers()
    }
  })
})
