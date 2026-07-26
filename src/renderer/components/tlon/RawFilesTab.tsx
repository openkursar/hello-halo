/**
 * RawFilesTab — manage a KB's source files ("Files").
 *
 * - Drop zone + desktop file picker to add text files.
 * - Files grouped into "Not yet learned" / "Learned" with status icons.
 * - "Learn now" triggers ingest; live progress bar reflects the event stream.
 *
 * Learned status comes from RawFileStatus.learned (pulled from disk), never
 * from progress events.
 */

import { useState, DragEvent } from 'react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { useTlonStore } from '../../stores/tlon.store'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { IngestProgress } from './IngestProgress'
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

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const paths: string[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = (file as File & { path?: string }).path
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

  // Only 'raw' sources can be deleted here; 'linked' files live outside the KB
  // and are managed by their watched folder in Settings.
  const cleanableSkipped = skipped.filter(f => f.source === 'raw')

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

  return (
    <div className="p-3 sm:p-4 space-y-4">
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
            />
          )}
          {learned.length > 0 && (
            <FileGroup
              title={t('Learned')}
              files={learned}
              onRemove={handleRemove}
              formatSize={formatSize}
            />
          )}
          {skipped.length > 0 && (
            <SkippedGroup
              files={skipped}
              onRemove={handleRemove}
              formatSize={formatSize}
              onCleanAll={cleanableSkipped.length > 0 ? handleCleanSkipped : undefined}
              cleanableCount={cleanableSkipped.length}
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
}: {
  file: RawFileStatus
  onRemove: (file: RawFileStatus) => void
  formatSize: (bytes: number) => string
}) {
  const { t } = useTranslation()
  const reason = stateReason(file, t)
  return (
    <div className="group flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card">
      <StatusIcon file={file} />
      <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm truncate">{file.name}</p>
        {reason ? (
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
      {file.source === 'linked' ? (
        // Watched-folder files live outside the KB — remove the folder in
        // Settings instead of deleting individual files here.
        <span
          className="p-1 flex-shrink-0"
          title={t('From a watched folder — manage it in Settings')}
        >
          <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
        </span>
      ) : (
        <button
          onClick={() => onRemove(file)}
          className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/20 transition-all flex-shrink-0"
          title={t('Remove')}
        >
          <Trash2 className="w-3.5 h-3.5 text-destructive" />
        </button>
      )}
    </div>
  )
}

function FileGroup({ title, files, onRemove, formatSize }: FileGroupProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</h4>
        <span className="text-[11px] text-muted-foreground tabular-nums">{files.length}</span>
      </div>
      <div className="space-y-1">
        {files.map(file => (
          <FileRow key={file.path} file={file} onRemove={onRemove} formatSize={formatSize} />
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
}: {
  files: RawFileStatus[]
  onRemove: (file: RawFileStatus) => void
  formatSize: (bytes: number) => string
  onCleanAll?: () => void
  cleanableCount: number
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
        {onCleanAll && (
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
            <FileRow key={file.path} file={file} onRemove={onRemove} formatSize={formatSize} />
          ))}
        </div>
      )}
    </div>
  )
}
