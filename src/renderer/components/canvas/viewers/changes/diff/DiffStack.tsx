/** Small diffs keep every file mounted; large diffs are browsed one file at a time. */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Info } from 'lucide-react'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { useTranslation } from '../../../../../i18n'
import { useViewerResources } from '../../../viewer-resources'
import { goToChunk, type DiffEditorHandle, type DiffLayout, type DiffSide } from './diff-editor'
import type { DiffPart, LoadedDiff } from './diff-content'
import { CARD_HEADER_HEIGHT, FileDiffCard, type CardGate } from './FileDiffCard'
import { StackContext, type StackContextValue } from './stack-context'
import { ReadBudget, diffChars, showOneFile } from './stack-policy'
import { IconButton } from '../shared/parts'
import type { ViewFile } from '../model/view-files'

export interface DiffStackHandle {
  /** Next or previous change, continuing into another file at the edge. */
  navigate(direction: 1 | -1): void
  showFile(key: string, options?: { focus?: boolean }): boolean
  withEditors(key: string, apply: (editors: DiffEditorHandle[]) => void, unavailable?: () => void): boolean
}

export interface StackAnchor {
  key: string
  offset: number
}

interface DiffStackProps {
  files: readonly ViewFile[]
  /** What the files were compared under; text sizes read for another one are not counted. */
  scope?: string
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
  anchor?: StackAnchor
  onAnchorChange: (anchor: StackAnchor) => void
  onCurrentChange?: (key: string | null) => void
  header?: ReactNode
  editPages?: Record<string, number>
  onEditPageChange?: (key: string, page: number) => void
}

type Pending =
  | { kind: 'nav'; key: string; direction: 1 | -1; fromEdge: boolean }
  | { kind: 'apply'; key: string; apply: (editors: DiffEditorHandle[]) => void; unavailable?: () => void }

const USER_SCROLL_EVENTS = ['wheel', 'touchstart'] as const

