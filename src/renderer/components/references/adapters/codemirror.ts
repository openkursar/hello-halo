/**
 * CodeMirror adapter: an editor's selection becomes a reference with exact
 * lines; the pending references of the editor's own source show highlighted,
 * and each comment as a card under its lines, where it is read, edited and
 * deleted — a new comment is written in such a card too. Works for a plain
 * editor and for either side of a merge view: side by side, a hidden twin of
 * every card on the other side keeps the two sides aligned; in a unified merge
 * view, text in the deleted-chunk widgets is the before side, and its cards
 * follow the chunk's widget.
 *
 * Everything lives in the editor's own lifecycle (a view plugin): destroying
 * the EditorView releases the store subscriptions and any offered selection.
 * Highlights and cards are derived from the stores whenever the plugin starts,
 * so an editor that unmounts and mounts again shows them again.
 */

import { Facet, StateEffect, StateField, type EditorState, type Extension, type Range, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type {
  ContentReference,
  DiffReferenceSource,
  FileReferenceSource,
  ReferenceLineRange,
} from '../../../../shared/types/content-reference'
import { findReference, getTargetReferences, useComposerReferencesStore, type ReferenceDraft } from '../../../stores/composer-references.store'
import { endNewComment, saveNewComment, startNewComment, useCommentEdits } from '../comment-edits'
import { requestCommentFocus } from '../comment-focus'
import { openCommentCard, openCommentCardAtComposer } from '../comment-markers'
import { relocateLines, type LineSource, type RevealOutcome } from '../relocate'
import { afterPointerRelease, canOffer, offerSelection, SELECTION_SETTLE_MS, type SelectionRect } from '../selection'
import { sameReferenceSource } from '../reference-match'
import { afterLine, beforeSideAnchor, beforeSideLines, twinAnchor, type CardAnchor, type ChunkRange } from './comment-placement'
import { renderInlineComment, unmountInlineComment, type InlineCommentProps } from './comment-widget'

export interface CodeMirrorReferenceOptions {
  /** Read when a selection is offered. Null offers nothing (e.g. a buffer with no file behind it). */
  source: () => FileReferenceSource | DiffReferenceSource | null
  /**
   * Unified merge view only: the before side, shown in the deleted-chunk
   * widgets. Without it, selections inside deleted chunks are ignored.
   */
  beforeSource?: () => DiffReferenceSource | null
  /**
   * False when the document is a fragment whose line numbers are not the
   * file's (message-mode edit snippets): references then carry the quote
   * only, and highlights, cards and going back locate by it.
   */
  lines?: boolean
  /**
   * The lines of this editor's document that pending references point at —
   * called once the editor shows them, and whenever they change; never inside
   * an update (a diff unfolds them here so they do not stay collapsed).
   */
  onLines?: (view: EditorView, ranges: readonly ReferenceLineRange[]) => void
}

/** How long the place gone back to stays lit. */
const REVEAL_FLASH_MS = 1800

const optionsFacet = Facet.define<CodeMirrorReferenceOptions, CodeMirrorReferenceOptions | null>({
  combine: values => values[0] ?? null,
})

// ============================================
// Decorations
// ============================================

/** A comment card (or a hidden twin of one) to place. */
interface CardSpec {
  id: string
  anchor: CardAnchor
  /** Order among cards at one place: the before side's, then the after side's, then a new comment. */
  order: number
  ghost: boolean
  /** A new comment: what it will point at. */
  draft?: ReferenceDraft
}

const setReferenceDecorations = StateEffect.define<{ marks: DecorationSet; cards: DecorationSet }>()
const setRevealLines = StateEffect.define<{ from: number; to: number } | null>()

const referenceMarkDeco = Decoration.mark({ class: 'cm-haloRefMark' })
const revealLineDeco = Decoration.line({ class: 'cm-haloRevealLine' })

const resizeObservers = new WeakMap<HTMLElement, ResizeObserver>()

class CommentWidget extends WidgetType {
  constructor(readonly spec: CardSpec, readonly onNewDone?: (note: string | null) => void) {
    super()
  }

  eq(other: CommentWidget): boolean {
    return other.spec.id === this.spec.id && other.spec.ghost === this.spec.ghost && !!other.spec.draft === !!this.spec.draft
  }

  private props(): InlineCommentProps {
    return { id: this.spec.id, draft: this.spec.draft, ghost: this.spec.ghost, onNewDone: this.onNewDone }
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('div')
    dom.className = 'cm-haloComment'
    renderInlineComment(dom, this.props())
    // The card grows as it is written in (and its twin with it): the editor measures its lines again.
    const observer = new ResizeObserver(() => view.requestMeasure())
    observer.observe(dom)
    resizeObservers.set(dom, observer)
    return dom
  }

  updateDOM(dom: HTMLElement): boolean {
    renderInlineComment(dom, this.props())
    return true
  }

  destroy(dom: HTMLElement): void {
    resizeObservers.get(dom)?.disconnect()
    resizeObservers.delete(dom)
    unmountInlineComment(dom)
  }

  // Typing, clicking and selecting in the card are the card's, not the editor's.
  ignoreEvent(): boolean {
    return true
  }

  get estimatedHeight(): number {
    return 72
  }
}

function buildRevealLines(doc: Text, from: number, to: number): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const last = doc.lineAt(to).number
  for (let n = doc.lineAt(from).number; n <= last; n++) ranges.push(revealLineDeco.range(doc.line(n).from))
  return Decoration.set(ranges)
}

