/**
 * The chips that sum up a message's references: comments and selections as
 * one chip each (counted, never numbered), a chip per attached file. In the
 * composer a group's × removes the whole group with Undo putting it back in
 * place, a row's × removes one, and a row goes back to the place — a comment
 * to be edited there, a selection only shown. In the transcript they only show.
 *
 * No DOM: React's hooks are replaced by a small runner and the returned
 * element tree is searched for the handlers under test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useRef: (value: any) => env.runner.ref(value),
  useMemo: (compute: any) => compute(),
  useCallback: (fn: any) => fn,
  useEffect: () => {},
  useLayoutEffect: () => {},
}))
vi.mock('../../../../src/renderer/i18n', () => {
  const t = (key: string, options?: Record<string, unknown>) => key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''))
  return { useTranslation: () => ({ t }), default: { t } }
})
vi.mock('../../../../src/renderer/api', () => ({ api: { showArtifactInFolder: vi.fn() } }))
vi.mock('../../../../src/renderer/api/transport', () => ({ isElectron: () => true }))
vi.mock('../../../../src/renderer/hooks/useIsMobile', () => ({ useIsMobile: () => false }))
vi.mock('../../../../src/renderer/components/references/reveal', () => ({ revealReference: vi.fn() }))

import { ComposerReferenceChips, MessageReferenceChips, groupReferences } from '../../../../src/renderer/components/references/ReferenceChips'
import { revealReference } from '../../../../src/renderer/components/references/reveal'
import { useComposerReferencesStore, type ReferenceDraft } from '../../../../src/renderer/stores/composer-references.store'
import { useNotificationStore } from '../../../../src/renderer/stores/notification.store'
import type { ContentReference } from '../../../../src/shared/types/content-reference'

class ComponentRunner {
  values: any[] = []; index = 0
  state(initial: any) { const index = this.index++; if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial; return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }] }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  render(component: () => any) { this.index = 0; env.runner = this; return component() }
}
function nodes(tree: any): any[] { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }
function text(tree: any): string { if (tree === null || tree === undefined || tree === false) return ''; if (typeof tree !== 'object') return String(tree); if (Array.isArray(tree)) return tree.map(text).join(''); return text(tree.props?.children) }

const store = () => useComposerReferencesStore.getState()
const list = () => store().drafts.get('c1') ?? []
const toasts = () => useNotificationStore.getState().toasts

const diff = (line: number, note?: string): ReferenceDraft => ({
  source: { kind: 'diff', path: '/repo/src/a.ts', side: 'after', compareLabel: 'Uncommitted changes' },
  range: { startLine: line, endLine: line },
  quote: `const value${line} = ${line}`,
  ...(note ? { note } : {}),
})
const file = (path: string): ReferenceDraft => ({ source: { kind: 'path', path, isDirectory: false } })

/** The chips row and its group chips, as the composer renders them. */
function composerChips() {
  const runner = new ComponentRunner()
  const tree = runner.render(() => (ComposerReferenceChips as any).type({ composerKey: 'c1', references: list() }))
  const groups = nodes(tree).filter(node => node.props?.kind)
  const files = nodes(tree).filter(node => typeof node.type === 'function' && node.props?.reference?.source.kind === 'path')
  return { tree, groups, files, group: (kind: string) => groups.find(node => node.props.kind === kind) }
}

/** What a group chip shows. */
function chipLabel(group: any): string {
  const runner = new ComponentRunner()
  return text(runner.render(() => group.type(group.props)))
}

beforeEach(() => {
  vi.mocked(revealReference).mockClear()
  useComposerReferencesStore.setState({ drafts: new Map(), target: null, signal: null })
  useNotificationStore.getState().clear()
  store().add('c1', [diff(1, 'Why?'), diff(2), diff(3, 'Rename this'), file('/Users/me/notes.md'), diff(4)])
})

describe('grouping', () => {
  it('sorts references into comments, selections and files, keeping their order', () => {
    const groups = groupReferences(list())
    expect(groups.comments.map(ref => ref.note)).toEqual(['Why?', 'Rename this'])
    expect(groups.selections.map(ref => ref.range?.startLine)).toEqual([2, 4])
    expect(groups.files.map(ref => ref.source.kind === 'path' && ref.source.path)).toEqual(['/Users/me/notes.md'])
  })

  it('shows a counted chip per group and a chip per file, with no numbers on anything', () => {
    const { groups, files, group } = composerChips()
    expect(groups.map(node => node.props.kind)).toEqual(['comments', 'selections'])
    expect(files).toHaveLength(1)
    expect(chipLabel(group('comments'))).toContain('2 comments')
    expect(chipLabel(group('selections'))).toContain('2 selections')
  })

  it('shows nothing without references', () => {
    useComposerReferencesStore.setState({ drafts: new Map() })
    expect(composerChips().tree).toBeNull()
  })
})

describe('in the composer', () => {
  it("a group's × removes the whole group, and Undo puts it back in place", () => {
    const before = list().map(ref => ref.id)
    composerChips().group('comments').props.onRemoveGroup()
    expect(list().map(ref => ref.note ?? null)).toEqual([null, null, null])
    expect(toasts()[0].title).toBe('Removed 2 comments')
    expect(toasts()[0].action?.label).toBe('Undo')
    toasts()[0].action!.onClick()
    expect(list().map(ref => ref.id)).toEqual(before)
  })

  it("a row's × in a group's list removes that one only", () => {
    const { group } = composerChips()
    const [, second] = group('selections').props.references as ContentReference[]
    group('selections').props.onRemoveOne(second)
    expect(list().map(ref => ref.range?.startLine ?? null)).toEqual([1, 2, 3, null])
    expect(toasts()).toHaveLength(0)
  })

  it('a row goes back to the place: a comment to edit its card there, a selection only shown', () => {
    const { group } = composerChips()
    const [comment] = group('comments').props.references as ContentReference[]
    const [selection] = group('selections').props.references as ContentReference[]
    group('comments').props.onReveal(comment)
    group('selections').props.onReveal(selection)
    expect(revealReference).toHaveBeenNthCalledWith(1, comment, { focusComment: true })
    expect(revealReference).toHaveBeenNthCalledWith(2, selection, { keepFocus: true })
  })

  it("a file chip's × removes that file", () => {
    composerChips().files[0].props.onRemove()
    expect(list().some(ref => ref.source.kind === 'path')).toBe(false)
  })
})

describe('in the transcript', () => {
  it('shows the same chips with nothing to remove, and a row still goes back to the place', () => {
    const runner = new ComponentRunner()
    const tree = runner.render(() => (MessageReferenceChips as any).type({ references: list() }))
    const groups = nodes(tree).filter(node => node.props?.kind)
    expect(groups.map(node => node.props.kind)).toEqual(['comments', 'selections'])
    for (const group of groups) {
      expect(group.props.onRemoveGroup).toBeUndefined()
      expect(group.props.onRemoveOne).toBeUndefined()
    }
    const [comment] = groups[0].props.references as ContentReference[]
    groups[0].props.onReveal(comment)
    expect(revealReference).toHaveBeenCalledWith(comment)
  })
})
