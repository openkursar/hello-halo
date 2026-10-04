/**
 * The changed files stacked one under another, virtualized: only cards near
 * the viewport are rendered, and at most MAX_LIVE_EDITORS of them hold
 * editors. Scrolling fast shows placeholders instead of cards, so flinging
 * through a long list reads no files. Owns change navigation (F7 / Shift+F7
 * across files) and jumping to a file or a line.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { useViewerResources } from '../../../viewer-resources'
import { EditorSlots } from './editor-slots'
import { goToChunk, type DiffEditorHandle, type DiffLayout, type DiffSide } from './diff-editor'
import type { DiffPart, LoadedDiff } from './diff-content'
import { CARD_HEADER_HEIGHT, FileDiffCard, estimateCardHeight, type CardGate } from './FileDiffCard'
import { StackContext, type StackContextValue } from './stack-context'
import type { ViewFile } from '../model/view-files'

export interface DiffStackHandle {
  /** Next (1) or previous (-1) change, moving on to the next file when this one has no more. */
  navigate(direction: 1 | -1): void
  /**
   * Scrolls a file's card to the top, unfolding it; with `focus`, its header
   * takes keyboard focus. False when the file is not in this stack.
   */
  showFile(key: string, options?: { focus?: boolean }): boolean
  /**
   * Brings a file's card into view and calls `apply` with its editors once they
   * exist, to reveal a place in them (the card mounts its editors only near the
   * viewport). False when the file is not in this stack.
   */
  withEditors(key: string, apply: (editors: DiffEditorHandle[]) => void): boolean
}

export interface StackAnchor {
  key: string
  offset: number
}

interface DiffStackProps {
  files: readonly ViewFile[]
  layout: DiffLayout
  collapseUnchanged: boolean
  folded: ReadonlySet<string>
  onToggleFold: (key: string) => void
  onUnfold: (key: string) => void
  gateFor: (file: ViewFile) => CardGate
  onLoad: (key: string) => void
  load: (file: ViewFile, signal: AbortSignal) => Promise<LoadedDiff>
  version: number
  actionsFor?: (file: ViewFile) => ReactNode
  sideExtensions?: (file: ViewFile, part: DiffPart, side: DiffSide, unified: boolean) => Extension[]
  /** Where to start; read once, when the stack mounts. */
  anchor?: StackAnchor
  onAnchorChange: (anchor: StackAnchor) => void
  onCurrentChange?: (key: string | null) => void
  header?: ReactNode
}

/** What every card is rendered with; a new object re-renders every card on screen. */
type ItemContext = Pick<DiffStackProps,
  'folded' | 'onToggleFold' | 'gateFor' | 'onLoad' | 'load' | 'version' | 'layout' | 'collapseUnchanged' | 'actionsFor' | 'sideExtensions' | 'header'>

type Pending =
  | { kind: 'nav'; key: string; direction: 1 | -1; deadline: number }
  | { kind: 'apply'; key: string; apply: (editors: DiffEditorHandle[]) => void; deadline: number }

const PENDING_MS = 5_000

/** Scroll speeds (pixels per 100 ms, as Virtuoso measures them) to start and stop showing placeholders. */
const SEEK_ENTER = 400
const SEEK_EXIT = 80
/**
 * How long a programmatic scroll (a jump to a file, centering a change, a
 * reveal) keeps placeholders off: such a scroll is fast by nature, and
 * placeholders would land it on estimated heights or unmount the card it
 * brought into view, focus and all.
 */
const JUMP_MS = 1_000
/**
 * After a jump to a file, its card is kept at the top, frame by frame, while the editors
 * around it measure their lines (the list moves cards as heights change). It stops once the
 * card stayed put, at the same height, for a few frames and a short while — or when the
 * user scrolls, or at the latest after SETTLE_MAX_MS.
 */
const SETTLE_MAX_MS = 2_500
const SETTLE_QUIET_FRAMES = 3
const SETTLE_QUIET_MS = 400
const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