const referenceField = StateField.define<{ marks: DecorationSet; cards: DecorationSet; reveal: DecorationSet }>({
  create: () => ({ marks: Decoration.none, cards: Decoration.none, reveal: Decoration.none }),
  update(value, tr) {
    let { marks, cards, reveal } = value
    marks = marks.map(tr.changes)
    cards = cards.map(tr.changes)
    reveal = reveal.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setReferenceDecorations)) ({ marks, cards } = effect.value)
      else if (effect.is(setRevealLines)) {
        reveal = effect.value ? buildRevealLines(tr.state.doc, effect.value.from, effect.value.to) : Decoration.none
      }
    }
    return { marks, cards, reveal }
  },
  provide: field => [
    EditorView.decorations.from(field, value => value.marks),
    EditorView.decorations.from(field, value => value.cards),
    EditorView.decorations.from(field, value => value.reveal),
  ],
})

const referenceTheme = EditorView.baseTheme({
  '.cm-haloRefMark': {
    backgroundColor: 'hsl(var(--primary) / 0.18)',
    borderBottom: '1.5px solid hsl(var(--primary) / 0.7)',
  },
  '.cm-haloComment': {
    padding: '4px 12px 6px 8px',
  },
  // The merge-view selectors outrank a diff theme's changed-line tint, which would hide the flash.
  '.cm-line.cm-haloRevealLine, &.cm-merge-a .cm-line.cm-haloRevealLine, &.cm-merge-b .cm-line.cm-haloRevealLine': {
    backgroundColor: 'hsl(var(--halo-warning) / 0.32) !important',
  },
})

// ============================================
// Locating references in a document
// ============================================

function lineSourceOfDoc(doc: Text): LineSource {
  return { lines: doc.lines, line: n => doc.line(n).text }
}

/** Character span of `ref` in `doc`, or null when it cannot be placed there. */
function locate(doc: Text, ref: Pick<ContentReference, 'range' | 'quote'>, useLines: boolean): { from: number; to: number; outcome: RevealOutcome } | null {
  if (useLines && ref.range) {
    if (doc.lines === 0) return null
    const { range, outcome } = relocateLines(lineSourceOfDoc(doc), ref.range, ref.quote)
    return { from: doc.line(range.startLine).from, to: doc.line(range.endLine).to, outcome }
  }
  if (!ref.quote) return null
  const at = doc.toString().indexOf(ref.quote)
  return at < 0 ? null : { from: at, to: at + ref.quote.length, outcome: 'exact' }
}

/** The lines `ref` spans in `doc`, or null when it cannot be placed there. */
function linesIn(doc: Text, ref: Pick<ContentReference, 'range' | 'quote'>, useLines: boolean): ReferenceLineRange | null {
  const span = locate(doc, ref, useLines)
  return span ? { startLine: doc.lineAt(span.from).number, endLine: doc.lineAt(span.to).number } : null
}

function cardOrder(source: ContentReference['source']): number {
  return source.kind === 'diff' && source.side === 'before' ? 1 : 2
}

const NEW_COMMENT_ORDER = 3

// ============================================
// Merge views
// ============================================

// The merge package is loaded by the changes view; reaching for it lazily keeps it out of the startup bundle.
type MergeModule = typeof import('@codemirror/merge')
let mergeModule: MergeModule | null = null
let mergeLoading: Promise<MergeModule> | null = null

