import { afterEach, beforeEach, expect, it, vi } from 'vitest'

type PendingInput = {
  spaceId: string
  text: string
  preserveDraft?: boolean
  slashPreview?: { command: string; label: string; description: string }
}

const env = vi.hoisted(() => ({
  runner: null as any,
  chat: { currentSpaceId: 'target', pendingComposerInput: null as PendingInput | null },
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

// Execute the real component and effects without a DOM or rendering its child components.
class ComponentRunner {
  values: any[] = []
  index = 0
  effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>()
  pending: Array<() => void> = []

  state(initial: any) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial
    return [this.values[index], (update: any) => {
      this.values[index] = typeof update === 'function' ? update(this.values[index]) : update
    }]
  }

  ref(initial: any) {
    const index = this.index++
    this.values[index] ??= { current: initial }
    return this.values[index]
  }

  effect(effect: () => void | (() => void), deps: unknown[]) {
    const index = this.index++
    const previous = this.effects.get(index)
    if (previous && deps.length === previous.deps.length && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return
    this.pending.push(() => {
      previous?.cleanup?.()
      this.effects.set(index, { deps, cleanup: effect() || undefined })
    })
  }

  render(props: object) {
    this.index = 0
    this.pending = []
    env.runner = this
    const tree = (InputArea as unknown as { type: (props: object) => unknown }).type(props)
    this.pending.forEach(effect => effect())
    return tree
  }

  unmount() {
    for (const effect of this.effects.values()) effect.cleanup?.()
    this.effects.clear()
  }
}

function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}

const textarea = (tree: unknown) => nodes(tree).find(node => node.type === 'textarea')
const runners: ComponentRunner[] = []
let sequence = 0
const props = () => ({ onSend: vi.fn(), onInject: vi.fn(), isGenerating: false, draftKey: `skill-prefill-${++sequence}` })
const mount = () => { const runner = new ComponentRunner(); runners.push(runner); return runner }
const skillInput = (): PendingInput => ({
  spaceId: 'target',
  text: '/review ',
  preserveDraft: true,
  slashPreview: { command: '/review', label: 'review', description: 'Review the selected work.' },
})

function typeDraft(runner: ComponentRunner, inputProps: ReturnType<typeof props>, draft: string) {
  textarea(runner.render(inputProps)).props.onChange({ target: { value: draft, selectionStart: draft.length } })
  expect(textarea(runner.render(inputProps)).props.value).toBe(draft)
}

beforeEach(() => {
  env.chat = { currentSpaceId: 'target', pendingComposerInput: null }
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 0 })
  vi.stubGlobal('window', { innerWidth: 1280 })
})
afterEach(() => {
  for (const runner of runners.splice(0)) runner.unmount()
  vi.unstubAllGlobals()
})

it.each([false, true])('prepends the skill to an existing draft without sending (generating: %s)', isGenerating => {
  const inputProps = { ...props(), isGenerating }
  const runner = mount()
  const draft = '  Review src/main.ts\nKeep original spacing.  '
  typeDraft(runner, inputProps, draft)

  env.chat.pendingComposerInput = skillInput()
  runner.render(inputProps)
  const tree = runner.render(inputProps)
  expect(textarea(tree).props.value).toBe(`/review ${draft}`)
  expect(env.chat.pendingComposerInput).toBeNull()
  expect(nodes(tree).find(node => node.type === SlashCommandMenu).props.items).toEqual([
    expect.objectContaining({ command: '/review', description: 'Review the selected work.' }),
  ])
  expect(textarea(runner.render(inputProps)).props.value).toBe(`/review ${draft}`)
  expect(inputProps.onSend).not.toHaveBeenCalled()
  expect(inputProps.onInject).not.toHaveBeenCalled()
})

it.each(['/review summarize this', '  /review\tKeep these spaces\n  and this line.  ', '/review\r\nKeep CRLF', '/review'])('does not duplicate the same leading skill: %s', draft => {
  const inputProps = props()
  const runner = mount()
  typeDraft(runner, inputProps, draft)
  env.chat.pendingComposerInput = skillInput()
  runner.render(inputProps)
  expect(textarea(runner.render(inputProps)).props.value).toBe(draft)
  expect(inputProps.onSend).not.toHaveBeenCalled()
})

