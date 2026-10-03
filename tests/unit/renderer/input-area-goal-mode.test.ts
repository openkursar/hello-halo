/**
 * The composer in goal mode: leaving it keeps the typed text and never stops a
 * running turn, and Send mid-turn sets the goal instead of injecting a message.
 *
 * No DOM here: React's hooks are replaced by a small runner and the returned
 * element tree is searched for the handlers under test.
 */

import { beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (value: any) => env.runner.state(value), useRef: (value: any) => env.runner.ref(value), useMemo: (compute: any) => compute(), useCallback: (fn: any) => fn, useEffect: () => {}, useLayoutEffect: () => {} }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }), default: { t: (text: string) => text } }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: (select: any) => select({ config: null }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: Object.assign((select: any) => select({ pendingComposerInput: null, currentSpaceId: 's' }), { getState: () => ({ clearComposerDraft: vi.fn() }), setState: vi.fn() }) }))
vi.mock('../../../src/renderer/stores/onboarding.store', () => ({ useOnboardingStore: () => ({ isActive: false, currentStep: null }) }))
vi.mock('../../../src/renderer/components/onboarding/onboardingData', () => ({ getOnboardingPrompt: () => '' }))
vi.mock('../../../src/renderer/components/chat/composer-menu/useComposerToolsets', () => ({ useComposerToolsets: () => ({ list: [], extraEnabled: [], requested: new Set(), toggle: vi.fn() }) }))
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
const textarea = (tree: any) => nodes(tree).find(node => node.type === 'textarea')
const toolbar = (tree: any) => nodes(tree).find(node => typeof node.type === 'function' && 'canSend' in node.props)
const key = (name: string) => ({ key: name, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn() })

let goal: any
let props: any
beforeEach(() => {
  vi.stubGlobal('window', { innerWidth: 1280 })
  goal = {
    active: true,
    menuItem: { label: 'Set goal', description: 'Keeps working toward it', onSelect: vi.fn() },
    exit: vi.fn(),
    chip: null,
    placeholder: 'Describe the goal',
    sendTitle: 'Set goal',
    canSubmit: (text: string) => text.trim().length > 0,
    submit: vi.fn(async () => true),
    shelf: null,
  }
  props = { onSend: vi.fn(async () => true), onInject: vi.fn(), onStop: vi.fn(), isGenerating: false, goal }
})

function mount() {
  const runner = new ComponentRunner()
  const render = () => runner.render(() => (InputArea as unknown as { type: (p: typeof props) => unknown }).type(props))  // memo wrapper: call the component itself
  const type = (value: string) => {
    textarea(render()).props.onChange({ target: { value, selectionStart: value.length } })
    return render()
  }
  return { render, type }
}

it('Esc leaves goal mode, keeps the text and does not stop the running turn', () => {
  props.isGenerating = true
  const { type } = mount()
  const tree = type('Ship the release')

  const event = key('Escape')
  textarea(tree).props.onKeyDown(event)

  expect(goal.exit).toHaveBeenCalledTimes(1)
  expect(props.onStop).not.toHaveBeenCalled()
  expect(event.stopPropagation).toHaveBeenCalled()
  expect(textarea(tree).props.value).toBe('Ship the release')
})

it('Backspace in an empty composer leaves goal mode', () => {
  const { render } = mount()
  textarea(render()).props.onKeyDown(key('Backspace'))
  expect(goal.exit).toHaveBeenCalledTimes(1)
})

it('Backspace with text edits the text and stays in goal mode', () => {
  const { type } = mount()
  textarea(type('x')).props.onKeyDown(key('Backspace'))
  expect(goal.exit).not.toHaveBeenCalled()
})

it('Send mid-turn sets the goal rather than injecting a message', () => {
  props.isGenerating = true
  const { type } = mount()
  const tree = type('Ship the release')

  expect(toolbar(tree).props.canSend).toBe(true)
  toolbar(tree).props.onSend()

  expect(goal.submit).toHaveBeenCalledWith('Ship the release', undefined, true, [])
  expect(props.onInject).not.toHaveBeenCalled()
  expect(props.onSend).not.toHaveBeenCalled()
})

it('outside goal mode, Esc stops the running turn', () => {
  props.isGenerating = true
  goal.active = false
  const { render } = mount()
  textarea(render()).props.onKeyDown(key('Escape'))
  expect(props.onStop).toHaveBeenCalledTimes(1)
  expect(goal.exit).not.toHaveBeenCalled()
})
