/**
 * RawFilesTab — manage a KB's source files ("Files").
 *
 * - Drop zone + desktop file picker to add text files.
 * - Files grouped into "Not yet learned" / "Learned" with status icons.
 * - "Learn now" triggers ingest; live progress bar reflects the event stream.
 * - "Select files" removes many of the KB's own files at once.
 *
 * Learned status comes from RawFileStatus.learned (pulled from disk), never
 * from progress events.
 */

import { useEffect, useRef, useState, DragEvent } from 'react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { useTlonStore } from '../../stores/tlon.store'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { IngestProgress } from './IngestProgress'
import { useCanvasActions } from '../../hooks/useCanvasLifecycle'
import {
  FileText,
  CheckCircle2,
  Circle,
  CircleOff,
  AlertCircle,
  Trash2,
  Upload,
  FolderOpen,
  FolderPlus,
  Sparkles,
  Loader2,
  ChevronDown,
  Eye,
  ListChecks,
  X,
} from 'lucide-react'
import type { KnowledgeBaseEntry, RawFileStatus } from '../../../shared/types/tlon'

interface RawFilesTabProps {
  kb: KnowledgeBaseEntry
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif']

/**
 * Only the KB's own copies can be removed here; watched-folder files live
 * outside the KB and are managed with their folder in Settings.
 */
function isRemovable(file: RawFileStatus): boolean {
  return file.source === 'raw'
}

/** How rows take part in multi-select; absent while not selecting. */
export interface RowSelection {
  isSelected: (file: RawFileStatus) => boolean
  toggle: (file: RawFileStatus) => void
  setMany: (files: RawFileStatus[], selected: boolean) => void
}

interface RemoveSelectedDeps {
  confirm: (count: number) => Promise<boolean>
  remove: (paths: string[]) => Promise<{ failed: string[] }>
}

/**
 * Remove the chosen files after one confirmation. Resolves to the files that
 * could not be removed — empty when all were — or null when nothing was tried.
 */
export async function removeSelectedFiles(
  targets: RawFileStatus[],
  deps: RemoveSelectedDeps,
): Promise<RawFileStatus[] | null> {
  if (targets.length === 0 || !(await deps.confirm(targets.length))) return null
  const { failed } = await deps.remove(targets.map(f => f.path))
  const failedPaths = new Set(failed)
  return targets.filter(f => failedPaths.has(f.path))
}

/**
 * Human reason a file sits in a non-learned state, shown inline so it's
 * readable without hovering (native title tooltips are invisible on touch and
 * in remote web). Returns null for states that need no explanation.
 */
function stateReason(file: RawFileStatus, t: (k: string, o?: Record<string, unknown>) => string): string | null {
  if (file.state === 'failed') {
    return file.error ? t("Couldn't read: {{message}}", { message: file.error }) : t("Couldn't read this file")
  }
  if (file.state === 'no-text') {
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'))
    if (IMAGE_EXTS.includes(ext)) return t('No text found in this image')
    if (ext === '.pdf') return t('No text layer — looks like a scan')
    return t('No readable text found')
  }
  return null
}

export function RawFilesTab({ kb }: RawFilesTabProps) {
  const { t } = useTranslation()
  const { showConfirm, DialogComponent } = useConfirmDialog()
  const rawFiles = useTlonStore(s => s.rawFiles[kb.id]) ?? []
  const progress = useTlonStore(s => s.ingestProgress[kb.id])
  const addFiles = useTlonStore(s => s.addFiles)
  const removeRawFile = useTlonStore(s => s.removeRawFile)
  const removeRawFiles = useTlonStore(s => s.removeRawFiles)
  const pickAndAddFiles = useTlonStore(s => s.pickAndAddFiles)
  const pickAndImportFolder = useTlonStore(s => s.pickAndImportFolder)
  const triggerIngest = useTlonStore(s => s.triggerIngest)

  const [isDragging, setIsDragging] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [removing, setRemoving] = useState(false)
  const [notRemoved, setNotRemoved] = useState<RawFileStatus[]>([])
  const isElectron = !api.isRemoteMode()
  const isIngesting = progress?.phase === 'running'

  // 'no-text' sources yield nothing until their bytes change, so they can never
  // clear the "not yet learned" list — grouping them there makes it contradict
  // the "Learn N" count forever. Split them into their own "skipped" group.
  // 'failed' stays with the retryable pending files (it's in `learnable`).
  const notYetLearned = rawFiles.filter(f => f.state === 'pending' || f.state === 'failed')
  const learned = rawFiles.filter(f => f.state === 'learned')
  const skipped = rawFiles.filter(f => f.state === 'no-text')
  const learnable = notYetLearned

  const removable = rawFiles.filter(isRemovable)
  // Counted against the current list, so files gone since they were picked drop out.
  const selectedFiles = removable.filter(f => selected.has(f.path))
  const selectionActive = selecting && removable.length > 0

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const paths: string[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = api.getPathForFile(file)
      if (p) paths.push(p)
    }
    if (paths.length > 0) {
      await addFiles(kb.id, paths)
    }
  }

