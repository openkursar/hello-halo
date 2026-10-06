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

import { ModelSelector, ModelSelectSheet } from '../../../src/renderer/components/ai-config/ModelSelector'
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
const nodes = (tree: any): any[] => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(nodes) : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
const text = (tree: any): string => typeof tree === 'string' ? tree : !tree || typeof tree !== 'object' ? ''
  : Array.isArray(tree) ? tree.map(text).join(' ') : [tree.props?.children].flat(Infinity).map(text).join(' ')
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

describe('model selector account ownership', () => {
  it.each([false, true])('does not present global account facts for a removed conversation pin (mobile=%s)', mobile => {
    env.mobile = mobile
    const { render } = selector()
    let tree = render()
    expect(nodes(tree).find(node => node.type === 'button')?.props['aria-label']).toBe('Account removed. Choose another account.')
    nodes(tree).find(node => node.type === 'button').props.onClick()
    tree = render()
    const content = mobile ? child(child(tree, 'ModelSelectSheet'), 'ModelList') : child(tree, 'CurrentModelCard')
    expect(text(content)).toContain('Account removed. Choose another account.')
    if (mobile) {
      expect(nodes(content).some(node => node.type?.displayName === 'Check')).toBe(false)
    } else {
      expect(text(content)).not.toContain('Global model B')
      expect(text(content)).not.toContain('Global account B')
    }
    expect(text(content)).not.toContain('Context window')
    expect(env.chat.setConversationModel).not.toHaveBeenCalled()
  })

  it('makes an explicit selection the only operation that replaces the removed pin', async () => {
    const { render } = selector()
    nodes(render()).find(node => node.type === 'button').props.onClick()
    button(child(render(), 'CurrentModelCard'), 'Choose another account').props.onClick()
    const list = child(render(), 'ModelList')
    expect(text(list)).toContain('Account removed. Choose another account.')
    await button(list, 'Global model B').props.onClick()
    expect(env.chat.setConversationModel).toHaveBeenCalledWith('s', 'c', 'b', 'b-model')
  })

  it('keeps recovery visible after the last source is removed', () => {
    env.app.config.aiSources = { version: 2, currentId: null, sources: [] }
    const { render } = selector()
    nodes(render()).find(node => node.type === 'button').props.onClick()
    const card = child(render(), 'CurrentModelCard')
    button(card, 'Configure AI Source').props.onClick()
    expect(env.app.navigate).toHaveBeenCalledWith('settings')
    const sheet = new Runner().render(() => ModelSelectSheet({ onClose: vi.fn() }))
    expect(text(child(sheet, 'ModelList'))).toContain('Account removed. Choose another account.')
  })

  it('directs a digital human to its own settings without showing the global account as its model', () => {
    env.target = { kind: 'digital-human', appId: 'person', appName: 'Person', modelSourceId: 'removed', modelId: 'old-model' }
    const { render } = selector()
    nodes(render()).find(node => node.type === 'button').props.onClick()
    const tree = render()
    expect(text(tree)).toContain('Account removed. Choose another account.')
    expect(text(tree)).not.toContain('Global model B')
    button(tree, 'Change in its settings').props.onClick()
    expect(openPersonModelSettings).toHaveBeenCalledWith('person')
  })
})
