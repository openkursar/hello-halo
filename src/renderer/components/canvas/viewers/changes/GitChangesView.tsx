/**
 * The changes view of a space's Git repositories: top bar, the "Changes",
 * "Graph" and "Overview & review" sub-pages, the detail page opened from the
 * overview, and the file list with the commit box.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { FileCode2, Loader2, Minus, PanelRight, Plus, Undo2 } from 'lucide-react'
import { useStore } from 'zustand'
import type { Extension } from '@codemirror/state'
import type { TabState, ChangesSource, RevealRequest } from '../../../../services/canvas-lifecycle'
import { useCanvasActions } from '../../../../hooks/useCanvasLifecycle'
import { useConfirmDialog } from '../../../../hooks/useConfirmDialog'
import { api } from '../../../../api'
import { useTranslation } from '../../../../i18n'
import { holdArtifactSpace } from '../../../../services/artifact-space-holds'
import { useChangesViewPrefs } from '../../../../stores/changes-view-prefs.store'
import { useNotificationStore } from '../../../../stores/notification.store'
import { useSpaceStore } from '../../../../stores/space.store'
import { useViewerResources } from '../../viewer-resources'
import {
  focusCommentCard,
  notifyRevealOutcome,
  referenceExtension,
  relocateLines,
  revealFileAt,
  revealInEditor,
  type FileLinkTarget,
} from '../../../references'
import type { DiffReferenceSource } from '../../../../../shared/types/content-reference'
import type { GitReviewRecord } from '../../../../../shared/types/git'
import type { DetailState, StoredCompareScope } from '../../../../types/changes-view'
import { createGitChangesController, type GitChangesController, type GitChangesState } from './state/git-changes-store'
import { describeGitError, gitErrorMessage, type GitErrorText } from './state/git-errors'
import { DiffStack, type DiffStackHandle, type StackAnchor } from './diff/DiffStack'
import { DiffTools } from './diff/DiffTools'
import { NewChangesBar } from './diff/NewChangesBar'
import { diffFromGit, type DiffPart, type LoadedDiff } from './diff/diff-content'
import { expandCollapsedAt, originalLines, revealBeforeInUnified, unfoldReferencedLines, type DiffEditorHandle, type DiffSide } from './diff/diff-editor'
import type { CardGate } from './diff/FileDiffCard'
import { TopBar } from './top-bar/TopBar'
import { GitGraphPage } from './graph/GitGraphPage'
import { FilePanel } from './panel/FilePanel'
import { FileDrawer } from './panel/FileDrawer'
import { ResizableFilePanel } from './panel/ResizableFilePanel'
import { createPathOrder, inPanelOrder, type PanelGroup, type PanelGroupId } from './panel/panel-rows'
import { CommitBox } from './commit/CommitBox'
import { DetailBar } from './overview/DetailBar'
import { OverviewPage } from './overview/OverviewPage'
import { detailAt, detailFiles, filesMentionedIn, itemIndexOf, openDetail, stepDetail } from './overview/detail-nav'
import { ReviewSection } from './review/ReviewSection'
import { ChangedSinceCounter } from './review/changed-since'
import { LoadErrorState, LoadingState, NoChangesState, NoGitState, NoRepositoryState } from './shared/EmptyStates'
import { IconButton } from './shared/parts'
import { changesLayout, layoutStep, mainWidth, MIN_SIDE_BY_SIDE_WIDTH, useContainerWidth } from './shared/use-container-width'
import { useViewMemory } from './shared/use-view-memory'
import { useChangesKeys } from './shared/use-changes-keys'
import { matchesFilter } from './model/file-filter'
import { isLargeDiff, totalsOf, viewFileFromGit, type ViewFile } from './model/view-files'
import { baseName, deepestRootOf, joinRepoPath, relativeTo } from './model/paths'
import { scopeKey, scopeLabel } from './model/scope'
import { trashWording } from './model/trash-wording'

type GitSource = Extract<ChangesSource, { kind: 'git' }>

/** Something to do with the diff stack once it shows the file (the page may only just have switched). */
interface StackAction {
  /** Returns false while the stack does not hold the file yet. */
  run: (stack: DiffStackHandle) => boolean
  /** For the stack of all files, or for a detail page's. */
  allFiles: boolean
  until: number
}

const STACK_ACTION_MS = 5_000

const BUSY = (
  <span className="inline-flex h-6 w-6 items-center justify-center">
    <Loader2 size={13} className="animate-spin text-subtle-foreground" />
  </span>
)

function useGit<T>(controller: GitChangesController, select: (state: GitChangesState) => T): T {
  return useStore(controller.store, select)
}