export const DiffStack = forwardRef<DiffStackHandle, DiffStackProps>(function DiffStack(props, ref) {
  const { files, anchor, onAnchorChange, onCurrentChange, onUnfold, folded, gateFor } = props
  const { t } = useTranslation()
  const resources = useViewerResources()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(() => anchor?.key ?? files[0]?.key ?? null)
  const selectedIndex = Math.max(0, files.findIndex((file) => file.key === selectedKey))
  const selected = files[selectedIndex]
  const [budget] = useState(() => new ReadBudget())
  const [, updateBudget] = useReducer((n: number) => n + 1, 0)
  const estimatedSingle = useMemo(() => showOneFile(files), [files])
  // While rendering, so the render that brings a new scope's files already prices them without the old scope's text.
  budget.setScope(props.scope ?? '')
  const single = estimatedSingle || budget.exceeds(files)
  const shown = single ? (selected ? [selected] : []) : files
  const latest = useRef({ files, single, selected, folded, gateFor, onUnfold, onAnchorChange, onCurrentChange, onLoad: props.onLoad, editPages: props.editPages, onEditPageChange: props.onEditPageChange })
  latest.current = { files, single, selected, folded, gateFor, onUnfold, onAnchorChange, onCurrentChange, onLoad: props.onLoad, editPages: props.editPages, onEditPageChange: props.onEditPageChange }
  const editors = useRef(new Map<string, DiffEditorHandle[]>())
  const pageNavigation = useRef(new Map<string, (direction: 1 | -1, fromEdge: boolean) => boolean>())
  const unavailableEditors = useRef(new Set<string>())
  const pending = useRef<Pending | null>(null)
  /** The file whose "Load diff" was clicked: should its read go over the budget, the one-file view shows it. */
  const requestedLoad = useRef<string | null>(null)
  const currentKey = useRef<string | null>(anchor?.key ?? null)
  const position = useRef<{ key: string; offset: number; focus?: boolean } | null>(anchor ?? null)
  const frame = useRef(0)

  const cardFor = useCallback((key: string) => scrollerRef.current?.querySelector<HTMLElement>(`[data-file-key="${CSS.escape(key)}"]`) ?? null, [])
  const place = useCallback(() => {
    frame.current = 0
    const target = position.current
    const scroller = scrollerRef.current
    const card = target ? cardFor(target.key) : null
    if (!target || !scroller || !card) return
    const offset = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top + target.offset
    if (Math.abs(offset) > 1) scroller.scrollBy({ top: offset })
    if (target.focus) {
      card.querySelector<HTMLElement>('header button')?.focus({ preventScroll: true })
      target.focus = false
    }
  }, [cardFor])
  const schedulePlace = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(place)
  }, [place])
  const selectFile = useCallback((key: string, focus = false) => {
    setSelectedKey(key)
    latest.current.onUnfold(key)
    position.current = { key, offset: 0, focus }
    currentKey.current = key
    latest.current.onAnchorChange({ key, offset: 0 })
    latest.current.onCurrentChange?.(key)
    schedulePlace()
  }, [schedulePlace])
  const loadFile = useCallback((key: string) => {
    requestedLoad.current = key
    latest.current.onLoad(key)
  }, [])

  const displayed = useRef({ single, key: selected?.key })
  useLayoutEffect(() => {
    const previous = displayed.current
    displayed.current = { single, key: selected?.key }
    if (pending.current && !files.some((file) => file.key === pending.current?.key)) pending.current = null
    if (selected && !files.some((file) => file.key === selectedKey)) {
      setSelectedKey(selected.key)
      position.current = { key: selected.key, offset: 0 }
      currentKey.current = selected.key
      onAnchorChange({ key: selected.key, offset: 0 })
      onCurrentChange?.(selected.key)
    }
    if (single && selected) {
      currentKey.current = selected.key
      onCurrentChange?.(selected.key)
      if (!previous.single || previous.key !== selected.key) {
        const focus = position.current?.key === selected.key ? position.current.focus : undefined
        position.current = anchor?.key === selected.key ? { ...anchor, focus } : { key: selected.key, offset: 0, focus }
        onAnchorChange({ key: position.current.key, offset: position.current.offset })
      }
    }
    schedulePlace()
  }, [files, single, selected?.key, selectedKey, schedulePlace, onCurrentChange, onAnchorChange, anchor])

  useEffect(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content) return
    const scope = resources.scope()
    const observer = scope.add(new ResizeObserver(schedulePlace))
    observer.observe(content)
    const release = () => {
      position.current = null
      pending.current = null
    }
    for (const type of USER_SCROLL_EVENTS) scroller.addEventListener(type, release, { passive: true })
    document.addEventListener('pointerdown', release, true)
    document.addEventListener('keydown', release, true)
    scope.add(() => {
      pending.current = null
      document.removeEventListener('pointerdown', release, true)
      document.removeEventListener('keydown', release, true)
      for (const type of USER_SCROLL_EVENTS) scroller.removeEventListener(type, release)
      cancelAnimationFrame(frame.current)
    })
    return () => scope.dispose()
  }, [resources, schedulePlace])

  const centerOn = useCallback((view: EditorView, pos: number) => {
    position.current = null
    view.focus()
    view.requestMeasure({
      read: () => {
        const scroller = scrollerRef.current
        if (!scroller || !view.dom.isConnected) return 0
        const block = view.lineBlockAt(pos)
        const box = scroller.getBoundingClientRect()
        return view.documentTop + block.top - box.top - box.height / 3
      },
      write: (delta) => { if (Math.abs(delta) > 1) scrollerRef.current?.scrollBy({ top: delta }) },
    })
  }, [])
  const enterCard = useCallback((handles: DiffEditorHandle[], direction: 1 | -1) => {
    const ordered = direction > 0 ? handles : [...handles].reverse()
    for (const handle of ordered) {
      if (goToChunk(handle, direction, true)) {
        centerOn(handle.nav, handle.nav.state.selection.main.head)
        return
      }
    }
    const handle = ordered[0]
    if (!handle) return
    handle.nav.dispatch({ selection: { anchor: 0 } })
    centerOn(handle.nav, 0)
  }, [centerOn])
  const navigateFrom = useCallback((startIndex: number, direction: 1 | -1) => {
    const list = latest.current.files
    for (let i = startIndex + direction; i >= 0 && i < list.length; i += direction) {
      const file = list[i]
      if (file.binary || latest.current.gateFor(file) || unavailableEditors.current.has(file.key)) continue
      pending.current = { kind: 'nav', key: file.key, direction, fromEdge: true }
      selectFile(file.key)
      const ready = editors.current.get(file.key)
      if (ready) {
        if (pageNavigation.current.get(file.key)?.(direction, true)) {
          if (pending.current?.kind === 'nav') pending.current.fromEdge = false
        } else {
          pending.current = null
          enterCard(ready, direction)
        }
      }
      return
    }
  }, [enterCard, selectFile])
  const navigate = useCallback((direction: 1 | -1) => {
    const list = latest.current.files
    if (list.length === 0) return
    position.current = null
    const focused = (document.activeElement as HTMLElement | null)?.closest?.('[data-file-key]')?.getAttribute('data-file-key')
    const key = focused ?? currentKey.current ?? latest.current.selected?.key
    const index = list.findIndex((file) => file.key === key)
    const handles = index >= 0 ? editors.current.get(list[index].key) : undefined
    if (!handles?.length) {
      navigateFrom(index < 0 && direction < 0 ? list.length : index, direction)
      return
    }
    let active = handles.findIndex((handle) => handle.nav.hasFocus)
    let fromEdge = false
    if (active < 0) {
      const top = scrollerRef.current?.getBoundingClientRect().top ?? 0
      active = Math.max(0, handles.findIndex((handle) => handle.nav.dom.getBoundingClientRect().bottom > top))
      const view = handles[active].nav
      const y = top - view.documentTop
      const pos = y <= 0 ? 0 : view.lineBlockAtHeight(y).from
      if (direction > 0 && pos === 0) fromEdge = true
      else view.dispatch({ selection: { anchor: direction > 0 ? pos - 1 : pos } })
    }
    for (let i = active; i >= 0 && i < handles.length; i += direction) {
      const handle = handles[i]
      if (goToChunk(handle, direction, i !== active || fromEdge)) {
        centerOn(handle.nav, handle.nav.state.selection.main.head)
        return
      }
    }
    pending.current = { kind: 'nav', key: list[index].key, direction, fromEdge: false }
    if (pageNavigation.current.get(list[index].key)?.(direction, false)) return
    pending.current = null
    navigateFrom(index, direction)
  }, [centerOn, navigateFrom])

  const applyToEditors = useCallback((waiting: Extract<Pending, { kind: 'apply' }>, handles: DiffEditorHandle[]) => {
    const view = handles[0].nav
    view.requestMeasure({
      read: () => null,
      // CodeMirror refuses dispatch during measurement; reveal only after the cycle has finished.
      write: () => queueMicrotask(() => {
        if (pending.current !== waiting || editors.current.get(waiting.key) !== handles) return
        pending.current = null
        position.current = null
        waiting.apply(handles)
      }),
    })
  }, [])
  const actions = useRef({ enterCard, navigateFrom, schedulePlace })
  actions.current = { enterCard, navigateFrom, schedulePlace }
  const stackValue = useMemo<StackContextValue>(() => ({
    admitContent(key, diff) {
      const { files, single, selected } = latest.current
      const requested = requestedLoad.current === key
      if (requested) requestedLoad.current = null
      const { admit, recheck } = budget.admit(key, diffChars(diff), { files, single, selectedKey: requested ? key : selected?.key })
      if (requested && recheck && !single) setSelectedKey(key)
      if (recheck) updateBudget()
      return admit
    },
    partPage(key) {
      return latest.current.editPages?.[key] ?? 0
    },
    onPartPageChange(key, page) {
      latest.current.onEditPageChange?.(key, page)
      position.current = { key, offset: 0 }
      latest.current.onAnchorChange({ key, offset: 0 })
      schedulePlace()
    },
    registerEditors(key, handles, navigatePage) {
      if (handles?.length) editors.current.set(key, handles)
      else editors.current.delete(key)
      if (navigatePage) pageNavigation.current.set(key, navigatePage)
      else pageNavigation.current.delete(key)
      if (handles === null) unavailableEditors.current.add(key)
      else unavailableEditors.current.delete(key)
      actions.current.schedulePlace()
      const waiting = pending.current
      if (!waiting || waiting.key !== key || handles === undefined) return
      if (waiting.kind === 'nav') {
        if (handles?.length && waiting.fromEdge && navigatePage?.(waiting.direction, true)) {
          waiting.fromEdge = false
          return
        }
        pending.current = null
        if (handles?.length) actions.current.enterCard(handles, waiting.direction)
        else actions.current.navigateFrom(latest.current.files.findIndex((file) => file.key === key), waiting.direction)
      } else if (handles?.length) {
        applyToEditors(waiting, handles)
      } else {
        pending.current = null
        console.warn('[ChangesView] Cannot reveal diff: file has no readable editor', key)
        waiting.unavailable?.()
      }
    },
    scrollParent() {
      const element = scrollerRef.current
      return element ? { element, topInset: CARD_HEADER_HEIGHT } : null
    },
  }), [applyToEditors, budget])

  useImperativeHandle(ref, () => ({
    navigate,
    showFile(key, options = {}) {
      if (!latest.current.files.some((file) => file.key === key)) return false
      pending.current = null
      selectFile(key, options.focus)
      return true
    },
    withEditors(key, apply, unavailable) {
      if (!latest.current.files.some((file) => file.key === key)) return false
      selectFile(key)
      const waiting: Extract<Pending, { kind: 'apply' }> = { kind: 'apply', key, apply, unavailable }
      pending.current = waiting
      const ready = editors.current.get(key)
      if (ready?.length) {
        applyToEditors(waiting, ready)
      } else if (unavailableEditors.current.has(key)) {
        pending.current = null
        console.warn('[ChangesView] Cannot reveal diff: file has no readable editor', key)
        unavailable?.()
      }
      return true
    },
  }), [navigate, selectFile, applyToEditors])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    let tracking = 0
    const track = () => {
      tracking = 0
      const state = latest.current
      const top = scroller.getBoundingClientRect().top
      for (const card of scroller.querySelectorAll<HTMLElement>('[data-file-key]')) {
        const rect = card.getBoundingClientRect()
        if (rect.bottom <= top + 1) continue
        const key = card.dataset.fileKey!
        if (!position.current) state.onAnchorChange({ key, offset: Math.max(0, Math.round(top - rect.top)) })
        if (currentKey.current !== key) {
          currentKey.current = key
          setSelectedKey(key)
          state.onCurrentChange?.(key)
        }
        break
      }
    }
    const onScroll = () => { if (!tracking) tracking = requestAnimationFrame(track) }
    const scope = resources.scope()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scope.add(() => scroller.removeEventListener('scroll', onScroll))
    scope.add(() => cancelAnimationFrame(tracking))
    onScroll()
    return () => scope.dispose()
  }, [resources])

  return (
    <StackContext.Provider value={stackValue}>
      <div className="flex h-full min-h-0 flex-col">
        {single && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2 text-[12px] text-muted-foreground" role="status">
            <Info size={15} className="hidden shrink-0 text-primary sm:block" aria-hidden />
            <span className="min-w-0 flex-1">{t('Large diff · Showing one file at a time')}</span>
            <span className="shrink-0 tabular-nums">{t('{{current}} of {{total}}', { current: selectedIndex + 1, total: files.length })}</span>
            <IconButton label={t('Previous file')} disabled={selectedIndex === 0} onClick={() => { pending.current = null; selectFile(files[selectedIndex - 1].key) }}><ChevronLeft size={16} /></IconButton>
            <IconButton label={t('Next file')} disabled={selectedIndex >= files.length - 1} onClick={() => { pending.current = null; selectFile(files[selectedIndex + 1].key) }}><ChevronRight size={16} /></IconButton>
          </div>
        )}
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-diff-scroll>
          <div ref={contentRef}>
            {props.header ?? <div className="h-2" />}
            {shown.map((file) => (
              <div key={file.key} className="px-2 py-1 sm:px-3 sm:py-1.5">
                <FileDiffCard
                  file={file}
                  folded={folded.has(file.key)}
                  onToggleFold={props.onToggleFold}
                  gate={gateFor(file)}
                  onLoad={loadFile}
                  load={props.load}
                  version={props.version}
                  layout={props.layout}
                  collapseUnchanged={props.collapseUnchanged}
                  actionsFor={props.actionsFor}
                  sideExtensions={props.sideExtensions}
                />
              </div>
            ))}
            <div className="h-24" />
          </div>
        </div>
      </div>
    </StackContext.Provider>
  )
})
