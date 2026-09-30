/**
 * Local paths in the composer: what a drop or paste attaches, and what each
 * send route carries. The real `webUtils.getPathForFile` needs Electron, so
 * the api is stubbed; the composer's own logic around it is what runs here.
 *
 * No DOM: React's hooks are replaced by a small runner and the returned
 * element tree is searched for the handlers under test.
 */

import { beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any, electron: true, pathFor: new Map<object, string>() }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (value: any) => env.runner.state(value), useRef: (value: any) => env.runner.ref(value), useMemo: (compute: any) => compute(), useCallback: (fn: any) => fn, useEffect: () => {}, useLayoutEffect: () => {} }))
vi.mock('../../../src/renderer/api', () => ({ api: { getPathForFile: (file: object) => env.pathFor.get(file) ?? '', pickLocalEntries: vi.fn() } }))
vi.mock('../../../src/renderer/api/transport', () => ({ isElectron: () => env.electron }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }), default: { t: (text: string) => text } }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: (select: any) => select({ config: null }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: Object.assign((select: any) => select({ pendingComposerInput: null, currentSpaceId: 's' }), { getState: () => ({ clearComposerDraft: vi.fn() }), setState: vi.fn() }) }))
vi.mock('../../../src/renderer/stores/thinking-level.store', () => ({ useThinkingLevelStore: (select: any) => select({ level: null }) }))
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
import { AttachedPathChips } from '../../../src/renderer/components/chat/AttachedPathChips'
import { splitAttachedPaths } from '../../../src/shared/attached-paths'

class ComponentRunner {
  values: any[] = []; index = 0
  state(initial: any) { const index = this.index++; if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial; return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }] }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  render(component: () => any) { this.index = 0; env.runner = this; return component() }
}
function nodes(tree: any): any[] { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }
const textarea = (tree: any) => nodes(tree).find(node => node.type === 'textarea')
const toolbar = (tree: any) => nodes(tree).find(node => typeof node.type === 'function' && 'canSend' in node.props)
const dropZone = (tree: any) => nodes(tree).find(node => typeof node.props?.onDrop === 'function')
const chips = (tree: any) => nodes(tree).find(node => node.type === AttachedPathChips)?.props.paths ?? []
const errorText = (tree: any) => nodes(tree).find(node => node.type === 'span' && String(node.props?.className).includes('text-destructive flex-1'))?.props.children

/** A dropped entry: a File-like object, whether it is a folder, and the path Electron would report. */
function drop(tree: any, entries: Array<{ name: string; type?: string; path: string; dir?: boolean }>) {
  const files = entries.map(e => { const file = { name: e.name, type: e.type ?? '', size: 10 }; env.pathFor.set(file, e.path); return file })
  const items = entries.map(e => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: !!e.dir }) }))
  return dropZone(tree).props.onDrop({ preventDefault: vi.fn(), dataTransfer: { getData: () => '', files, items } })
}

let props: any
let goal: any
beforeEach(() => {
  env.electron = true
  env.pathFor.clear()
  vi.stubGlobal('window', { innerWidth: 1280 })
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0 })
  goal = {
    active: false,
    menuItem: { label: 'Set goal', description: 'd', onSelect: vi.fn() },
    exit: vi.fn(), chip: null, placeholder: '', sendTitle: '',
    canSubmit: (text: string) => text.trim().length > 0,
    submit: vi.fn(async () => true),
    shelf: null,
  }
  props = { onSend: vi.fn(async () => true), onInject: vi.fn(), onStop: vi.fn(), isGenerating: false, goal }
})

function mount() {
  const runner = new ComponentRunner()
  const render = () => runner.render(() => InputArea(props))
  const type = (value: string) => { textarea(render()).props.onChange({ target: { value, selectionStart: value.length } }); return render() }
  return { render, type }
}

const PDF = { name: 'q3 report.pdf', type: 'application/pdf', path: '/Users/me/Docs/q3 report.pdf' }
const DIR = { name: 'site', path: '/Users/me/site', dir: true }