/**
 * Lights up a place a reference points at in a file's diff, telling the user when it moved or is
 * gone; a comment gone back to for editing gets its card focused.
 */
function showReference(handle: DiffEditorHandle, reveal: RevealRequest): void {
  const view = handle.editorFor(reveal.side ?? 'after')
  if (view) {
    if (reveal.range) expandCollapsedAt(view, reveal.range.startLine, reveal.range.endLine)
    notifyRevealOutcome(revealInEditor(view, { range: reveal.range, quote: reveal.quote, commentId: reveal.commentId }))
    return
  }
  // The unified layout's before side: find the quoted lines in the original text, then place them.
  const { range, outcome } = relocateLines(originalLines(handle), reveal.range ?? { startLine: 1, endLine: 1 }, reveal.quote)
  revealBeforeInUnified(handle, range.startLine, outcome !== 'lost')
  if (reveal.commentId) focusCommentCard(handle.nav, reveal.commentId)
  notifyRevealOutcome(outcome)
}

function fileTarget(reveal: RevealRequest) {
  return { range: reveal.range, quote: reveal.quote, keepFocus: reveal.keepFocus, commentId: reveal.commentId }
}

export function GitChangesView({ tab, source }: { tab: TabState; source: GitSource }) {
  const { t } = useTranslation()
  // A viewer instance shows one tab for its whole life; effects read its id here.
  const tabIdRef = useRef(tab.id)
  const resources = useViewerResources()
  const { setTabTitle, setRefreshHandler, openFile, consumeReveal } = useCanvasActions()
  const [memory, update] = useViewMemory(tab)
  const prefs = useChangesViewPrefs()
  const [controller] = useState(() => createGitChangesController(source.spaceId, memory, source.repoRoot))
  const [changedSince] = useState(() => new ChangedSinceCounter())
  const rootRef = useRef<HTMLDivElement>(null)
  const stackRef = useRef<DiffStackHandle>(null)
  const panelToggleRef = useRef<HTMLButtonElement>(null)
  const width = useContainerWidth(rootRef, (w) => layoutStep(w, prefs.panelOpen, prefs.panelWidth))
  const layout = changesLayout(width, prefs.panelWidth)
  const pageWidth = width === 0 ? 0 : mainWidth(width, prefs.panelOpen, prefs.panelWidth)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [currentKey, setCurrentKey] = useState<string | null>(memory.stackAnchor?.key ?? null)
  const [commitError, setCommitError] = useState<GitErrorText | null>(null)
  const { showConfirm, DialogComponent } = useConfirmDialog()
  const notify = useNotificationStore((s) => s.show)
  const workDir = useSpaceStore((s) => (s.currentSpace?.id === source.spaceId ? s.currentSpace.workingDir ?? s.currentSpace.path : null))

  const phase = useGit(controller, (s) => s.phase)
  const git = useGit(controller, (s) => s.git)
  const repositories = useGit(controller, (s) => s.repositories)
  const repoRoot = useGit(controller, (s) => s.repoRoot)
  const status = useGit(controller, (s) => s.status)
  const list = useGit(controller, (s) => s.list)
  const listError = useGit(controller, (s) => s.listError)
  const loadError = useGit(controller, (s) => s.loadError)
  const review = useGit(controller, (s) => s.review)
  const refreshing = useGit(controller, (s) => s.refreshing)
  const version = useGit(controller, (s) => s.version)
  const newChanges = useGit(controller, (s) => s.newChanges)
  const recount = useGit(controller, (s) => s.recount)
  const busyPaths = useGit(controller, (s) => s.busyPaths)
  const operation = useGit(controller, (s) => s.operation)
  const repo = status?.repo ?? repositories.find((r) => r.root === repoRoot) ?? null

  // Lifetime: load on mount (opening or coming back to the tab), on window focus, on file events (hint only).
  useEffect(() => {
    const scope = resources.scope()
    scope.add(() => controller.dispose())
    scope.add(holdArtifactSpace(source.spaceId))
    scope.add(api.onArtifactChangedBatch((batch) => batch.spaceId === source.spaceId && controller.noteFileChanges(batch.resync ? null : batch.changes.map((c) => c.path))))
    const onFocus = () => controller.refreshIfStale()
    const onVisible = () => {
      if (document.visibilityState === 'visible') controller.refreshIfStale()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    scope.add(() => window.removeEventListener('focus', onFocus))
    scope.add(() => document.removeEventListener('visibilitychange', onVisible))
    scope.add(setRefreshHandler('changes', async (refreshed) => {
      if (refreshed.id === tabIdRef.current) await controller.refresh({ relist: true })
    }))
    void controller.load({ relist: true })
    return () => scope.dispose()
  }, [controller, resources, source.spaceId, setRefreshHandler])

  // Keyboard focus starts in the view (F7 works at once), unless the user is typing elsewhere.
  useEffect(() => {
    const active = document.activeElement
    if (!active || active === document.body) rootRef.current?.focus({ preventScroll: true })
  }, [])

  const repoName = repo?.name
  useEffect(() => {
    setTabTitle(tabIdRef.current, repoName ? `${t('Changes')} · ${repoName}` : t('Changes'))
  }, [repoName, setTabTitle, t])

  // Files: everything in the list, then what the filter and "hide generated" leave, plus files a
  // reference or report link asked to see.
  const files = useMemo(() => (list && repoRoot ? list.files.map((f) => viewFileFromGit(f, repoRoot)) : []), [list, repoRoot])
  const forced = useMemo(() => new Set(memory.forced), [memory.forced])
  const passes = useCallback(
    (file: ViewFile) => forced.has(file.key) || ((!prefs.hideGenerated || !file.generated) && matchesFilter(file.path, memory.filter)),
    [forced, prefs.hideGenerated, memory.filter]
  )
  const shown = useMemo(() => files.filter(passes), [files, passes])
  const hiddenGenerated = useMemo(
    () => (prefs.hideGenerated ? files.filter((f) => f.generated && !forced.has(f.key)).length : 0),
    [prefs.hideGenerated, files, forced]
  )
  const totals = useMemo(() => (list ? totalsOf(files) : null), [list, files])
  // Of the list on screen, which during a scope switch is still the previous scope's.
  const scopeIsWorkingTree = (list?.scope ?? memory.scope).kind === 'uncommitted'

  // Panel groups: the working tree's own groups for uncommitted changes, the compared files otherwise.
  const groups = useMemo<PanelGroup[]>(() => {
    if (!scopeIsWorkingTree || !status || !repoRoot) return [{ id: 'changes', files: shown }]
    const toView = (entries: typeof status.staged) => entries.map((f) => viewFileFromGit(f, repoRoot)).filter(passes)
    return [
      { id: 'conflicted', files: toView(status.conflicted) },
      { id: 'staged', files: toView(status.staged) },
      { id: 'unstaged', files: toView(status.unstaged) },
    ]
  }, [scopeIsWorkingTree, status, repoRoot, shown, passes])
  const order = useMemo(() => {
    const paths = list?.files.map((f) => f.path) ?? []
    for (const entries of status ? [status.conflicted, status.staged, status.unstaged] : []) {
      for (const entry of entries) paths.push(entry.path)
    }
    return createPathOrder(paths, prefs.tree)
  }, [list, status, prefs.tree])
  // The diffs follow the file list, so Next file, F7 and "k of N" walk it in the order it shows.
  const ordered = useMemo(() => inPanelOrder(shown, groups, order), [shown, groups, order])
  const detail = memory.page === 'overview' ? memory.detail : null
  const stackFiles = useMemo(() => (detail ? detailFiles(detail, ordered) : ordered), [detail, ordered])

  const setFilter = useCallback((filter: string) => update({ filter, forced: [] }), [update])
  const setHideGenerated = useCallback((hide: boolean) => {
    prefs.setHideGenerated(hide)
    update({ forced: [] })
  }, [prefs, update])
  const showGenerated = useCallback(() => setHideGenerated(false), [setHideGenerated])

  const folded = useMemo(() => new Set(memory.folded), [memory.folded])
  const loaded = useMemo(() => new Set(memory.loaded), [memory.loaded])
  const gateFor = useCallback((file: ViewFile): CardGate => {
    if (loaded.has(file.key)) return null
    if (file.generated) return 'generated'
    return isLargeDiff(file) ? 'large' : null
  }, [loaded])

  const toggleFold = useCallback((key: string) => {
    update({ folded: memory.folded.includes(key) ? memory.folded.filter((k) => k !== key) : [...memory.folded, key] })
  }, [memory, update])
  const unfold = useCallback((key: string) => {
    if (memory.folded.includes(key)) update({ folded: memory.folded.filter((k) => k !== key) })
  }, [memory, update])
  const loadAnyway = useCallback((key: string) => update({ loaded: [...memory.loaded, key] }), [memory, update])
  const allFolded = useMemo(() => stackFiles.length > 0 && stackFiles.every((f) => folded.has(f.key)), [stackFiles, folded])
  const foldAll = (fold: boolean) => {
    const keys = new Set(stackFiles.map((f) => f.key))
    update({ folded: fold ? [...new Set([...memory.folded, ...keys])] : memory.folded.filter((k) => !keys.has(k)) })
  }

  const loadDiff = useCallback(
    async (file: ViewFile, signal: AbortSignal): Promise<LoadedDiff> => diffFromGit(await controller.contents(file, signal)),
    [controller]
  )

  // Both sides of every diff can be pointed at. The sources are read when a selection is offered,
  // so they name the scope and revision on screen without rebuilding the editors when those change.
  const compareLabel = scopeLabel(memory.scope, t)
  const beforeRevision = list?.beforeRevision ?? null
  const referenceContext = useRef({ compareLabel, beforeRevision })
  referenceContext.current = { compareLabel, beforeRevision }
  const sideExtensions = useCallback((file: ViewFile, _part: DiffPart, side: DiffSide, unified: boolean): Extension[] => {
    if (!repoRoot) return []
    const sourceFor = (which: DiffSide) => (): DiffReferenceSource => {
      const { compareLabel: label, beforeRevision: revision } = referenceContext.current
      return {
        kind: 'diff',
        path: which === 'before' && file.oldPath ? joinRepoPath(repoRoot, file.oldPath) : file.absPath,
        side: which,
        compareLabel: label,
        repo: revision ? { root: repoRoot, beforeRevision: revision } : { root: repoRoot },
      }
    }
    return [unified
      ? referenceExtension({ source: sourceFor('after'), beforeSource: sourceFor('before'), onLines: unfoldReferencedLines })
      : referenceExtension({ source: sourceFor(side), onLines: unfoldReferencedLines })]
  }, [repoRoot])
  const onAnchorChange = useCallback((anchor: StackAnchor) => {
    memory.stackAnchor = anchor
  }, [memory])

  const sideBySideFits = width === 0 || pageWidth >= MIN_SIDE_BY_SIDE_WIDTH
  const diffLayout = prefs.sideBySide && sideBySideFits ? 'split' : 'unified'

  // Operations.
  const stagedPaths = useMemo(() => new Set(status?.staged.map((f) => f.path)), [status])
  const unstagedPaths = useMemo(() => new Set(status?.unstaged.map((f) => f.path)), [status])
  const conflictedPaths = useMemo(() => new Set(status?.conflicted.map((f) => f.path)), [status])

  const reportFailure = useCallback((message: string) => {
    notify({ title: message, variant: 'error', duration: 6000 })
  }, [notify])

  const stage = useCallback(async (targets: ViewFile[]) => {
    const failure = await controller.stage(targets.flatMap(pathsOf))
    if (failure) reportFailure(gitErrorMessage(failure, t))
  }, [controller, reportFailure, t])
  const unstage = useCallback(async (targets: ViewFile[]) => {
    const failure = await controller.unstage(targets.flatMap(pathsOf))
    if (failure) reportFailure(gitErrorMessage(failure, t))
  }, [controller, reportFailure, t])
  const discard = useCallback(async (file: ViewFile) => {
    const name = baseName(file.path)
    const untracked = file.state === 'untracked'
    const ok = await showConfirm(untracked
      ? {
          ...trashWording(name, window.platform as Window['platform'] | undefined, t),
          cancelLabel: t('Cancel'),
          variant: 'danger',
        }
      : {
          title: t('Discard changes to {{name}}?', { name }),
          message: t('This can\'t be undone in Halo.'),
          confirmLabel: t('Discard'),
          cancelLabel: t('Cancel'),
          variant: 'danger',
        })
    if (!ok) return
    const failure = await controller.discard([file.path])
    if (failure) reportFailure(gitErrorMessage(failure, t))
  }, [controller, reportFailure, showConfirm, t])
  const openInEditor = useCallback((file: ViewFile) => {
    void openFile(file.absPath)
  }, [openFile])

  const keepDraft = useCallback((message: string) => {
    memory.commitMessage = message
  }, [memory])
  const commit = useCallback(async ({ amend, push, message }: { amend: boolean; push: boolean; message: string }): Promise<boolean> => {
    setCommitError(null)
    const outcome = await controller.commit({ message, amend, push })
    if ('failure' in outcome) {
      setCommitError(describeGitError(outcome.failure, t))
      return false
    }
    const { result } = outcome
    if (push && !result.pushed) {
      notify({
        title: t('Committed {{commit}}, but the push failed', { commit: result.commit }),
        body: gitErrorMessage({ code: result.pushErrorCode, error: result.pushError }, t),
        variant: 'warning',
        duration: 8000,
      })
      return true
    }
    notify({
      title: amend ? t('Amended {{commit}}', { commit: result.commit })
        : push ? t('Committed and pushed {{commit}}', { commit: result.commit })
          : t('Committed {{commit}}', { commit: result.commit }),
      variant: 'success',
      duration: 4000,
    })
    return true
  }, [controller, notify, t])
  const upstream = repo?.upstream
  const sync = useCallback(async () => {
    setCommitError(null)
    const outcome = await controller.sync()
    if ('failure' in outcome) {
      setCommitError(describeGitError(outcome.failure, t))
      return
    }
    notify({
      title: upstream ? t('Synced with {{upstream}}', { upstream }) : t('Published {{branch}}', { branch: outcome.result.repo.branch ?? '' }),
      variant: 'success',
      duration: 4000,
    })
  }, [controller, notify, t, upstream])

  const rowActions = useCallback((file: ViewFile, group: PanelGroupId): ReactNode => {
    if (busyPaths.has(file.path)) return BUSY
    const open = file.state !== 'deleted' && (
      <IconButton size="sm" label={t('Open file')} onClick={() => openInEditor(file)}><FileCode2 size={13} /></IconButton>
    )
    if (group === 'staged') {
      return <>{open}<IconButton size="sm" label={t('Unstage')} onClick={() => void unstage([file])}><Minus size={13} /></IconButton></>
    }
    if (group === 'unstaged') {
      return (
        <>
          {open}
          <IconButton size="sm" label={t('Discard')} onClick={() => void discard(file)}><Undo2 size={13} /></IconButton>
          <IconButton size="sm" label={t('Stage')} onClick={() => void stage([file])}><Plus size={13} /></IconButton>
        </>
      )
    }
    return open || null
  }, [busyPaths, openInEditor, unstage, discard, stage, t])
  const groupActions = useCallback((group: PanelGroup): ReactNode => {
    if (group.id === 'staged') return <IconButton size="sm" label={t('Unstage all')} onClick={() => void unstage([...group.files])}><Minus size={13} /></IconButton>
    if (group.id === 'unstaged') return <IconButton size="sm" label={t('Stage all')} onClick={() => void stage([...group.files])}><Plus size={13} /></IconButton>
    return null
  }, [stage, unstage, t])
  const cardActions = useCallback((file: ViewFile): ReactNode => (
    <>
      {scopeIsWorkingTree && !conflictedPaths.has(file.path) && (busyPaths.has(file.path) ? BUSY
        : unstagedPaths.has(file.path)
          ? <IconButton size="sm" label={t('Stage file')} onClick={() => void stage([file])}><Plus size={14} /></IconButton>
          : stagedPaths.has(file.path)
            ? <IconButton size="sm" label={t('Unstage file')} onClick={() => void unstage([file])}><Minus size={14} /></IconButton>
            : null)}
      {file.state !== 'deleted' && (
        <IconButton size="sm" label={t('Open in editor')} onClick={() => openInEditor(file)}><FileCode2 size={14} /></IconButton>
      )}
    </>
  ), [scopeIsWorkingTree, conflictedPaths, busyPaths, unstagedPaths, stagedPaths, stage, unstage, openInEditor, t])

  // Work for the diff stack, done once it shows the file: the page may only just have switched, and
  // the stack mounts in the render that follows.
  const stackAction = useRef<StackAction | null>(null)
  const onChangesPage = memory.page === 'changes' && !detail
  // Queuing renders once more, so the effect below runs even when nothing else changed.
  const [, renderAgain] = useReducer((n: number) => n + 1, 0)
  const queueStackAction = useCallback((run: StackAction['run'], allFiles: boolean) => {
    stackAction.current = { run, allFiles, until: Date.now() + STACK_ACTION_MS }
    renderAgain()
  }, [])

  // Detail page and file-list clicks. Leaving a detail page brings the overview back where it
  // was and points at the folder just seen, or at the report link the page was opened from.
  const [returnedFrom, setReturnedFrom] = useState<{ kind: DetailState['kind']; item: string; mention?: number } | null>(null)
  const detailTakesFocus = useRef(false)
  const enterDetail = useCallback((next: DetailState) => {
    setReturnedFrom(null)
    detailTakesFocus.current = true
    update({ detail: next })
  }, [update])
  const leaveDetail = useCallback(() => {
    if (detail) setReturnedFrom({ kind: detail.kind, item: detail.items[detail.index] ?? '', mention: detail.mention })
    update({ detail: null })
  }, [detail, update])
  useEffect(() => {
    detailTakesFocus.current = false
  })

  const openFromPanel = useCallback((file: ViewFile) => {
    // Picked in the drawer: the card takes the focus the drawer had.
    const focus = drawerOpen
    setDrawerOpen(false)
    const show = (stack: DiffStackHandle) => stack.showFile(file.key, { focus })
    if (detail) {
      const index = itemIndexOf(detail, file.path)
      if (index >= 0) {
        if (index !== detail.index) update({ detail: detailAt(detail, index) })
        queueStackAction(show, false)
        return
      }
    }
    if (memory.page !== 'changes' || detail) update({ page: 'changes', detail: null })
    queueStackAction(show, true)
  }, [drawerOpen, detail, memory, update, queueStackAction])

  // A file page opened from a report link starts at the line the link names, unfolded if the diff
  // had collapsed it as unchanged.
  const detailItem = detail?.kind === 'file' ? detail.items[detail.index] : undefined
  const detailLine = detail?.kind === 'file' ? detail.line : undefined
  const stackFilesRef = useRef(stackFiles)
  stackFilesRef.current = stackFiles
  useEffect(() => {
    if (detailItem === undefined || detailLine === undefined) return
    const file = stackFilesRef.current.find((f) => f.path === detailItem)
    if (!file) return
    stackRef.current?.withEditors(file.key, (editors) => {
      const view = editors[0].editorFor('after') ?? editors[0].editorFor('before')
      if (!view) return
      expandCollapsedAt(view, detailLine)
      revealInEditor(view, { range: { startLine: detailLine, endLine: detailLine } })
    })
  }, [detailItem, detailLine])

  // AI review: the card lives in the overview, which follows the review only while it is shown.
  const onReviewStarted = useCallback((record: GitReviewRecord) => controller.setReview(record), [controller])
  // A report link to a file of this list opens that file's page, walked through the files the report names.
  const openReportFile = useCallback((target: FileLinkTarget, mention: number, report: string): boolean => {
    if (!repoRoot) return false
    const relative = relativeTo(repoRoot, target.path)
    const file = relative ? files.find((f) => f.path === relative) : undefined
    if (!file) return false
    const prefix = workDir ? relativeTo(workDir, repoRoot) ?? '' : ''
    const visible = new Set(shown.map((f) => f.path))
    const mentioned = filesMentionedIn(report, files.map((f) => f.path), prefix).filter((path) => path === file.path || visible.has(path))
    const items = mentioned.includes(file.path) ? mentioned : [file.path, ...mentioned]
    update({
      loaded: memory.loaded.includes(file.key) ? memory.loaded : [...memory.loaded, file.key],
      forced: passes(file) ? memory.forced : [...memory.forced, file.key],
    })
    enterDetail(openDetail('file', items, file.path, target.range?.startLine, mention >= 0 ? mention : undefined))
    return true
  }, [repoRoot, files, shown, passes, workDir, memory, update, enterDetail])

  useChangesKeys(rootRef, {
    onNavigate: (direction) => {
      if (memory.page === 'changes' || detail) stackRef.current?.navigate(direction)
    },
    onEscape: (typing) => {
      if (drawerOpen) {
        setDrawerOpen(false)
        return true
      }
      if (typing) {
        // Out of the field, back to the view; the canvas stays open.
        rootRef.current?.focus({ preventScroll: true })
        return true
      }
      if (detail) {
        leaveDetail()
        return true
      }
      return false
    },
    onStep: (delta) => {
      if (!detail) return false
      update({ detail: stepDetail(detail, delta) })
      return true
    },
  })

  // A place to show, asked from outside (a reference card, a task card): shown in the repository
  // that holds the file; what this view cannot show opens as a file instead.
  const reveal = tab.reveal
  const switchingFor = useRef<number | null>(null)
  useEffect(() => {
    if (!reveal) return
    const consume = () => consumeReveal(tabIdRef.current, reveal.seq)
    if (reveal.page === 'overview') {
      update({ page: 'overview', detail: null })
      consume()
      return
    }
    if (!reveal.path || phase !== 'ready' || !repoRoot) return
    const path = reveal.path
    const owner = deepestRootOf(repositories.map((r) => r.root), path)
    if (owner && owner !== repoRoot) {
      if (switchingFor.current === reveal.seq) return
      switchingFor.current = reveal.seq
      update({ forced: [] })
      void controller.selectRepository(owner).then(() => {
        if (controller.store.getState().repoRoot === owner) return
        // The repository could not be shown: open the file rather than keep the request forever.
        consume()
        void revealFileAt(path, fileTarget(reveal))
      })
      return
    }
    consume()
    const relative = relativeTo(repoRoot, path)
    // A renamed file's before side is named by its old path.
    const file = relative ? files.find((f) => f.path === relative || (reveal.side === 'before' && f.oldPath === relative)) : undefined
    if (!file) {
      void revealFileAt(path, fileTarget(reveal))
      return
    }
    update({
      page: 'changes',
      detail: null,
      loaded: memory.loaded.includes(file.key) ? memory.loaded : [...memory.loaded, file.key],
      forced: passes(file) ? memory.forced : [...memory.forced, file.key],
    })
    queueStackAction((stack) => stack.withEditors(
      file.key,
      (editors) => showReference(editors[0], reveal),
      () => { void revealFileAt(path, fileTarget(reveal)) }
    ), true)
  }, [reveal, phase, repoRoot, repositories, files, controller, consumeReveal, passes, update, memory, queueStackAction])

  useEffect(() => {
    const action = stackAction.current
    if (!action) return
    if (Date.now() > action.until) {
      stackAction.current = null
      return
    }
    if (action.allFiles !== onChangesPage || !stackRef.current) return
    if (action.run(stackRef.current)) stackAction.current = null
  })

  const panelToggle = layout.dockedPanel ? (
    <IconButton ref={panelToggleRef} label={t('File list')} pressed={prefs.panelOpen} onClick={() => prefs.setPanelOpen(!prefs.panelOpen)}>
      <PanelRight size={15} />
    </IconButton>
  ) : (
    <IconButton ref={panelToggleRef} label={t('File list')} aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={() => setDrawerOpen((v) => !v)}>
      <PanelRight size={15} />
    </IconButton>
  )

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

  const snapshotMissing = listError?.code === 'GIT_SNAPSHOT_MISSING'
  let page: ReactNode
  if (phase === 'loading') page = <LoadingState />
  else if (phase === 'no-git' && git && !git.available) page = <NoGitState git={git} onRetry={() => void controller.load({ relist: true })} />
  else if (phase === 'no-repo') page = <NoRepositoryState />
  else if (phase === 'error') page = <LoadErrorState message={gitErrorMessage(loadError ?? {}, t)} onRetry={() => void controller.load({ relist: true })} />
  else if (memory.page === 'overview' && !detail) {
    page = (
      <OverviewPage
        width={pageWidth}
        shown={shown}
        hiddenGenerated={hiddenGenerated}
        initialScroll={memory.overviewScroll}
        onScroll={(top) => { memory.overviewScroll = top }}
        returnedFrom={returnedFrom?.kind === 'dir' ? returnedFrom.item : null}
        onOpenDirectory={(dir, order) => enterDetail(openDetail('dir', order, dir))}
        review={(
          <ReviewSection
            spaceId={source.spaceId}
            record={review}
            list={list}
            repoRoot={repoRoot}
            scopeLabel={compareLabel}
            recount={recount}
            changedSince={changedSince}
            treeVersion={controller.treeVersion}
            onStarted={onReviewStarted}
            onOpenReportFile={openReportFile}
            returnTo={returnedFrom?.kind === 'file' ? returnedFrom.mention ?? null : null}
          />
        )}
      />
    )
  } else if (listError) {
    page = <LoadErrorState message={gitErrorMessage(listError, t, memory.scope.kind === 'revision' || memory.scope.kind === 'commit' ? memory.scope.revision : undefined)} onRetry={() => void controller.load()} />
  } else if (!list && refreshing) {
    // A scope or repository switch dropped the old list; the next one is on its way.
    page = <LoadingState />
  } else if (stackFiles.length === 0) {
    page = shown.length === 0 && files.length > 0
      ? <NoMatchState onClear={() => { setFilter(''); if (prefs.hideGenerated) setHideGenerated(false) }} />
      : <NoChangesState scope={memory.scope} />
  } else {
    page = (
      <DiffStack
        key={detail ? `detail:${detail.kind}:${detail.items[detail.index]}` : 'all'}
        ref={stackRef}
        files={stackFiles}
        scope={list ? `${repoRoot}\n${scopeKey(list.scope)}` : undefined}
        layout={diffLayout}
        collapseUnchanged={prefs.collapseUnchanged}
        folded={folded}
        onToggleFold={toggleFold}
        onUnfold={unfold}
        gateFor={gateFor}
        onLoad={loadAnyway}
        load={loadDiff}
        version={version}
        actionsFor={cardActions}
        sideExtensions={sideExtensions}
        anchor={detail ? undefined : memory.stackAnchor}
        onAnchorChange={detail ? noop : onAnchorChange}
        onCurrentChange={setCurrentKey}
      />
    )
  }

  const changeScope = (scope: StoredCompareScope) => {
    update({ forced: [] })
    void controller.setScope(scope)
  }
  const changeRepository = (root: string) => {
    update({ forced: [] })
    void controller.selectRepository(root)
  }

  const panel = phase === 'ready' && (
    <FilePanel
      groups={groups}
      hiddenGenerated={hiddenGenerated}
      onShowGenerated={showGenerated}
      filter={memory.filter}
      onFilterChange={setFilter}
      order={order}
      onTreeChange={prefs.setTree}
      hideGenerated={prefs.hideGenerated}
      onHideGeneratedChange={setHideGenerated}
      onRefresh={() => void controller.refresh({ relist: true })}
      refreshing={refreshing}
      currentKey={currentKey}
      onOpenFile={openFromPanel}
      rowActions={rowActions}
      groupActions={scopeIsWorkingTree ? groupActions : undefined}
      truncatedAt={list?.truncated || status?.truncated ? list?.files.length : undefined}
      touch={layout.stacked}
      focusFilter={!layout.dockedPanel}
      footer={repo && (
        <CommitBox
          repo={repo}
          stagedCount={status?.staged.length ?? 0}
          viewedSubject={memory.scope.kind === 'commit' ? memory.scope.subject : undefined}
          initialMessage={memory.commitMessage}
          onDraftChange={keepDraft}
          operation={operation}
          onCommit={commit}
          onSync={() => void sync()}
          error={commitError}
          onDismissError={() => setCommitError(null)}
        />
      )}
    />
  )

  return (
    <div ref={rootRef} tabIndex={-1} className="flex h-full min-h-0 min-w-0 flex-col bg-background outline-none">
      {phase !== 'loading' && phase !== 'no-git' && phase !== 'no-repo' && (
        <TopBar
          spaceId={source.spaceId}
          repositories={repositories}
          repo={repo}
          onSelectRepository={changeRepository}
          scope={memory.scope}
          review={review}
          snapshotMissing={snapshotMissing}
          onScope={changeScope}
          totals={totals}
          page={memory.page}
          onPage={(next) => update({ page: next, detail: null, ...(next === 'graph' ? { graphOpened: true } : {}) })}
          tools={memory.page === 'changes' || detail ? tools : null}
          panelToggle={panelToggle}
          layout={layout}
        />
      )}
      {detail && (
        <DetailBar
          detail={detail}
          fileCount={stackFiles.length}
          takeFocus={detailTakesFocus.current}
          onBack={leaveDetail}
          onStep={(delta) => update({ detail: stepDetail(detail, delta) })}
        />
      )}
      <div className="relative flex min-h-0 flex-1">
        <section className="relative min-w-0 flex-1" aria-label={compareLabel}>
          {newChanges > 0 && (memory.page === 'changes' || detail) && (
            <NewChangesBar count={newChanges} onRefresh={() => void controller.refresh()} onDismiss={controller.dismissNewChanges} />
          )}
          {repoRoot && (memory.graphOpened || memory.page === 'graph') && (
            // The graph stands on its own: a failed change list (a gone branch, a pruned snapshot) must not hide it.
            // Once opened it stays mounted, hidden, so filters, scroll and loaded pages survive page switches.
            <div hidden={memory.page !== 'graph'} className="h-full">
              <GitGraphPage
                spaceId={source.spaceId}
                repoRoot={repoRoot}
                active={memory.page === 'graph'}
                selected={memory.scope.kind === 'commit' ? memory.scope.revision : null}
                onCompare={(oid, subject) => {
                  update({ page: 'changes', detail: null, forced: [] })
                  void controller.setScope({ kind: 'commit', revision: oid, subject })
                }}
              />
            </div>
          )}
          {memory.page !== 'graph' && page}
        </section>
        {panel && layout.dockedPanel && prefs.panelOpen && (
          <ResizableFilePanel containerRef={rootRef} preferredWidth={prefs.panelWidth} onWidthChange={prefs.setPanelWidth}>
            {panel}
          </ResizableFilePanel>
        )}
        {panel && !layout.dockedPanel && drawerOpen && (
          <FileDrawer fullWidth={layout.stacked} onClose={() => setDrawerOpen(false)} opener={panelToggleRef}>
            {panel}
          </FileDrawer>
        )}
      </div>
      {DialogComponent}
    </div>
  )
}

function pathsOf(file: ViewFile): string[] {
  return file.oldPath ? [file.path, file.oldPath] : [file.path]
}

function noop() {}

function NoMatchState({ onClear }: { onClear: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-subtle-foreground">
      {t('No matching files')}
      <button type="button" onClick={onClear} className="text-primary hover:underline">{t('Clear filter')}</button>
    </div>
  )
}
