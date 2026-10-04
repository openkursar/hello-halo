/**
 * DOM text adapter: rendered text (Markdown preview, AI replies, the review
 * report) offers its selections as references, and shows the pending
 * references that point into it as highlighted passages — a comment also
 * with a marker in the margin that opens it.
 *
 * Elements register themselves; one document listener, owned by the
 * reference layer, resolves a selection to the nearest registered element, so
 * nothing listens per element and a page without the layer does no work.
 * Highlights use the CSS Custom Highlight API (the page's DOM is never
 * rewritten) and are computed only while matching references exist.
 */

import { useEffect, useRef, type RefObject } from 'react'
import { create } from 'zustand'
import type { FileReferenceSource, MessageReferenceSource } from '../../../../shared/types/content-reference'
import { getTargetReferences, useComposerReferencesStore, type ReferenceDraft } from '../../../stores/composer-references.store'
import { approximateLines, looseIndexOf } from '../relocate'
import { sameReferenceSource } from '../reference-match'
import { afterPointerRelease, canOffer, offerSelection, SELECTION_SETTLE_MS, useSelectionStore, type SelectionRect } from '../selection'
import { showCommentAt } from '../comment-markers'

export interface TextReferenceOptions {
  /** Source for selections inside the element; null switches the adapter off. */
  source: FileReferenceSource | MessageReferenceSource | null
  /**
   * The text the element was rendered from, when it is a file (Markdown
   * preview); used only to give the reference approximate line numbers.
   */
  sourceText?: string
}

const SCOPE_ATTRIBUTE = 'data-reference-scope'
const REFERENCE_HIGHLIGHT = 'halo-ref'
const REVEAL_HIGHLIGHT = 'halo-reveal'
const REVEAL_FLASH_MS = 1800
/** Quiet time before marks are found again after the element's content changed. */
const REMARK_DELAY_MS = 150

interface ScopeMark {
  range: Range
  id: string
  comment: boolean
}

interface TextScope {
  element: HTMLElement
  options: { current: TextReferenceOptions }
  marks: ScopeMark[]
  observer: MutationObserver | null
  remarkTimer: ReturnType<typeof setTimeout> | null
}

const scopes = new Map<HTMLElement, TextScope>()

// ============================================
// Text search in an element
// ============================================

interface TextIndex {
  text: string
  nodes: Text[]
  starts: number[]
}

/** Editors inside a scope number their own text (the CodeMirror adapter). */
const textFilter: NodeFilter = {
  acceptNode: node => node.nodeType === Node.TEXT_NODE
    ? NodeFilter.FILTER_ACCEPT
    : (node as Element).classList.contains('cm-editor') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP,
}

function indexText(root: HTMLElement): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, textFilter)
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data
    if (!data) continue
    nodes.push(node as Text)
    starts.push(text.length)
    text += data
  }
  return { text, nodes, starts }
}

function positionAt(index: TextIndex, offset: number): { node: Text; offset: number } {
  let low = 0
  let high = index.nodes.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (index.starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  const node = index.nodes[low]
  return { node, offset: Math.min(offset - index.starts[low], node.data.length) }
}

function rangeIn(index: TextIndex, quote: string): Range | null {
  if (index.nodes.length === 0) return null
  const span = looseIndexOf(index.text, quote)
  if (!span) return null
  const start = positionAt(index, span[0])
  const end = positionAt(index, span[1])
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range
}

// ============================================
// Highlights
// ============================================

/** Where a pending comment sits in rendered text, for its marker in the margin. */
export interface TextCommentMark {
  key: string
  id: string
  range: Range
  scope: HTMLElement
}

/** Comment markers for the reference layer to draw; empty unless pending comments point into rendered text. */
export const useTextCommentMarks = create<{ marks: TextCommentMark[] }>(() => ({ marks: [] }))

function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}

