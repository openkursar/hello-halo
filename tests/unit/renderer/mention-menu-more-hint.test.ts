/**
 * A bare "@" previews a few rows per kind. A kind cut short says, on its
 * heading, how to reach the rest: keep typing after the "@", in the box — the
 * menu itself takes no input.
 *
 * No DOM here: React's hooks are replaced by a small runner and the returned
 * element tree is searched for the heading text.
 */

import { beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any }))
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
vi.mock('../../../src/renderer/components/chat/composer-menu/useComposerToolsets', () => ({ useComposerToolsets: () => ({ list: [], requested: new Set(), toggle: vi.fn() }) }))
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
const texts = (tree: any) => nodes(tree).flatMap(node => [node.props?.children].flat(Infinity)).filter(child => typeof child === 'string')

/** A composer offering five other conversations to mention, after `typed` was typed. */
function composerAfterTyping(typed: string) {
  const runner = new ComponentRunner()
  const mentionConversations = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, title: `Plan ${i}`, summary: '', updatedAt: new Date(0).toISOString(), status: 'idle' }))
  const props = { onSend: vi.fn(async () => true), isGenerating: false, mentionConversations }
  const render = () => runner.render(() => (InputArea as unknown as { type: (p: typeof props) => unknown }).type(props))
  const textarea = nodes(render()).find(node => node.type === 'textarea')
  textarea.props.onChange({ target: { value: typed, selectionStart: typed.length } })
  return render()
}

beforeEach(() => {
  vi.stubGlobal('window', { innerWidth: 1280 })
})

it('a kind cut short on a bare "@" tells the user to keep typing', () => {
  expect(texts(composerAfterTyping('@'))).toContain('Keep typing to filter')
})

it('says nothing more once a query lifts the cap', () => {
  const shown = texts(composerAfterTyping('@Plan'))
  expect(shown).toContain('Conversations')
  expect(shown).not.toContain('Keep typing to filter')
})
