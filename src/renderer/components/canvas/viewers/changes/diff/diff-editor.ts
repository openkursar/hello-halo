/**
 * Read-only diff editors for one file of the changes view, on @codemirror/merge:
 * a side-by-side MergeView or a single editor with the unified (inline) merge
 * extension. A file that exists on one side only is that side's text, marked
 * whole as added or deleted, with no diff to compute.
 *
 * Editors size to their content inside the view's scroller, so CodeMirror
 * renders only the lines in view however long the file is.
 */

import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, drawSelection, highlightSpecialChars, lineNumbers, type DecorationSet } from '@codemirror/view'
import { syntaxHighlighting } from '@codemirror/language'
import { MergeView, getChunks, getOriginalDoc, mergeViewSiblings, uncollapseUnchanged, unifiedMergeView, type Chunk } from '@codemirror/merge'
import { getLanguageSupport } from '../../../../../lib/codemirror-setup'
import { baseName, extensionOf } from '../model/paths'
import { diffEditorTheme, diffHighlightStyle } from './diff-theme'

export type DiffLayout = 'split' | 'unified'
export type DiffSide = 'before' | 'after'
/** `modified` has both sides; `added` only the after side; `deleted` only the before side. */
export type DiffKind = 'modified' | 'added' | 'deleted'

export interface DiffEditorSpec {
  before: string
  after: string
  kind: DiffKind
  layout: DiffLayout
  collapseUnchanged: boolean
  /** Path whose name picks the language. */
  path: string
  /** False for fragments whose line numbers are not the file's. */
  lineNumbers: boolean
  /** Translations of CodeMirror's own phrases ("$ unchanged lines"). */
  phrases: Record<string, string>
  /** Accessible names of the editors: one per side, `both` for the unified layout's single editor. */
  labels: { before: string; after: string; both: string }
  /**
   * Extra extensions for the editor showing a side; in the unified layout the
   * one editor shows the after side and holds the before side's deleted chunks.
   */
  sideExtensions?: (side: DiffSide, unified: boolean) => Extension[]
  /**
   * The element the editors scroll with, and how much of its top a sticky header
   * covers: places are scrolled into view on it (see `scrollWithin`).
   */
  scrollParent?: () => { element: HTMLElement; topInset: number } | null
}

export interface DiffEditorHandle {
  /** Where change navigation and reveals act: the after side, or the only editor. */
  readonly nav: EditorView
  /** The editor showing `side`; null when no editor shows it on its own (unified layout). */
  editorFor(side: DiffSide): EditorView | null
  /** Whether `nav` holds diff chunks (a one-sided file has none). */
  readonly hasChunks: boolean
  destroy(): void
}

const SPECIAL_NAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  vagrantfile: 'ruby',
  jenkinsfile: 'groovy',
  '.gitignore': 'gitignore',
  '.dockerignore': 'gitignore',
  '.editorconfig': 'ini',
}

export function languageForPath(path: string): string | null {
  const name = baseName(path).toLowerCase()
  if (SPECIAL_NAMES[name]) return SPECIAL_NAMES[name]
  if (name === '.env' || name.startsWith('.env.')) return 'shell'
  return extensionOf(path) || null
}

type Mark = 'flash' | 'focus'
const setMark = StateEffect.define<{ from: number; to: number; mark: Mark } | null>()
const MARK_LINES: Record<Mark, Decoration> = {
  // Where a jump landed (a report link, a reference).
  flash: Decoration.line({ class: 'cm-changesFlash' }),
  // The change F7 moved to.
  focus: Decoration.line({ class: 'cm-changesFocus' }),
}
const MARK_MS: Record<Mark, number> = { flash: 1_800, focus: 900 }

/** Lines briefly marked after a jump, so the eye finds where it landed. */
const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setMark)) continue
      if (!effect.value) {
        next = Decoration.none
        continue
      }
      const { from, to, mark } = effect.value
      const ranges = []
      for (let pos = from; pos <= to;) {
        const line = tr.state.doc.lineAt(pos)
        ranges.push(MARK_LINES[mark].range(line.from))
        pos = line.to + 1
      }
      next = Decoration.set(ranges)
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

function markLines(view: EditorView, from: number, to: number, mark: Mark): void {
  view.dispatch({ effects: setMark.of({ from, to: Math.max(from, Math.min(to, view.state.doc.length)), mark }) })
  setTimeout(() => {
    // The editor may have been unmounted meanwhile.
    if (view.dom.isConnected) view.dispatch({ effects: setMark.of(null) })
  }, MARK_MS[mark])
}

/** Diffs with very different sides fall back to a quicker, coarser algorithm rather than stall. */
const DIFF_CONFIG = { scanLimit: 500, timeout: 200 }
const COLLAPSE = { margin: 3, minSize: 4 }

/** The editor's accessible name; read-only is announced too, which the read-only facet does not do. */
function named(label: string): Extension {
  return EditorView.contentAttributes.of({ 'aria-label': label, 'aria-readonly': 'true' })
}