const VIRTUOSO_COMPONENTS = {
  Header: ({ context }: { context?: ItemContext }) => <>{context?.header ?? <div className="h-2" />}</>,
  Footer: () => <div className="h-24" />,
  ScrollSeekPlaceholder: ({ height }: { height: number }) => (
    <div className="px-2 py-1 sm:px-3 sm:py-1.5" style={{ height }} aria-hidden>
      <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-2 sm:h-9">
          {/* Where the fold button sits, so the name's bar lines up with the name. */}
          <span className="h-10 w-10 shrink-0 sm:h-6 sm:w-6" />
          <span className="h-2 w-40 max-w-[40%] rounded-full bg-muted" />
        </div>
        <div className="diff-skeleton min-h-0 flex-1" />
      </div>
    </div>
  ),
}

function renderItem(_index: number, file: ViewFile, context: ItemContext) {
  return (
    <div className="px-2 py-1 sm:px-3 sm:py-1.5">
      <FileDiffCard
        file={file}
        folded={context.folded.has(file.key)}
        onToggleFold={context.onToggleFold}
        gate={context.gateFor(file)}
        onLoad={context.onLoad}
        load={context.load}
        version={context.version}
        layout={context.layout}
        collapseUnchanged={context.collapseUnchanged}
        actionsFor={context.actionsFor}
        sideExtensions={context.sideExtensions}
      />
    </div>
  )
}