function loadMerge(): Promise<MergeModule> {
  mergeLoading ??= import('@codemirror/merge').then(module => (mergeModule = module))
  return mergeLoading
}

function inMergeView(view: EditorView, options: CodeMirrorReferenceOptions): boolean {
  return !!options.beforeSource || view.dom.classList.contains('cm-merge-a') || view.dom.classList.contains('cm-merge-b')
}

interface MergeContext {
  chunks: readonly ChunkRange[]
  /** Side by side: the other editor, and whether this one shows side A (before). */
  sibling: { view: EditorView; selfIsA: boolean } | null
  /** Unified: the original (before) text. */
  original: Text | null
}

function mergeContextOf(view: EditorView): MergeContext | null {
  if (!mergeModule) return null
  const info = mergeModule.getChunks(view.state)
  if (!info) return null
  // Told apart by the sibling: a unified merge view reports itself as side B as well.
  const siblings = mergeModule.mergeViewSiblings(view)
  if (!siblings) return { chunks: info.chunks, sibling: null, original: mergeModule.getOriginalDoc(view.state) }
  const selfIsA = siblings.a === view
  return { chunks: info.chunks, sibling: { view: selfIsA ? siblings.b : siblings.a, selfIsA }, original: null }
}

// ============================================
// Selections
// ============================================

function elementOf(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
}

function rectOf(rect: DOMRect): SelectionRect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

/** Whether a DOM position lies inside one of this editor's deleted-chunk widgets (unified merge view). */
function inDeletedChunk(view: EditorView, node: Node | null): boolean {
  const chunk = elementOf(node)?.closest('.cm-deletedChunk')
  return !!chunk && view.contentDOM.contains(chunk)
}

/** Line in the original document of a DOM position inside a deleted-chunk widget. */
function originalLineAt(merge: MergeModule, view: EditorView, state: EditorState, node: Node): number | null {
  const lineEl = elementOf(node)?.closest('.cm-deletedLine')
  const chunkEl = lineEl?.closest('.cm-deletedChunk')
  if (!lineEl || !chunkEl || !view.contentDOM.contains(chunkEl)) return null
  const chunks = merge.getChunks(state)?.chunks
  if (!chunks) return null
  const pos = view.posAtDOM(chunkEl)
  const chunk = chunks.find(c => c.fromB === pos)
  if (!chunk || chunk.fromA >= chunk.toA) return null
  const index = Array.prototype.indexOf.call(chunkEl.querySelectorAll('.cm-deletedLine'), lineEl)
  if (index < 0) return null
  const original = merge.getOriginalDoc(state)
  const line = original.lineAt(chunk.fromA).number + index
  return line <= original.lines ? line : null
}

/** Writing in a comment card is not selecting content. */
function inCommentCard(): boolean {
  return !!document.activeElement?.closest('.cm-haloComment')
}

/** Starts writing a comment on `draft` in a card in the content; it goes to the composer beside it once saved. */
function startComment(draft: ReferenceDraft): void {
  const target = useComposerReferencesStore.getState().target
  if (target) startNewComment(target.key, draft)
}

class ReferencePlugin {
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private cancelRelease: (() => void) | null = null
  private syncFrame: number | null = null
  private shown = false
  private lastLines: string | null = null
  private destroyed = false
  private readonly unsubscribe: Array<() => void>

  constructor(private readonly view: EditorView) {
    let references = getTargetReferences()
    this.unsubscribe = [
      useComposerReferencesStore.subscribe(() => {
        if (getTargetReferences() === references) return
        references = getTargetReferences()
        this.scheduleSync()
      }),
      useCommentEdits.subscribe((state, previous) => {
        if (state.newComments !== previous.newComments) this.scheduleSync()
      }),
    ]
    this.scheduleSync()
  }

  private get options(): CodeMirrorReferenceOptions {
    return this.view.state.facet(optionsFacet) ?? { source: () => null }
  }

  update(update: ViewUpdate): void {
    if (update.selectionSet || update.focusChanged) this.scheduleOffer()
    if (update.docChanged && this.shown) this.scheduleSync()
  }

  destroy(): void {
    this.destroyed = true
    for (const stop of this.unsubscribe) stop()
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.cancelRelease?.()
    if (this.syncFrame !== null) cancelAnimationFrame(this.syncFrame)
    offerSelection(this, null)
  }

