/**
 * Choosing a model while load-balancing groups exist: a group is one choice in
 * the list, picking it pins the conversation and starts new chats on it, and
 * picking an account's model afterwards leaves the group.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  runner: null as any,
  appState: {} as any,
  chatState: {} as any,
  target: {} as any,
  api: {} as Record<string, any>,
  isGenerating: false,
  activeId: 'c1',
  routeHook: vi.fn(),
}))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useRef: (value: any) => env.runner.ref(value),
  useEffect: () => {},
}))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')) }),
  getCurrentLanguage: () => 'en',
}))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/stores/app.store', () => ({
  useAppStore: Object.assign((select?: any) => select ? select(env.appState) : env.appState, { getState: () => env.appState }),
}))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: (select: any) => select({ apps: [] }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: Object.assign((select?: any) => select ? select(env.chatState) : env.chatState, { getState: () => env.chatState }),
  selectActiveConversationId: () => env.activeId,
  useIsGenerating: () => env.isGenerating,
}))
vi.mock('../../../src/renderer/hooks/useActiveModelTarget', () => ({ useActiveModelTarget: () => env.target }))
vi.mock('../../../src/renderer/hooks/useIsMobile', () => ({ useIsMobile: () => true }))
vi.mock('../../../src/renderer/hooks/useFreshModelCatalogs', () => ({ useFreshModelCatalogs: () => {} }))
vi.mock('../../../src/renderer/hooks/useConversationGroupRoute', () => ({ useConversationGroupRoute: (...args: unknown[]) => env.routeHook(...args) }))
vi.mock('../../../src/renderer/services/home-telemetry', () => ({ trackHome: vi.fn() }))
vi.mock('../../../src/renderer/utils/people-navigation', () => ({ openPersonModelSettings: vi.fn() }))
vi.mock('../../../src/renderer/utils/group-navigation', () => ({ openGroupEditor: vi.fn() }))
vi.mock('../../../src/renderer/components/ai-config/ThinkingLevelControl', () => ({ ThinkingLevelControl: () => null }))
vi.mock('../../../src/renderer/components/ai-config/ConversationEngineSelector', () => ({ ConversationEngineSection: () => null }))

import { ModelSelector, ModelSelectSheet } from '../../../src/renderer/components/ai-config/ModelSelector'
import { useConversationEngineId } from '../../../src/renderer/hooks/useConversationEngine'
import type { Conversation } from '../../../src/renderer/types'
import type { AIGroup, AISource, AISourcesConfig } from '../../../src/shared/types/ai-sources'
import type { GroupRouteInfo } from '../../../src/shared/types/ai-groups-runtime'

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
// Resolve each function component once per draw so inspecting the tree cannot advance its hooks.
function expand(tree: any): any {
  if (Array.isArray(tree)) return tree.map(expand)
  if (!tree || typeof tree !== 'object') return tree
  if (typeof tree.type === 'function') return expand(tree.type(tree.props))
  return { ...tree, props: { ...tree.props, children: expand(tree.props?.children) } }
}
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}
function textOf(node: any): string {
  return [node?.props?.children].flat(Infinity).map(child => typeof child === 'string' ? child : child && typeof child === 'object' ? textOf(child) : '').join('')
}
const buttonWith = (tree: any, text: string) => nodes(tree).find(node => node.type === 'button' && textOf(node).includes(text))
const headers = (tree: any) => nodes(tree).filter(node => node.type === 'button' && node.props['aria-expanded'] !== undefined && node.props.title)

function account(id: string): AISource {
  return {
    id, name: id, provider: 'custom', authType: 'api-key', apiUrl: 'https://example.invalid', apiKey: 'key',
    model: `${id}-m1`, availableModels: [{ id: `${id}-m1`, name: `${id} one` }, { id: `${id}-m2`, name: `${id} two` }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
const group: AIGroup = {
  id: 'g1', name: 'Daily', strategy: 'priority',
  members: [{ sourceId: 'main', modelId: 'main-m1' }, { sourceId: 'backup', modelId: 'backup-m1' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}
const aiSources = (extra: Partial<AISourcesConfig> = {}): AISourcesConfig =>
  ({ version: 2, currentId: 'main', sources: [account('main'), account('backup')], groups: [group], ...extra })

const setConversationModel = vi.fn()
const setConfig = vi.fn()
const onClose = vi.fn()

function open(sources: AISourcesConfig, pin: Partial<Conversation> = {}, engine?: string) {
  env.activeId = 'c1'
  env.appState = { config: { aiSources: sources }, setConfig, navigate: vi.fn() }
  const conversation = { id: 'c1', messages: [], ...pin }
  env.chatState = { currentSpaceId: 'space1', setConversationModel, sessionInitInfo: engine ? new Map([['c1', { engineId: engine }]]) : new Map(), conversationCache: new Map([['c1', conversation]]), spaceStates: new Map() }
  env.target = { kind: 'conversation', conversationId: 'c1', conversation }
  const runner = new ComponentRunner()
  return { draw: () => runner.render(() => expand(ModelSelectSheet({ onClose }))) }
}

function openDigitalHuman(sources: AISourcesConfig, pin: { modelSourceId?: string; modelId?: string }) {
  env.activeId = 'app-chat:app1:local:direct:conversation1'
  env.appState = { config: { aiSources: sources }, setConfig, navigate: vi.fn() }
  env.chatState = { currentSpaceId: 'space1', sessionInitInfo: new Map(), conversationCache: new Map(), spaceStates: new Map() }
  env.target = { kind: 'digital-human', appId: 'app1', appName: 'Helper', ...pin }
  const runner = new ComponentRunner()
  const draw = () => runner.render(() => expand(ModelSelector()))
  return { draw }
}
const statuses = (tree: any) => nodes(tree).filter(node => node.props?.role === 'status').map(textOf)

const served: GroupRouteInfo = {
  groupId: 'g1', sessionKey: 'c1', state: 'serving', at: 1,
  member: { key: 'k', sourceId: 'backup', modelId: 'backup-m1', label: { account: 'Backup account', model: 'Backup model' } },
}

beforeEach(() => {
  vi.useFakeTimers()
  setConversationModel.mockReset().mockResolvedValue(true)
  setConfig.mockReset()
  onClose.mockReset()
  env.routeHook.mockReset().mockReturnValue(null)
  env.isGenerating = false
  env.api.aiSourcesSwitchSource = vi.fn().mockResolvedValue({ success: true, data: { version: 2, currentId: 'main', sources: [], marker: 'switched' } })
  env.api.aiSourcesSetModel = vi.fn().mockResolvedValue({ success: true, data: { version: 2, currentId: 'main', sources: [], marker: 'model-set' } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a group in the model list', () => {
  it('does not mount route observation or recovery when no group is selected', () => {
    const { draw } = open(aiSources({ groups: [] }))
    draw()
    expect(env.routeHook).not.toHaveBeenCalled()
  })

  it('sits among the accounts under its own name with an Auto mark, and offers one choice', () => {
    const { draw } = open(aiSources())
    const tree = draw()
    expect(headers(tree).map(node => node.props.title)).toEqual(['main', 'backup', 'Daily · Auto'])
    // Not expanded unless it is what the conversation runs on.
    expect(buttonWith(tree, 'Choose automatically')).toBeUndefined()
  })

  it('opens on the group when the conversation runs on it, and shows it selected', () => {
    const { draw } = open(aiSources(), { modelSourceId: 'g1', modelId: 'halo-auto' })
    const choice = buttonWith(draw(), 'Choose automatically')
    expect(choice).toBeDefined()
    expect(textOf(choice)).toContain('2 models')
    expect(choice.props.className).toContain('bg-secondary/60')
  })

  it('pins the conversation to the group and starts new chats on it, without picking a model of its own', async () => {
    const { draw } = open(aiSources(), { modelSourceId: 'g1', modelId: 'halo-auto' })
    await buttonWith(draw(), 'Choose automatically').props.onClick()
    expect(setConversationModel).toHaveBeenCalledWith('space1', 'c1', 'g1', 'halo-auto')
    expect(env.api.aiSourcesSwitchSource).toHaveBeenCalledWith('g1')
    expect(env.api.aiSourcesSetModel).not.toHaveBeenCalled()
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ aiSources: expect.objectContaining({ marker: 'switched' }) }))
    expect(nodes(draw()).some(node => node.props?.className?.includes('animate-slide-out-bottom'))).toBe(true)
    vi.advanceTimersByTime(200)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the menu and global selection unchanged when the conversation pin is refused, and allows retry', async () => {
    setConversationModel.mockResolvedValueOnce(false)
    const sources = aiSources()
    const { draw } = open(sources, { modelSourceId: 'main', modelId: 'main-m1' })
    headers(draw())[2].props.onClick({ stopPropagation: () => {} })
    await buttonWith(draw(), 'Choose automatically').props.onClick()

    expect(setConversationModel).toHaveBeenCalledWith('space1', 'c1', 'g1', 'halo-auto')
    expect(env.api.aiSourcesSwitchSource).not.toHaveBeenCalled()
    expect(env.api.aiSourcesSetModel).not.toHaveBeenCalled()
    expect(setConfig).not.toHaveBeenCalled()
    expect(env.appState.config.aiSources).toBe(sources)
    expect(env.target.conversation.modelSourceId).toBe('main')
    const tree = draw()
    expect(nodes(tree).filter(node => node.props?.role === 'alert').map(textOf)).toEqual(['The group selection could not be saved. Please try again.'])
    expect(buttonWith(tree, 'Choose automatically')).toBeDefined()
    expect(nodes(tree).some(node => node.props?.className?.includes('animate-slide-out-bottom'))).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(200)
    expect(onClose).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('pin was not saved'), { conversationId: 'c1', groupId: 'g1' })
    expect(console.error).not.toHaveBeenCalled()

    await buttonWith(tree, 'Choose automatically').props.onClick()
    expect(env.api.aiSourcesSwitchSource).toHaveBeenCalledTimes(1)
    expect(nodes(draw()).filter(node => node.props?.role === 'alert')).toEqual([])
    vi.advanceTimersByTime(200)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('cannot be chosen for a conversation whose engine cannot use a group, and says why before anything is sent', () => {
    const { draw } = open(aiSources(), { modelSourceId: 'g1', modelId: 'halo-auto' }, 'codex')
    const tree = draw()
    expect(buttonWith(tree, 'Choose automatically')?.props.disabled).toBe(true)
    expect(nodes(tree).map(textOf).join(' ')).toContain('Codex cannot use a load-balancing group')
  })

  it('refuses a group for pending Codex even while the actual engine is still Halo', () => {
    const { draw } = open(aiSources(), { modelSourceId: 'g1', modelId: 'halo-auto', engineOverride: 'codex' }, 'halo')
    const tree = draw()
    expect(buttonWith(tree, 'Choose automatically')?.props.disabled).toBe(true)
    expect(textOf(tree)).toContain('Codex cannot use a load-balancing group')
    expect(useConversationEngineId('c1', 'space1')).toBe('halo')
    expect(setConversationModel).not.toHaveBeenCalled()
    expect(env.api.aiSourcesSwitchSource).not.toHaveBeenCalled()
  })

  it('allows a group for a pending supported engine without relabeling the live Codex engine', () => {
    const { draw } = open(aiSources(), { modelSourceId: 'g1', modelId: 'halo-auto', engineOverride: 'anthropic' }, 'codex')
    expect(buttonWith(draw(), 'Choose automatically')?.props.disabled).toBe(false)
    expect(useConversationEngineId('c1', 'space1')).toBe('codex')
  })

  it('can be chosen on the other engines', () => {
    for (const engine of ['halo', 'anthropic', 'dsh']) {
      const { draw } = open(aiSources(), { modelSourceId: 'g1', modelId: 'halo-auto' }, engine)
      expect(buttonWith(draw(), 'Choose automatically')?.props.disabled).toBe(false)
    }
  })

  it('cannot be chosen once it has no models left, and says what to do', () => {
    const { draw } = open(aiSources({ groups: [{ ...group, members: [] }] }), { modelSourceId: 'g1', modelId: 'halo-auto' })
    const tree = draw()
    expect(buttonWith(tree, 'Choose automatically')?.props.disabled).toBe(true)
    expect(nodes(tree).map(textOf).join(' ')).toContain('This group has no models left')
  })

  it('opens from its header, like an account', () => {
    const { draw } = open(aiSources())
    headers(draw())[2].props.onClick({ stopPropagation: () => {} })
    expect(buttonWith(draw(), 'Choose automatically')).toBeDefined()
  })
})

describe('the mark for the account in use', () => {
  const dotted = (tree: any) => headers(tree).filter(node => nodes(node).some(child => child.props?.title === 'Active')).map(node => node.props.title)

  it('stays on the account when no group is chosen', () => {
    expect(dotted(open(aiSources()).draw())).toEqual(['main'])
  })

  it('moves to the group once it is chosen for new chats', () => {
    expect(dotted(open(aiSources({ currentGroupId: 'g1' })).draw())).toEqual(['Daily · Auto'])
  })
})

describe('leaving a group for an account', () => {
  it('switches away from the chosen group even when the account is already the current one', async () => {
    const { draw } = open(aiSources({ currentGroupId: 'g1' }), { modelSourceId: 'main', modelId: 'main-m1' })
    await buttonWith(draw(), 'main two').props.onClick()
    expect(setConversationModel).toHaveBeenCalledWith('space1', 'c1', 'main', 'main-m2')
    expect(env.api.aiSourcesSwitchSource).toHaveBeenCalledWith('main')
    expect(env.api.aiSourcesSetModel).toHaveBeenCalledWith('main-m2')
  })

  it('does not switch the account when it is current and no group is chosen', async () => {
    const { draw } = open(aiSources(), { modelSourceId: 'main', modelId: 'main-m1' })
    await buttonWith(draw(), 'main two').props.onClick()
    expect(env.api.aiSourcesSwitchSource).not.toHaveBeenCalled()
    expect(env.api.aiSourcesSetModel).toHaveBeenCalledWith('main-m2')
  })
})

describe('the header of the sheet', () => {
  it('names the group with its Auto mark, not a model', () => {
    const { draw } = open(aiSources(), { modelSourceId: 'g1', modelId: 'halo-auto' })
    expect(nodes(draw()).some(node => node.type === 'p' && textOf(node) === 'Daily · Auto')).toBe(true)
  })
})

describe('a digital human that runs on a group', () => {
  const opened = (sources: AISourcesConfig, pin: { modelSourceId?: string; modelId?: string }, name: string) => {
    const { draw } = openDigitalHuman(sources, pin)
    const button = nodes(draw()).find(node => node.type === 'button' && node.props['aria-label'] === name)
    expect(button).toBeDefined()
    button.props.onClick()
    return draw()
  }

  it('names the group with its Auto mark on the button', () => {
    const { draw } = openDigitalHuman(aiSources(), { modelSourceId: 'g1', modelId: 'halo-auto' })
    expect(nodes(draw()).some(node => node.type === 'button' && node.props['aria-label'] === 'Daily · Auto')).toBe(true)
  })

  it('says nothing about the route until the card is open', () => {
    const { draw } = openDigitalHuman(aiSources(), { modelSourceId: 'g1', modelId: 'halo-auto' })
    expect(statuses(draw())).toEqual([])
    expect(env.routeHook).not.toHaveBeenCalled()
  })

  it('follows the open conversation of the digital human under its group, and does not guess before it is served', () => {
    const tree = opened(aiSources(), { modelSourceId: 'g1', modelId: 'halo-auto' }, 'Daily · Auto')
    expect(statuses(tree).join(' ')).toContain('Picked automatically when you send')
    expect(env.routeHook).toHaveBeenCalledWith({ id: env.activeId, sessionId: undefined }, 'g1')
  })

  it('reads the cached native binding only for the open group card and follows a changed binding', () => {
    const { draw } = openDigitalHuman(aiSources(), { modelSourceId: 'g1', modelId: 'halo-auto' })
    const getCached = vi.spyOn(env.chatState.conversationCache, 'get')
    env.chatState.conversationCache.set(env.activeId, { engineBinding: { version: 1, engineId: 'anthropic', sessionId: 'native-cc' } })
    env.chatState.conversationCache.set('hidden', { engineBinding: { version: 1, engineId: 'anthropic', sessionId: 'other-native' } })
    const button = nodes(draw()).find(node => node.type === 'button' && node.props['aria-label'] === 'Daily · Auto')
    expect(getCached).not.toHaveBeenCalled()
    expect(env.routeHook).not.toHaveBeenCalled()

    button.props.onClick()
    draw()
    expect(getCached).toHaveBeenCalledTimes(1)
    expect(getCached).toHaveBeenCalledWith(env.activeId)
    expect(env.routeHook).toHaveBeenLastCalledWith({ id: env.activeId, sessionId: 'native-cc' }, 'g1')

    env.chatState.conversationCache.set(env.activeId, { engineBinding: { version: 1, engineId: 'anthropic', sessionId: 'native-cc-new' } })
    draw()
    expect(env.routeHook).toHaveBeenLastCalledWith({ id: env.activeId, sessionId: 'native-cc-new' }, 'g1')
  })

  it('names the account and model serving its chat once the router has served it', () => {
    env.routeHook.mockReturnValue(served)
    const text = statuses(opened(aiSources(), { modelSourceId: 'g1', modelId: 'halo-auto' }, 'Daily · Auto')).join(' ')
    expect(text).toContain('In use for this chat')
    expect(text).toContain('Backup model')
    expect(text).toContain('Backup account')
  })

  it('shows a switch only while a reply is awaited', () => {
    env.routeHook.mockReturnValue({ ...served, state: 'switching' })
    env.isGenerating = true
    expect(statuses(opened(aiSources(), { modelSourceId: 'g1', modelId: 'halo-auto' }, 'Daily · Auto')).join(' ')).toContain('Trying another model')
    env.isGenerating = false
    expect(statuses(opened(aiSources(), { modelSourceId: 'g1', modelId: 'halo-auto' }, 'Daily · Auto')).join(' ')).not.toContain('Trying another model')
  })

  it('leaves a digital human that runs on an account without a route line', () => {
    const tree = opened(aiSources(), { modelSourceId: 'main', modelId: 'main-m1' }, 'main one')
    expect(statuses(tree)).toEqual([])
    expect(env.routeHook).not.toHaveBeenCalled()
  })
})