it('a dropped file and folder become chips, and send appends them as absolute paths', async () => {
  const { render, type } = mount()
  await drop(render(), [PDF, DIR])
  expect(chips(render())).toEqual([
    { path: '/Users/me/Docs/q3 report.pdf', isDirectory: false },
    { path: '/Users/me/site', isDirectory: true },
  ])

  toolbar(type('Summarize')).props.onSend()
  expect(props.onSend).toHaveBeenCalledWith(
    'Summarize\n\n<attached_paths>\n/Users/me/Docs/q3 report.pdf\n/Users/me/site/\n</attached_paths>',
    undefined,
    true,
  )
  expect(chips(render())).toEqual([])
})

it('paths alone are enough to send', async () => {
  const { render } = mount()
  await drop(render(), [PDF])
  const bar = toolbar(render())
  expect(bar.props.canSend).toBe(true)
  bar.props.onSend()
  expect(props.onSend).toHaveBeenCalledWith('<attached_paths>\n/Users/me/Docs/q3 report.pdf\n</attached_paths>', undefined, true)
})

it('dropping the same path twice attaches it once', async () => {
  const { render } = mount()
  await drop(render(), [PDF])
  await drop(render(), [PDF])
  expect(chips(render())).toHaveLength(1)
})

it('a file name with a line break is attached as one path and sent intact', async () => {
  const { render } = mount()
  await drop(render(), [{ name: 'a\nb', path: '/tmp/a\nb.txt' }])
  expect(chips(render())).toEqual([{ path: '/tmp/a\nb.txt', isDirectory: false }])
  toolbar(render()).props.onSend()
  const [sent] = props.onSend.mock.calls[0]
  expect(splitAttachedPaths(sent).paths).toEqual([{ path: '/tmp/a\nb.txt', isDirectory: false }])
})

it('an item with no local path is refused visibly, never shown as attached', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { render } = mount()
  await drop(render(), [{ name: 'from-browser.pdf', type: 'application/pdf', path: '' }, PDF])
  const tree = render()
  expect(chips(tree).map((p: any) => p.path)).toEqual(['/Users/me/Docs/q3 report.pdf'])
  expect(errorText(tree)).toBe('{{count}} item(s) could not be attached: not a file or folder on this computer')
  expect(warn).toHaveBeenCalledWith('[InputArea] Items not attached', expect.objectContaining({ count: 1, reason: 'no-local-path' }))
})

it('mid-turn, paths travel with the injected message', async () => {
  props.isGenerating = true
  const { render, type } = mount()
  await drop(render(), [PDF])
  toolbar(type('also this')).props.onSend()
  expect(props.onInject).toHaveBeenCalledWith('also this\n\n<attached_paths>\n/Users/me/Docs/q3 report.pdf\n</attached_paths>')
})

it('goal mode hands the paths to the goal, separate from the goal text', async () => {
  goal.active = true
  const { render, type } = mount()
  await drop(render(), [PDF])
  toolbar(type('Ship the report')).props.onSend()
  expect(goal.submit).toHaveBeenCalledWith('Ship the report', undefined, true, [{ path: '/Users/me/Docs/q3 report.pdf', isDirectory: false }])
  expect(chips(render())).toEqual([])
})

it('a goal set mid-turn leaves the paths for the next message', async () => {
  goal.active = true
  props.isGenerating = true
  const { render, type } = mount()
  await drop(render(), [PDF])
  toolbar(type('Ship the report')).props.onSend()
  expect(goal.submit).toHaveBeenCalledWith('Ship the report', undefined, true, [])
  expect(chips(render())).toHaveLength(1)
})

it('on a remote client nothing is attached by path, and the user is told why', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  env.electron = false
  const { render } = mount()
  await drop(render(), [PDF, DIR])
  const tree = render()
  expect(chips(tree)).toEqual([])
  expect(errorText(tree)).toBe('Only images can be attached from this device')
})