  /** Called by the DOM handlers for selections CodeMirror does not track (inside widgets). */
  scheduleOffer(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      this.cancelRelease?.()
      this.cancelRelease = afterPointerRelease(() => {
        this.cancelRelease = null
        if (!this.destroyed) this.offer()
      })
    }, SELECTION_SETTLE_MS)
  }

  private offer(): void {
    const view = this.view
    const domSelection = document.getSelection()
    if (inCommentCard()) {
      offerSelection(this, null)
      return
    }

    if (this.options.beforeSource && domSelection && !domSelection.isCollapsed && domSelection.rangeCount > 0) {
      const anchorInside = inDeletedChunk(view, domSelection.anchorNode)
      const focusInside = inDeletedChunk(view, domSelection.focusNode)
      if (anchorInside && focusInside) {
        void this.offerBefore(domSelection)
        return
      }
      // A selection reaching into a deleted chunk from outside cannot be placed on lines correctly.
      if (anchorInside || focusInside) {
        offerSelection(this, null)
        return
      }
    }

    const selection = view.state.selection.main
    const inEditor = !!domSelection?.anchorNode && view.contentDOM.contains(domSelection.anchorNode)
    if (selection.empty || !(view.hasFocus || inEditor)) {
      offerSelection(this, null)
      return
    }
    if (!canOffer()) return
    const source = this.options.source()
    if (!source) return

    const doc = view.state.doc
    const quote = doc.sliceString(selection.from, selection.to)
    if (!quote.trim()) {
      offerSelection(this, null)
      return
    }
    const startLine = doc.lineAt(selection.from).number
    // A selection that ends at the start of a line does not include that line.
    const endPos = selection.to > selection.from && doc.lineAt(selection.to).from === selection.to ? selection.to - 1 : selection.to
    const range: ReferenceLineRange = { startLine, endLine: Math.max(startLine, doc.lineAt(endPos).number) }
    const draft: ReferenceDraft = {
      source: source.kind === 'file' ? { ...source, precision: 'lines' } : source,
      quote,
      ...(this.options.lines === false ? {} : { range }),
    }

    const head = view.coordsAtPos(selection.head)
    const start = view.coordsAtPos(selection.from)
    const end = view.coordsAtPos(selection.to)
    if (!head) return
    const collapse = () => {
      if (!this.destroyed) view.dispatch({ selection: { anchor: view.state.selection.main.head } })
    }
    offerSelection(this, {
      draft,
      rect: { left: head.left, right: head.left, top: start?.top ?? head.top, bottom: end?.bottom ?? head.bottom },
      collapse,
      refocus: () => {
        if (!this.destroyed) view.focus()
      },
      comment: () => {
        collapse()
        startComment(draft)
      },
    })
  }

  private async offerBefore(domSelection: Selection): Promise<void> {
    if (!canOffer()) return
    const source = this.options.beforeSource?.()
    const quote = domSelection.toString()
    const anchorNode = domSelection.anchorNode
    const focusNode = domSelection.focusNode
    if (!source || !quote.trim() || !anchorNode || !focusNode) return
    const rect = domSelection.getRangeAt(0).getBoundingClientRect()
    const merge = await loadMerge()
    if (this.destroyed) return
    const anchor = originalLineAt(merge, this.view, this.view.state, anchorNode)
    const focus = originalLineAt(merge, this.view, this.view.state, focusNode)
    // Lines that cannot be mapped exactly are not offered: a wrong place is worse than none.
    if (!anchor || !focus) {
      offerSelection(this, null)
      return
    }
    const draft: ReferenceDraft = {
      source,
      quote,
      ...(this.options.lines === false ? {} : { range: { startLine: Math.min(anchor, focus), endLine: Math.max(anchor, focus) } }),
    }
    const collapse = () => document.getSelection()?.removeAllRanges()
    offerSelection(this, {
      draft,
      rect: rectOf(rect),
      collapse,
      refocus: () => {
        if (!this.destroyed) this.view.focus()
      },
      comment: () => {
        collapse()
        startComment(draft)
      },
    })
  }

  scheduleSync(): void {
    if (this.syncFrame !== null || this.destroyed) return
    this.syncFrame = requestAnimationFrame(() => {
      this.syncFrame = null
      if (!this.destroyed) this.sync()
    })
  }

  private sync(): void {
    const view = this.view
    const options = this.options
    // A side-by-side view's editors get their merge classes after their plugins start, so this is checked here.
    const inMerge = inMergeView(view, options)
    if (inMerge && !mergeModule) {
      void loadMerge().then(() => this.scheduleSync())
      return
    }
    const doc = view.state.doc
    const useLines = options.lines !== false
    const references = getTargetReferences()
    const newComments = [...useCommentEdits.getState().newComments.entries()]
    const merge = inMerge ? mergeContextOf(view) : null
    const own = options.source()
    const beforeSource = merge?.original ? options.beforeSource?.() ?? null : null
    const siblingSource = merge?.sibling ? merge.sibling.view.state.facet(optionsFacet)?.source() ?? null : null

    const marks: Range<Decoration>[] = []
    const cards: CardSpec[] = []
    const lines: ReferenceLineRange[] = []

    /**
     * Where a card goes for a reference (or a new comment) of this editor's own text, of the
     * before side shown in its deleted chunks, or of the other side of a side-by-side diff (a twin).
     */
    const place = (item: Pick<ContentReference, 'source' | 'range' | 'quote'>): {
      anchor: CardAnchor
      ghost: boolean
      lines: ReferenceLineRange | null
      /** Text of this editor to highlight. */
      span?: { from: number; to: number }
    } | null => {
      if (own && sameReferenceSource(item.source, own)) {
        const span = locate(doc, item, useLines)
        if (!span) return null
        const range = { startLine: doc.lineAt(span.from).number, endLine: doc.lineAt(span.to).number }
        return { anchor: afterLine(doc, range.endLine), ghost: false, lines: range, span }
      }
      if (beforeSource && merge?.original && sameReferenceSource(item.source, beforeSource)) {
        const range = linesIn(merge.original, item, useLines)
        if (!range) return null
        return {
          anchor: beforeSideAnchor(doc, merge.original, merge.chunks, range.endLine),
          ghost: false,
          lines: beforeSideLines(doc, merge.original, merge.chunks, range.startLine, range.endLine),
        }
      }
      if (siblingSource && merge?.sibling && sameReferenceSource(item.source, siblingSource)) {
        const otherDoc = merge.sibling.view.state.doc
        const range = linesIn(otherDoc, item, useLines)
        const anchor = range && twinAnchor(doc, otherDoc, merge.chunks, range.endLine, !merge.sibling.selfIsA)
        return anchor ? { anchor, ghost: true, lines: null } : null
      }
      return null
    }

    for (const ref of references) {
      const placed = place(ref)
      if (!placed) continue
      if (placed.span && placed.span.to > placed.span.from) marks.push(referenceMarkDeco.range(placed.span.from, placed.span.to))
      if (placed.lines) lines.push(placed.lines)
      if (ref.note) cards.push({ id: ref.id, anchor: placed.anchor, order: cardOrder(ref.source), ghost: placed.ghost })
    }
    for (const [id, entry] of newComments) {
      const placed = place(entry.draft)
      if (placed) cards.push({ id, anchor: placed.anchor, order: NEW_COMMENT_ORDER, ghost: placed.ghost, draft: entry.draft })
    }

    const hasAny = marks.length > 0 || cards.length > 0
    if (hasAny || this.shown) {
      this.shown = hasAny
      view.dispatch({ effects: setReferenceDecorations.of({ marks: Decoration.set(marks, true), cards: this.buildCards(cards) }) })
    }
    this.reportLines(lines)
  }

  private buildCards(specs: readonly CardSpec[]): DecorationSet {
    const view = this.view
    return Decoration.set(specs.map(spec => {
      const onNewDone = spec.draft && !spec.ghost
        ? (note: string | null) => {
            if (note === null) endNewComment(spec.id)
            else saveNewComment(spec.id, note)
            if (!this.destroyed) view.focus()
          }
        : undefined
      return Decoration.widget({
        widget: new CommentWidget(spec, onNewDone),
        block: true,
        side: spec.anchor.before ? 0 : spec.order,
      }).range(spec.anchor.pos)
    }), true)
  }

  private reportLines(lines: readonly ReferenceLineRange[]): void {
    const onLines = this.options.onLines
    if (!onLines) return
    const key = JSON.stringify(lines)
    if (key === this.lastLines) return
    this.lastLines = key
    const ranges = lines.slice()
    queueMicrotask(() => {
      if (!this.destroyed) onLines(this.view, ranges)
    })
  }
}