function paint(): void {
  const ranges: Range[] = []
  const marks: TextCommentMark[] = []
  for (const scope of scopes.values()) {
    for (const mark of scope.marks) {
      ranges.push(mark.range)
      if (mark.comment) marks.push({ key: `${mark.id}:${marks.length}`, id: mark.id, range: mark.range, scope: scope.element })
    }
  }
  if (highlightsSupported()) {
    if (ranges.length > 0) CSS.highlights.set(REFERENCE_HIGHLIGHT, new Highlight(...ranges))
    else CSS.highlights.delete(REFERENCE_HIGHLIGHT)
  }
  const previous = useTextCommentMarks.getState().marks
  if (previous.length === 0 && marks.length === 0) return
  useTextCommentMarks.setState({ marks })
}

function findMarks(scope: TextScope): void {
  const source = scope.options.current.source
  const matching = source ? getTargetReferences().filter(ref => ref.quote && sameReferenceSource(ref.source, source)) : []
  if (matching.length === 0) {
    scope.marks = []
    stopWatching(scope)
    return
  }
  const index = indexText(scope.element)
  scope.marks = matching.flatMap(ref => {
    const range = rangeIn(index, ref.quote!)
    return range ? [{ range, id: ref.id, comment: !!ref.note }] : []
  })
  // Content mounted later (a chunk scrolled in, a re-render) may hold a passage not found now.
  watch(scope)
}

function watch(scope: TextScope): void {
  if (scope.observer) return
  scope.observer = new MutationObserver(() => {
    if (scope.remarkTimer) clearTimeout(scope.remarkTimer)
    scope.remarkTimer = setTimeout(() => {
      scope.remarkTimer = null
      if (!scopes.has(scope.element)) return
      findMarks(scope)
      paint()
    }, REMARK_DELAY_MS)
  })
  scope.observer.observe(scope.element, { childList: true, subtree: true, characterData: true })
}

function stopWatching(scope: TextScope): void {
  scope.observer?.disconnect()
  scope.observer = null
  if (scope.remarkTimer) clearTimeout(scope.remarkTimer)
  scope.remarkTimer = null
}

let lastReferences: unknown = null
let unsubscribeStore: (() => void) | null = null

function syncSubscription(): void {
  if (scopes.size > 0 && !unsubscribeStore) {
    lastReferences = getTargetReferences()
    unsubscribeStore = useComposerReferencesStore.subscribe(() => {
      const references = getTargetReferences()
      if (references === lastReferences) return
      lastReferences = references
      for (const scope of scopes.values()) findMarks(scope)
      paint()
    })
  } else if (scopes.size === 0 && unsubscribeStore) {
    unsubscribeStore()
    unsubscribeStore = null
  }
}

function register(element: HTMLElement, options: { current: TextReferenceOptions }): TextScope {
  const scope: TextScope = { element, options, marks: [], observer: null, remarkTimer: null }
  element.setAttribute(SCOPE_ATTRIBUTE, '')
  scopes.set(element, scope)
  syncSubscription()
  if (getTargetReferences().length > 0) {
    findMarks(scope)
    if (scope.marks.length > 0) paint()
  }
  return scope
}

function unregister(scope: TextScope): void {
  stopWatching(scope)
  scope.element.removeAttribute(SCOPE_ATTRIBUTE)
  scopes.delete(scope.element)
  const hadMarks = scope.marks.length > 0
  scope.marks = []
  syncSubscription()
  if (hadMarks) paint()
}

/**
 * Makes the element's text referenceable as `options.source` and shows the
 * pending references that point into it. See the module comment.
 */
export function useTextReferences(ref: RefObject<HTMLElement | null>, options: TextReferenceOptions): void {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const sourceKey = options.source ? JSON.stringify(options.source) : null

  useEffect(() => {
    const element = ref.current
    if (!element || !sourceKey) return
    const scope = register(element, optionsRef)
    return () => unregister(scope)
  }, [ref, sourceKey])
}

// ============================================
// Selections
// ============================================

const TEXT_OWNER = {}

/** Elements whose selections belong to another adapter or are not content. */
const NOT_CONTENT = '.cm-editor, .xterm, [data-reference-layer], textarea, input, [contenteditable="true"]'

