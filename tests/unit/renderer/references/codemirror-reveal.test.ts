/**
 * Going back to lines in an editor: the place found as it was, where it moved
 * to, or — when the text is gone — the original lines shown without lighting
 * anything (lighting the wrong text would be worse than none). The light is a
 * decoration removed on a timer, not an animation, so reduced motion keeps it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'

vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('../../../../src/renderer/api', () => ({ api: {} }))
// The comment card reads the send-key setting; the whole app store is not needed for that.
vi.mock('../../../../src/renderer/stores/app.store', () => ({ useAppStore: (select: (state: unknown) => unknown) => select({ config: null }) }))

const { referenceExtension, revealInEditor } = await import('../../../../src/renderer/components/references/adapters/codemirror')
const { useComposerReferencesStore } = await import('../../../../src/renderer/stores/composer-references.store')
const { useSelectionStore } = await import('../../../../src/renderer/components/references/selection')

function fakeView(doc: string, withExtension = true) {
  const view = {
    dom: { isConnected: true },
    state: EditorState.create({ doc, extensions: withExtension ? [referenceExtension({ source: () => null })] : [] }),
    dispatch(spec: TransactionSpec) {
      view.state = view.state.update(spec).state
    },
    // 20px lines, 100px from the top of the window.
    coordsAtPos(pos: number) {
      const top = 100 + (view.state.doc.lineAt(pos).number - 1) * 20
      return { left: 60, right: 60, top, bottom: top + 20 }
    },
  }
  return view
}

/** Line numbers carrying the reveal light. */
function litLines(view: ReturnType<typeof fakeView>): number[] {
  const lines: number[] = []
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = (typeof source === 'function' ? null : source) as DecorationSet | null
    set?.between(0, view.state.doc.length, (from, _to, deco) => {
      if (deco.spec.class === 'cm-haloRevealLine') lines.push(view.state.doc.lineAt(from).number)
    })
  }
  return lines
}

const lines = ['import x', 'const a = 1', 'function f() {', '  return a', '}']

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('revealInEditor', () => {
  it('lights the lines when the text is still there, then turns the light off', () => {
    const view = fakeView(lines.join('\n'))
    const outcome = revealInEditor(view as unknown as EditorView, { range: { startLine: 3, endLine: 4 }, quote: 'function f() {\n  return a' })
    expect(outcome).toBe('exact')
    expect(litLines(view)).toEqual([3, 4])
    vi.advanceTimersByTime(1800)
    expect(litLines(view)).toEqual([])
  })

  it('follows text that moved and lights its new place', () => {
    const view = fakeView(['// header', '// more', ...lines].join('\n'))
    expect(revealInEditor(view as unknown as EditorView, { range: { startLine: 3, endLine: 4 }, quote: 'function f() {\n  return a' })).toBe('moved')
    expect(litLines(view)).toEqual([5, 6])
  })

  it('lights nothing when the text is gone', () => {
    const view = fakeView(lines.join('\n'))
    expect(revealInEditor(view as unknown as EditorView, { range: { startLine: 2, endLine: 2 }, quote: 'const removed = 2' })).toBe('lost')
    expect(litLines(view)).toEqual([])
  })

  it('finds a quote with no lines (a fragment of a reply\'s edits)', () => {
    const view = fakeView(lines.join('\n'))
    expect(revealInEditor(view as unknown as EditorView, { quote: '  return a' })).toBe('exact')
    expect(litLines(view)).toEqual([4])
    expect(revealInEditor(view as unknown as EditorView, { quote: 'nowhere' })).toBe('lost')
  })

  it('works on an editor that was created without the reference extension', () => {
    const view = fakeView(lines.join('\n'), false)
    expect(revealInEditor(view as unknown as EditorView, { range: { startLine: 1, endLine: 1 }, quote: 'import x' })).toBe('exact')
    expect(litLines(view)).toEqual([1])
  })

  it('leaves an editor that went away alone when the timer fires', () => {
    const view = fakeView(lines.join('\n'))
    revealInEditor(view as unknown as EditorView, { range: { startLine: 1, endLine: 1 } })
    view.dom.isConnected = false
    const dispatch = vi.spyOn(view, 'dispatch')
    vi.advanceTimersByTime(1800)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('a comment gone back to in an editor that shows no card for it', () => {
  const chip = { left: 40, top: 700, right: 140, bottom: 728 }

  beforeEach(() => {
    useComposerReferencesStore.setState({
      drafts: new Map([['conv-1', [{ id: 'ref-1', source: { kind: 'diff', path: '/repo/a.ts', side: 'after', compareLabel: 'Uncommitted changes' }, range: { startLine: 3, endLine: 4 }, quote: 'function f() {\n  return a', note: 'Why?' }]]]),
      target: { key: 'conv-1', title: 'T', visible: true, reveal: vi.fn() },
      signal: null,
    })
    useSelectionStore.setState({ offered: null, commenting: null, viewing: null })
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 16))
    vi.stubGlobal('CSS', { escape: (value: string) => value })
    vi.stubGlobal('window', { innerHeight: 800 })
    vi.stubGlobal('document', {
      querySelector: (selector: string) => (selector === '[data-composer-comments="conv-1"]' ? { getBoundingClientRect: () => ({ ...chip, width: 100, height: 28 }) } : null),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // A diff comment shown in the file itself (the change is no longer in the list): the lines are there, its card is not.
  it('opens it in the floating card beside the lines it is on', () => {
    const view = fakeView(lines.join('\n'))
    revealInEditor(view as unknown as EditorView, { range: { startLine: 3, endLine: 4 }, quote: 'function f() {\n  return a', commentId: 'ref-1' })
    vi.advanceTimersByTime(40)
    expect(useSelectionStore.getState().viewing).toEqual({ id: 'ref-1', rect: { left: 60, right: 60, top: 140, bottom: 180 }, focus: true })
  })

  it('opens it beside the composer chip when its text is nowhere to be found', () => {
    const view = fakeView(lines.join('\n'))
    expect(revealInEditor(view as unknown as EditorView, { quote: 'const removed = 2', commentId: 'ref-1' })).toBe('lost')
    expect(useSelectionStore.getState().viewing).toEqual({ id: 'ref-1', rect: chip, focus: true })
  })
})