export const DiffStack = forwardRef<DiffStackHandle, DiffStackProps>(function DiffStack(props, ref) {
  const { files, anchor, onAnchorChange, onCurrentChange, onUnfold, folded, gateFor } = props
  const resources = useViewerResources()
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const jumpUntil = useRef(0)
  const scrollSeek = useMemo(() => ({
    enter: (velocity: number) => Date.now() > jumpUntil.current && Math.abs(velocity) > SEEK_ENTER,
    exit: (velocity: number) => Math.abs(velocity) < SEEK_EXIT,
  }), [])
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const scrollerRef = useRef(scroller)
  scrollerRef.current = scroller
  const holdSeek = useCallback(() => {
    jumpUntil.current = Date.now() + JUMP_MS
  }, [])
  const jumpTo = useCallback((index: number) => {
    holdSeek()
    virtuosoRef.current?.scrollToIndex({ index, align: 'start' })
  }, [holdSeek])
  /**
   * Cards not rendered for a while are placed by heights they had before (or by
   * estimates), and an editor's height changes as it measures its lines: once the
   * card is rendered, its top is kept at the top of the view until things settle.
   * Only for a plain "show this file" — a reveal or a change navigation places
   * itself by the editor once it exists.
   */
  const stopSettling = useRef<(() => void) | null>(null)
  /** `then` runs once the card stays put (or the time is up), not when the user took over. */
  const settleAt = useCallback((index: number, then?: () => void) => {
    stopSettling.current?.()
    if (!scroller) return
    const deadline = Date.now() + SETTLE_MAX_MS
    let frame = 0
    let quietSince = Date.now()
    let quietFrames = 0
    let lastHeight = -1
    const unsettle = () => {
      quietSince = Date.now()
      quietFrames = 0
    }
    const stop = () => {
      cancelAnimationFrame(frame)
      for (const type of USER_SCROLL_EVENTS) scroller.removeEventListener(type, stop)
      if (stopSettling.current === stop) stopSettling.current = null
    }
    const done = () => {
      stop()
      then?.()
    }
    const settle = () => {
      if (!scroller.isConnected) return stop()
      if (Date.now() > deadline) return done()
      holdSeek()
      const item = scroller.querySelector<HTMLElement>(`[data-index="${index}"]`)
      if (!item) {
        unsettle()
        virtuosoRef.current?.scrollToIndex({ index, align: 'start' })
      } else {
        const rect = item.getBoundingClientRect()
        const offset = rect.top - scroller.getBoundingClientRect().top
        if (Math.abs(offset) > 1) {
          unsettle()
          scroller.scrollBy({ top: offset })
        } else if (rect.height !== lastHeight) {
          unsettle()
        } else if (++quietFrames >= SETTLE_QUIET_FRAMES && Date.now() - quietSince >= SETTLE_QUIET_MS) {
          return done()
        }
        lastHeight = rect.height
      }
      frame = requestAnimationFrame(settle)
    }
    for (const type of USER_SCROLL_EVENTS) scroller.addEventListener(type, stop, { passive: true })
    stopSettling.current = stop
    frame = requestAnimationFrame(settle)
  }, [scroller, holdSeek])
  const filesRef = useRef(files)
  filesRef.current = files
  const foldedRef = useRef(folded)
  foldedRef.current = folded
  const editors = useRef(new Map<string, DiffEditorHandle[]>())
  const pending = useRef<Pending | null>(null)
  const currentKey = useRef<string | null>(null)

  const [slots] = useState(() => new EditorSlots())
  const [heights] = useState(() => new Map<string, number>())
  const visibility = useRef(new Map<Element, (visible: boolean) => void>())
  const measured = useRef(new Map<Element, string>())
  const observers = useRef<{ intersection: IntersectionObserver | null; resize: ResizeObserver | null }>({ intersection: null, resize: null })

  // One visibility observer and one size observer for every card.
  useEffect(() => {
    if (!scroller) return
    const scope = resources.scope()
    const intersection = scope.add(new IntersectionObserver((entries) => {
      for (const entry of entries) visibility.current.get(entry.target)?.(entry.isIntersecting)
    }, { root: scroller }))
    const resize = scope.add(new ResizeObserver((entries) => {
      for (const entry of entries) {
        const key = measured.current.get(entry.target)
        if (key) heights.set(key, entry.contentRect.height)
      }
    }))
    for (const element of visibility.current.keys()) intersection.observe(element)
    for (const element of measured.current.keys()) resize.observe(element)
    observers.current = { intersection, resize }
    scope.add(() => {
      observers.current = { intersection: null, resize: null }
    })
    return () => scope.dispose()
  }, [scroller, resources, heights])

  const centerOn = useCallback((view: EditorView, pos: number) => {
    view.focus()
    const place = () => {
      if (!scroller || !view.dom.isConnected) return
      const block = view.lineBlockAt(pos)
      const box = scroller.getBoundingClientRect()
      const delta = view.documentTop + block.top - box.top - box.height / 3
      if (Math.abs(delta) <= 1) return
      holdSeek()
      scroller.scrollBy({ top: delta })
    }
    // At once, so a card a jump left out of view is back before the list unmounts it; again
    // once the editor has measured the lines it now shows.
    place()
    requestAnimationFrame(place)
  }, [scroller, holdSeek])

  /** Lands on the first (1) or last (-1) change of a card; a card with no chunks (a new file) is a stop of its own. */
  const enterCard = useCallback((handles: DiffEditorHandle[], direction: 1 | -1) => {
    const ordered = direction > 0 ? handles : [...handles].reverse()
    for (const handle of ordered) {
      if (goToChunk(handle, direction, true)) {
        centerOn(handle.nav, handle.nav.state.selection.main.head)
        return
      }
    }
    const handle = ordered[0]
    handle.nav.dispatch({ selection: { anchor: 0 } })
    centerOn(handle.nav, 0)
  }, [centerOn])

  const navigateFrom = useCallback((startIndex: number, direction: 1 | -1) => {
    const list = filesRef.current
    for (let i = startIndex + direction; i >= 0 && i < list.length; i += direction) {
      const file = list[i]
      if (file.binary || gateFor(file)) continue
      if (foldedRef.current.has(file.key)) onUnfold(file.key)
      const ready = editors.current.get(file.key)
      if (ready) {
        enterCard(ready, direction)
        return
      }
      pending.current = { kind: 'nav', key: file.key, direction, deadline: Date.now() + PENDING_MS }
      jumpTo(i)
      return
    }
  }, [enterCard, gateFor, onUnfold, jumpTo])

  const navigate = useCallback((direction: 1 | -1) => {
    const list = filesRef.current
    if (list.length === 0) return
    stopSettling.current?.()
    const focused = (document.activeElement as HTMLElement | null)?.closest?.('[data-file-key]')?.getAttribute('data-file-key') ?? null
    const key = focused ?? currentKey.current
    const index = key === null ? -1 : list.findIndex((file) => file.key === key)
    const handles = index >= 0 ? editors.current.get(list[index].key) : undefined
    if (!handles) {
      navigateFrom(index < 0 && direction < 0 ? list.length : index, direction)
      return
    }
    // A card with several fragments (a reply's edits) moves through them in order. When the
    // cursor is not in the card yet, start from the line at the top of the view.
    let active = handles.findIndex((handle) => handle.nav.hasFocus)
    let fromEdge = false
    if (active < 0) {
      const top = scroller?.getBoundingClientRect().top ?? 0
      active = Math.max(0, handles.findIndex((handle) => handle.nav.dom.getBoundingClientRect().bottom > top))
      const view = handles[active].nav
      const y = top - view.documentTop
      const pos = y <= 0 ? 0 : view.lineBlockAtHeight(y).from
      if (direction > 0 && pos === 0) {
        fromEdge = true
      } else {
        // One before the top line, so a change starting on it still counts as next.
        view.dispatch({ selection: { anchor: direction > 0 ? pos - 1 : pos } })
      }
    }
    for (let i = active; i >= 0 && i < handles.length; i += direction) {
      const handle = handles[i]
      if (goToChunk(handle, direction, i !== active || fromEdge)) {
        centerOn(handle.nav, handle.nav.state.selection.main.head)
        return
      }
    }
    navigateFrom(index, direction)
  }, [centerOn, navigateFrom, scroller])

  /**
   * A jump lands by the list's own idea of the heights above, which can lag behind an
   * editor there measuring its lines: a card it left out of view goes back to the top at
   * once, before the list unmounts it and whatever was to be shown in it.
   */
  const keepInView = useCallback((key: string) => {
    const card = scroller?.querySelector<HTMLElement>(`[data-file-key="${CSS.escape(key)}"]`)
    if (!scroller || !card) return
    const box = scroller.getBoundingClientRect()
    const rect = card.getBoundingClientRect()
    if (rect.bottom > box.top && rect.top < box.bottom) return
    holdSeek()
    scroller.scrollBy({ top: rect.top - box.top })
  }, [scroller, holdSeek])

  // The context stays the same object for the stack's life: cards key their slot and
  // editor effects on it, so a new one would rebuild every editor on screen.
  const actions = useRef({ enterCard, navigateFrom, keepInView, settleAt })
  actions.current = { enterCard, navigateFrom, keepInView, settleAt }
  const stackValue = useMemo<StackContextValue>(() => ({
    slots,
    heights,
    observe(element, onVisible) {
      visibility.current.set(element, onVisible)
      observers.current.intersection?.observe(element)
      return () => {
        visibility.current.delete(element)
        observers.current.intersection?.unobserve(element)
      }
    },
    measure(element, key) {
      measured.current.set(element, key)
      observers.current.resize?.observe(element)
      return () => {
        measured.current.delete(element)
        observers.current.resize?.unobserve(element)
      }
    },
    registerEditors(key, handles) {
      if (handles) editors.current.set(key, handles)
      else editors.current.delete(key)
      const waiting = pending.current
      if (!waiting || waiting.key !== key || handles === undefined) return
      pending.current = null
      if (Date.now() > waiting.deadline) return
      if (waiting.kind === 'nav') {
        if (handles) actions.current.enterCard(handles, waiting.direction)
        else actions.current.navigateFrom(filesRef.current.findIndex((file) => file.key === key), waiting.direction)
      } else if (handles) {
        // Shown once the jump has settled: the list may still move the card, or mount it
        // again with new editors, while the heights around it are measured.
        actions.current.keepInView(key)
        actions.current.settleAt(filesRef.current.findIndex((file) => file.key === key), () => {
          const current = editors.current.get(key)
          if (current) {
            holdSeek()
            waiting.apply(current)
          } else {
            pending.current = { ...waiting, deadline: Date.now() + PENDING_MS }
          }
        })
      }
    },
    scrollParent() {
      const element = scrollerRef.current
      return element ? { element, topInset: CARD_HEADER_HEIGHT } : null
    },
  }), [slots, heights, holdSeek])

  useImperativeHandle(ref, () => ({
    navigate,
    showFile(key, options = {}) {
      const index = filesRef.current.findIndex((file) => file.key === key)
      if (index < 0) return false
      if (foldedRef.current.has(key)) onUnfold(key)
      jumpTo(index)
      settleAt(index)
      // The card may mount only once the scroll gets there.
      const focusHeader = (frames: number) => {
        const button = scroller?.querySelector<HTMLElement>(`[data-file-key="${CSS.escape(key)}"] header button`)
        if (button) button.focus({ preventScroll: true })
        else if (frames > 0) requestAnimationFrame(() => focusHeader(frames - 1))
      }
      if (options.focus) requestAnimationFrame(() => focusHeader(10))
      return true
    },
    withEditors(key, apply) {
      const index = filesRef.current.findIndex((file) => file.key === key)
      if (index < 0) return false
      stopSettling.current?.()
      if (foldedRef.current.has(key)) onUnfold(key)
      const ready = editors.current.get(key)
      if (ready) {
        holdSeek()
        apply(ready)
        return true
      }
      pending.current = { kind: 'apply', key, apply, deadline: Date.now() + PENDING_MS }
      jumpTo(index)
      return true
    },
  }), [navigate, onUnfold, scroller, jumpTo, settleAt, holdSeek])

  // Where the user is: the card at the top, for the tab's memory and the file list's highlight.
  useEffect(() => {
    if (!scroller) return
    let frame = 0
    const track = () => {
      frame = 0
      const top = scroller.getBoundingClientRect().top
      for (const item of scroller.querySelectorAll<HTMLElement>('[data-index]')) {
        const rect = item.getBoundingClientRect()
        if (rect.bottom <= top + 1) continue
        const file = filesRef.current[Number(item.dataset.index)]
        if (!file) break
        onAnchorChange({ key: file.key, offset: Math.max(0, Math.round(top - rect.top)) })
        if (currentKey.current !== file.key) {
          currentKey.current = file.key
          onCurrentChange?.(file.key)
        }
        break
      }
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(track)
    }
    const scope = resources.scope()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scope.add(() => scroller.removeEventListener('scroll', onScroll))
    scope.add(() => cancelAnimationFrame(frame))
    onScroll()
    return () => scope.dispose()
  }, [scroller, resources, onAnchorChange, onCurrentChange])

  // Cards not shown yet are laid out by their own estimates rather than by the first card's
  // height, so a jump far down the list lands where it aims. Read once, at mount.
  const [heightEstimates] = useState(() => files.map((file) => estimateCardHeight(file, folded.has(file.key), gateFor(file), props.collapseUnchanged)))

  const [initialLocation] = useState(() => {
    const index = anchor ? files.findIndex((file) => file.key === anchor.key) : -1
    return index >= 0 ? { index, align: 'start' as const, offset: anchor?.offset ?? 0 } : 0
  })

  const { onToggleFold, onLoad, load, version, layout, collapseUnchanged, actionsFor, sideExtensions, header } = props
  const context = useMemo<ItemContext>(
    () => ({ folded, onToggleFold, gateFor, onLoad, load, version, layout, collapseUnchanged, actionsFor, sideExtensions, header }),
    [folded, onToggleFold, gateFor, onLoad, load, version, layout, collapseUnchanged, actionsFor, sideExtensions, header]
  )

  return (
    <StackContext.Provider value={stackValue}>
      <Virtuoso
        ref={virtuosoRef}
        scrollerRef={(element) => setScroller(element instanceof HTMLElement ? element : null)}
        className="h-full"
        data={files as ViewFile[]}
        context={context}
        computeItemKey={(_index, file) => file.key}
        increaseViewportBy={{ top: 400, bottom: 800 }}
        heightEstimates={heightEstimates}
        // A card changes height in place as its editor measures the lines it shows; measured at
        // once, the list's offsets stay true, so jumps land where they aim.
        skipAnimationFrameInResizeObserver
        initialTopMostItemIndex={initialLocation}
        scrollSeekConfiguration={scrollSeek}
        components={VIRTUOSO_COMPONENTS}
        itemContent={renderItem}
      />
    </StackContext.Provider>
  )
})