/**
 * The editors sit in a list that scrolls as a whole, whose inner layers CodeMirror
 * would take for scroll containers (and scroll the list by the wrong amount, or not
 * at all): a place asked to be shown — a reveal, the cursor leaving the view — is
 * scrolled into view on the list itself.
 */
function scrollWithin(parent: NonNullable<DiffEditorSpec['scrollParent']>): Extension {
  return EditorView.scrollHandler.of((view, range, { y, yMargin }) => {
    const target = parent()
    if (!target) return false
    // Called mid-update: the line's block is readable then, character coordinates are not.
    const block = view.lineBlockAt(range.head)
    const rect = { top: view.documentTop + block.top, bottom: view.documentTop + block.bottom }
    const box = target.element.getBoundingClientRect()
    const top = box.top + target.topInset
    let delta = 0
    if (y === 'center') delta = (rect.top + rect.bottom) / 2 - (top + box.bottom) / 2
    else if (y === 'start') delta = rect.top - top - yMargin
    else if (y === 'end') delta = rect.bottom - box.bottom + yMargin
    else if (rect.top < top + yMargin) delta = rect.top - top - yMargin
    else if (rect.bottom > box.bottom - yMargin) delta = rect.bottom - box.bottom + yMargin
    if (Math.abs(delta) >= 1) target.element.scrollBy({ top: delta })
    return true
  })
}

function commonExtensions(spec: DiffEditorSpec): Extension[] {
  const language = getLanguageSupport(languageForPath(spec.path) ?? undefined)
  return [
    EditorState.readOnly.of(true),
    // Selectable and focusable for references and F7, without a soft keyboard on touch screens.
    EditorView.contentAttributes.of({ inputmode: 'none' }),
    EditorState.phrases.of(spec.phrases),
    spec.lineNumbers ? lineNumbers() : [],
    highlightSpecialChars(),
    drawSelection(),
    // No lineWrapping: off-screen wrapped lines are only height-estimated, the
    // estimate undercounts wide CJK glyphs, and the shortfall keeps the tail of
    // a long diff out of the viewport forever. Unwrapped lines are one uniform
    // height, so the estimates are exact; long lines scroll horizontally.
    syntaxHighlighting(diffHighlightStyle),
    language ?? [],
    markField,
    diffEditorTheme,
    spec.scrollParent ? scrollWithin(spec.scrollParent) : [],
  ]
}

export function createDiffEditor(parent: HTMLElement, spec: DiffEditorSpec): DiffEditorHandle {
  const common = commonExtensions(spec)
  const extra = spec.sideExtensions ?? (() => [])

  if (spec.kind !== 'modified') {
    const side: DiffSide = spec.kind === 'added' ? 'after' : 'before'
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: side === 'after' ? spec.after : spec.before,
        extensions: [
          ...common,
          named(spec.labels[side]),
          EditorView.editorAttributes.of({ class: side === 'after' ? 'cm-wholeInserted' : 'cm-wholeDeleted' }),
          extra(side, false),
        ],
      }),
    })
    return {
      nav: view,
      editorFor: (wanted) => (wanted === side ? view : null),
      hasChunks: false,
      destroy: () => view.destroy(),
    }
  }

  if (spec.layout === 'split') {
    const merge = new MergeView({
      a: { doc: spec.before, extensions: [...common, named(spec.labels.before), extra('before', false)] },
      b: { doc: spec.after, extensions: [...common, named(spec.labels.after), extra('after', false)] },
      parent,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: spec.collapseUnchanged ? COLLAPSE : undefined,
      diffConfig: DIFF_CONFIG,
    })
    return {
      nav: merge.b,
      editorFor: (side) => (side === 'before' ? merge.a : merge.b),
      hasChunks: true,
      destroy: () => merge.destroy(),
    }
  }

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: spec.after,
      extensions: [
        ...common,
        named(spec.labels.both),
        unifiedMergeView({
          original: spec.before,
          highlightChanges: true,
          gutter: true,
          mergeControls: false,
          syntaxHighlightDeletions: true,
          collapseUnchanged: spec.collapseUnchanged ? COLLAPSE : undefined,
          diffConfig: DIFF_CONFIG,
        }),
        extra('after', true),
      ],
    }),
  })
  return {
    nav: view,
    editorFor: (side) => (side === 'after' ? view : null),
    hasChunks: true,
    destroy: () => view.destroy(),
  }
}

/**
 * Moves to the next (1) or previous (-1) changed chunk of `handle`, or with
 * `fromEdge` to its first (1) or last (-1) one. False when there is none that
 * way, so the caller moves on to another file. (`goToNextChunk` wraps around
 * instead, which cannot tell the caller a file is done.)
 */