function draftFor(scope: TextScope, quote: string): ReferenceDraft | null {
  const { source, sourceText } = scope.options.current
  if (!source) return null
  if (source.kind === 'message') return { source, quote }
  const range = sourceText ? approximateLines(sourceText, quote) : undefined
  return { source: { ...source, precision: 'passage' }, quote, ...(range ? { range } : {}) }
}

function offerCurrentSelection(): void {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    offerSelection(TEXT_OWNER, null)
    return
  }
  const range = selection.getRangeAt(0)
  const container = range.commonAncestorContainer
  const element = container.nodeType === Node.ELEMENT_NODE ? container as Element : container.parentElement
  const scopeElement = element && !element.closest(NOT_CONTENT) ? element.closest(`[${SCOPE_ATTRIBUTE}]`) : null
  const scope = scopeElement ? scopes.get(scopeElement as HTMLElement) : undefined
  if (!scope) {
    offerSelection(TEXT_OWNER, null)
    return
  }
  if (!canOffer()) return
  const quote = selection.toString()
  const draft = quote.trim() ? draftFor(scope, quote) : null
  if (!draft) {
    offerSelection(TEXT_OWNER, null)
    return
  }
  const rect = range.getBoundingClientRect()
  const saved = range.cloneRange()
  offerSelection(TEXT_OWNER, {
    draft,
    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    collapse: () => document.getSelection()?.removeAllRanges(),
    // Rendered text has no caret to return to; only a cancelled comment selects the text again.
    refocus: (restoreSelection) => {
      if (!restoreSelection || !saved.startContainer.isConnected) return
      const current = document.getSelection()
      current?.removeAllRanges()
      current?.addRange(saved)
    },
  })
}

/**
 * Listens for selections in registered elements; returns the stop function.
 * A collapsed selection costs one check and nothing else.
 */
export function listenForTextSelections(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelRelease: (() => void) | null = null
  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
    cancelRelease?.()
    cancelRelease = null
  }

  const onSelectionChange = () => {
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed) {
      cancel()
      if (useSelectionStore.getState().offered?.owner === TEXT_OWNER) offerSelection(TEXT_OWNER, null)
      return
    }
    if (scopes.size === 0) return
    cancel()
    timer = setTimeout(() => {
      timer = null
      cancelRelease = afterPointerRelease(() => {
        cancelRelease = null
        offerCurrentSelection()
      })
    }, SELECTION_SETTLE_MS)
  }

  document.addEventListener('selectionchange', onSelectionChange)
  return () => {
    document.removeEventListener('selectionchange', onSelectionChange)
    cancel()
    offerSelection(TEXT_OWNER, null)
  }
}

// ============================================
// Going back to a passage
// ============================================

let revealTimer: ReturnType<typeof setTimeout> | null = null

/** Lights up `range` briefly, without changing the page's DOM. */
export function flashRange(range: Range): void {
  if (!highlightsSupported()) return
  CSS.highlights.set(REVEAL_HIGHLIGHT, new Highlight(range))
  if (revealTimer) clearTimeout(revealTimer)
  revealTimer = setTimeout(() => {
    revealTimer = null
    CSS.highlights.delete(REVEAL_HIGHLIGHT)
  }, REVEAL_FLASH_MS)
}

/** The passage `quote` inside `root`, or null when it is not there now. */
export function findTextRange(root: HTMLElement, quote: string): Range | null {
  return rangeIn(indexText(root), quote)
}

function rectOf(range: Range): SelectionRect {
  const rect = range.getBoundingClientRect()
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

/**
 * Scrolls the passage into view and lights it up; false when it is not in
 * `root`. With `commentId`, the comment on it opens for editing.
 */
export function revealInElement(root: HTMLElement, quote: string, options: { commentId?: string } = {}): boolean {
  const range = findTextRange(root, quote)
  if (!range) return false
  const anchor = range.startContainer.parentElement
  anchor?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  flashRange(range)
  if (options.commentId) showCommentAt(options.commentId, () => rectOf(range))
  return true
}