it.each(['/other  Keep spacing\n\n  and paths /a/b  ', ' \t/other\r\nKeep CRLF', '/other'])('replaces only a recognized leading command: %s', draft => {
  const inputProps = { ...props(), slashCommands: [{ id: 'other', command: '/other', label: 'other', category: 'skill' as const }] }
  const runner = mount()
  typeDraft(runner, inputProps, draft)
  env.chat.pendingComposerInput = skillInput()
  runner.render(inputProps)
  expect(textarea(runner.render(inputProps)).props.value).toBe(draft.replace('/other', '/review'))
  expect(inputProps.onSend).not.toHaveBeenCalled()
  expect(inputProps.onInject).not.toHaveBeenCalled()
})

it.each(['/a/b read this path', '/other/path stays intact', '/unknown Keep this text', '/other-long Keep this text', '/other\\file Keep this text'])('preserves a path or unrecognized prefix: %s', draft => {
  const inputProps = { ...props(), slashCommands: [{ id: 'other', command: '/other', label: 'other', category: 'skill' as const }] }
  const runner = mount()
  typeDraft(runner, inputProps, draft)
  env.chat.pendingComposerInput = skillInput()
  runner.render(inputProps)
  expect(textarea(runner.render(inputProps)).props.value).toBe(`/review ${draft}`)
})

it('recognizes a previous Use prefill even before the session announces its commands', () => {
  const inputProps = props()
  const runner = mount()
  typeDraft(runner, inputProps, 'Keep this\n  draft.')
  env.chat.pendingComposerInput = { ...skillInput(), text: '/other ', slashPreview: { command: '/other', label: 'other', description: '' } }
  runner.render(inputProps)
  expect(textarea(runner.render(inputProps)).props.value).toBe('/other Keep this\n  draft.')
  env.chat.pendingComposerInput = skillInput()
  runner.render(inputProps)
  expect(textarea(runner.render(inputProps)).props.value).toBe('/review Keep this\n  draft.')
})

it('prepends a skill to a draft restored when the conversation composer remounts', () => {
  const inputProps = props()
  const original = mount()
  const draft = 'Compare these changes before committing.'
  typeDraft(original, inputProps, draft)
  original.unmount()

  env.chat.pendingComposerInput = skillInput()
  const restored = mount()
  restored.render(inputProps)
  expect(textarea(restored.render(inputProps)).props.value).toBe(`/review ${draft}`)
  expect(env.chat.pendingComposerInput).toBeNull()
  expect(inputProps.onSend).not.toHaveBeenCalled()
  expect(inputProps.onInject).not.toHaveBeenCalled()
})

it('fills an empty composer with only the skill command and does not send', () => {
  const inputProps = props()
  env.chat.pendingComposerInput = skillInput()
  const runner = mount()
  runner.render(inputProps)
  expect(textarea(runner.render(inputProps)).props.value).toBe('/review ')
  expect(env.chat.pendingComposerInput).toBeNull()
  expect(inputProps.onSend).not.toHaveBeenCalled()
  expect(inputProps.onInject).not.toHaveBeenCalled()
})

it.each([undefined, false])('keeps replacement semantics for ordinary prefill (preserveDraft: %s)', preserveDraft => {
  const inputProps = props()
  const runner = mount()
  typeDraft(runner, inputProps, 'An earlier unsent draft.')
  env.chat.pendingComposerInput = { spaceId: 'target', text: 'Replacement prompt', preserveDraft }
  runner.render(inputProps)
  expect(textarea(runner.render(inputProps)).props.value).toBe('Replacement prompt')
  expect(env.chat.pendingComposerInput).toBeNull()
  expect(inputProps.onSend).not.toHaveBeenCalled()
  expect(inputProps.onInject).not.toHaveBeenCalled()
})
