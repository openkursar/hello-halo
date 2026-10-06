/**
 * An AI request to turn on a toolset opens the composer's "+" panel at once,
 * also while the turn that asked is still running; the panel then offers only
 * the capability switches, since nothing can be attached mid-turn.
 *
 * No DOM here: React's hooks are replaced by a small runner and the returned
 * element tree is searched for the panel and the toolbar.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  runner: null as any,
  toolsets: { list: [] as any[], requested: new Set<string>() },
  onRequested: null as null | (() => void),
}))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (value: any) => env.runner.state(value), useRef: (value: any) => env.runner.ref(value), useMemo: (compute: any) => compute(), useCallback: (fn: any) => fn, useEffect: () => {}, useLayoutEffect: () => {} }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }), default: { t: (text: string) => text } }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: (select: any) => select({ config: null }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: Object.assign((select: any) => select({ pendingComposerInput: null, currentSpaceId: 's' }), { getState: () => ({ clearComposerDraft: vi.fn() }), setState: vi.fn() }) }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: (select: any) => select({ currentSpace: null }) }))
vi.mock('../../../src/renderer/stores/composer-references.store', async original => {
  const real = await original<typeof import('../../../src/renderer/stores/composer-references.store')>()
  const store = real.useComposerReferencesStore
  return {
    ...real,
    useComposerReferences: (key: string) => store.getState().drafts.get(key) ?? [],
    useComposerReferencesStore: Object.assign((select: any) => select(store.getState()), store),
  }
})
vi.mock('../../../src/renderer/components/references', () => ({ ComposerReferenceChips: () => null, notifyReferenceLimit: vi.fn(), commitCommentEdits: vi.fn(), useHasNewCommentText: () => false }))
vi.mock('../../../src/renderer/stores/onboarding.store', () => ({ useOnboardingStore: () => ({ isActive: false, currentStep: null }) }))
vi.mock('../../../src/renderer/components/onboarding/onboardingData', () => ({ getOnboardingPrompt: () => '' }))
vi.mock('../../../src/renderer/components/chat/composer-menu/useComposerToolsets', () => ({
  useComposerToolsets: (options: { onRequested: () => void }) => {
    env.onRequested = options.onRequested
    return { list: env.toolsets.list, extraEnabled: [], requested: env.toolsets.requested, toggle: vi.fn() }
  },
}))
vi.mock('../../../src/renderer/components/chat/LiveSessionsHeader', () => ({ LiveSessionsHeader: () => null }))
vi.mock('../../../src/renderer/components/chat/KnowledgeBaseButton', () => ({ KnowledgeBaseButton: () => null }))
vi.mock('../../../src/renderer/components/chat/DigitalHumanSelector', () => ({ DigitalHumanSelector: () => null }))
vi.mock('../../../src/renderer/components/chat/cross-conversation', () => ({ ConversationMentionRow: () => null }))
vi.mock('../../../src/renderer/components/apps/AutomationAvatar', () => ({ AutomationAvatar: () => null }))
vi.mock('../../../src/renderer/utils/conversation-navigation', () => ({ startDigitalHumanConversation: vi.fn() }))

import { InputArea } from '../../../src/renderer/components/chat/InputArea'

class ComponentRunner {
  values: any[] = []; index = 0
  state(initial: any) { const index = this.index++; if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial; return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }] }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  render(component: () => any) { this.index = 0; env.runner = this; return component() }
}
/** Every element in the tree, without rendering child components. */
function nodes(tree: any): any[] { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }
const panel = (tree: any) => nodes(tree).find(node => Array.isArray(node.props?.sections))
const toolbar = (tree: any) => nodes(tree).find(node => typeof node.type === 'function' && 'canSend' in node.props)

const terminal = { id: 'ai-terminal', displayName: 'Terminal', summary: 'Run commands', open: false }

function mount(isGenerating: boolean) {
  const runner = new ComponentRunner()
  const props = { onSend: vi.fn(async () => true), onInject: vi.fn(), onStop: vi.fn(), isGenerating }
  return () => runner.render(() => (InputArea as unknown as { type: (p: typeof props) => unknown }).type(props))
}

beforeEach(() => {
  vi.stubGlobal('window', { innerWidth: 1280 })
  env.toolsets = { list: [terminal], requested: new Set(['ai-terminal']) }
  env.onRequested = null
})

describe('a toolset request while the turn is running', () => {
  it('opens the panel at once with only the capability switches, the requested one highlighted', () => {
    const render = mount(true)
    expect(panel(render())).toBeUndefined()
    env.onRequested!()
    const sections = panel(render()).props.sections
    expect(sections.map((section: any) => section.id)).toEqual(['capabilities'])
    expect(sections[0].items).toEqual([expect.objectContaining({ id: 'toolset:ai-terminal', attention: true, toggle: expect.objectContaining({ checked: false }) })])
  })

  it('keeps the "+" button for the switches while a turn runs, and only when there are switches', () => {
    expect(toolbar(mount(true)()).props.canOpenMenu).toBe(true)
    env.toolsets = { list: [], requested: new Set() }
    expect(toolbar(mount(true)()).props.canOpenMenu).toBe(false)
    expect(toolbar(mount(false)()).props.canOpenMenu).toBe(true)
  })

  it('offers every section again once no turn is running', () => {
    const render = mount(false)
    render()
    env.onRequested!()
    expect(panel(render()).props.sections.map((section: any) => section.id)).toEqual(['add', 'context', 'capabilities'])
  })
})
