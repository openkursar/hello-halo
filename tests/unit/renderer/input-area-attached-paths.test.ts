/**
 * References in the composer: local paths dropped or pasted become file
 * references, every send route carries the references (never as text), and
 * comments still open in the content go with the message as written. The
 * real `webUtils.getPathForFile` needs Electron, so the api is stubbed; the
 * composer's own logic around it is what runs here.
 *
 * No DOM: React's hooks are replaced by a small runner and the returned
 * element tree is searched for the handlers under test.
 */

import { beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any, electron: true, pathFor: new Map<object, string>(), upload: null as any, spaceId: 's' as string | null }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (value: any) => env.runner.state(value), useRef: (value: any) => env.runner.ref(value), useMemo: (compute: any) => compute(), useCallback: (fn: any) => fn, useEffect: (effect: any, deps: any[]) => env.runner.effect(effect, deps), useLayoutEffect: () => {} }))
vi.mock('../../../src/renderer/api', () => ({ api: { getPathForFile: (file: object) => env.pathFor.get(file) ?? '', pickLocalEntries: vi.fn(), uploadArtifactFile: (...args: unknown[]) => env.upload(...args) } }))
vi.mock('../../../src/renderer/api/transport', () => ({ isElectron: () => env.electron }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }), default: { t: (text: string) => text } }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: (select: any) => select({ config: null }) }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: (select: any) => select({ currentSpace: null }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: Object.assign((select: any) => select({ pendingComposerInput: null, currentSpaceId: env.spaceId }), { getState: () => ({ clearComposerDraft: vi.fn() }), setState: vi.fn() }) }))
// The store is real; only its React hooks are read straight from the state (no React render here).
vi.mock('../../../src/renderer/stores/composer-references.store', async original => {
  const real = await original<typeof import('../../../src/renderer/stores/composer-references.store')>()
  const store = real.useComposerReferencesStore
  return {
    ...real,
    useComposerReferences: (key: string) => store.getState().drafts.get(key) ?? [],
    useComposerReferencesStore: Object.assign((select: any) => select(store.getState()), store),
  }
})
vi.mock('../../../src/renderer/components/references', async () => {
  const edits = await vi.importActual<typeof import('../../../src/renderer/components/references/comment-edits')>('../../../src/renderer/components/references/comment-edits')
  return {
    ComposerReferenceChips: () => null,
    notifyReferenceLimit: vi.fn(),
    commitCommentEdits: edits.commitCommentEdits,
    useHasNewCommentText: (key: string) => edits.hasNewCommentText(edits.useCommentEdits.getState(), key),
  }
})
vi.mock('../../../src/renderer/stores/onboarding.store', () => ({ useOnboardingStore: () => ({ isActive: false, currentStep: null }) }))
vi.mock('../../../src/renderer/components/onboarding/onboardingData', () => ({ getOnboardingPrompt: () => '' }))
vi.mock('../../../src/renderer/components/chat/composer-menu/useComposerToolsets', () => ({ useComposerToolsets: () => ({ list: [], requested: new Set(), toggle: vi.fn() }) }))
vi.mock('../../../src/renderer/components/chat/KnowledgeBaseButton', () => ({ KnowledgeBaseButton: () => null }))
vi.mock('../../../src/renderer/components/chat/DigitalHumanSelector', () => ({ DigitalHumanSelector: () => null }))
vi.mock('../../../src/renderer/components/chat/cross-conversation', () => ({ ConversationMentionRow: () => null }))
vi.mock('../../../src/renderer/components/apps/AutomationAvatar', () => ({ AutomationAvatar: () => null }))
vi.mock('../../../src/renderer/utils/conversation-navigation', () => ({ startDigitalHumanConversation: vi.fn() }))

vi.mock('../../../src/renderer/utils/imageProcessor', () => ({
  processImage: vi.fn(async () => ({ mediaType: 'image/png', data: 'aW1hZ2U=', compressedSize: 5 })),
  isValidImageType: (file: { type: string }) => file.type === 'image/png',
  formatFileSize: () => '5 B',
}))