const referencePlugin = ViewPlugin.fromClass(ReferencePlugin, {
  eventHandlers: {
    mouseup(this: ReferencePlugin) {
      this.scheduleOffer()
    },
    keyup(this: ReferencePlugin, event: KeyboardEvent) {
      if (event.shiftKey) this.scheduleOffer()
    },
  },
})

/** The adapter for one editor. See the module comment. */
export function referenceExtension(options: CodeMirrorReferenceOptions): Extension {
  return [optionsFacet.of(options), referenceField, referenceTheme, referencePlugin]
}

// ============================================
// Going back to a place
// ============================================

/** Where `span` shows in the window, or null when it is not drawn or scrolled out of sight. */
function spanRect(view: EditorView, span: { from: number; to: number }): SelectionRect | null {
  const start = view.coordsAtPos(span.from)
  const end = view.coordsAtPos(span.to)
  if (!start || !end || end.bottom < 0 || start.top > window.innerHeight) return null
  return { left: start.left, right: start.left, top: start.top, bottom: end.bottom }
}

/** Whether `view` draws the card of the comment `ref`: a reference of its own text (or its before side) that it can place. */
function drawsCommentCard(view: EditorView, ref: ContentReference): boolean {
  const options = view.state.facet(optionsFacet)
  if (!options) return false
  const useLines = options.lines !== false
  const own = options.source()
  if (own && sameReferenceSource(ref.source, own)) return locate(view.state.doc, ref, useLines) !== null
  const before = options.beforeSource?.() ?? null
  if (!before || !sameReferenceSource(ref.source, before)) return false
  const original = mergeContextOf(view)?.original
  return !original || linesIn(original, ref, useLines) !== null
}