export function goToChunk(handle: DiffEditorHandle, direction: 1 | -1, fromEdge = false): boolean {
  if (!handle.hasChunks) return false
  const view = handle.nav
  const info = getChunks(view.state)
  if (!info || info.chunks.length === 0) return false
  const ranges = info.chunks.map((chunk) => (info.side === 'a'
    ? { from: chunk.fromA, to: chunk.endA }
    : { from: chunk.fromB, to: chunk.endB }))
  const head = view.state.selection.main.head
  let target: { from: number; to: number } | undefined
  if (fromEdge) target = direction > 0 ? ranges[0] : ranges[ranges.length - 1]
  else if (direction > 0) target = ranges.find((range) => range.from > head)
  else target = [...ranges].reverse().find((range) => range.from < head)
  if (!target) return false
  view.dispatch({ selection: { anchor: target.from }, userEvent: 'select.byChunk' })
  markLines(view, target.from, target.to, 'focus')
  return true
}

/** Type of the widget @codemirror/merge puts in place of collapsed unchanged lines. */
const COLLAPSED_WIDGET_TYPE = 'collapsed-unchanged-code'

/** Starts of the collapsed unchanged sections touching `from`..`to`. */
function collapsedStartsIn(view: EditorView, from: number, to: number): number[] {
  const starts = new Set<number>()
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === 'function' ? source(view) : source
    set.between(from, to, (start, _end, value) => {
      if ((value.spec.widget as { type?: string } | undefined)?.type === COLLAPSED_WIDGET_TYPE) starts.add(start)
    })
  }
  return [...starts]
}

/** The position on the other side of a diff that `pos` (on side a when `fromA`) lines up with. */
export function mapAcross(pos: number, chunks: readonly Pick<Chunk, 'fromA' | 'toA' | 'fromB' | 'toB'>[], fromA: boolean): number {
  let ours = 0
  let theirs = 0
  for (const chunk of chunks) {
    if ((fromA ? chunk.fromA : chunk.fromB) >= pos) break
    ours = fromA ? chunk.toA : chunk.toB
    theirs = fromA ? chunk.toB : chunk.toA
  }
  return theirs + (pos - ours)
}

/**
 * Expands the collapsed unchanged sections touching lines `startLine`..`endLine`
 * (1-based), on both sides of a side-by-side diff, so those lines can be shown:
 * a reference or a report may point at context the diff folds away.
 */
export function expandCollapsedAt(view: EditorView, startLine: number, endLine = startLine): void {
  const doc = view.state.doc
  const clamp = (line: number) => Math.max(1, Math.min(line, doc.lines))
  const starts = collapsedStartsIn(view, doc.line(clamp(startLine)).from, doc.line(clamp(endLine)).to)
  if (starts.length === 0) return
  view.dispatch({ effects: starts.map((start) => uncollapseUnchanged.of(start)) })
  const siblings = mergeViewSiblings(view)
  const info = getChunks(view.state)
  if (!siblings || !info) return
  const other = siblings.a === view ? siblings.b : siblings.a
  const across = new Set(starts.flatMap((start) => {
    const pos = mapAcross(start, info.chunks, info.side === 'a')
    return collapsedStartsIn(other, pos, pos)
  }))
  if (across.size > 0) other.dispatch({ effects: [...across].map((start) => uncollapseUnchanged.of(start)) })
}

/** Keeps the lines pending references point at unfolded, so their highlights and comment cards show. */
export function unfoldReferencedLines(view: EditorView, ranges: readonly { startLine: number; endLine: number }[]): void {
  for (const range of ranges) expandCollapsedAt(view, range.startLine, range.endLine)
}

/** The before side's text in the unified layout, by 1-based line, to find a quoted place in. */
export function originalLines(handle: DiffEditorHandle): { lines: number; line(n: number): string } {
  const original = getOriginalDoc(handle.nav.state)
  return { lines: original.lines, line: (n) => original.line(n).text }
}

/**
 * The unified layout has no editor for the before side: its lines are the
 * deleted-chunk widgets inside the after editor. Brings the place a before-side
 * line maps to into view and, with `light`, marks it for a moment.
 */
export function revealBeforeInUnified(handle: DiffEditorHandle, startLine: number, light = true): void {
  const view = handle.nav
  const original = getOriginalDoc(view.state)
  const posA = original.line(Math.max(1, Math.min(startLine, original.lines))).from
  let posB = posA
  for (const chunk of getChunks(view.state)?.chunks ?? []) {
    if (posA < chunk.fromA) break
    if (posA <= chunk.endA) {
      posB = chunk.fromB
      break
    }
    // Past this chunk the two sides are offset by what it added or removed.
    posB = posA + (chunk.toB - chunk.toA)
  }
  posB = Math.max(0, Math.min(posB, view.state.doc.length))
  expandCollapsedAt(view, view.state.doc.lineAt(posB).number)
  view.dispatch({ effects: EditorView.scrollIntoView(posB, { y: 'center' }) })
  if (light) markLines(view, posB, posB, 'flash')
}