import { processImage } from '../../../src/renderer/utils/imageProcessor'
import { ImageAttachmentPreview } from '../../../src/renderer/components/chat/ImageAttachmentPreview'
import { InputArea } from '../../../src/renderer/components/chat/InputArea'
import { ComposerReferenceChips } from '../../../src/renderer/components/references'
import { addReference } from '../../../src/renderer/components/references/add-reference'
import { setEditText, startEditing, startNewComment, useCommentEdits } from '../../../src/renderer/components/references/comment-edits'
import { getTargetReferences, useComposerReferencesStore } from '../../../src/renderer/stores/composer-references.store'
import type { ContentReference } from '../../../src/shared/types/content-reference'

class ComponentRunner {
  values: any[] = []; index = 0
  effectsEnabled = false
  pendingEffects: Array<() => void> = []
  effect(effect: () => void | (() => void), deps: any[]) {
    if (!this.effectsEnabled) return
    const index = this.index++
    const previous = this.values[index]
    if (previous && deps?.every((value, i) => Object.is(value, previous.deps?.[i]))) return
    this.pendingEffects.push(() => {
      previous?.cleanup?.()
      this.values[index] = { deps, cleanup: effect() }
    })
  }
  state(initial: any) { const index = this.index++; if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial; return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }] }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  render(component: () => any) { this.index = 0; env.runner = this; const tree = component(); this.pendingEffects.splice(0).forEach(effect => effect()); return tree }
  unmount() { this.values.forEach(value => value?.cleanup?.()) }
}
function nodes(tree: any): any[] { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }
const textarea = (tree: any) => nodes(tree).find(node => node.type === 'textarea')
const toolbar = (tree: any) => nodes(tree).find(node => typeof node.type === 'function' && 'canSend' in node.props)
const dropZone = (tree: any) => nodes(tree).find(node => typeof node.props?.onDrop === 'function')
const cards = (tree: any): ContentReference[] => nodes(tree).find(node => node.type === ComposerReferenceChips)?.props.references ?? []
const errorText = (tree: any) => nodes(tree).find(node => node.type === 'span' && String(node.props?.className).includes('text-destructive flex-1'))?.props.children
const spanTexts = (tree: any) => nodes(tree).filter(node => node.type === 'span' && typeof node.props?.children === 'string').map(node => node.props.children)
/** What the user sees of a path card: its path and kind. */
const paths = (references: readonly ContentReference[] | undefined) =>
  (references ?? []).map(ref => (ref.source.kind === 'path' ? { path: ref.source.path, isDirectory: ref.source.isDirectory } : ref.source.kind))

/** A dropped entry: a File-like object, whether it is a folder, and the path Electron would report. */
function drop(tree: any, entries: Array<{ name: string; type?: string; path: string; dir?: boolean; size?: number }>) {
  const files = entries.map(e => { const file = { name: e.name, type: e.type ?? '', size: e.size ?? 10 }; env.pathFor.set(file, e.path); return file })
  const items = entries.map(e => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: !!e.dir }) }))
  return dropZone(tree).props.onDrop({ preventDefault: vi.fn(), dataTransfer: { getData: () => '', files, items } })
}

let props: any
let goal: any
beforeEach(() => {
  env.electron = true
  env.spaceId = 's'
  env.pathFor.clear()
  env.upload = vi.fn(async (_spaceId: string, file: { name: string }) => ({ success: true, data: { path: `/srv/space/${file.name}`, name: file.name, size: 10 } }))
  useComposerReferencesStore.setState({ drafts: new Map(), target: null, signal: null })
  useCommentEdits.setState({ texts: new Map(), newComments: new Map() })
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
  props = { onSend: vi.fn(async () => true), onInject: vi.fn(), onStop: vi.fn(), isGenerating: false, goal, draftKey: 'c1' }
})

function mount(own = props, effectsEnabled = false) {
  const runner = new ComponentRunner()
  runner.effectsEnabled = effectsEnabled
  const render = () => runner.render(() => (InputArea as unknown as { type: (p: typeof props) => unknown }).type(own))  // memo wrapper: call the component itself
  const type = (value: string) => { textarea(render()).props.onChange({ target: { value, selectionStart: value.length } }); return render() }
  return { render, type, unmount: () => runner.unmount() }
}

const PNG = { name: 'image.png', type: 'image/png', path: '/tmp/image.png' }
const attachedImages = (tree: any) => nodes(tree).find(node => node.type === ImageAttachmentPreview)?.props.images ?? []