  const handleRemove = async (file: RawFileStatus) => {
    const ok = await showConfirm({
      title: t('Remove file'),
      message: t('Remove "{{name}}" from this knowledge base?', { name: file.name }),
      confirmLabel: t('Remove'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (ok) await removeRawFile(kb.id, file.path)
  }

  const cleanableSkipped = skipped.filter(isRemovable)

  const handleCleanSkipped = async () => {
    const ok = await showConfirm({
      title: t('Remove skipped files'),
      message: t('Remove {{count}} skipped file(s) that have no readable text? This does not delete the original files on disk.', { count: cleanableSkipped.length }),
      confirmLabel: t('Remove'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (ok) await removeRawFiles(kb.id, cleanableSkipped.map(f => f.path))
  }

  const stopSelecting = () => {
    setSelecting(false)
    setSelected(new Set())
    setNotRemoved([])
  }

  const selection: RowSelection | undefined = selectionActive ? {
    isSelected: (file) => selected.has(file.path),
    toggle: (file) => setSelected(prev => {
      const next = new Set(prev)
      if (next.has(file.path)) next.delete(file.path)
      else next.add(file.path)
      return next
    }),
    setMany: (files, on) => setSelected(prev => {
      const next = new Set(prev)
      for (const file of files) {
        if (on) next.add(file.path)
        else next.delete(file.path)
      }
      return next
    }),
  } : undefined

  const handleRemoveSelected = async () => {
    const left = await removeSelectedFiles(selectedFiles, {
      confirm: (count) => showConfirm({
        title: t('Remove selected files'),
        message: t('Remove {{count}} file(s) from this knowledge base? This does not delete the original files on disk.', { count }),
        confirmLabel: t('Remove'),
        cancelLabel: t('Cancel'),
        variant: 'danger',
      }),
      remove: async (paths) => {
        setRemoving(true)
        try {
          return await removeRawFiles(kb.id, paths)
        } finally {
          setRemoving(false)
        }
      },
    })
    if (left === null) return
    if (left.length === 0) {
      stopSelecting()
      return
    }
    // Left selected, so trying again is one click.
    setSelected(new Set(left.map(f => f.path)))
    setNotRemoved(left)
  }

  return (
    <div className="px-6 sm:px-10 py-3 sm:py-4 space-y-4">
      {/* Drop zone — dropped browser File objects carry no filesystem path, so
          adding files is desktop-only */}
      {isElectron ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`rounded-xl border-2 border-dashed p-5 sm:p-6 text-center transition-colors ${
            isDragging ? 'border-primary bg-primary/5' : 'border-border'
          }`}
        >
          <Upload className="w-6 h-6 mx-auto text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">{t('Drop files or folders here')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('PDF, Office docs, images (OCR), Markdown, text, CSV, HTML. Folders import recursively — source code and system files are skipped.')}
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={() => pickAndAddFiles(kb.id)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              {t('Browse files')}
            </button>
            <button
              onClick={() => pickAndImportFolder(kb.id)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
            >
              <FolderPlus className="w-4 h-4" />
              {t('Browse folder')}
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border-2 border-dashed border-border p-5 sm:p-6 text-center">
          <Upload className="w-6 h-6 mx-auto text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">{t('Adding files requires the desktop app.')}</p>
        </div>
      )}

      {/* Progress */}
      <IngestProgress progress={progress} />

      {/* Learn button */}
      {learnable.length > 0 && (
        <button
          onClick={() => triggerIngest(kb.id)}
          disabled={isIngesting}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isIngesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {isIngesting
            ? t('Learning…')
            : t('Learn {{count}} new file(s)', { count: learnable.length })}
        </button>
      )}

      {/* Multi-select. The bar stays in view while selecting down a long list. */}
      {removable.length > 0 && (
        selectionActive ? (
          <div className="sticky top-0 z-10 -mx-2 px-2 py-2 space-y-2 bg-background/95 backdrop-blur border-b border-border">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm tabular-nums">
                {t('{{count}} selected', { count: selectedFiles.length })}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleRemoveSelected}
                  disabled={selectedFiles.length === 0 || removing}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {removing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  {removing ? t('Removing…') : t('Remove selected')}
                </button>
                <button
                  onClick={stopSelecting}
                  disabled={removing}
                  className="px-3 py-1.5 text-sm rounded-lg bg-secondary hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {t('Cancel')}
                </button>
              </div>
            </div>
            {notRemoved.length > 0 && (
              <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium text-destructive">
                    {t('Could not remove {{count}} file(s). They stay selected so you can try again.', { count: notRemoved.length })}
                  </p>
                  <button
                    onClick={() => setNotRemoved([])}
                    className="p-0.5 rounded hover:bg-destructive/20 transition-colors flex-shrink-0"
                    title={t('Dismiss')}
                    aria-label={t('Dismiss')}
                  >
                    <X className="w-3.5 h-3.5 text-destructive" />
                  </button>
                </div>
                <ul className="mt-1 max-h-32 overflow-y-auto space-y-0.5 text-muted-foreground">
                  {notRemoved.map(file => (
                    <li key={file.path} className="truncate">{file.name}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="flex justify-end">
            <button
              onClick={() => setSelecting(true)}
              className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-secondary transition-colors"
            >
              <ListChecks className="w-3.5 h-3.5" />
              {t('Select files')}
            </button>
          </div>
        )
      )}

      {/* File groups */}
      {rawFiles.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {t('No files yet. Add some above to get started.')}
        </p>
      ) : (
        <div className="space-y-4">
          {notYetLearned.length > 0 && (
            <FileGroup
              title={t('Not yet learned')}
              files={notYetLearned}
              onRemove={handleRemove}
              formatSize={formatSize}
              selection={selection}
            />
          )}
          {learned.length > 0 && (
            <FileGroup
              title={t('Learned')}
              files={learned}
              onRemove={handleRemove}
              formatSize={formatSize}
              selection={selection}
            />
          )}
          {skipped.length > 0 && (
            <SkippedGroup
              files={skipped}
              onRemove={handleRemove}
              formatSize={formatSize}
              onCleanAll={cleanableSkipped.length > 0 ? handleCleanSkipped : undefined}
              cleanableCount={cleanableSkipped.length}
              selection={selection}
            />
          )}
        </div>
      )}

      {DialogComponent}
    </div>
  )
}

interface FileGroupProps {
  title: string
  files: RawFileStatus[]
  onRemove: (file: RawFileStatus) => void
  formatSize: (bytes: number) => string
  selection?: RowSelection
}

/** Per-state status icon. The odd states also carry an inline reason row. */
function StatusIcon({ file }: { file: RawFileStatus }) {
  switch (file.state) {
    case 'learned':
      return <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
    case 'no-text':
      return <CircleOff className="w-4 h-4 text-amber-500 flex-shrink-0" />
    case 'failed':
      return <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
    default:
      return <Circle className="w-4 h-4 text-muted-foreground flex-shrink-0" />
  }
}

function FileRow({
  file,
  onRemove,
  formatSize,
  selection,
}: {
  file: RawFileStatus
  onRemove: (file: RawFileStatus) => void
  formatSize: (bytes: number) => string
  selection?: RowSelection
}) {
  const { t } = useTranslation()
  const reason = stateReason(file, t)
  const { openFile } = useCanvasActions()
  const isLearned = file.state === 'learned'
  const selectable = !!selection && isRemovable(file)
  const isSelected = selectable && selection.isSelected(file)
  // Said in the row, not only in a tooltip: a touch screen shows no tooltip.
  const unpickableReason = selection && !selectable ? t('From a watched folder — manage it in Settings') : null

  const handleClick = () => {
    if (selectable) {
      selection.toggle(file)
      return
    }
    if (isLearned) {
      openFile(file.openPath, file.name)
    }
  }

  return (
    <div
      onClick={handleClick}
      className={`group flex items-center gap-2 px-3 py-2 rounded-lg border ${
        isSelected ? 'border-primary bg-primary/5' : 'border-border bg-card'
      } ${selectable || isLearned ? 'cursor-pointer hover:bg-secondary transition-colors' : ''}`}
    >
      {selection && (
        <input
          type="checkbox"
          checked={isSelected}
          disabled={!selectable}
          onChange={() => selection.toggle(file)}
          onClick={(e) => e.stopPropagation()}
          aria-label={t('Select "{{name}}"', { name: file.name })}
          title={unpickableReason ?? undefined}
          className="w-3.5 h-3.5 rounded border-border accent-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 flex-shrink-0"
        />
      )}
      <StatusIcon file={file} />
      <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm truncate">{file.name}</p>
        {unpickableReason ? (
          <p className="text-[11px] text-muted-foreground truncate flex items-center gap-1">
            <FolderOpen className="w-3 h-3 flex-shrink-0" />
            {unpickableReason}
          </p>
        ) : reason ? (
          <p className={`text-[11px] truncate ${file.state === 'failed' ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'}`}>
            {reason}
          </p>
        ) : file.source === 'linked' ? (
          <p className="text-[11px] text-muted-foreground truncate flex items-center gap-1">
            <FolderOpen className="w-3 h-3 flex-shrink-0" />
            {file.dirLabel || t('Watched folder')}
          </p>
        ) : (
          file.path !== file.name && (
            <p className="text-[11px] text-muted-foreground truncate">{file.path}</p>
          )
        )}
      </div>
      <span className="text-[11px] text-muted-foreground tabular-nums flex-shrink-0">
        {formatSize(file.size)}
      </span>
      {isLearned && !selection && (
        <Eye className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity flex-shrink-0" />
      )}
      {file.source === 'linked' ? (
        // Watched-folder files live outside the KB — remove the folder in
        // Settings instead of deleting individual files here.
        <span
          className="p-1 flex-shrink-0"
          title={t('From a watched folder — manage it in Settings')}
        >
          <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
        </span>
      ) : !selection && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(file) }}
          className="p-1 rounded opacity-0 group-hover:opacity-100 max-sm:opacity-100 hover:bg-destructive/20 transition-all flex-shrink-0"
          title={t('Remove')}
        >
          <Trash2 className="w-3.5 h-3.5 text-destructive" />
        </button>
      )}
    </div>
  )
}

/** Selects or clears every removable file of one group; partly selected shows as mixed. */
function GroupCheckbox({ title, files, selection }: { title: string; files: RawFileStatus[]; selection: RowSelection }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLInputElement>(null)
  const removable = files.filter(isRemovable)
  const count = removable.filter(selection.isSelected).length
  const all = removable.length > 0 && count === removable.length

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && !all
  }, [count, all])

  if (removable.length === 0) return null
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={all}
      onChange={() => selection.setMany(removable, !all)}
      aria-label={t('Select all in "{{group}}"', { group: title })}
      className="w-3.5 h-3.5 rounded border-border accent-primary cursor-pointer flex-shrink-0"
    />
  )
}

export function FileGroup({ title, files, onRemove, formatSize, selection }: FileGroupProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {selection && <GroupCheckbox title={title} files={files} selection={selection} />}
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide truncate">{title}</h4>
        </div>
        <span className="text-[11px] text-muted-foreground tabular-nums">{files.length}</span>
      </div>
      <div className="space-y-1">
        {files.map(file => (
          <FileRow key={file.path} file={file} onRemove={onRemove} formatSize={formatSize} selection={selection} />
        ))}
      </div>
    </div>
  )
}

/**
 * Files that extraction found no readable text in. They can never leave this
 * state until their bytes change, so the group is collapsed by default and
 * offers a one-tap clean-up for the KB-owned (non-linked) ones.
 */
function SkippedGroup({
  files,
  onRemove,
  formatSize,
  onCleanAll,
  cleanableCount,
  selection,
}: {
  files: RawFileStatus[]
  onRemove: (file: RawFileStatus) => void
  formatSize: (bytes: number) => string
  onCleanAll?: () => void
  cleanableCount: number
  selection?: RowSelection
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <button
          onClick={() => setExpanded(v => !v)}
          className="group/head inline-flex items-center gap-1 min-w-0"
        >
          <ChevronDown
            className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${expanded ? '' : '-rotate-90'}`}
          />
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide truncate">
            {t('Skipped — no readable text')}
          </h4>
          <span className="text-[11px] text-muted-foreground tabular-nums">{files.length}</span>
        </button>
        {onCleanAll && !selection && (
          <button
            onClick={onCleanAll}
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-destructive rounded-md hover:bg-destructive/10 transition-colors flex-shrink-0"
          >
            <Trash2 className="w-3 h-3" />
            {t('Clean up {{count}}', { count: cleanableCount })}
          </button>
        )}
      </div>
      {expanded && (
        <div className="space-y-1">
          {files.map(file => (
            <FileRow key={file.path} file={file} onRemove={onRemove} formatSize={formatSize} selection={selection} />
          ))}
        </div>
      )}
    </div>
  )
}