/**
 * Puts the keyboard focus on the card of the pending comment `id` in `view` —
 * now, or once the card mounts (its tab or editor may still be on the way).
 * When `view` draws no card for it (another kind of view of the file, a
 * buffer with unsaved edits, a text it cannot place), the comment opens in the
 * floating card instead: beside `near` when that shows, else beside the
 * composer's comments chip.
 */
export function focusCommentCard(view: EditorView, id: string, near?: () => SelectionRect | null): void {
  const { drafts, target } = useComposerReferencesStore.getState()
  const owner = findReference(drafts, id)
  if (!owner?.reference.note) return
  const elsewhere = () => {
    const rect = view.dom.isConnected ? near?.() ?? null : null
    if (rect) openCommentCard(id, rect)
    else openCommentCardAtComposer(id)
  }
  // Editors draw cards for the composer beside the canvas only.
  if (owner.key === target?.key && drawsCommentCard(view, owner.reference)) requestCommentFocus(id, elsewhere)
  // Once the scroll to the place is drawn, so `near` reads where it shows.
  else requestAnimationFrame(() => requestAnimationFrame(elsewhere))
}

/**
 * Scrolls to the referenced lines (or quote) and lights them up briefly.
 * When the text moved, the new place is lit and 'moved' returned; when it is
 * gone, the original lines are shown unlit and 'lost' returned. With
 * `commentId`, the comment's card there takes the focus — or, with nothing to
 * show it at, it opens beside the composer.
 */
export function revealInEditor(view: EditorView, target: { range?: ReferenceLineRange; quote?: string; commentId?: string }): RevealOutcome {
  const doc = view.state.doc
  const span = locate(doc, target, !!target.range)
  if (!span) {
    if (target.commentId) openCommentCardAtComposer(target.commentId)
    return 'lost'
  }
  if (!view.state.field(referenceField, false)) {
    view.dispatch({ effects: StateEffect.appendConfig.of([referenceField, referenceTheme]) })
  }
  const lit = span.outcome !== 'lost'
  view.dispatch({
    effects: [
      EditorView.scrollIntoView(span.from, { y: 'center' }),
      setRevealLines.of(lit ? { from: span.from, to: Math.max(span.from, span.to) } : null),
    ],
  })
  if (lit) {
    setTimeout(() => {
      // The editor may be gone by now (tab switched); a destroyed view refuses dispatches.
      if (view.dom.isConnected) view.dispatch({ effects: setRevealLines.of(null) })
    }, REVEAL_FLASH_MS)
  }
  if (target.commentId) focusCommentCard(view, target.commentId, () => spanRect(view, span))
  return span.outcome
}