it.each(['', 'look here'])('injects images with text %j and clears the accepted draft', async text => {
  props.isGenerating = true
  props.draftKey = `image-accepted-${text}`
  props.onInject = vi.fn(async () => true)
  const { render, type } = mount()
  await drop(render(), [PNG])
  if (text) await drop(render(), [PDF])
  const tree = type(text)
  const images = attachedImages(tree)
  expect(images).toHaveLength(1)
  expect(toolbar(tree).props.canSend).toBe(true)
  toolbar(tree).props.onSend()
  expect(props.onInject).toHaveBeenCalledWith(text, text ? expect.any(Array) : undefined, images)
  expect(attachedImages(render())).toEqual([])
  expect(textarea(render()).props.value).toBe('')
  expect(cards(render())).toEqual([])
  await Promise.resolve()
  expect(attachedImages(mount().render())).toEqual([])
})

it.each(['refused', 'failed'])('restores images, text and references when injection is %s', async outcome => {
  props.isGenerating = true
  props.draftKey = `image-${outcome}`
  props.onInject = vi.fn(() => outcome === 'refused' ? Promise.resolve(false) : Promise.reject(new Error('offline')))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { render, type } = mount()
  await drop(render(), [PNG, PDF])
  const tree = type('look here')
  const images = attachedImages(tree)
  toolbar(tree).props.onSend()
  expect(attachedImages(render())).toEqual([])
  await new Promise(resolve => setTimeout(resolve, 0))
  const restored = mount().render()
  expect(attachedImages(restored)).toEqual(images)
  expect(textarea(restored).props.value).toBe('look here')
  expect(cards(restored)).toHaveLength(1)
})

it.each([false, true])('preserves submitted and newly attached images after delayed failure (inject=%s)', async inject => {
  props.isGenerating = inject
  props.draftKey = `image-delayed-failure-${inject}`
  let reject!: (error: Error) => void
  const sender = vi.fn().mockImplementationOnce(() => new Promise<boolean>((_resolve, fail) => { reject = fail })).mockResolvedValue(true)
  props[inject ? 'onInject' : 'onSend'] = sender
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const composer = mount(props, true)
  try {
    await drop(composer.render(), [PNG])
    const submitted = attachedImages(composer.render())
    toolbar(composer.render()).props.onSend()
    expect(attachedImages(composer.render())).toEqual([])
    await drop(composer.render(), [{ ...PNG, name: 'second.png', path: '/tmp/second.png' }])
    const added = attachedImages(composer.render())
    expect(added).toHaveLength(1)
    expect(added[0].id).not.toBe(submitted[0].id)
    reject(new Error('offline'))
    await new Promise(resolve => setTimeout(resolve, 0))
    const expected = [...submitted, ...added]
    expect(attachedImages(composer.render())).toEqual(expected)
    expect(attachedImages(mount().render())).toEqual(expected)
    toolbar(composer.render()).props.onSend()
    expect(sender).toHaveBeenCalledTimes(2)
    expect(sender.mock.calls[1][inject ? 2 : 1]).toEqual(expected)
    expect(attachedImages(composer.render())).toEqual([])
  } finally {
    composer.unmount()
  }
})

it('does not send or clear images on an injection surface without image support', async () => {
  props.isGenerating = true
  props.supportsImageInjection = false
  props.draftKey = 'run-images'
  const { render, type } = mount()
  await drop(render(), [PNG])
  expect(toolbar(render()).props.canSend).toBe(false)
  toolbar(render()).props.onSend()
  expect(props.onInject).not.toHaveBeenCalled()
  toolbar(type('text only')).props.onSend()
  expect(props.onInject).toHaveBeenCalledWith('text only', undefined, undefined)
  expect(attachedImages(render())).toHaveLength(1)
})

