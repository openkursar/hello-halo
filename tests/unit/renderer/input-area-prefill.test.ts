import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  runner: null as any,
  chat: { currentSpaceId: 'target', pendingComposerInput: null as null | { spaceId: string; text: string; slashPreview?: { command: string; label: string; description: string } } },
}))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useRef: (value: any) => env.runner.ref(value),
  useMemo: (compute: any) => compute(),
  useCallback: (fn: any) => fn,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => env.runner.effect(effect, deps),
}))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }), default: { t: (text: string) => text } }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: (select: any) => select({ config: null }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: Object.assign((select: any) => select(env.chat), { getState: () => ({ clearComposerDraft: vi.fn() }), setState: (update: object) => Object.assign(env.chat, update) }) }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: (select: any) => select({ currentSpace: null }) }))
vi.mock('../../../src/renderer/stores/composer-references.store', () => ({ useComposerReferences: () => [], useComposerReferencesStore: Object.assign(() => null, { getState: () => ({ take: vi.fn() }) }) }))
vi.mock('../../../src/renderer/components/references', () => ({ ComposerReferenceChips: () => null, notifyReferenceLimit: vi.fn(), commitCommentEdits: vi.fn(), useHasNewCommentText: () => false }))
vi.mock('../../../src/renderer/stores/onboarding.store', () => ({ useOnboardingStore: () => ({ isActive: false, currentStep: null }) }))
vi.mock('../../../src/renderer/components/onboarding/onboardingData', () => ({ getOnboardingPrompt: () => '' }))
vi.mock('../../../src/renderer/components/chat/composer-menu/useComposerToolsets', () => ({ useComposerToolsets: () => ({ list: [], requested: new Set(), toggle: vi.fn() }) }))
vi.mock('../../../src/renderer/components/chat/LiveSessionsHeader', () => ({ LiveSessionsHeader: () => null }))
vi.mock('../../../src/renderer/components/chat/KnowledgeBaseButton', () => ({ KnowledgeBaseButton: () => null }))
vi.mock('../../../src/renderer/components/chat/DigitalHumanSelector', () => ({ DigitalHumanSelector: () => null }))
vi.mock('../../../src/renderer/components/chat/cross-conversation', () => ({ ConversationMentionRow: () => null }))
vi.mock('../../../src/renderer/components/apps/AutomationAvatar', () => ({ AutomationAvatar: () => null }))
vi.mock('../../../src/renderer/utils/conversation-navigation', () => ({ startDigitalHumanConversation: vi.fn() }))
vi.mock('../../../src/renderer/hooks/useAutoResize', () => ({ useAutoResize: vi.fn() }))
vi.mock('../../../src/renderer/hooks/useFileMentionQuery', () => ({ useFileMentionQuery: () => ({ items: [], indexing: false, available: false }) }))

import { InputArea } from '../../../src/renderer/components/chat/InputArea'
import { SlashCommandMenu } from '../../../src/renderer/components/chat/SlashCommandMenu'

class ComponentRunner {
  values: any[] = []
  index = 0
  effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>()
  pending: Array<() => void> = []
  state(initial: any) { const index = this.index++; if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial; return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }] }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  effect(effect: () => void | (() => void), deps: unknown[]) {
    const index = this.index++
    const previous = this.effects.get(index)
    if (previous && deps.length === previous.deps.length && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return
    this.pending.push(() => { previous?.cleanup?.(); this.effects.set(index, { deps, cleanup: effect() || undefined }) })
  }
  render(props: object) {
    this.index = 0
    this.pending = []
    env.runner = this
    const tree = (InputArea as unknown as { type: (props: object) => unknown }).type(props)
    this.pending.forEach(effect => effect())
    return tree
  }
  unmount() { for (const effect of this.effects.values()) effect.cleanup?.(); this.effects.clear() }
}

function nodes(tree: any): any[] { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }
const textarea = (tree: unknown) => nodes(tree).find(node => node.type === 'textarea')
const runners: ComponentRunner[] = []
const props = (draftKey?: string) => ({ onSend: vi.fn(), onInject: vi.fn(), isGenerating: false, draftKey })
const mount = () => { const runner = new ComponentRunner(); runners.push(runner); return runner }

beforeEach(() => {
  env.chat = { currentSpaceId: 'target', pendingComposerInput: { spaceId: 'target', text: '/review ', slashPreview: { command: '/review', label: 'review', description: 'Review the selected work.' } } }
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 0 })
  vi.stubGlobal('window', { innerWidth: 1280 })
})
afterEach(() => { for (const runner of runners.splice(0)) runner.unmount(); vi.unstubAllGlobals() })

it('keeps a skill command pending through the temporary composer until the new conversation mounts', () => {
  const pending = env.chat.pendingComposerInput
  const temporary = mount()
  temporary.render(props())
  expect(env.chat.pendingComposerInput).toBe(pending)
  expect(textarea(temporary.render(props())).props.value).toBe('')
  temporary.unmount()

  const conversation = mount()
  conversation.render(props('created-conversation'))
  const tree = conversation.render(props('created-conversation'))
  expect(env.chat.pendingComposerInput).toBeNull()
  expect(textarea(tree).props.value).toBe('/review ')
  expect(nodes(tree).find(node => node.type === SlashCommandMenu).props.items).toEqual([expect.objectContaining({ command: '/review', description: 'Review the selected work.' })])
  textarea(tree).props.onChange({ target: { value: '/review revised arguments', selectionStart: 25 } })
  expect(textarea(conversation.render(props('created-conversation'))).props.value).toBe('/review revised arguments')
})

it('fills when the same composer receives its conversation identity after initialization', () => {
  const runner = mount()
  runner.render(props())
  runner.render(props('initialized-conversation'))
  expect(textarea(runner.render(props('initialized-conversation'))).props.value).toBe('/review ')
  expect(env.chat.pendingComposerInput).toBeNull()
})

it('leaves another workspace request pending and preserves the current conversation draft', () => {
  env.chat.currentSpaceId = 'other-space'
  const pending = env.chat.pendingComposerInput
  const runner = mount()
  const tree = runner.render(props('other-conversation'))
  textarea(tree).props.onChange({ target: { value: 'Keep this draft.', selectionStart: 16 } })
  expect(textarea(runner.render(props('other-conversation'))).props.value).toBe('Keep this draft.')
  expect(env.chat.pendingComposerInput).toBe(pending)
})
