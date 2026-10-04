/**
 * "View changes" of one AI reply: the files it changed with its edit tools,
 * read-only — each Edit as a small diff of the fragment it replaced, each
 * Write as the whole text it wrote. No repository, scope, staging or commit.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { FileCode2, Info, PanelRight } from 'lucide-react'
import type { Extension } from '@codemirror/state'
import type { TabState, ChangesSource } from '../../../../../services/canvas-lifecycle'
import { useCanvasActions } from '../../../../../hooks/useCanvasLifecycle'
import { useTranslation } from '../../../../../i18n'
import { useChatStore } from '../../../../../stores/chat.store'
import { useSpaceStore } from '../../../../../stores/space.store'
import { useChangesViewPrefs } from '../../../../../stores/changes-view-prefs.store'
import { extractFileChanges } from '../../../../diff'
import { referenceExtension, revealMessage } from '../../../../references'
import type { DiffReferenceSource } from '../../../../../../shared/types/content-reference'
import { DiffStack, type DiffStackHandle, type StackAnchor } from '../diff/DiffStack'
import { DiffTools } from '../diff/DiffTools'
import { diffFromMessage, type DiffPart, type LoadedDiff } from '../diff/diff-content'
import { unfoldReferencedLines, type DiffSide } from '../diff/diff-editor'
import { FilePanel } from '../panel/FilePanel'
import { FileDrawer } from '../panel/FileDrawer'
import { LoadErrorState, LoadingState } from '../shared/EmptyStates'
import { formatTime } from '../shared/format'
import { IconButton, DiffStat } from '../shared/parts'
import { changesLayout, layoutStep, mainWidth, MIN_SIDE_BY_SIDE_WIDTH, useContainerWidth } from '../shared/use-container-width'
import { useViewMemory } from '../shared/use-view-memory'
import { useChangesKeys } from '../shared/use-changes-keys'
import { matchesFilter } from '../model/file-filter'
import { totalsOf, type ViewFile } from '../model/view-files'
import { messageViewFiles } from './message-changes'

type MessageSource = Extract<ChangesSource, { kind: 'message' }>

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; files: ViewFile[] }
  | { status: 'error'; message: string }

const noGate = () => null

export function MessageChangesView({ tab, source }: { tab: TabState; source: MessageSource }) {
  const { t, i18n } = useTranslation()
  // A viewer instance shows one tab for its whole life; effects read its id here.
  const tabIdRef = useRef(tab.id)
  const { openFile, consumeReveal } = useCanvasActions()
  const [memory, update] = useViewMemory(tab)
  const prefs = useChangesViewPrefs()
  const rootRef = useRef<HTMLDivElement>(null)
  const stackRef = useRef<DiffStackHandle>(null)
  const panelToggleRef = useRef<HTMLButtonElement>(null)
  const width = useContainerWidth(rootRef, (w) => layoutStep(w, prefs.panelOpen))
  const layout = changesLayout(width)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [currentKey, setCurrentKey] = useState<string | null>(memory.stackAnchor?.key ?? null)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const folder = useSpaceStore((s) => (s.currentSpace?.id === source.spaceId ? s.currentSpace.workingDir ?? s.currentSpace.path : null))

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    useChatStore.getState().loadMessageThoughts(source.spaceId, source.conversationId, source.messageId).then(
      (thoughts) => {
        if (!cancelled) setState({ status: 'ready', files: messageViewFiles(extractFileChanges(thoughts), folder) })
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    )
    return () => {
      cancelled = true
    }
  }, [source.spaceId, source.conversationId, source.messageId, folder, attempt])

  useEffect(() => {
    const active = document.activeElement
    if (!active || active === document.body) rootRef.current?.focus({ preventScroll: true })
  }, [])

  const files = useMemo(() => (state.status === 'ready' ? state.files : []), [state])
  const shown = useMemo(() => files.filter((f) => matchesFilter(f.path, memory.filter)), [files, memory.filter])
  const totals = useMemo(() => totalsOf(files), [files])
  const folded = useMemo(() => new Set(memory.folded), [memory.folded])
  const allFolded = useMemo(() => shown.length > 0 && shown.every((f) => folded.has(f.key)), [shown, folded])
  const toggleFold = useCallback((key: string) => {
    update({ folded: memory.folded.includes(key) ? memory.folded.filter((k) => k !== key) : [...memory.folded, key] })
  }, [memory, update])
  const unfold = useCallback((key: string) => {
    if (memory.folded.includes(key)) update({ folded: memory.folded.filter((k) => k !== key) })
  }, [memory, update])
  const foldAll = (fold: boolean) => {
    const keys = new Set(shown.map((f) => f.key))
    update({ folded: fold ? [...new Set([...memory.folded, ...keys])] : memory.folded.filter((k) => !keys.has(k)) })
  }
  const loadDiff = useCallback(async (file: ViewFile): Promise<LoadedDiff> => diffFromMessage(file), [])
  const setFilter = useCallback((filter: string) => update({ filter }), [update])

  // A reply's diffs are fragments (or files as they were then), so references carry the
  // text only and the AI reads the file to find it.
  const compareLabel = t('Changes in the reply at {{time}}', { time: formatTime(source.replyAt, i18n.language) })
  const sideExtensions = useCallback((file: ViewFile, _part: DiffPart, side: DiffSide, unified: boolean): Extension[] => {
    const sourceFor = (which: DiffSide) => (): DiffReferenceSource => ({ kind: 'diff', path: file.absPath, side: which, compareLabel })
    return [unified
      ? referenceExtension({ source: sourceFor('after'), beforeSource: sourceFor('before'), lines: false, onLines: unfoldReferencedLines })
      : referenceExtension({ source: sourceFor(side), lines: false, onLines: unfoldReferencedLines })]
  }, [compareLabel])
  const onAnchorChange = useCallback((anchor: StackAnchor) => {
    memory.stackAnchor = anchor
  }, [memory])

  const sideBySideFits = width === 0 || mainWidth(width, prefs.panelOpen) >= MIN_SIDE_BY_SIDE_WIDTH
  const diffLayout = prefs.sideBySide && sideBySideFits ? 'split' : 'unified'

  const openInEditor = useCallback((file: ViewFile) => {
    void openFile(file.absPath)
  }, [openFile])
  const cardActions = useCallback((file: ViewFile) => (
    <IconButton size="sm" label={t('Open in editor')} onClick={() => openInEditor(file)}><FileCode2 size={14} /></IconButton>
  ), [openInEditor, t])
  const rowActions = useCallback((file: ViewFile) => (
    <IconButton size="sm" label={t('Open file')} onClick={() => openInEditor(file)}><FileCode2 size={13} /></IconButton>
  ), [openInEditor, t])

  // Shown once the stack is on screen and holds the file; asking renders once more, so this runs.
  const pendingShow = useRef<{ key: string; focus: boolean } | null>(null)
  const [, renderAgain] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const pending = pendingShow.current
    if (pending && stackRef.current?.showFile(pending.key, { focus: pending.focus })) pendingShow.current = null
  })
  const openFromPanel = useCallback((file: ViewFile) => {
    // Picked in the drawer: the card takes the focus the drawer had.
    pendingShow.current = { key: file.key, focus: drawerOpen }
    setDrawerOpen(false)
    renderAgain()
  }, [drawerOpen])

  useChangesKeys(rootRef, {
    onNavigate: (direction) => stackRef.current?.navigate(direction),
    onEscape: (typing) => {
      if (drawerOpen) {
        setDrawerOpen(false)
        return true
      }
      if (!typing) return false
      // Out of the field, back to the view; the canvas stays open.
      rootRef.current?.focus({ preventScroll: true })
      return true
    },
    onStep: () => false,
  })

  // References from a reply carry no repository; they open the file itself, so a reveal
  // asked of this tab only brings the file into view.
  const reveal = tab.reveal
  useEffect(() => {
    if (!reveal || state.status !== 'ready') return
    consumeReveal(tabIdRef.current, reveal.seq)
    const file = reveal.path ? files.find((f) => f.absPath === reveal.path) : undefined
    if (!file) return
    pendingShow.current = { key: file.key, focus: false }
    renderAgain()
  }, [reveal, state.status, files, consumeReveal])

  const tools = (
    <DiffTools
      onPrevious={() => stackRef.current?.navigate(-1)}
      onNext={() => stackRef.current?.navigate(1)}
      sideBySide={prefs.sideBySide}
      sideBySideFits={sideBySideFits}
      onSideBySide={prefs.setSideBySide}
      collapseUnchanged={prefs.collapseUnchanged}
      onCollapseUnchanged={prefs.setCollapseUnchanged}
      allFolded={allFolded}
      onFoldAll={foldAll}
      compact={layout.compactTools}
      minimal={layout.stacked}
    />
  )

  const banner = useMemo(() => (
    <div className="mx-2 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-secondary px-3 py-1.5 text-[12.5px] text-muted-foreground sm:mx-3">
      <Info size={14} className="shrink-0 text-faint-foreground" aria-hidden />
      <span title={t('Only edits made with file tools are shown. Changes made by commands aren\'t included.')}>
        {t('{{count}} files edited in this reply · Read-only', { count: files.length })}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => void revealMessage(source.conversationId, source.messageId)}
        className="font-medium text-primary hover:underline"
      >
        {t('Go to reply')}
      </button>
    </div>
  ), [files.length, source.conversationId, source.messageId, t])

  const panel = state.status === 'ready' && (
    <FilePanel
      groups={[{ id: 'changes', files: shown }]}
      hiddenGenerated={0}
      onShowGenerated={noop}
      filter={memory.filter}
      onFilterChange={setFilter}
      tree={prefs.tree}
      onTreeChange={prefs.setTree}
      hideGenerated={false}
      onHideGeneratedChange={noop}
      currentKey={currentKey}
      onOpenFile={openFromPanel}
      rowActions={rowActions}
      touch={layout.stacked}
      focusFilter={!layout.dockedPanel}
      showGeneratedToggle={false}
    />
  )

  let page
  if (state.status === 'loading') page = <LoadingState />
  else if (state.status === 'error') page = <LoadErrorState message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
  else if (files.length === 0) {
    page = (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-subtle-foreground">
        {t('This reply\'s edits are no longer available.')}
      </div>
    )
  } else {
    page = (
      <DiffStack
        ref={stackRef}
        files={shown}
        layout={diffLayout}
        collapseUnchanged={prefs.collapseUnchanged}
        folded={folded}
        onToggleFold={toggleFold}
        onUnfold={unfold}
        gateFor={noGate}
        onLoad={noop}
        load={loadDiff}
        version={0}
        actionsFor={cardActions}
        sideExtensions={sideExtensions}
        anchor={memory.stackAnchor}
        onAnchorChange={onAnchorChange}
        onCurrentChange={setCurrentKey}
        header={banner}
      />
    )
  }

  return (
    <div ref={rootRef} tabIndex={-1} className="flex h-full min-h-0 min-w-0 flex-col bg-background outline-none">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{source.title}</span>
        {state.status === 'ready' && <DiffStat additions={totals.additions} deletions={totals.deletions} />}
        <span className="flex-1" />
        {tools}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        {layout.dockedPanel ? (
          <IconButton ref={panelToggleRef} label={t('File list')} pressed={prefs.panelOpen} onClick={() => prefs.setPanelOpen(!prefs.panelOpen)}>
            <PanelRight size={15} />
          </IconButton>
        ) : (
          <IconButton ref={panelToggleRef} label={t('File list')} aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={() => setDrawerOpen((v) => !v)}>
            <PanelRight size={15} />
          </IconButton>
        )}
      </div>
      <div className="relative flex min-h-0 flex-1">
        <section className="relative min-w-0 flex-1" aria-label={compareLabel}>{page}</section>
        {panel && layout.dockedPanel && prefs.panelOpen && (
          <aside className="flex min-h-0 shrink-0 flex-col border-l border-border" style={{ width: layout.panelWidth }} aria-label={t('File list')}>
            {panel}
          </aside>
        )}
        {panel && !layout.dockedPanel && drawerOpen && (
          <FileDrawer fullWidth={layout.stacked} onClose={() => setDrawerOpen(false)} opener={panelToggleRef}>
            {panel}
          </FileDrawer>
        )}
      </div>
    </div>
  )
}

function noop() {}