it('waits for image processing before injecting by button or Enter', async () => {
  props.isGenerating = true
  props.draftKey = 'image-processing'
  let finish!: (value: any) => void
  vi.mocked(processImage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const { render, type } = mount()
  const dropping = drop(render(), [PNG])
  const tree = type('wait for image')
  expect(toolbar(tree).props.canSend).toBe(false)
  toolbar(tree).props.onSend()
  pressEnter(tree)
  expect(props.onInject).not.toHaveBeenCalled()
  finish({ mediaType: 'image/png', data: 'aW1hZ2U=', compressedSize: 5 })
  await dropping
  expect(toolbar(render()).props.canSend).toBe(true)
  pressEnter(render())
  expect(props.onInject.mock.calls[0][2]).toHaveLength(1)
})

const PDF = { name: 'q3 report.pdf', type: 'application/pdf', path: '/Users/me/Docs/q3 report.pdf' }
const DIR = { name: 'site', path: '/Users/me/site', dir: true }

it('a dropped file and folder become path cards, and send carries them as references, not text', async () => {
  const { render, type } = mount()
  await drop(render(), [PDF, DIR])
  expect(paths(cards(render()))).toEqual([
    { path: '/Users/me/Docs/q3 report.pdf', isDirectory: false },
    { path: '/Users/me/site', isDirectory: true },
  ])

  toolbar(type('Summarize')).props.onSend()
  const [content, images, thinking, options] = props.onSend.mock.calls[0]
  expect(content).toBe('Summarize')
  expect(images).toBeUndefined()
  expect(thinking).toBe(true)
  expect(paths(options.references)).toEqual([
    { path: '/Users/me/Docs/q3 report.pdf', isDirectory: false },
    { path: '/Users/me/site', isDirectory: true },
  ])
  expect(cards(render())).toEqual([])
})

it('references alone are enough to send', async () => {
  const { render } = mount()
  await drop(render(), [PDF])
  expect(cards(render())).toHaveLength(1)
  const bar = toolbar(render())
  expect(bar.props.canSend).toBe(true)
  bar.props.onSend()
  const [content, , , options] = props.onSend.mock.calls[0]
  expect(content).toBe('')
  expect(paths(options.references)).toEqual([{ path: '/Users/me/Docs/q3 report.pdf', isDirectory: false }])
})

it('dropping the same path twice attaches it once', async () => {
  const { render } = mount()
  await drop(render(), [PDF])
  await drop(render(), [PDF])
  expect(cards(render())).toHaveLength(1)
})

it('a file name with a line break is attached as one path and sent intact', async () => {
  const { render } = mount()
  await drop(render(), [{ name: 'a\nb', path: '/tmp/a\nb.txt' }])
  expect(paths(cards(render()))).toEqual([{ path: '/tmp/a\nb.txt', isDirectory: false }])
  toolbar(render()).props.onSend()
  expect(paths(props.onSend.mock.calls[0][3].references)).toEqual([{ path: '/tmp/a\nb.txt', isDirectory: false }])
})

it('an item with no local path is refused visibly, never shown as attached', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { render } = mount()
  await drop(render(), [{ name: 'from-browser.pdf', type: 'application/pdf', path: '' }, PDF])
  const tree = render()
  expect(paths(cards(tree))).toEqual([{ path: '/Users/me/Docs/q3 report.pdf', isDirectory: false }])
  expect(errorText(tree)).toBe('{{count}} item(s) could not be attached: not a file or folder on this computer')
  expect(warn).toHaveBeenCalledWith('[InputArea] Items not attached', expect.objectContaining({ count: 1, reason: 'no-local-path' }))
})

it('mid-turn, the cards travel with the injected message', async () => {
  props.isGenerating = true
  const { render, type } = mount()
  await drop(render(), [PDF])
  toolbar(type('also this')).props.onSend()
  const [content, references] = props.onInject.mock.calls[0]
  expect(content).toBe('also this')
  expect(paths(references)).toEqual([{ path: '/Users/me/Docs/q3 report.pdf', isDirectory: false }])
  expect(cards(render())).toEqual([])
})

it('mid-turn, cards alone can be appended', async () => {
  props.isGenerating = true
  const { render } = mount()
  await drop(render(), [PDF])
  const bar = toolbar(render())
  expect(bar.props.canSend).toBe(true)
  bar.props.onSend()
  expect(props.onInject).toHaveBeenCalledWith('', expect.any(Array), undefined)
})

it('goal mode hands the cards to the goal, separate from the goal text', async () => {
  goal.active = true
  const { render, type } = mount()
  await drop(render(), [PDF])
  toolbar(type('Ship the report')).props.onSend()
  const [text, images, thinking, references] = goal.submit.mock.calls[0]
  expect([text, images, thinking]).toEqual(['Ship the report', undefined, true])
  expect(paths(references)).toEqual([{ path: '/Users/me/Docs/q3 report.pdf', isDirectory: false }])
  expect(cards(render())).toEqual([])
})

it('a goal set mid-turn leaves the cards for the next message', async () => {
  goal.active = true
  props.isGenerating = true
  const { render, type } = mount()
  await drop(render(), [PDF])
  toolbar(type('Ship the report')).props.onSend()
  expect(goal.submit).toHaveBeenCalledWith('Ship the report', undefined, true, [])
  expect(cards(render())).toHaveLength(1)
})

it('a refused send puts the cards back, in their order', async () => {
  let settle: (accepted: boolean) => void = () => {}
  props.onSend = vi.fn(() => new Promise<boolean>(resolve => { settle = resolve }))
  const { render } = mount()
  await drop(render(), [PDF, DIR])
  toolbar(render()).props.onSend()
  expect(cards(render())).toEqual([])
  settle(false)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(paths(cards(render()))).toEqual([
    { path: '/Users/me/Docs/q3 report.pdf', isDirectory: false },
    { path: '/Users/me/site', isDirectory: true },
  ])
})

it('a refused append puts the text and the cards back, in their order', async () => {
  let settle: (accepted: boolean) => void = () => {}
  props.isGenerating = true
  props.draftKey = 'c-append'
  props.onInject = vi.fn(() => new Promise<boolean>(resolve => { settle = resolve }))
  const { render, type } = mount()
  await drop(render(), [PDF, DIR])
  toolbar(type('also this')).props.onSend()
  expect(cards(render())).toEqual([])
  settle(false)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(paths(cards(render()))).toEqual([
    { path: '/Users/me/Docs/q3 report.pdf', isDirectory: false },
    { path: '/Users/me/site', isDirectory: true },
  ])
  // The text is back in the conversation's draft, where its composer reads it.
  expect(textarea(mount().render()).props.value).toBe('also this')
})

it('an append that resolves to nothing counts as taken', async () => {
  props.isGenerating = true
  props.draftKey = 'c-taken'
  props.onInject = vi.fn(async () => undefined)
  const { render, type } = mount()
  await drop(render(), [PDF])
  toolbar(type('also this')).props.onSend()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(cards(render())).toEqual([])
  expect(textarea(mount().render()).props.value).toBe('')
})

it('sending takes the comments still open in the content: edits as edited, a new one with text, not an empty one', () => {
  const lines = (line: number) => ({
    source: { kind: 'file' as const, path: '/repo/a.ts', precision: 'lines' as const },
    range: { startLine: line, endLine: line },
    quote: `line ${line}`,
  })
  useComposerReferencesStore.getState().add('c1', [{ ...lines(1), note: 'before' }])
  const [edited] = useComposerReferencesStore.getState().drafts.get('c1')!
  startEditing(edited.id, 'before')
  setEditText(edited.id, 'after editing')
  setEditText(startNewComment('c1', lines(5)), 'Half a thought')
  startNewComment('c1', lines(6))

  const { render } = mount()
  toolbar(render()).props.onSend()
  const [, , , options] = props.onSend.mock.calls[0]
  expect(options.references.map((ref: ContentReference) => ref.note)).toEqual(['after editing', 'Half a thought'])
  expect(useCommentEdits.getState().newComments.size).toBe(0)
  expect(cards(render())).toEqual([])
})

it('a comment being written is enough to send, once it has text', () => {
  const comment = startNewComment('c1', { source: { kind: 'file', path: '/repo/a.ts', precision: 'lines' }, range: { startLine: 2, endLine: 2 }, quote: 'line 2' })
  const { render } = mount()
  expect(toolbar(render()).props.canSend).toBe(false)
  setEditText(comment, 'Why twice?')
  expect(toolbar(render()).props.canSend).toBe(true)

  toolbar(render()).props.onSend()
  const [content, , , options] = props.onSend.mock.calls[0]
  expect(content).toBe('')
  expect(options.references.map((ref: ContentReference) => ref.note)).toEqual(['Why twice?'])
})

it('with a second composer on screen, cards from the page still go to the chat beside the canvas', async () => {
  // The chat beside the canvas ('c1'), and a team chat opened in the canvas with a composer of its own.
  const chat = mount()
  const teamProps = { ...props, onSend: vi.fn(async () => true), draftKey: 'team-1:task-1:app-1' }
  const team = mount(teamProps)
  chat.render()
  team.render()
  // Named as the page's reference layer names it.
  useComposerReferencesStore.getState().setTarget({ key: 'c1', title: 'Fix the router', visible: true, reveal: vi.fn() })

  addReference({ source: { kind: 'terminal', title: 'zsh', sessionId: 't1' }, quote: 'FAIL a.test.ts' }, { focusComposer: true })
  expect(paths(cards(chat.render()))).toEqual(['terminal'])
  expect(cards(team.render())).toEqual([])
  expect(useComposerReferencesStore.getState().signal).toMatchObject({ key: 'c1', focus: 'text' })

  // The team composer's own cards stay its own, and the numbered highlights keep following the chat's.
  await drop(team.render(), [PDF])
  toolbar(team.render()).props.onSend()
  expect(paths(teamProps.onSend.mock.calls[0][3].references)).toEqual([{ path: '/Users/me/Docs/q3 report.pdf', isDirectory: false }])
  expect(useComposerReferencesStore.getState().target?.key).toBe('c1')
  expect(paths(getTargetReferences())).toEqual(['terminal'])
  expect(paths(cards(chat.render()))).toEqual(['terminal'])
})

it('on a remote client a file is uploaded into the space and attached by the path it got there; a folder is refused', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  env.electron = false
  const { render } = mount()
  await drop(render(), [PDF, DIR])
  const tree = render()
  expect(env.upload).toHaveBeenCalledTimes(1)
  expect(env.upload.mock.calls[0][0]).toBe('s')
  expect(env.upload.mock.calls[0][1].name).toBe('q3 report.pdf')
  expect(paths(cards(tree))).toEqual([{ path: '/srv/space/q3 report.pdf', isDirectory: false }])
  expect(errorText(tree)).toBe('{{count}} folder(s) could not be attached: only files can be uploaded from this device')
})

const pressEnter = (tree: any) => textarea(tree).props.onKeyDown({
  key: 'Enter', shiftKey: false, ctrlKey: false, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn(),
})

it.each([
  ['a new message', () => {}, () => props.onSend, (call: any[]) => call[3].references],
  ['a message added mid-reply', () => { props.isGenerating = true }, () => props.onInject, (call: any[]) => call[1]],
  ['a goal', () => { goal.active = true }, () => goal.submit, (call: any[]) => call[3]],
])('on a remote client %s waits for its uploads, whether sent by button or by Enter', async (_case, arrange, sender, sentReferences) => {
  env.electron = false
  arrange()
  let finish!: (result: unknown) => void
  env.upload = vi.fn(() => new Promise(resolve => { finish = resolve }))
  const { render, type } = mount()
  const dropping = drop(render(), [PDF])
  const typed = type('Read this')
  expect(toolbar(typed).props.canSend).toBe(false)
  expect(spanTexts(typed)).toContain('Uploading {{count}} file(s)…')
  pressEnter(typed)
  expect(sender()).not.toHaveBeenCalled()

  finish({ success: true, data: { path: '/srv/space/q3 report.pdf', name: 'q3 report.pdf', size: 10 } })
  await dropping
  const ready = render()
  expect(spanTexts(ready)).not.toContain('Uploading {{count}} file(s)…')
  expect(toolbar(ready).props.canSend).toBe(true)
  pressEnter(ready)
  expect(sender()).toHaveBeenCalledTimes(1)
  expect(paths(sentReferences(sender().mock.calls[0]))).toEqual([{ path: '/srv/space/q3 report.pdf', isDirectory: false }])
})

it('on a remote client with no workspace open, a file is not uploaded and the user is told to open one', async () => {
  env.electron = false
  env.spaceId = null
  const { render } = mount()
  await drop(render(), [PDF])
  expect(env.upload).not.toHaveBeenCalled()
  expect(errorText(render())).toBe('Open a workspace to attach files')
})

it('on a remote client a file over the upload limit, or one the server refuses, is not attached and the user is told', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  env.electron = false
  const { render } = mount()
  await drop(render(), [{ ...PDF, size: 300 * 1024 * 1024 }])
  expect(env.upload).not.toHaveBeenCalled()
  expect(errorText(render())).toBe('{{name}} is larger than {{limit}} and was not uploaded')

  env.upload = vi.fn(async () => ({ success: false, error: 'Access denied' }))
  await drop(render(), [PDF])
  const tree = render()
  expect(cards(tree)).toEqual([])
  expect(errorText(tree)).toBe('Could not upload {{name}}')
})
